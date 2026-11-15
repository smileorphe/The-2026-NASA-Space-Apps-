"""Outils géodésiques Mars (sans dépendance à pyproj, qui gère mal les CRS martiens)."""
from __future__ import annotations

import math

import numpy as np

from . import config


def lonlat_to_dtm(lon, lat):
    """Degrés (lon Est, lat planétocentrique) -> mètres dans la projection du DTM HiRISE."""
    r = config.MARS_RADIUS_DTM
    return r * np.radians(lon), r * np.radians(lat)


def dtm_to_lonlat(x, y):
    r = config.MARS_RADIUS_DTM
    return np.degrees(np.asarray(x) / r), np.degrees(np.asarray(y) / r)


def lonlat_to_crism(lon, lat):
    """Degrés -> mètres dans CRISM_LAT_15_0 (projection de la ROI Zastrow & Glotch)."""
    r = config.MARS_RADIUS_CRISM
    k = math.cos(math.radians(config.CRISM_STD_PARALLEL_DEG))
    return r * k * np.radians(lon), r * np.radians(lat)


def haversine_m(lon1, lat1, lon2, lat2, radius: float = config.MARS_RADIUS_DTM):
    """Distance de grand cercle sur Mars, en mètres. Accepte scalaires ou tableaux."""
    lon1, lat1, lon2, lat2 = map(np.radians, (lon1, lat1, lon2, lat2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * radius * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def densify(coords: list[tuple[float, float]], step_m: float):
    """Points régulièrement espacés (~step_m) le long d'une polyligne lon/lat.

    Interpolation linéaire en degrés : l'erreur est négligeable sur quelques km.
    Retourne (lons, lats, index_du_sommet_d_origine_pour_chaque_sommet).
    """
    if len(coords) < 2:
        raise ValueError("Un tracé doit contenir au moins 2 points")
    lons, lats, vertex_idx = [coords[0][0]], [coords[0][1]], [0]
    for (lo1, la1), (lo2, la2) in zip(coords[:-1], coords[1:]):
        seg = float(haversine_m(lo1, la1, lo2, la2))
        n = max(1, int(math.ceil(seg / step_m)))
        t = np.linspace(0.0, 1.0, n + 1)[1:]
        lons.extend(lo1 + (lo2 - lo1) * t)
        lats.extend(la1 + (la2 - la1) * t)
        vertex_idx.append(len(lons) - 1)
    return np.asarray(lons), np.asarray(lats), vertex_idx
