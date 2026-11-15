"""Tests de bout en bout de l'API. Les tests de terrain sont ignorés si le DTM est absent."""
import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app

needs_dtm = pytest.mark.skipif(not config.DTM_PATH.exists(), reason="DTM HiRISE absent")


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    assert client.get("/health").json()["status"] == "ok"


def test_route_geojson(client):
    gj = client.get("/route").json()
    roles = {f["properties"]["role"] for f in gj["features"]}
    assert {"habitat", "point_b", "aller", "retour"} <= roles


def test_autonomie(client):
    r = client.post("/autonomy", json={"outbound_remaining_min": 35, "observation_min": 15,
                                       "return_min": 40}).json()
    assert r["margin_min"] == 30 and r["simulated"] is True


def test_autonomie_entree_invalide(client):
    assert client.post("/autonomy", json={"outbound_remaining_min": -5, "observation_min": 15,
                                          "return_min": 40}).status_code == 422


def test_ajout_arret(client):
    r = client.post("/autonomy/add-stop", json={"outbound_remaining_min": 35, "observation_min": 15,
                                                "return_min": 40, "extra_stop_min": 15}).json()
    assert r["accepted"] is False


def test_incidents(client):
    lst = client.get("/incidents").json()
    if lst:
        inc = client.get(f"/incidents/{lst[0]['id']}").json()
        assert inc["simulation"] is True
    assert client.get("/incidents/..%2Fsecret").status_code in (400, 404)


def test_layers(client):
    assert any(l["id"] == "dtm" for l in client.get("/layers").json())


needs_tiles = pytest.mark.skipif(not (config.BACKEND_DATA / "tiles" / "metadata.json").exists(),
                                 reason="tuiles non générées")


@needs_tiles
def test_map_et_tuiles(client):
    m = client.get("/map").json()
    assert {"ortho", "slope"} <= set(m["layers"])
    # le point B doit être dans l'emprise des tuiles
    lo0, la0, lo1, la1 = m["bounds_lonlat"]
    assert lo0 < 77.38035 < lo1 and la0 < 18.54224 < la1
    z = m["layers"]["ortho"]["min_zoom"]
    from scripts.make_tiles import lat_to_ty, lon_to_tx
    x, y = int(lon_to_tx(77.38035, z)), int(lat_to_ty(18.54224, z))
    r = client.get(f"/tiles/ortho/{z}/{x}/{y}.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"


@needs_dtm
def test_stats_aller_reelles(client):
    s = client.get("/route/stats?leg=aller").json()
    assert 500 < s["distance_m"] < 5000
    assert s["nodata_fraction"] < 0.05
    assert s["slope_max_deg"] < config.SLOPE_MAX_DEG, "le tracé provisoire passe par une pente interdite"


@needs_dtm
def test_gate(client):
    g = client.get("/gate").json()
    assert g["checks"]["dtm_couvre_trace"]["ok"] is True
    assert g["checks"]["point_b_dans_roi"]["ok"] is True
    assert g["verdict"] in ("incomplet", "valide")


needs_meteo = pytest.mark.skipif(not config.METEO_SUMMARY.exists(), reason="météo MEDA absente")
needs_rad = pytest.mark.skipif(not config.RAD_SUMMARY.exists(), reason="radiations RAD absentes")


@needs_meteo
def test_meteo(client):
    w = client.get("/weather").json()
    assert w["lieu_mesure"].startswith("Cratère Jezero")
    assert -120 < w["air_temp_c"]["min"] < w["air_temp_c"]["max"] < 40
    assert 300 < w["pression_pa"]["moyenne"] < 1200
    assert w["go_no_go"]["statut"] in ("vert", "orange", "rouge")
    h = client.get("/weather/hourly").json()["horaire"]
    assert len(h) == 24


@needs_rad
def test_radiations(client):
    r = client.get("/radiation").json()
    assert 5 < r["debit_dose_tissu_uGy_h"]["moyenne"] < 30   # valeurs publiées : ~10 µGy/h
    assert "Gale" in r["lieu_mesure"]


@needs_rad
def test_dose_eva_proportionnelle(client):
    d1 = client.get("/radiation/eva?duration_min=60").json()
    d2 = client.get("/radiation/eva?duration_min=120").json()
    assert d2["dose_absorbee_uGy"] == pytest.approx(2 * d1["dose_absorbee_uGy"], rel=1e-3)
    assert d1["dose_absorbee_uGy"] == pytest.approx(d1["debit_uGy_h"], rel=1e-3)
    assert client.get("/radiation/eva?duration_min=-5").status_code == 422


@needs_dtm
def test_briefing(client):
    b = client.get("/briefing").json()
    assert b["decision"] in ("GO", "GO sous réserve", "NO-GO")
    assert {"autonomie", "terrain", "meteo", "radiations", "donnees"} <= set(b["checks"])


@needs_dtm
def test_plan_autonomie(client):
    p = client.get("/autonomy/plan").json()
    assert p["status"] in ("vert", "orange", "rouge")
