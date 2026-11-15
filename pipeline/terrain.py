"""Outils communs : rasters de l'extrait 5 m, carte de coût, échantillonnage le long d'un tracé.

Une seule carte de coût sert à tout (durées du tracé, retour au moindre coût, itinéraires, zone de retour) :
    coût = (1 + α · pente[°]) × facteur sable ; pentes > SLOPE_MAX_DEG et NoData interdites.
Coût 1 = 1 m de terrain plat ; durée (min) = coût / (vitesse en m/min).
"""
import json
import math
import os

os.environ["GDAL_PAM_ENABLED"] = "NO"

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.features import rasterize
from shapely.geometry import LineString
from skimage.graph import route_through_array

import config as C
import vectors as V

LOCAL, LONLAT = CRS.from_proj4(C.LOCAL), CRS.from_proj4(C.LONLAT)


def m_per_min(speed_kmh: float) -> float:
    return speed_kmh * 1000 / 60


class Raster:
    def __init__(self, path):
        with rasterio.open(path) as d:
            self.a = d.read(1).astype("float64")
            self.transform = d.transform
            self.inv = ~d.transform

    def sample(self, xs, ys):
        """Interpolation bilinéaire (centres de pixels)."""
        cols, rows = self.inv * (np.asarray(xs), np.asarray(ys))
        c, r = cols - 0.5, rows - 0.5
        c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
        fc, fr = c - c0, r - r0
        a = self.a
        return (a[r0, c0] * (1 - fc) * (1 - fr) + a[r0, c0 + 1] * fc * (1 - fr)
                + a[r0 + 1, c0] * (1 - fc) * fr + a[r0 + 1, c0 + 1] * fc * fr)


class Terrain:
    """DTM, pente et carte de coût de l'extrait 5 m."""

    def __init__(self):
        self.dtm = Raster(C.OUT / "dtm_5m.tif")
        self.slope = Raster(C.OUT / "slope_5m.tif")
        s = self.slope.a
        sand = V.sand_polygons(to=LOCAL)
        self.sand = rasterize([(g, 1) for g in getattr(sand, "geoms", [sand])], out_shape=s.shape,
                              transform=self.slope.transform, fill=0, dtype="uint8").astype(bool)
        self.forbidden = ~np.isfinite(s) | (s > C.SLOPE_MAX_DEG)
        cost = (1 + C.ALPHA_PER_DEG * np.nan_to_num(s)) * np.where(self.sand, C.SAND_FACTOR, 1.0)
        cost[self.forbidden] = -1  # négatif = infranchissable pour skimage.graph
        self.cost = cost
        self.uniform = np.where(self.forbidden, -1, 1.0)

    def cell(self, x, y):
        c, r = self.slope.inv * (x, y)
        return int(r), int(c)

    def xy(self, idx):
        return [self.slope.transform * (c + 0.5, r + 0.5) for r, c in idx]

    def along(self, coords):
        """Coût équivalent (m de plat) et longueur dans le sable, échantillonnés tous les mètres."""
        line = LineString(coords)
        n = max(1, int(line.length))
        step = line.length / n
        cells = [self.cell(*line.interpolate(i * step).coords[0]) for i in range(1, n + 1)]
        cost = sum(self.cost[r, c] for r, c in cells)
        if any(self.cost[r, c] < 0 for r, c in cells):
            cost = math.inf  # traverse une cellule interdite
        return float(cost * step), float(sum(self.sand[r, c] for r, c in cells) * step)

    def least_cost(self, start, end, uniform=False):
        """Itinéraire de moindre coût (8 voisins, distances géométriques), en coordonnées locales."""
        idx, _ = route_through_array(self.uniform if uniform else self.cost, self.cell(*start), self.cell(*end),
                                     fully_connected=True, geometric=True)
        line = LineString(self.xy(idx))
        simple = line.simplify(C.RES_M / 2)
        if self.analyse(list(simple.coords))["max_slope_deg"] > C.SLOPE_MAX_DEG:
            simple = line  # la simplification ne doit pas créer de raccourci trop raide
        return list(simple.coords)

    def analyse(self, path):
        """Indicateurs d'un tracé (repère local)."""
        x5, y5, d5 = densify(path, C.RES_M)
        dz = np.diff(self.dtm.sample(x5, y5))
        x1, y1, _ = densify(path, 1.0)
        return {
            "distance_m": round(float(d5[-1]), 1),
            "elevation_gain_m": round(float(dz[dz > 0].sum()), 1),
            "elevation_loss_m": round(float(-dz[dz < 0].sum()), 1),
            "max_slope_deg": round(float(np.nanmax(self.slope.sample(x1, y1))), 1),
        }


def densify(path, step):
    """Points tous les `step` mètres (+ sommets), avec leur distance cumulée."""
    xs, ys, ds = [path[0][0]], [path[0][1]], [0.0]
    for (x0, y0), (x1, y1) in zip(path, path[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(math.ceil(L / step)))
        for i in range(1, n + 1):
            xs.append(x0 + (x1 - x0) * i / n); ys.append(y0 + (y1 - y0) * i / n); ds.append(ds[-1] + L / n)
    return np.array(xs), np.array(ys), np.array(ds)


_to_local = Transformer.from_crs(LONLAT, LOCAL, always_xy=True)
_to_lonlat = Transformer.from_crs(LOCAL, LONLAT, always_xy=True)


def to_lonlat(coords):
    return [[round(v, 7) for v in _to_lonlat.transform(x, y)] for x, y in coords]


def load_route():
    """Tracé de mission (repère local) et points nommés, depuis le GeoJSON du front-end."""
    gj = json.loads((C.FRONT_DATA / "route_aller.geojson").read_text())
    line = next(f for f in gj["features"] if f["geometry"]["type"] == "LineString")["geometry"]["coordinates"]
    pts = {f["properties"]["id"]: _to_local.transform(*f["geometry"]["coordinates"])
           for f in gj["features"] if f["geometry"]["type"] == "Point"}
    return [_to_local.transform(*p) for p in line], pts


def load_detour():
    gj = json.loads((C.FRONT_DATA / "route_detour.geojson").read_text())
    return [_to_local.transform(*p) for p in gj["features"][0]["geometry"]["coordinates"]]
