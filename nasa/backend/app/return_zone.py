"""Zone de retour à pied (dossier workflow, tâche T23).

« Toute la zone d'où l'on peut encore rentrer à l'habitat à pied avec assez d'oxygène. »

Méthode :
1. Grille de 10 m sur la zone 3x3 km, altitude moyenne du DTM HiRISE, pente par case.
2. Cases franchissables : pente < SLOPE_MAX_DEG (20°).
3. Graphe : chaque case reliée à ses 8 voisines, poids = distance (10 m ou 14,1 m).
4. Dijkstra depuis l'habitat (scipy.sparse.csgraph) -> distance à pied jusqu'à l'habitat pour chaque case.
5. Temps de retour = distance / (vitesse × facteur de vitesse). Même modèle de vitesse que /route/stats.
6. Limite de temps :
   - mode « depart » (préparation) : il faut aller ET revenir, plus l'observation :
       2 × t + observation ≤ autonomie − réserve
   - mode « en_cours » (pendant la sortie) : t × facteur_conso ≤ autonomie − réserve − temps écoulé
7. Contour de la zone -> polygones GeoJSON (lon / lat).
Note : le graphe à 8 voisins surestime un peu les distances (jusqu'à ~8 %), ce qui va dans le sens de la sécurité.
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

from . import config

CELL_M = 10.0


@lru_cache(maxsize=1)
def _grid():
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds
    from scipy import ndimage

    x0, y0, x1, y1 = config.ZONE_BBOX_M
    n = int(round((x1 - x0) / CELL_M))
    with rasterio.open(config.DTM_PATH) as src:
        z = src.read(1, window=from_bounds(x0, y0, x1, y1, src.transform),
                     out_shape=(n, n), resampling=Resampling.average).astype("float64")
    bad = (z < -1e30) | ~np.isfinite(z)
    if bad.any():
        z[bad] = np.nanmean(np.where(bad, np.nan, z))
    gy, gx = np.gradient(ndimage.uniform_filter(z, 2), CELL_M)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    return z, slope


def _cell(lon: float, lat: float, n: int) -> tuple[int, int]:
    x0, _, _, y1 = config.ZONE_BBOX_M
    R = config.MARS_RADIUS_DTM
    c = int((R * math.radians(lon) - x0) / CELL_M)
    r = int((y1 - R * math.radians(lat)) / CELL_M)
    if not (0 <= r < n and 0 <= c < n):
        raise ValueError("Point hors de la zone 3x3 km")
    return r, c


@lru_cache(maxsize=4)
def distance_grid(habitat: tuple[float, float]) -> np.ndarray:
    """Distance à pied (m) jusqu'à l'habitat pour chaque case ; inf si inaccessible."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra

    _, slope = _grid()
    n = slope.shape[0]
    ok = slope < config.SLOPE_MAX_DEG
    idx = np.arange(n * n).reshape(n, n)
    rows, cols, w = [], [], []
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        r0, r1 = max(0, -dr), n - max(0, dr)
        c0, c1 = max(0, -dc), n - max(0, dc)
        a = idx[r0:r1, c0:c1]
        b = idx[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
        m = ok[r0:r1, c0:c1] & ok[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
        L = CELL_M * math.hypot(dr, dc)
        rows.append(a[m]); cols.append(b[m]); w.append(np.full(m.sum(), L))
    rows, cols, w = map(np.concatenate, (rows, cols, w))
    g = coo_matrix((np.r_[w, w], (np.r_[rows, cols], np.r_[cols, rows])), shape=(n * n, n * n)).tocsr()
    hr, hc = _cell(*habitat, n)
    d = dijkstra(g, indices=hr * n + hc)
    return d.reshape(n, n)


def return_time_min(habitat, lon, lat, speed_factor: float = 1.0) -> float:
    d = distance_grid(tuple(habitat))
    r, c = _cell(lon, lat, d.shape[0])
    return float(d[r, c] / 1000.0 / (config.WALK_SPEED_KMH * speed_factor) * 60.0)


def limit_min(mode: str, elapsed_min: float, observation_min: float, consumption_factor: float) -> float:
    budget = config.AUTONOMY_MIN - config.RESERVE_MIN
    if mode == "depart":
        return max(0.0, (budget - observation_min) / 2.0)
    return max(0.0, (budget - elapsed_min) / consumption_factor)


def zone_geojson(habitat, mode: str = "depart", elapsed_min: float = 0.0, observation_min: float = 15.0,
                 speed_factor: float = 1.0, consumption_factor: float = 1.0, points: dict | None = None) -> dict:
    import rasterio.features
    from rasterio.transform import from_origin
    from shapely.geometry import mapping, shape
    from shapely.ops import transform as shp_transform, unary_union

    d = distance_grid(tuple(habitat))
    t = d / 1000.0 / (config.WALK_SPEED_KMH * speed_factor) * 60.0
    lim = limit_min(mode, elapsed_min, observation_min, consumption_factor)
    mask = (t <= lim).astype("uint8")
    x0, _, _, y1 = config.ZONE_BBOX_M
    tr = from_origin(x0, y1, CELL_M, CELL_M)
    polys = [shape(g) for g, v in rasterio.features.shapes(mask, mask=mask.astype(bool), transform=tr) if v == 1]
    R = config.MARS_RADIUS_DTM
    zone = unary_union(polys).simplify(CELL_M) if polys else None
    to_deg = lambda x, y, z=None: (np.degrees(np.asarray(x) / R), np.degrees(np.asarray(y) / R))
    n = mask.shape[0]
    touches_edge = bool(mask[0, :].any() or mask[-1, :].any() or mask[:, 0].any() or mask[:, -1].any())

    feats = []
    if zone is not None and not zone.is_empty:
        feats.append({"type": "Feature", "geometry": mapping(shp_transform(to_deg, zone)),
                      "properties": {"role": "zone_retour", "limite_retour_min": round(lim, 1)}})
    checks = {}
    for name, (lon, lat) in (points or {}).items():
        try:
            tm = return_time_min(habitat, lon, lat, speed_factor)
        except ValueError:
            checks[name] = {"dans_zone": False, "detail": "hors de la zone 3x3 km"}
            continue
        checks[name] = {"temps_retour_min": round(tm, 1) if math.isfinite(tm) else None,
                        "dans_zone": bool(math.isfinite(tm) and tm <= lim),
                        "marge_min": round(lim - tm, 1) if math.isfinite(tm) else None}
    return {
        "type": "FeatureCollection",
        "features": feats,
        "properties": {
            "mode": mode,
            "limite_retour_min": round(lim, 1),
            "regle": ("2 × temps de retour + observation ≤ autonomie − réserve" if mode == "depart" else
                      "temps de retour × facteur de consommation ≤ autonomie − réserve − temps écoulé"),
            "vitesse_kmh": round(config.WALK_SPEED_KMH * speed_factor, 2),
            "facteur_vitesse": speed_factor, "facteur_consommation": consumption_factor,
            "temps_ecoule_min": elapsed_min, "observation_min": observation_min,
            "surface_km2": round(float(mask.sum()) * CELL_M * CELL_M / 1e6, 3),
            "limitee_par_bord_de_zone": touches_edge,
            "points": checks,
            "pente_infranchissable_deg": config.SLOPE_MAX_DEG,
            "simulated": True,
        },
    }
