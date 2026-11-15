"""Scope & Data Gate (guide, section 3) — étape bloquante P0.

Vérifie automatiquement ce qui peut l'être :
  1. le DTM couvre tout le tracé ;
  2. le point B est dans la ROI carbonates (shapefile Zastrow & Glotch) ;
  3. la signature carbonate au point B -> EN ATTENTE de data_models.zip (cartes d'abondance).
"""
from __future__ import annotations

from pathlib import Path

from .geo import lonlat_to_crism


def point_in_roi(lon: float, lat: float, roi_path: Path) -> dict:
    if not roi_path.exists():
        return {"ok": None, "detail": f"ROI introuvable : {roi_path}"}
    import geopandas as gpd
    from shapely.geometry import Point

    roi = gpd.read_file(roi_path)
    # Le .prj est une projection Mars ; on convertit nous-mêmes le point dans ce système.
    x, y = lonlat_to_crism(lon, lat)
    inside = bool(roi.geometry.contains(Point(float(x), float(y))).any())
    return {
        "ok": inside,
        "detail": "Point B dans la ROI carbonates marginaux (040ff)." if inside
        else "Point B HORS de la ROI carbonates : déplacer le point B.",
    }


def run_gate(route, dtm, roi_path: Path) -> dict:
    all_lons = [c[0] for c in route.all_coords()]
    all_lats = [c[1] for c in route.all_coords()]
    b_lon, b_lat = route.point_b()

    checks = {
        "dtm_couvre_trace": {
            "ok": dtm.covers(all_lons, all_lats) if dtm else None,
            "detail": "DTM HiRISE 1 m (Mars 2020 TRN)" if dtm else "DTM non chargé",
        },
        "point_b_dans_roi": point_in_roi(b_lon, b_lat, roi_path),
        "signature_carbonate_point_b": {
            "ok": None,
            "detail": "En attente des cartes d'abondance (data_models.zip, Zenodo 4699583). "
                      "Ne pas annoncer de détection minérale avant cette vérification.",
        },
    }
    oks = [c["ok"] for c in checks.values()]
    if any(o is False for o in oks):
        verdict = "bloque"
    elif all(o is True for o in oks):
        verdict = "valide"
    else:
        verdict = "incomplet"
    return {"verdict": verdict, "checks": checks}
