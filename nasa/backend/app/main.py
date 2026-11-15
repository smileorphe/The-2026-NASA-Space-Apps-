"""API FastAPI EVA Planner.

Lancer (depuis le dossier backend/) :
    uvicorn app.main:app --reload
Documentation interactive : http://127.0.0.1:8000/docs
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from functools import lru_cache

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import autonomy, config, environment
from .gate import run_gate
from .route import Route
from .terrain import Dtm, route_stats

log = logging.getLogger("eva")
state: dict = {"dtm": None, "route": None}


@asynccontextmanager
async def lifespan(_: FastAPI):
    if config.DTM_PATH.exists():
        state["dtm"] = Dtm(config.DTM_PATH)
        log.info("DTM chargé : %s", config.DTM_PATH.name)
    else:
        log.warning("DTM introuvable (%s) : routes de terrain désactivées", config.DTM_PATH)
    state["route"] = Route.load(config.ROUTE_PATH)
    yield
    if state["dtm"]:
        state["dtm"].close()


app = FastAPI(title="EVA Planner API", version="0.1.0", lifespan=lifespan,
              description="Données et calculs de la mission EVA à Jezero. "
                          "Les valeurs d'autonomie sont SIMULÉES.")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])

# Tuiles de carte générées par scripts/make_tiles.py : /tiles/{couche}/{z}/{x}/{y}.png
TILES_DIR = config.BACKEND_DATA / "tiles"
TILES_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/tiles", StaticFiles(directory=TILES_DIR), name="tiles")

# Vue 3D Three.js (nasa/index.html) et ses données réelles (scripts/export_3d.py -> nasa/assets/)
ASSETS_DIR = config.PROJECT_DIR / "assets"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")


@app.get("/3d", include_in_schema=False)
def view_3d():
    page = config.PROJECT_DIR / "index.html"
    if not page.exists():
        raise HTTPException(404, "index.html introuvable")
    return FileResponse(page)


def _dtm() -> Dtm:
    if state["dtm"] is None:
        raise HTTPException(503, "DTM non disponible sur ce serveur")
    return state["dtm"]


def _route() -> Route:
    return state["route"]


@lru_cache(maxsize=4)
def _stats(leg: str) -> dict:
    coords = _route().line(leg)
    if coords is None:
        raise HTTPException(404, f"Aucun tracé '{leg}' dans route.geojson")
    try:
        return route_stats(coords, _dtm().sample).to_dict()
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


# --- Généralités -------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok", "dtm_loaded": state["dtm"] is not None,
            "route": config.ROUTE_PATH.name}


@app.get("/config")
def simulation_config():
    """Paramètres de simulation : le front doit afficher ces valeurs, pas les siennes."""
    return {
        "walk_speed_kmh": config.WALK_SPEED_KMH,
        "autonomy_min": config.AUTONOMY_MIN,
        "reserve_min": config.RESERVE_MIN,
        "caution_buffer_min": config.CAUTION_BUFFER_MIN,
        "slope_thresholds_deg": {"attention": config.SLOPE_CAUTION_DEG,
                                 "difficile": config.SLOPE_HARD_DEG,
                                 "interdit": config.SLOPE_MAX_DEG},
        "zone_bbox_dtm_m": config.ZONE_BBOX_M,
        "simulated": True,
    }


@app.get("/layers")
def layers():
    with open(config.SOURCES_PATH, encoding="utf-8") as f:
        return json.load(f)


@app.get("/map")
def map_config():
    """Tout ce dont Leaflet a besoin : centre, emprise, couches de tuiles, légende des pentes."""
    meta_path = TILES_DIR / "metadata.json"
    if not meta_path.exists():
        raise HTTPException(503, "Tuiles non générées : lancer scripts/make_tiles.py")
    with open(meta_path, encoding="utf-8") as f:
        return json.load(f)


# --- Itinéraire --------------------------------------------------------------
@app.get("/route")
def get_route():
    return _route().geojson


@app.get("/route/stats")
def get_route_stats(leg: str = Query("aller", pattern="^(aller|retour)$"),
                    profile: bool = True):
    s = dict(_stats(leg))
    if not profile:
        s.pop("profile")
    return s


@app.get("/gate")
def gate():
    """Scope & Data Gate : bloquant tant que le verdict n'est pas 'valide'."""
    return run_gate(_route(), state["dtm"], config.ROI_PATH)


# --- Autonomie simulée -------------------------------------------------------
class AutonomyIn(BaseModel):
    outbound_remaining_min: float = Field(ge=0)
    observation_min: float = Field(ge=0)
    return_min: float = Field(ge=0)
    autonomy_min: float = Field(config.AUTONOMY_MIN, ge=0)
    reserve_min: float = Field(config.RESERVE_MIN, ge=0)


class AddStopIn(AutonomyIn):
    extra_stop_min: float = Field(gt=0)


def _eval(body: AutonomyIn):
    return autonomy.evaluate(body.autonomy_min, body.outbound_remaining_min,
                             body.observation_min, body.return_min, body.reserve_min)


@app.post("/autonomy")
def post_autonomy(body: AutonomyIn):
    return _eval(body).to_dict()


@app.post("/autonomy/add-stop")
def post_add_stop(body: AddStopIn):
    return autonomy.try_add_stop(_eval(body), body.extra_stop_min)


def _plan(observation_min: float = 15.0) -> dict:
    aller = _stats("aller")["duration_walk_min"]
    retour = _stats("retour")["duration_walk_min"] if _route().line("retour") else aller
    return autonomy.evaluate(config.AUTONOMY_MIN, aller, observation_min, retour).to_dict()


@app.get("/autonomy/plan")
def autonomy_plan(observation_min: float = Query(15.0, ge=0)):
    """Budget au départ, à partir des durées de marche calculées sur le DTM."""
    return _plan(observation_min)


# --- Météo (MEDA) et radiations (RAD) ----------------------------------------
@app.get("/weather")
def get_weather():
    """Bandeau météo : mesures MEDA réelles (Jezero) + critère GO / NO-GO simulé."""
    w = environment.weather()
    if w is None:
        raise HTTPException(503, "Météo absente : lancer scripts/fetch_meda.py")
    return w


@app.get("/weather/hourly")
def get_weather_hourly():
    """Profil heure par heure (heure solaire locale) : température air / sol, pression, vent."""
    w = environment.weather_hourly()
    if w is None:
        raise HTTPException(503, "Météo absente : lancer scripts/fetch_meda.py")
    return w


@app.get("/radiation")
def get_radiation():
    """Débit de dose de surface mesuré par RAD (Curiosity, Gale)."""
    r = environment.radiation()
    if r is None:
        raise HTTPException(503, "Radiations absentes : lancer scripts/fetch_rad.py")
    return r


@app.get("/radiation/eva")
def get_radiation_eva(duration_min: float | None = Query(None, ge=0)):
    """Dose estimée de la sortie. Sans durée : aller + observation + retour du plan."""
    if duration_min is None:
        p = _plan()
        duration_min = p["outbound_remaining_min"] + p["observation_min"] + p["return_min"]
    d = environment.eva_dose(duration_min)
    if d is None:
        raise HTTPException(503, "Radiations absentes : lancer scripts/fetch_rad.py")
    return d


@app.get("/briefing")
def briefing():
    """Briefing GO / NO-GO : regroupe terrain, autonomie, météo, radiations et données."""
    checks = {}
    try:
        plan = _plan()
        checks["autonomie"] = {"statut": plan["status"], "detail": plan["message"]}
        slope = _stats("aller")["slope_max_deg"]
        lvl = ("rouge" if slope >= config.SLOPE_MAX_DEG else
               "orange" if slope >= config.SLOPE_HARD_DEG else "vert")
        checks["terrain"] = {"statut": lvl, "detail": f"Pente max à l'aller : {slope}°"}
    except HTTPException as e:
        checks["terrain"] = {"statut": "inconnu", "detail": e.detail}
    w = environment.weather()
    checks["meteo"] = ({"statut": w["go_no_go"]["statut"], "detail": " ".join(w["go_no_go"]["raisons"])}
                       if w else {"statut": "inconnu", "detail": "Météo absente"})
    r = environment.radiation()
    checks["radiations"] = ({"statut": "vert", "detail": f"Débit de fond {r['debit_dose_tissu_uGy_h']['moyenne']} µGy/h (RAD, Gale)"}
                            if r else {"statut": "inconnu", "detail": "Radiations absentes"})
    g = run_gate(_route(), state["dtm"], config.ROI_PATH)
    checks["donnees"] = {"statut": {"valide": "vert", "incomplet": "orange"}.get(g["verdict"], "rouge"),
                         "detail": f"Scope & Data Gate : {g['verdict']}"}
    statuts = [c["statut"] for c in checks.values()]
    decision = "NO-GO" if "rouge" in statuts else "GO" if all(s == "vert" for s in statuts) else "GO sous réserve"
    return {"decision": decision, "checks": checks, "simulated": True}


# --- Imprévus (réponses DONKI enregistrées, rejouées hors ligne) -------------
@app.get("/incidents")
def list_incidents():
    if not config.INCIDENTS_DIR.exists():
        return []
    return [{"id": p.stem, "file": p.name} for p in sorted(config.INCIDENTS_DIR.glob("*.json"))]


@app.get("/incidents/{incident_id}")
def get_incident(incident_id: str):
    if not incident_id.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(400, "Identifiant invalide")
    p = config.INCIDENTS_DIR / f"{incident_id}.json"
    if not p.exists():
        raise HTTPException(404, "Imprévu inconnu")
    with open(p, encoding="utf-8") as f:
        return json.load(f)
