"""Lecture du DTM et calcul des caractéristiques d'un tracé (guide, section 4)."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from . import config
from .geo import densify, haversine_m, lonlat_to_dtm

# sample_fn(lons, lats) -> altitudes en mètres (NaN si hors DTM / pas de donnée)
SampleFn = Callable[[np.ndarray, np.ndarray], np.ndarray]


class Dtm:
    """Accès paresseux au DTM HiRISE : on lit seulement les pixels demandés (fichier de 1,8 Go)."""

    def __init__(self, path: Path):
        import rasterio  # import local : les tests unitaires n'en ont pas besoin

        self.path = path
        self._ds = rasterio.open(path)
        self.nodata = self._ds.nodata
        self.bounds = self._ds.bounds
        self.res = self._ds.res

    def sample(self, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
        xs, ys = lonlat_to_dtm(np.asarray(lons), np.asarray(lats))
        vals = np.fromiter(
            (v[0] for v in self._ds.sample(zip(xs, ys), indexes=1, masked=False)),
            dtype="float64", count=len(xs),
        )
        bad = ~np.isfinite(vals) | (vals < -1e30)
        if self.nodata is not None:
            bad |= np.isclose(vals, self.nodata)
        inside = (xs >= self.bounds.left) & (xs <= self.bounds.right) & \
                 (ys >= self.bounds.bottom) & (ys <= self.bounds.top)
        vals[bad | ~inside] = np.nan
        return vals

    def covers(self, lons, lats) -> bool:
        xs, ys = lonlat_to_dtm(np.asarray(lons), np.asarray(lats))
        b = self.bounds
        return bool(np.all((xs >= b.left) & (xs <= b.right) & (ys >= b.bottom) & (ys <= b.top)))

    def close(self):
        self._ds.close()


@dataclass
class RouteStats:
    distance_m: float
    elevation_min_m: float
    elevation_max_m: float
    elevation_range_m: float
    elevation_gain_m: float
    elevation_loss_m: float
    slope_max_deg: float
    slope_mean_deg: float
    duration_walk_min: float
    nodata_fraction: float
    profile: list[dict]              # [{d, z, slope}] tous les ~SLOPE_WINDOW_M
    difficult_segments: list[dict]   # [{from_m, to_m, slope_max_deg, level}]
    waypoint_distances_m: list[float]

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def _cumulative_gain(z: np.ndarray, threshold: float) -> tuple[float, float]:
    """Cumul de dénivelé avec hystérésis, pour ne pas compter le bruit du DTM."""
    gain = loss = 0.0
    ref = float(z[0])
    for v in map(float, z[1:]):
        diff = v - ref
        if diff >= threshold:
            gain += diff
            ref = v
        elif diff <= -threshold:
            loss -= diff
            ref = v
    return gain, loss


def _level(slope: float) -> str:
    if slope >= config.SLOPE_MAX_DEG:
        return "interdit"
    if slope >= config.SLOPE_HARD_DEG:
        return "difficile"
    if slope >= config.SLOPE_CAUTION_DEG:
        return "attention"
    return "facile"


def route_stats(coords: list[tuple[float, float]], sample_fn: SampleFn,
                speed_kmh: float = config.WALK_SPEED_KMH) -> RouteStats:
    """Distance, altitude, dénivelé, pentes et durée de marche d'une polyligne lon/lat."""
    lons, lats, vertex_idx = densify(coords, config.SAMPLE_STEP_M)
    seg = haversine_m(lons[:-1], lats[:-1], lons[1:], lats[1:])
    dist = np.concatenate([[0.0], np.cumsum(seg)])
    z = sample_fn(lons, lats).astype("float64")

    nodata_fraction = float(np.mean(~np.isfinite(z)))
    if nodata_fraction == 1.0:
        raise ValueError("Le tracé est entièrement hors du DTM")
    if nodata_fraction > 0:  # bouche les petits trous par interpolation le long du tracé
        ok = np.isfinite(z)
        z = np.interp(dist, dist[ok], z[ok])

    # Rééchantillonnage régulier sur la fenêtre de pente
    total = float(dist[-1])
    win = config.SLOPE_WINDOW_M
    d_reg = np.arange(0.0, total + 1e-9, win)
    if d_reg[-1] < total:
        d_reg = np.append(d_reg, total)
    z_reg = np.interp(d_reg, dist, z)
    dd = np.diff(d_reg)
    slopes = np.degrees(np.arctan2(np.abs(np.diff(z_reg)), np.where(dd > 0, dd, np.nan)))
    slopes = np.nan_to_num(slopes)

    gain, loss = _cumulative_gain(z_reg, config.GAIN_THRESHOLD_M)

    # Segments difficiles : tronçons consécutifs au-dessus du seuil "attention"
    difficult: list[dict] = []
    current = None
    for i, s in enumerate(slopes):
        if s >= config.SLOPE_CAUTION_DEG:
            if current is None:
                current = {"from_m": float(d_reg[i]), "slope_max_deg": 0.0}
            current["to_m"] = float(d_reg[i + 1])
            current["slope_max_deg"] = max(current["slope_max_deg"], float(s))
        elif current is not None:
            difficult.append(current)
            current = None
    if current is not None:
        difficult.append(current)
    for seg_ in difficult:
        seg_["level"] = _level(seg_["slope_max_deg"])
        seg_["slope_max_deg"] = round(seg_["slope_max_deg"], 1)

    profile = [
        {"d": round(float(d), 1), "z": round(float(e), 2),
         "slope": round(float(slopes[min(i, len(slopes) - 1)]), 1) if len(slopes) else 0.0}
        for i, (d, e) in enumerate(zip(d_reg, z_reg))
    ]

    return RouteStats(
        distance_m=round(total, 1),
        elevation_min_m=round(float(z.min()), 2),
        elevation_max_m=round(float(z.max()), 2),
        elevation_range_m=round(float(z.max() - z.min()), 2),
        elevation_gain_m=round(gain, 1),
        elevation_loss_m=round(loss, 1),
        slope_max_deg=round(float(slopes.max()) if len(slopes) else 0.0, 1),
        slope_mean_deg=round(float(slopes.mean()) if len(slopes) else 0.0, 1),
        duration_walk_min=round(total / 1000.0 / speed_kmh * 60.0, 1),
        nodata_fraction=round(nodata_fraction, 4),
        profile=profile,
        difficult_segments=difficult,
        waypoint_distances_m=[round(float(dist[i]), 1) for i in vertex_idx],
    )
