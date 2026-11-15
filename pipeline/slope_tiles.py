"""P2 — Tuiles de pente (classes config.SLOPE_CLASSES) dans la grille géographique de la carte.

Grille identique à `gdal2tiles --profile=geodetic --xyz` et au TileMatrixSet des couches Mars Trek :
origine (−180°, 90°), tuiles de 256 px, résolution 360 / (512 · 2^z) °/px, lignes comptées depuis le haut.
GDAL en ligne de commande n'étant pas requis, la découpe est faite ici avec rasterio (plus proche voisin).
Sortie : frontend/public/tiles/slope/{z}/{ligne}/{colonne}.png + manifest.json.
"""
import json
import math
import os
import shutil
from datetime import date

os.environ["GDAL_PAM_ENABLED"] = "NO"

import numpy as np
import rasterio
from PIL import Image
from pyproj import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds

import config as C

LEVELS = range(11, 16)  # niveaux affichés par la carte (MAX_VIEW_LEVEL = 15)
TILE = 256
OUT_DIR = C.FRONT_TILES / "slope"


def classify(slope: np.ndarray) -> np.ndarray:
    """Index de classe ; −1 pour NoData."""
    idx = np.full(slope.shape, -1, dtype=np.int8)
    valid = np.isfinite(slope)
    bounds = [c[0] for c in C.SLOPE_CLASSES[:-1]]
    idx[valid] = np.digitize(slope[valid], bounds, right=True)  # ≤ 10 → 0, ]10, 15] → 1, ...
    return idx


def main():
    shutil.rmtree(OUT_DIR, ignore_errors=True)
    lonlat = CRS.from_proj4(C.LONLAT)
    with rasterio.open(C.OUT / "slope_5m.tif") as src:
        slope = src.read(1)
        src_crs, src_tr = src.crs, src.transform
        lon0, lat0, lon1, lat1 = transform_bounds(src_crs, lonlat, *src.bounds, densify_pts=21)
    palette = np.array([c[2] for c in C.SLOPE_CLASSES] + [(0, 0, 0, 0)], dtype=np.uint8)  # dernier = transparent
    counts = {}
    for z in LEVELS:
        res = 360 / (2 * TILE * 2 ** z)
        span = res * TILE
        col0, col1 = math.floor((lon0 + 180) / span), math.floor((lon1 + 180) / span)
        row0, row1 = math.floor((90 - lat1) / span), math.floor((90 - lat0) / span)
        n = 0
        for row in range(row0, row1 + 1):
            for col in range(col0, col1 + 1):
                dst = np.full((TILE, TILE), np.nan, dtype="float32")
                reproject(slope, dst, src_transform=src_tr, src_crs=src_crs, src_nodata=np.nan,
                          dst_transform=from_origin(-180 + col * span, 90 - row * span, res, res), dst_crs=lonlat,
                          dst_nodata=np.nan, resampling=Resampling.nearest)
                idx = classify(dst)
                if (idx < 0).all():
                    continue
                rgba = palette[np.where(idx < 0, len(C.SLOPE_CLASSES), idx)]
                out = OUT_DIR / str(z) / str(row) / f"{col}.png"
                out.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgba, "RGBA").save(out, optimize=True)
                n += 1
        counts[z] = n
    (OUT_DIR / "manifest.json").write_text(json.dumps({
        "layer": "slope", "source": "pipeline/output/slope_5m.tif (DTM HiRISE 1 m → 5 m)",
        "grid": "géographique Mars 2000, origine (-180, 90), 256 px, résolution 360/(512·2^z) — équivalent gdal2tiles --profile=geodetic --xyz",
        "classes": [{"max_deg": c[0], "label": c[1], "rgba": c[2]} for c in C.SLOPE_CLASSES],
        "levels": [min(LEVELS), max(LEVELS)], "tiles": counts, "generated": date.today().isoformat(),
    }, ensure_ascii=False, indent=1) + "\n")
    print(f"Tuiles de pente : {counts} → {OUT_DIR.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
