"""Tests des calculs (guide P3/P4 : « résultats cohérents et testés »).

Aucun fichier NASA requis : le DTM est remplacé par des fonctions d'altitude synthétiques.
"""
import math

import numpy as np
import pytest

from app import autonomy, config
from app.geo import haversine_m, lonlat_to_dtm
from app.terrain import route_stats

DEG_M = math.pi * config.MARS_RADIUS_DTM / 180.0  # ~59 274 m par degré de latitude


def test_haversine_un_degre_de_latitude():
    assert haversine_m(77.0, 18.0, 77.0, 19.0) == pytest.approx(DEG_M, rel=1e-9)


def test_longitude_raccourcie_par_la_latitude():
    # À 18.5°N, 1° de longitude vaut cos(18.5°) × 1° de latitude : les degrés ne sont pas des mètres.
    d = haversine_m(77.0, 18.5, 77.001, 18.5)
    assert d == pytest.approx(0.001 * DEG_M * math.cos(math.radians(18.5)), rel=1e-4)


def test_projection_dtm_coherente_avec_emprise_du_fichier():
    # Coin haut-gauche du DTM HiRISE : x=4577366 m -> 77.2229°E (vérifié sur le GeoTIFF).
    x, _ = lonlat_to_dtm(77.22293307697143, 18.5)
    assert x == pytest.approx(4577366.0, abs=0.01)


def test_terrain_plat():
    coords = [(77.38, 18.52), (77.38, 18.53)]
    s = route_stats(coords, lambda lo, la: np.full(len(lo), -2400.0))
    assert s.distance_m == pytest.approx(0.01 * DEG_M, rel=1e-3)
    assert s.slope_max_deg == 0
    assert s.elevation_gain_m == 0 and s.elevation_range_m == 0
    assert s.difficult_segments == []
    assert s.duration_walk_min == pytest.approx(s.distance_m / 1000 / config.WALK_SPEED_KMH * 60, abs=0.05)


def test_pente_constante_10_degres():
    tan10 = math.tan(math.radians(10))
    def rampe(lo, la):  # altitude qui monte vers le nord à 10°
        return -2400.0 + (np.asarray(la) - 18.52) * DEG_M * tan10
    s = route_stats([(77.38, 18.52), (77.38, 18.525)], rampe)
    assert s.slope_max_deg == pytest.approx(10.0, abs=0.2)
    assert s.elevation_gain_m == pytest.approx(0.005 * DEG_M * tan10, rel=0.02)
    assert s.elevation_loss_m == 0
    assert s.difficult_segments and s.difficult_segments[0]["level"] == "attention"


def test_trous_du_dtm_interpoles():
    def avec_trou(lo, la):
        z = np.full(len(lo), -2400.0)
        z[len(z) // 3: len(z) // 2] = np.nan
        return z
    s = route_stats([(77.38, 18.52), (77.38, 18.53)], avec_trou)
    assert 0 < s.nodata_fraction < 1
    assert s.slope_max_deg == 0


def test_trace_hors_dtm_refuse():
    with pytest.raises(ValueError):
        route_stats([(77.38, 18.52), (77.38, 18.53)], lambda lo, la: np.full(len(lo), np.nan))


def test_formule_autonomie_exemple_du_guide():
    r = autonomy.evaluate(120, 35, 15, 40, reserve_min=20)
    assert r.margin_min == 30
    assert r.status == "orange"   # 30 < 20 + 15 de tampon
    assert r.simulated is True


@pytest.mark.parametrize("marge_attendue,statut", [(60, "vert"), (25, "orange"), (10, "rouge")])
def test_statuts(marge_attendue, statut):
    r = autonomy.evaluate(120, 0, 120 - marge_attendue, 0, reserve_min=20)
    assert r.margin_min == marge_attendue and r.status == statut


def test_arret_refuse_sous_la_reserve():
    base = autonomy.evaluate(120, 35, 15, 40, reserve_min=20)   # marge 30
    assert autonomy.try_add_stop(base, 5)["accepted"] is True    # marge 25
    refus = autonomy.try_add_stop(base, 15)                      # marge 15 < 20
    assert refus["accepted"] is False and "refusé" in refus["reason"]


def test_valeurs_negatives_interdites():
    with pytest.raises(ValueError):
        autonomy.evaluate(120, -1, 15, 40)
