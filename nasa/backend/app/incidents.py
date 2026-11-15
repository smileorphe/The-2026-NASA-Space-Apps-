"""Imprévus : catalogue (data/incidents/*.json) et évaluation en situation.

Une évaluation répond à : « l'astronaute est ICI, il s'est écoulé T minutes, tel imprévu arrive :
que faire, par où rentrer, combien de marge reste-t-il ? »

Modèle (le même que /autonomy, guide §5) :
    autonomie restante  = (autonomie − temps écoulé) / facteur de consommation
    marge               = autonomie restante − temps nécessaire
    rouge si marge < réserve ; orange si marge < réserve + tampon ; vert sinon.
Vitesse = vitesse de marche × facteur de vitesse de l'imprévu (blessé : × 0,5).
"""
from __future__ import annotations

import json
import math
import re

import numpy as np

from . import config
from .autonomy import status_for
from .geo import densify, haversine_m
from . import return_zone

DEFAULT_EFFECTS = {"retour_immediat": False, "facteur_vitesse": 1.0, "facteur_consommation": 1.0,
                   "detour_m": 0, "delta_observation_min": 0, "chemin_retour": "connu",
                   "delai_decision_min": None}
_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def load(incident_id: str) -> dict:
    if not _ID.match(incident_id):
        raise ValueError("Identifiant invalide")
    p = config.INCIDENTS_DIR / f"{incident_id}.json"
    if not p.exists():
        raise FileNotFoundError(incident_id)
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def catalogue() -> list[dict]:
    out = []
    for p in sorted(config.INCIDENTS_DIR.glob("*.json")):
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        out.append({"id": p.stem, "titre": d.get("titre"), "niveau": d.get("niveau"),
                    "code_workflow": d.get("code_workflow"), "moments": d.get("moments", []),
                    "reel": "evenement_reel" in d})
    return out


def point_at(coords: list[tuple[float, float]], distance_m: float) -> tuple[float, float]:
    """Position (lon, lat) à distance_m le long d'une polyligne."""
    lons, lats, _ = densify(coords, 2.0)
    cum = np.concatenate([[0.0], np.cumsum(haversine_m(lons[:-1], lats[:-1], lons[1:], lats[1:]))])
    d = min(max(distance_m, 0.0), float(cum[-1]))
    return float(np.interp(d, cum, lons)), float(np.interp(d, cum, lats))


def evaluate(incident: dict, phase: str, distance_m: float, elapsed_min: float,
             route, aller_m: float, retour_m: float | None, observation_min: float) -> dict:
    eff = {**DEFAULT_EFFECTS, **incident.get("effets", {})}
    speed_kmh = config.WALK_SPEED_KMH * eff["facteur_vitesse"]
    walk = lambda m: m / 1000.0 / speed_kmh * 60.0
    detour_min = walk(eff["detour_m"])
    retour_m = retour_m if retour_m is not None else aller_m
    obs = max(0.0, observation_min + eff["delta_observation_min"])

    # Position actuelle
    if phase == "aller":
        if not 0 <= distance_m <= aller_m + 1:
            raise ValueError(f"distance_m doit être entre 0 et {aller_m:.0f} m sur l'aller")
        pos = point_at(route.line("aller"), distance_m)
    elif phase == "station":
        pos = route.point_b()
    elif phase == "retour":
        if not 0 <= distance_m <= retour_m + 1:
            raise ValueError(f"distance_m doit être entre 0 et {retour_m:.0f} m sur le retour")
        pos = point_at(route.line("retour") or list(reversed(route.line("aller"))), distance_m)
    else:
        raise ValueError("phase doit valoir aller, station ou retour")

    # Options de retour vers l'habitat
    options = []
    if phase == "aller":
        options.append(("demi_tour_par_l_aller", "Demi-tour par l'aller (chemin connu)", distance_m))
    elif phase == "station":
        options.append(("retour_par_l_aller", "Retour par l'aller (chemin connu)", aller_m))
        if route.line("retour"):
            options.append(("retour_prevu", "Retour prévu", retour_m))
    else:
        options.append(("suite_du_retour", "Suite du retour prévu (chemin connu)", retour_m - distance_m))
    known = [o[0] for o in options]
    try:
        t_short = return_zone.return_time_min(route.habitat(), *pos, eff["facteur_vitesse"])
        if math.isfinite(t_short):
            options.append(("plus_court_terrain", "Chemin le plus court sur le terrain (hors tracé, pentes < 20°)",
                            t_short / 60.0 * speed_kmh * 1000.0))
    except ValueError:
        pass
    opts = [{"id": i, "nom": n, "distance_m": round(m, 1), "temps_min": round(walk(m) + detour_min, 1)}
            for i, n, m in options]

    remaining = max(0.0, (config.AUTONOMY_MIN - elapsed_min) / eff["facteur_consommation"])

    def pick(ids):
        cands = [o for o in opts if o["id"] in ids]
        return min(cands, key=lambda o: o["temps_min"])

    # Continuer le plan (si l'imprévu le permet)
    if phase == "aller":
        cont = walk(aller_m - distance_m) + detour_min + obs + walk(retour_m)
    elif phase == "station":
        cont = obs + walk(retour_m) + detour_min
    else:
        cont = walk(retour_m - distance_m) + detour_min

    if eff["retour_immediat"]:
        best = pick(known if eff["chemin_retour"] == "connu" else [o["id"] for o in opts])
        need = best["temps_min"]
        margin = remaining - need
        status, _ = status_for(margin)
        decision = "RETOUR IMMÉDIAT"
        consigne = f"{best['nom']} : {best['temps_min']} min de marche."
    else:
        need = cont
        margin = remaining - need
        status, _ = status_for(margin)
        best = pick(known)
        if status == "rouge":
            decision = "RETOUR"
            consigne = f"La suite du plan ne tient plus dans la réserve. {best['nom']} : {best['temps_min']} min."
        elif eff["delai_decision_min"]:
            wait = eff["delai_decision_min"]
            m_wait = remaining - wait - best["temps_min"]
            decision = "CONTINUER PRUDEMMENT"
            consigne = (f"Continuer tant que tout est vert ; sans contact dans {wait} min, retour. "
                        f"Marge si le retour commence dans {wait} min : {m_wait:.1f} min.")
        elif status == "orange":
            decision = "ADAPTER"
            consigne = "Marge réduite : raccourcir la station ou rentrer après l'observation."
        else:
            decision = "CONTINUER"
            consigne = "La suite du plan reste dans la marge de sécurité."

    zone_lim = return_zone.limit_min("en_cours", elapsed_min, obs, eff["facteur_consommation"])
    try:
        t_pos = return_zone.return_time_min(route.habitat(), *pos, eff["facteur_vitesse"])
        in_zone = math.isfinite(t_pos) and t_pos <= zone_lim
    except ValueError:
        t_pos, in_zone = None, False

    return {
        "imprevu": {"id": incident.get("id"), "titre": incident.get("titre"), "niveau": incident.get("niveau"),
                    "code_workflow": incident.get("code_workflow"), "message": incident.get("message")},
        "situation": {"phase": phase, "distance_m": distance_m, "temps_ecoule_min": elapsed_min,
                      "position_lonlat": [round(pos[0], 6), round(pos[1], 6)]},
        "effets_appliques": eff,
        "options_retour": opts,
        "autonomie_restante_min": round(remaining, 1),
        "temps_necessaire_min": round(need, 1),
        "marge_min": round(margin, 1),
        "reserve_min": config.RESERVE_MIN,
        "statut": status,
        "decision": decision,
        "consigne": consigne,
        "chemin_conseille": best,
        "zone_retour": {"dans_zone": in_zone, "limite_min": round(zone_lim, 1),
                        "temps_retour_terrain_min": None if t_pos is None or not math.isfinite(t_pos) else round(t_pos, 1)},
        "affichage": incident.get("affichage", {}),
        "simulation": True,
    }
