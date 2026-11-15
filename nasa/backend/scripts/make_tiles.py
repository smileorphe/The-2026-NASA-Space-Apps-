"""Génère les tuiles de carte Leaflet (XYZ, 256 px, PNG) de la zone de travail.

Couches produites :
    data/tiles/ortho/{z}/{x}/{y}.png   orthoimage HiRISE 25 cm (niveaux de gris, contraste étiré)
    data/tiles/slope/{z}/{x}/{y}.png   pentes calculées sur le DTM 1 m (vert/jaune/orange/rouge, transparent)
    data/tiles/metadata.json           emprise, niveaux de zoom, crédits

Convention (à respecter côté front) :
    Les tuiles suivent le schéma XYZ standard de Leaflet (EPSG:3857), en utilisant
    directement les degrés martiens (longitude Est, latitude planétocentrique, Mars 2000)
    comme s'il s'agissait de lat/lon terrestres. Ainsi L.tileLayer et L.geoJSON(route.geojson)
    se superposent sans configuration. Les distances mesurées par Leaflet sont FAUSSES
    (rayon terrestre) : utiliser celles de l'API (/route/stats).

Usage (depuis backend/) :
    python scripts/make_tiles.py                 # ortho z13-18, pentes z13-17
    python scripts/make_tiles.py --layers slope  # une seule couche
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config  # noqa: E402

TILE = 256
OUT = config.BACKEND_DATA / "tiles"
ORTHO_PATH = config.DATA_DIR / "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif"
R = config.MARS_RADIUS_DTM

# Couleurs des pentes (mêmes seuils que l'API, cf. config.py) : RGBA
SLOPE_COLORS = [
    (config.SLOPE_CAUTION_DEG, (46, 160, 67, 0)),      # < 10°  facile : transparent (ne pas teinter l'image)
    (config.SLOPE_HARD_DEG, (240, 200, 30, 150)),      # 10-15° jaune
    (config.SLOPE_MAX_DEG, (245, 130, 20, 170)),       # 15-20° orange
    (999.0, (220, 30, 30, 190)),                       # > 20°  rouge (interdit)
]


# --- Géométrie des tuiles (Web Mercator appliqué aux degrés martiens) -------
def lon_to_tx(lon, z):
    return (lon + 180.0) / 360.0 * 2 ** z


def lat_to_ty(lat, z):
    la = math.radians(lat)
    return (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * 2 ** z


def tx_to_lon(tx, z):
    return np.asarray(tx) / 2 ** z * 360.0 - 180.0


def ty_to_lat(ty, z):
    n = np.pi - 2 * np.pi * np.asarray(ty) / 2 ** z
    return np.degrees(np.arctan(np.sinh(n)))


def zone_lonlat():
    x0, y0, x1, y1 = config.ZONE_BBOX_M
    return (math.degrees(x0 / R), math.degrees(y0 / R), math.degrees(x1 / R), math.degrees(y1 / R))


def tiles_for_zoom(z):
    lo0, la0, lo1, la1 = zone_lonlat()
    xa, xb = int(lon_to_tx(lo0, z)), int(lon_to_tx(lo1, z))
    ya, yb = int(lat_to_ty(la1, z)), int(lat_to_ty(la0, z))
    return [(x, y) for x in range(xa, xb + 1) for y in range(ya, yb + 1)]


# --- Pyramide de rasters ----------------------------------------------------
def build_pyramid(arr: np.ndarray, levels: int, reducer) -> list[np.ndarray]:
    pyr = [arr]
    for _ in range(levels):
        a = pyr[-1]
        h, w = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
        a = a[:h, :w].reshape(h // 2, 2, w // 2, 2)
        pyr.append(reducer(a))
    return pyr


def mean_ignore_zero(a):
    """Moyenne 2x2 en ignorant les pixels 'pas de donnée' (0)."""
    a = a.astype("float32")
    valid = (a > 0).sum(axis=(1, 3))
    s = a.sum(axis=(1, 3))
    out = np.where(valid > 0, s / np.maximum(valid, 1), 0)
    return out.astype("uint8")


def max_pool(a):
    """Maximum 2x2 : aux petits zooms, on garde les pentes fortes visibles (sécurité)."""
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # blocs 100 % sans donnée -> NaN, voulu
        return np.nanmax(a, axis=(1, 3))


def sample_tile(pyr, base_res, x0m, y0m, z, tx, ty):
    """Échantillonne une tuile au plus proche voisin dans le bon niveau de la pyramide.
    Retourne (valeurs 256x256, masque valide)."""
    px = (np.arange(TILE) + 0.5) / TILE
    lons = tx_to_lon(tx + px, z)
    lats = ty_to_lat(ty + px, z)
    xs = R * np.radians(lons)
    ys = R * np.radians(lats)
    # résolution demandée (m/px martiens) -> niveau de pyramide
    target = abs(xs[-1] - xs[0]) / (TILE - 1)
    lvl = int(max(0, min(len(pyr) - 1, math.floor(math.log2(max(target / base_res, 1.0))))))
    arr, res = pyr[lvl], base_res * 2 ** lvl
    cols = np.floor((xs - x0m) / res).astype(int)
    rows = np.floor((y0m - ys) / res).astype(int)
    vc = (cols >= 0) & (cols < arr.shape[1])
    vr = (rows >= 0) & (rows < arr.shape[0])
    vals = arr[np.clip(rows, 0, arr.shape[0] - 1)[:, None], np.clip(cols, 0, arr.shape[1] - 1)[None, :]]
    return vals, vr[:, None] & vc[None, :]


def read_zone(path: Path):
    with rasterio.open(path) as src:
        w = from_bounds(*config.ZONE_BBOX_M, transform=src.transform).round_offsets().round_lengths()
        arr = src.read(1, window=w)
        t = src.window_transform(w)
        return arr, src.res[0], t.c, t.f, src.nodata


# --- Couches ------------------------------------------------------------------
def make_ortho(zooms):
    print(f"Lecture de l'orthoimage (zone 3x3 km) : {ORTHO_PATH.name}")
    arr, res, x0m, y0m, _ = read_zone(ORTHO_PATH)
    valid = arr > 0
    lo, hi = np.percentile(arr[valid], [1, 99])
    print(f"  {arr.shape[1]}x{arr.shape[0]} px, {res} m/px ; étirement {lo:.0f}-{hi:.0f} -> 1-255")
    stretched = np.clip((arr.astype("float32") - lo) / max(hi - lo, 1) * 254 + 1, 1, 255).astype("uint8")
    stretched[~valid] = 0
    pyr = build_pyramid(stretched, 8, mean_ignore_zero)

    def render(vals, mask):
        alpha = np.where(mask & (vals > 0), 255, 0).astype("uint8")
        return Image.fromarray(np.dstack([vals, alpha]), mode="LA")

    return write_layer("ortho", zooms, pyr, res, x0m, y0m, render)


def slope_degrees(z: np.ndarray, res: float) -> np.ndarray:
    """Pente (degrés) sur un DTM lissé 3x3 (réduit le bruit des pixels de 1 m)."""
    z = z.astype("float64")
    nan = ~np.isfinite(z)
    z[nan] = np.nanmean(z)
    p = np.pad(z, 1, mode="edge")
    zs = sum(p[i:i + z.shape[0], j:j + z.shape[1]] for i in range(3) for j in range(3)) / 9.0
    gy, gx = np.gradient(zs, res)
    s = np.degrees(np.arctan(np.hypot(gx, gy))).astype("float32")
    s[nan] = np.nan
    return s


def make_slope(zooms):
    print(f"Lecture du DTM (zone 3x3 km) : {config.DTM_PATH.name}")
    arr, res, x0m, y0m, nodata = read_zone(config.DTM_PATH)
    arr = arr.astype("float32")
    arr[(arr < -1e30) | (nodata is not None and np.isclose(arr, nodata))] = np.nan
    s = slope_degrees(arr, res)
    print(f"  pentes : médiane {np.nanmedian(s):.1f}°, >20° sur {np.nanmean(s > 20) * 100:.2f}% de la zone")
    pyr = build_pyramid(s, 6, max_pool)
    lut_thr = np.array([t for t, _ in SLOPE_COLORS])
    lut_col = np.array([c for _, c in SLOPE_COLORS], dtype="uint8")

    def render(vals, mask):
        idx = np.searchsorted(lut_thr, np.nan_to_num(vals, nan=0.0), side="right")
        rgba = lut_col[np.clip(idx, 0, len(lut_col) - 1)].copy()
        rgba[~mask | ~np.isfinite(vals), 3] = 0
        return Image.fromarray(rgba, mode="RGBA")

    return write_layer("slope", zooms, pyr, res, x0m, y0m, render)


THEMIS_PATH = (config.DATA_DIR / "sim3464_JezeroNili_FINAL" / "Rasters" /
               "USGS_THEMIS_IR_controlled_mosaic_oct2018" / "nili_THEMIS_DayIR_Controlled_oct2018.tif")
THERMAL_RES_M = 5.0  # THEMIS fait 100 m/px : on le reprojette en bilinéaire sur une grille de 5 m


def _thermal_palette():
    """Palette sombre -> clair (bleu nuit, violet, orange, jaune pâle), 256 couleurs RGBA."""
    stops = [(0.0, (20, 20, 60)), (0.35, (110, 40, 120)), (0.65, (230, 110, 40)), (1.0, (255, 235, 160))]
    lut = np.zeros((256, 4), dtype="uint8")
    for i in range(256):
        t = i / 255
        for (t0, c0), (t1, c1) in zip(stops[:-1], stops[1:]):
            if t0 <= t <= t1:
                k = (t - t0) / (t1 - t0)
                lut[i, :3] = [round(a + (b - a) * k) for a, b in zip(c0, c1)]
        lut[i, 3] = 170
    return lut


def make_thermal(zooms):
    """THEMIS IR de jour (Mars Odyssey), reprojeté de MTM 77.5E vers la projection du DTM."""
    from rasterio.warp import Resampling, reproject
    from rasterio.transform import from_origin

    print(f"Lecture et reprojection THEMIS : {THEMIS_PATH.name}")
    x0, y0, x1, y1 = config.ZONE_BBOX_M
    with rasterio.open(config.DTM_PATH) as dtm:
        dst_crs = dtm.crs
    w, h = int((x1 - x0) / THERMAL_RES_M), int((y1 - y0) / THERMAL_RES_M)
    dst = np.zeros((h, w), dtype="float32")
    with rasterio.open(THEMIS_PATH) as src:
        reproject(source=rasterio.band(src, 1), destination=dst,
                  src_nodata=0, dst_nodata=0,
                  dst_transform=from_origin(x0, y1, THERMAL_RES_M, THERMAL_RES_M), dst_crs=dst_crs,
                  resampling=Resampling.bilinear)
    valid = dst > 0
    lo, hi = np.percentile(dst[valid], [2, 98])
    print(f"  {w}x{h} px à {THERMAL_RES_M} m (source 100 m) ; étirement {lo:.0f}-{hi:.0f}")
    idx = np.clip((dst - lo) / max(hi - lo, 1) * 254 + 1, 1, 255).astype("uint8")
    idx[~valid] = 0
    pyr = build_pyramid(idx, 4, mean_ignore_zero)
    lut = _thermal_palette()

    def render(vals, mask):
        rgba = lut[vals].copy()
        rgba[~mask | (vals == 0), 3] = 0
        return Image.fromarray(rgba, mode="RGBA")

    return write_layer("thermal", zooms, pyr, THERMAL_RES_M, x0, y1, render)


def write_layer(name, zooms, pyr, res, x0m, y0m, render):
    t0, n, size = time.time(), 0, 0
    for z in zooms:
        tiles = tiles_for_zoom(z)
        for tx, ty in tiles:
            vals, mask = sample_tile(pyr, res, x0m, y0m, z, tx, ty)
            if not mask.any():
                continue
            p = OUT / name / str(z) / str(tx) / f"{ty}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            render(vals, mask).save(p, optimize=True)
            n += 1
            size += p.stat().st_size
        print(f"  {name} z{z} : {len(tiles)} tuiles")
    print(f"  -> {n} tuiles, {size / 1e6:.1f} Mo, {time.time() - t0:.0f} s")
    return {"min_zoom": min(zooms), "max_zoom": max(zooms), "tiles": n, "size_mb": round(size / 1e6, 1)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--layers", default="ortho,slope,thermal")
    ap.add_argument("--ortho-zooms", default="13-18")
    ap.add_argument("--slope-zooms", default="13-17")
    ap.add_argument("--thermal-zooms", default="13-16")
    args = ap.parse_args()

    def zr(s):
        a, b = map(int, s.split("-"))
        return list(range(a, b + 1))

    meta_path = OUT / "metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {"layers": {}}
    lo0, la0, lo1, la1 = zone_lonlat()
    meta.update({
        "scheme": "xyz",
        "crs_note": "Web Mercator appliqué aux degrés martiens (Mars 2000, lon Est, lat planétocentrique). "
                    "Distances Leaflet invalides : utiliser l'API.",
        "bounds_lonlat": [round(lo0, 6), round(la0, 6), round(lo1, 6), round(la1, 6)],
        "center_lonlat": [round((lo0 + lo1) / 2, 6), round((la0 + la1) / 2, 6)],
    })
    layers = [l.strip() for l in args.layers.split(",")]
    if "ortho" in layers:
        meta["layers"]["ortho"] = {**make_ortho(zr(args.ortho_zooms)),
                                   "url": "/tiles/ortho/{z}/{x}/{y}.png",
                                   "attribution": "HiRISE (NASA/JPL/UArizona), mosaïque Mars 2020 TRN, USGS"}
    if "slope" in layers:
        meta["layers"]["slope"] = {**make_slope(zr(args.slope_zooms)),
                                   "url": "/tiles/slope/{z}/{x}/{y}.png",
                                   "attribution": "Pentes calculées sur le DTM HiRISE 1 m (EVA Planner)",
                                   "legend": [{"max_deg": t, "rgba": c} for t, c in SLOPE_COLORS]}
    if "thermal" in layers:
        meta["layers"]["thermal"] = {
            **make_thermal(zr(args.thermal_zooms)),
            "url": "/tiles/thermal/{z}/{x}/{y}.png",
            "attribution": "THEMIS IR de jour, mosaïque contrôlée USGS (oct. 2018), Mars Odyssey (NASA/ASU)",
            "resolution_source_m": 100,
            "lecture": "Clair = surface plus chaude l'après-midi (souvent sable ou poussière, faible inertie "
                       "thermique). Sombre = surface plus froide (souvent roche). Indice qualitatif, pas une "
                       "carte d'inertie thermique.",
        }
    OUT.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Métadonnées -> {meta_path.relative_to(config.BACKEND_DIR)}")


if __name__ == "__main__":
    main()
