"""Données de la vue 3D du casque, dans la projection locale et sur l'emprise des grilles 5 m (terrain_export.py).

Sorties dans frontend/public/data/terrain/, à côté de grid.json (aucune nouvelle source : uniquement les données de l'équipe data) :
- ortho.png : ortho HiRISE 25 cm de l'équipe, découpée sur l'emprise des grilles, reprojetée et moyennée à 1,5 m
  (≈ 2 000 px de côté), niveaux de gris ; pixels sans donnée = 0 ;
- corridor_1m.f32 : DTM HiRISE 1 m sur un couloir de ±150 m autour du tracé de référence (route_aller.geojson),
  interpolation bilinéaire ; NaN hors du couloir ;
- horizon_ctx.f32 : DTM CTX 20 m (USGS, SIM 3464) en grille réduite à 100 m, ~10 km autour de l'emprise,
  aligné verticalement sur le DTM HiRISE (médiane des écarts sur l'emprise, voir `vertical_offset_m`).

Les grilles Float32 sont little-endian, ligne par ligne depuis le haut (nord), comme les grilles 5 m.
`export()` renvoie la description de chaque fichier, que terrain_export.py écrit dans grid.json.
"""
import os

os.environ["GDAL_PAM_ENABLED"] = "NO"

import numpy as np
import rasterio
from PIL import Image
from pyproj import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from rasterio.windows import Window, from_bounds
from shapely import contains_xy
from shapely.geometry import LineString

import config as C
from terrain import Raster, load_route, to_lonlat

OUT_DIR = C.FRONT_DATA / "terrain"
ORTHO_SRC = C.NASA / "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif"
CTX_DTM_SRC = C.NASA / "sim3464_JezeroNili_FINAL" / "Rasters" / "USGS_CTX_Stereo_DTMs" / "J03_045994_1986_J03_046060_1986_20m_DTM.tif"
ORTHO_RES_M = 1.5
CORRIDOR_HALF_WIDTH_M = 150.0
CORRIDOR_RES_M = 1.0
HORIZON_RES_M = 100.0
HORIZON_PAD_M = 10_000.0

LOCAL = CRS.from_proj4(C.LOCAL)


def describe(name, x0, y_top, cell, w, h, **extra):
    """Description d'un fichier : emprise (projection locale et lon/lat), taille de cellule, dimensions."""
    x1, y_bottom = x0 + w * cell, y_top - h * cell
    (lon0, lat1), (lon1, lat0) = to_lonlat([(x0, y_top), (x1, y_bottom)])
    return {"file": name, "width": w, "height": h, "cell_m": cell,
            "origin": {"x": x0, "y": y_top},
            "extent_local_m": [x0, y_bottom, x1, y_top],
            "extent_lonlat": [lon0, lat0, lon1, lat1], **extra}


def ortho(x0, y_top, width_m, height_m):
    w, h = int(np.ceil(width_m / ORTHO_RES_M)), int(np.ceil(height_m / ORTHO_RES_M))
    dst_tr = from_origin(x0, y_top, ORTHO_RES_M, ORTHO_RES_M)
    out = np.zeros((h, w), dtype="float32")
    with rasterio.open(ORTHO_SRC) as src:
        # Fenêtre source couvrant l'emprise (+ marge), lue à pleine résolution puis moyennée par la reprojection
        from rasterio.warp import transform_bounds
        l, b, r, t = transform_bounds(LOCAL, src.crs, x0, y_top - h * ORTHO_RES_M, x0 + w * ORTHO_RES_M, y_top, densify_pts=21)
        win = from_bounds(l - 20, b - 20, r + 20, t + 20, src.transform).round_offsets().round_lengths()
        win = win.intersection(Window(0, 0, src.width, src.height))
        arr = src.read(1, window=win).astype("float32")
        arr[arr == src.nodata] = np.nan
        reproject(arr, out, src_transform=src.window_transform(win), src_crs=src.crs, src_nodata=np.nan,
                  dst_transform=dst_tr, dst_crs=LOCAL, dst_nodata=np.nan, resampling=Resampling.average)
    png = np.where(np.isfinite(out), np.clip(np.round(out), 1, 255), 0).astype("uint8")
    Image.fromarray(png, mode="L").save(OUT_DIR / "ortho.png", optimize=True)
    return describe("ortho.png", x0, y_top, ORTHO_RES_M, w, h, format="PNG 8 bits, niveaux de gris ; 0 = sans donnée",
                    source=f"{ORTHO_SRC.name} (équipe data)", resolution="source 25 cm/px ; moyenne à 1,5 m/px",
                    nodata_pct=round(float(100 * (png == 0).mean()), 2))


def corridor():
    path, _ = load_route()
    zone = LineString(path).buffer(CORRIDOR_HALF_WIDTH_M)
    l, b, r, t = zone.bounds
    l, b, r, t = np.floor(l), np.floor(b), np.ceil(r), np.ceil(t)
    w, h = int(r - l), int(t - b)
    tr = from_origin(l, t, CORRIDOR_RES_M, CORRIDOR_RES_M)
    z = np.full((h, w), np.nan, dtype="float32")
    with rasterio.open(C.DTM_SRC) as src:
        reproject(rasterio.band(src, 1), z, src_nodata=src.nodata, dst_nodata=np.nan,
                  dst_transform=tr, dst_crs=LOCAL, resampling=Resampling.bilinear)
    cx = l + (np.arange(w) + 0.5) * CORRIDOR_RES_M
    cy = t - (np.arange(h) + 0.5) * CORRIDOR_RES_M
    gx, gy = np.meshgrid(cx, cy)
    z[~contains_xy(zone, gx, gy)] = np.nan
    z.astype("<f4").tofile(OUT_DIR / "corridor_1m.f32")
    return describe("corridor_1m.f32", float(l), float(t), CORRIDOR_RES_M, w, h, dtype="float32", nodata="NaN (hors du couloir)",
                    source=f"{C.DTM_SRC.name} (équipe data)", resolution="1 m (source), interpolation bilinéaire",
                    note=f"couloir de ±{CORRIDOR_HALF_WIDTH_M:.0f} m autour du tracé de référence (route_aller.geojson)")


def horizon(x0, y_top, width_m, height_m, hirise_5m: Raster):
    l = np.floor((x0 - HORIZON_PAD_M) / HORIZON_RES_M) * HORIZON_RES_M
    t = np.ceil((y_top + HORIZON_PAD_M) / HORIZON_RES_M) * HORIZON_RES_M
    w = int(np.ceil((x0 + width_m + HORIZON_PAD_M - l) / HORIZON_RES_M))
    h = int(np.ceil((t - (y_top - height_m - HORIZON_PAD_M)) / HORIZON_RES_M))
    z = np.full((h, w), np.nan, dtype="float32")
    with rasterio.open(CTX_DTM_SRC) as src:
        reproject(rasterio.band(src, 1), z, src_nodata=src.nodata, dst_nodata=np.nan,
                  dst_transform=from_origin(l, t, HORIZON_RES_M, HORIZON_RES_M), dst_crs=LOCAL, resampling=Resampling.average)
        # Alignement vertical : médiane de (HiRISE 5 m − CTX) sur l'emprise des grilles 5 m
        ctx5 = np.full(hirise_5m.a.shape, np.nan, dtype="float32")
        reproject(rasterio.band(src, 1), ctx5, src_nodata=src.nodata, dst_nodata=np.nan,
                  dst_transform=hirise_5m.transform, dst_crs=LOCAL, resampling=Resampling.bilinear)
    offset = float(np.nanmedian(hirise_5m.a - ctx5))
    z += offset
    z.astype("<f4").tofile(OUT_DIR / "horizon_ctx.f32")
    return describe("horizon_ctx.f32", float(l), float(t), HORIZON_RES_M, w, h, dtype="float32", nodata="NaN",
                    source=f"{CTX_DTM_SRC.name} (USGS, SIM 3464, équipe data)",
                    resolution="20 m (source), moyenne à 100 m",
                    vertical_offset_m=round(offset, 2),
                    note="décalage ajouté au CTX = médiane (HiRISE 5 m − CTX) sur l'emprise des grilles 5 m")


def export(grid_transform, w, h, hirise_5m: Raster) -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    x0, y_top, cell = grid_transform.c, grid_transform.f, grid_transform.a
    width_m, height_m = w * cell, h * cell
    out = {
        "ortho": ortho(x0, y_top, width_m, height_m),
        "corridor": corridor(),
        "horizon": horizon(x0, y_top, width_m, height_m, hirise_5m),
    }
    for k, d in out.items():
        size = (OUT_DIR / d["file"]).stat().st_size / 1e6
        print(f"  scène · {k:8s} {d['width']}×{d['height']} à {d['cell_m']} m · {size:.1f} Mo"
              + (f" · décalage vertical {d['vertical_offset_m']} m" if "vertical_offset_m" in d else ""))
    return out
