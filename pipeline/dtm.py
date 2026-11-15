"""P1 (1/2) — Extrait du DTM HiRISE 1 m, reprojeté en projection locale à pixels carrés et rééchantillonné à 5 m.

Sorties : output/dtm_5m.tif (altitude, m) et output/slope_5m.tif (pente, degrés).
La moyenne (Resampling.average) est utilisée pour passer de 1 m à 5 m.
"""
import os

os.environ["GDAL_PAM_ENABLED"] = "NO"  # ne jamais écrire de .aux.xml à côté des sources

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from pyproj import CRS, Transformer

import config as C


def local_grid(pad_m: float = 100.0):
    """Grille locale couvrant la zone (+ marge), alignée sur des multiples de la résolution."""
    t = Transformer.from_crs(CRS.from_proj4(C.LONLAT), CRS.from_proj4(C.LOCAL), always_xy=True)
    l, b, r, u = t.transform_bounds(*C.ZONE, densify_pts=21)
    res = C.RES_M
    l, b = np.floor((l - pad_m) / res) * res, np.floor((b - pad_m) / res) * res
    r, u = np.ceil((r + pad_m) / res) * res, np.ceil((u + pad_m) / res) * res
    w, h = int(round((r - l) / res)), int(round((u - b) / res))
    return from_origin(l, u, res, res), w, h


def slope_degrees(z: np.ndarray, res: float) -> np.ndarray:
    """Pente (°) par différences centrées ; NaN propagé."""
    gy, gx = np.gradient(z, res)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def main():
    C.OUT.mkdir(parents=True, exist_ok=True)
    transform, w, h = local_grid()
    crs = CRS.from_proj4(C.LOCAL)
    dtm = np.full((h, w), np.nan, dtype="float32")
    with rasterio.open(C.DTM_SRC) as src:
        reproject(
            rasterio.band(src, 1), dtm, src_nodata=src.nodata, dst_nodata=np.nan,
            dst_transform=transform, dst_crs=crs, resampling=Resampling.average,
        )
    slope = slope_degrees(dtm.astype("float64"), C.RES_M).astype("float32")

    profile = dict(driver="GTiff", width=w, height=h, count=1, dtype="float32", crs=crs.to_wkt(),
                   transform=transform, nodata=np.nan, compress="deflate")
    for name, arr in (("dtm_5m.tif", dtm), ("slope_5m.tif", slope)):
        with rasterio.open(C.OUT / name, "w", **profile) as dst:
            dst.write(arr, 1)

    valid = np.isfinite(dtm)
    print(f"Extrait {w}×{h} px à {C.RES_M} m · altitude {np.nanmin(dtm):.1f} à {np.nanmax(dtm):.1f} m · "
          f"NoData {100 * (1 - valid.mean()):.1f} %")
    print(f"Pente : médiane {np.nanmedian(slope):.1f}° · p99 {np.nanpercentile(slope, 99):.1f}° · max {np.nanmax(slope):.1f}° · "
          f"> {C.SLOPE_MAX_DEG:.0f}° : {100 * np.nanmean(slope > C.SLOPE_MAX_DEG):.2f} %")


if __name__ == "__main__":
    main()
