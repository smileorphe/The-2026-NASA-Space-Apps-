"""Exporte les VRAIES données de la zone pour la vue 3D Three.js (nasa/index.html).

Remplace le terrain synthétique de l'ancien prep.py. Produit, dans nasa/assets/ :
    data.json    relief (grille d'altitudes), habitat, cible, itinéraire, rochers, seuils, sources
    albedo.jpg   texture couleur : orthoimage HiRISE 25 cm teintée aux couleurs de Mars
    normal.jpg   relief fin (normal map) calculé sur le DTM 1 m
    slope.png    couche pentes (mêmes seuils que l'API)

Repère 3D (celui attendu par index.html) :
    origine = centre de la zone 3x3 km ; x = Est (m) ; z = Sud (m) ; donc le Nord est vers -z.
    y = altitude - alt0 (alt0 = -2540 m, valeur utilisée par index.html pour afficher l'altitude).
    Ligne 0 de la grille = bord nord (z = -ext/2). Images : haut = nord.

Usage (depuis backend/) :
    python scripts/export_3d.py                    # grille 1025 x 1025 (2,9 m), textures 4096 px
    python scripts/export_3d.py --grid 769 --tex 2048
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config  # noqa: E402
from app.geo import densify, lonlat_to_dtm  # noqa: E402
from app.route import Route  # noqa: E402

OUT = config.PROJECT_DIR / "assets"
ORTHO_PATH = config.DATA_DIR / "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif"
ALT0 = -2540.0
X0, Y0, X1, Y1 = config.ZONE_BBOX_M
EXT = X1 - X0
CX, CY = (X0 + X1) / 2, (Y0 + Y1) / 2

# Palette Mars pour teinter l'image HiRISE en niveaux de gris (ombre -> poussière claire).
# Les couleurs sont une interprétation (pas de HiRISE couleur sur la zone) : à signaler.
MARS_STOPS = [(0.0, (38, 22, 14)), (0.35, (112, 66, 40)), (0.7, (176, 116, 72)), (1.0, (232, 190, 140))]


def read_zone(path: Path, size: int, resampling) -> np.ndarray:
    with rasterio.open(path) as src:
        w = from_bounds(X0, Y0, X1, Y1, transform=src.transform)
        return src.read(1, window=w, out_shape=(size, size), resampling=resampling)


def to_local(lon, lat):
    x, y = lonlat_to_dtm(np.asarray(lon), np.asarray(lat))
    return np.asarray(x) - CX, -(np.asarray(y) - CY)


def heights(grid: int) -> tuple[np.ndarray, np.ndarray]:
    """Grille d'altitudes (grid x grid) et DTM 1 m brut, trous comblés."""
    with rasterio.open(config.DTM_PATH) as src:
        w = from_bounds(X0, Y0, X1, Y1, transform=src.transform).round_offsets().round_lengths()
        dem = src.read(1, window=w).astype("float32")
        nodata = src.nodata
    bad = (dem < -1e30) | (np.isclose(dem, nodata) if nodata is not None else False) | ~np.isfinite(dem)
    if bad.any():  # comble les trous par le plus proche voisin valide
        idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
        dem = dem[tuple(idx)]
    g = ndimage.zoom(dem, grid / dem.shape[0], order=1)[:grid, :grid]
    return g, dem


def normal_map(dem: np.ndarray, size: int) -> Image.Image:
    """Normal map en espace tangent : R = Est, G = Nord (haut de l'image), B = haut."""
    z = ndimage.uniform_filter(dem.astype("float64"), 3)
    dz_drow, dz_dcol = np.gradient(z, 1.0)          # 1 m/pixel
    dz_dx, dz_dn = dz_dcol, -dz_drow                # ligne croissante = vers le sud
    n = np.dstack([-dz_dx, -dz_dn, np.ones_like(z)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    rgb = ((n + 1) * 0.5 * 255).astype("uint8")
    return Image.fromarray(rgb, "RGB").resize((size, size), Image.BILINEAR)


def albedo(size: int) -> Image.Image:
    ortho = read_zone(ORTHO_PATH, size, Resampling.average).astype("float32")
    valid = ortho > 0
    lo, hi = np.percentile(ortho[valid], [1, 99])
    t = np.clip((ortho - lo) / max(hi - lo, 1), 0, 1)
    t[~valid] = np.median(t[valid])  # pas de trou noir là où l'ortho manque
    lut = np.zeros((256, 3), dtype="uint8")
    for i in range(256):
        u = i / 255
        for (u0, c0), (u1, c1) in zip(MARS_STOPS[:-1], MARS_STOPS[1:]):
            if u0 <= u <= u1:
                k = (u - u0) / (u1 - u0)
                lut[i] = [round(a + (b - a) * k) for a, b in zip(c0, c1)]
    return Image.fromarray(lut[(t * 255).astype("uint8")], "RGB")


def slope_overlay(dem: np.ndarray, size: int) -> Image.Image:
    z = ndimage.uniform_filter(dem.astype("float64"), 3)
    gy, gx = np.gradient(z, 1.0)
    s = np.degrees(np.arctan(np.hypot(gx, gy)))
    s = ndimage.maximum_filter(s, 3)
    rgba = np.zeros(s.shape + (4,), dtype="uint8")
    for lo, hi, col in [(0, config.SLOPE_CAUTION_DEG, (60, 200, 110, 90)),
                        (config.SLOPE_CAUTION_DEG, config.SLOPE_HARD_DEG, (240, 210, 60, 220)),
                        (config.SLOPE_HARD_DEG, config.SLOPE_MAX_DEG, (245, 130, 40, 235)),
                        (config.SLOPE_MAX_DEG, 999, (220, 40, 40, 245))]:
        rgba[(s >= lo) & (s < hi)] = col
    return Image.fromarray(rgba, "RGBA").resize((size, size), Image.NEAREST)


def detect_rocks(max_rocks: int) -> list[list[float]]:
    """Détection simple de blocs sur l'orthoimage 25 cm : un bloc éclairé laisse une ombre
    sombre et compacte. On cherche les taches sombres isolées de 0,7 à 5 m.
    Méthode approximative (à vérifier visuellement), pas un catalogue officiel de rochers."""
    with rasterio.open(ORTHO_PATH) as src:
        w = from_bounds(X0, Y0, X1, Y1, transform=src.transform).round_offsets().round_lengths()
        img = src.read(1, window=w).astype("float32")
        res = src.res[0]
    valid = img > 0
    background = ndimage.uniform_filter(img, 41)            # ~10 m
    contrast = background - img                             # positif = plus sombre que l'entourage
    sd = np.std(contrast[valid])
    mask = (contrast > 3.0 * sd) & valid
    mask = ndimage.binary_opening(mask, iterations=1)
    lab, n = ndimage.label(mask)
    if n == 0:
        return []
    idx = np.arange(1, n + 1)
    area = ndimage.sum_labels(mask, lab, idx) * res * res   # m²
    cy, cx = np.array(ndimage.center_of_mass(mask, lab, idx)).T
    diam = 2 * np.sqrt(area / math.pi)
    keep = (diam >= 0.7) & (diam <= 5.0)
    order = np.argsort(-diam[keep])[:max_rocks]
    rng = np.random.default_rng(7)
    rocks = []
    for i in np.flatnonzero(keep)[order]:
        x = X0 + (cx[i] + 0.5) * res - CX
        z = (CY - (Y1 - (cy[i] + 0.5) * res))
        # rayon du rocher ≈ moitié de l'ombre ; forme 0-2 tirée au hasard (reproductible)
        rocks.append([round(float(x), 2), round(float(z), 2), round(float(diam[i] * 0.45), 2),
                      round(float(rng.uniform(0, 2 * math.pi)), 2), int(rng.integers(0, 3))])
    return rocks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--grid", type=int, default=1025, help="points par côté de la grille de relief")
    ap.add_argument("--tex", type=int, default=4096, help="taille des textures (px)")
    ap.add_argument("--max-rocks", type=int, default=4000)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    print("Relief ...")
    g, dem = heights(args.grid)
    h = g - ALT0
    hmin, hmax = float(h.min()), float(h.max())
    u16 = np.round((h - hmin) / (hmax - hmin) * 65535).astype("<u2")

    print("Itinéraire ...")
    route = Route.load(config.ROUTE_PATH)
    pts = route.line("aller") + (route.line("retour") or [])[1:]
    lons, lats, _ = densify(pts, 10.0)
    px, pz = to_local(lons, lats)
    hx, hz = to_local(*route.habitat())
    tx, tz = to_local(*route.point_b())
    tgt_name = route.name("point_b", "Cible")

    print("Rochers (détection sur l'orthoimage) ...")
    rocks = detect_rocks(args.max_rocks)
    print(f"  {len(rocks)} rochers")

    data = {
        "ext": EXT, "grid": args.grid, "hmin": round(hmin, 3), "hmax": round(hmax, 3),
        "alt0": ALT0,
        "h16": base64.b64encode(u16.tobytes()).decode("ascii"),
        "hab": [round(float(hx), 2), round(float(hz), 2)],
        "tgt": [round(float(tx), 2), round(float(tz), 2)],
        "tgt_name": tgt_name,
        "path": [[round(float(a), 2), round(float(b), 2)] for a, b in zip(px, pz)],
        "rocks": rocks,
        "slope_thresholds_deg": [config.SLOPE_CAUTION_DEG, config.SLOPE_HARD_DEG, config.SLOPE_MAX_DEG],
        "repere": "origine = centre de la zone ; x = Est (m) ; z = Sud (m) ; y = altitude - alt0",
        "zone_bbox_dtm_m": list(config.ZONE_BBOX_M),
        "center_lonlat": [round(math.degrees(CX / config.MARS_RADIUS_DTM), 6),
                          round(math.degrees(CY / config.MARS_RADIUS_DTM), 6)],
        "sources": {
            "relief": "DTM HiRISE 1 m, mosaïque Mars 2020 TRN (USGS / NASA / UArizona)",
            "texture": "Orthoimage HiRISE 25 cm, teintée aux couleurs de Mars (interprétation)",
            "rochers": "Détection automatique simple des ombres sur l'orthoimage (approximative)",
            "itineraire": "route.geojson (tracé provisoire de l'équipe)",
        },
        "donnees_reelles": True,
    }
    (OUT / "data.json").write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    print("Textures ...")
    albedo(args.tex).save(OUT / "albedo.jpg", quality=90)
    normal_map(dem, args.tex).save(OUT / "normal.jpg", quality=92)
    slope_overlay(dem, min(args.tex, 3000)).save(OUT / "slope.png", optimize=True)

    for f in ("data.json", "albedo.jpg", "normal.jpg", "slope.png"):
        print(f"  {f:11s} {(OUT / f).stat().st_size / 1e6:6.1f} Mo")
    print(f"Relief : {hmin + ALT0:.0f} à {hmax + ALT0:.0f} m ; habitat ({hx:.0f}, {hz:.0f}) ; "
          f"cible ({tx:.0f}, {tz:.0f}) ; itinéraire {len(px)} points")
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
