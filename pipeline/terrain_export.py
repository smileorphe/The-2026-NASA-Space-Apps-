"""Export des grilles de l'extrait 5 m pour le front-end (routage et inspecteur dans le navigateur).

Sorties dans frontend/public/data/terrain/ :
- altitude.f32, slope.f32, cost.f32 : Float32 little-endian, ligne par ligne depuis le haut (nord) ;
- grid.json : dimensions, origine, taille de cellule, projection, nodata, paramètres de coût, références.

Coût : multiplicateur par cellule, identique à terrain.py — (1 + α·pente) × facteur sable ; valeur < 0 = interdit
(pente > SLOPE_MAX_DEG ou NoData). Coût d'un pas entre deux cellules voisines (comme skimage MCP_Geometric) :
(c1 + c2) / 2 × longueur du pas (5 m ou 5√2 m). Coût d'un chemin en « m de plat ».

Les `references` (calculées ici avec skimage) servent aux tests du routage TypeScript (domain/routing.ts).
"""
import json
from datetime import date

import numpy as np
from skimage.graph import MCP_Geometric, route_through_array

import config as C
import vectors as V
from terrain import LOCAL, Terrain, load_route, to_lonlat

OUT_DIR = C.FRONT_DATA / "terrain"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    t = Terrain()
    h, w = t.cost.shape
    tr = t.slope.transform
    for name, arr in (("altitude", t.dtm.a), ("slope", t.slope.a), ("cost", t.cost)):
        arr.astype("<f4").tofile(OUT_DIR / f"{name}.f32")

    _, pts = load_route()
    a, b = t.cell(*pts["A"]), t.cell(*pts["B"])
    # Quelques points de contrôle supplémentaires : centres des grandes régions MC (cibles typiques des clics)
    mc = V.crism_class_polygons("Majority MC", to=LOCAL).buffer(3).buffer(-3)
    centers = [t.cell(*p.representative_point().coords[0]) for p in sorted(getattr(mc, "geoms", [mc]), key=lambda p: -p.area)]
    extra = [c for c in dict.fromkeys(centers) if c not in (a, b)][:3]  # trois points distincts de A et B

    def grid_cost(costs, s, e):
        _, c = route_through_array(costs, s, e, fully_connected=True, geometric=True)
        return round(float(c * C.RES_M), 2)

    cum, _ = MCP_Geometric(t.cost, fully_connected=True).find_costs([a])
    refs = {
        "cells": {"A": list(a), "B": list(b), **{f"MC{i + 1}": list(c) for i, c in enumerate(extra)}},
        "least_cost_m": [{"from": "A", "to": "B", "cost_m": grid_cost(t.cost, a, b)},
                         {"from": "B", "to": "A", "cost_m": grid_cost(t.cost, b, a)},
                         *[{"from": "A", "to": f"MC{i + 1}", "cost_m": grid_cost(t.cost, a, c)} for i, c in enumerate(extra)]],
        "shortest_m": [{"from": "A", "to": "B", "cost_m": grid_cost(t.uniform, a, b)}],
        "cost_from_A_m": {k: round(float(cum[tuple(c)] * C.RES_M), 2) for k, c in [("B", b), *[(f"MC{i + 1}", c) for i, c in enumerate(extra)]]},
        # Centres de cellules en lon/lat, pour tester la conversion lon/lat ↔ cellule
        "cell_centers_lonlat": [{"cell": [r, c], "lonlat": to_lonlat([tr * (c + 0.5, r + 0.5)])[0]}
                                for r, c in [(0, 0), (h - 1, w - 1), tuple(a), tuple(b)]],
    }
    grid = {
        "width": w, "height": h, "cell_m": C.RES_M,
        "origin": {"x": tr.c, "y": tr.f, "note": "coin haut-gauche de la cellule (0, 0), mètres en projection locale"},
        "projection": {"proj4": C.LOCAL, "type": "eqc", "lat_ts": 18.55, "lon_0": 77.36, "radius_m": C.MARS_RADIUS_M},
        "dtype": "float32", "byte_order": "little", "order": "lignes depuis le haut (nord), colonnes vers l'est",
        "files": {"altitude": "altitude.f32", "slope": "slope.f32", "cost": "cost.f32"},
        "nodata": {"altitude": "NaN", "slope": "NaN", "cost": "valeur < 0 : cellule interdite (pente > 20° ou NoData)"},
        "cost": {"alpha_per_deg": C.ALPHA_PER_DEG, "sand_factor": C.SAND_FACTOR, "slope_max_deg": C.SLOPE_MAX_DEG,
                 "step": "(c1 + c2) / 2 × longueur du pas, 8 voisins (skimage MCP_Geometric)"},
        "references": refs, "generated": date.today().isoformat(),
    }
    (OUT_DIR / "grid.json").write_text(json.dumps(grid, ensure_ascii=False, indent=1) + "\n")
    size = sum((OUT_DIR / f).stat().st_size for f in grid["files"].values()) / 1e6
    print(f"Grilles {w}×{h} à {C.RES_M} m → {OUT_DIR.relative_to(C.ROOT)} ({size:.1f} Mo) · "
          f"références : A→B {refs['least_cost_m'][0]['cost_m']} m, plus court {refs['shortest_m'][0]['cost_m']} m")


if __name__ == "__main__":
    main()
