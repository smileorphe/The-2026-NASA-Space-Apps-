"""P5 — Itinéraires calculés et zone de retour, avec la carte de coût de terrain.py.

- « plus court » (coût uniforme) et « moindre coût » A → B : skimage.graph.route_through_array ;
- zone de retour : skimage.graph.MCP_Geometric depuis A. Une cellule en fait partie si le coût du retour à A
  ≤ (autonomie − réserve − (aller + observation)) × vitesse, avec les paramètres nominaux de config.py et la durée
  aller du tracé de mission (route_analysis.json). Même coût et même vitesse que les durées du tracé.
  Cohérence : B est dans la zone si et seulement si la marge nominale ≥ réserve (vérifié ici et par les tests).

Sorties (GeoJSON lon/lat Mars 2000) : frontend/public/data/routes_computed.geojson, return_zone.geojson.
"""
import json
import sys
from datetime import date

import numpy as np
from rasterio.features import shapes
from shapely.geometry import LineString, Point, mapping, shape
from shapely.ops import transform as shp_transform
from skimage.graph import MCP_Geometric

import config as C
from terrain import Terrain, _to_lonlat, load_route, m_per_min

ll = lambda g: shp_transform(_to_lonlat.transform, g)


def main():
    t = Terrain()
    path, pts = load_route()
    analysis = json.loads((C.FRONT_DATA / "route_analysis.json").read_text())
    params = {"alpha_per_deg": C.ALPHA_PER_DEG, "sand_factor": C.SAND_FACTOR, "slope_max_deg": C.SLOPE_MAX_DEG,
              "resolution_m": C.RES_M, "generated": date.today().isoformat()}

    # --- Itinéraires A → B, évalués comme le tracé de mission (échantillonnage tous les mètres)
    features = []
    for kind, label, uniform in (("shortest", "Plus court", True), ("least_cost", "Moindre coût", False)):
        coords = t.least_cost(pts["A"], pts["B"], uniform=uniform)
        cost, sand_m = t.along(coords)
        features.append({"type": "Feature", "properties": {"id": kind, "label": label, **t.analyse(coords),
                                                           "cost": round(cost, 1), "sand_m": round(sand_m, 1)},
                         "geometry": mapping(ll(LineString(coords)))})
    m_cost, m_sand = t.along(path)
    mission = {"id": "mission", "label": "Tracé de mission", **t.analyse(path), "cost": round(m_cost, 1), "sand_m": round(m_sand, 1)}
    for p in [mission] + [f["properties"] for f in features]:
        print(f"{p['label']:16s}: {p['distance_m']:.0f} m · +{p['elevation_gain_m']:.0f}/−{p['elevation_loss_m']:.0f} m · "
              f"pente max {p['max_slope_deg']:.1f}° · sable {p['sand_m']:.0f} m · coût {p['cost']:.0f}")
    (C.FRONT_DATA / "routes_computed.geojson").write_text(json.dumps({
        "type": "FeatureCollection", "name": "routes_computed", "parameters": params, "mission": mission,
        "note": "Itinéraires calculés A → B (route_through_array). Le tracé de mission reste route_aller.geojson. "
                "Coût et sable échantillonnés tous les mètres le long de chaque tracé.",
        "features": features}, ensure_ascii=False) + "\n")

    # --- Zone de retour
    v = m_per_min(C.SPEED_KMH)
    aller_min = analysis["aller"]["cost_m"] / v
    threshold_min = C.AUTONOMY_MIN - C.RESERVE_MIN - (aller_min + C.OBSERVATION_MIN)
    threshold_m = threshold_min * v
    cum, _ = MCP_Geometric(t.cost, fully_connected=True).find_costs([t.cell(*pts["A"])])
    cum_m = cum * C.RES_M
    mask = (np.isfinite(cum_m) & (cum_m <= threshold_m) & ~t.forbidden).astype("uint8")
    polys = [shape(g) for g, val in shapes(mask, mask=mask.astype(bool), transform=t.slope.transform) if val == 1]
    zone = next(p for p in polys if p.contains(Point(pts["A"]))).simplify(C.RES_M)
    back_m = float(cum_m[t.cell(*pts["B"])])
    contains_b = bool(back_m <= threshold_m)
    margin = C.AUTONOMY_MIN - (aller_min + C.OBSERVATION_MIN + back_m / v)
    (C.FRONT_DATA / "return_zone.geojson").write_text(json.dumps({
        "type": "FeatureCollection", "name": "return_zone",
        "parameters": {**params, "autonomy_min": C.AUTONOMY_MIN, "reserve_min": C.RESERVE_MIN,
                       "observation_min": C.OBSERVATION_MIN, "speed_kmh": C.SPEED_KMH,
                       "aller_min": round(aller_min, 2), "threshold_min": round(threshold_min, 2),
                       "threshold_cost_m": round(threshold_m, 1)},
        "note": "Cellules d'où le retour à A coûte au plus (autonomie − réserve − (aller + observation)) × vitesse "
                "(MCP_Geometric, paramètres nominaux). Simulation, pas un modèle physiologique.",
        "features": [{"type": "Feature", "properties": {
            "label": "Zone de retour à pied", "area_km2": round(zone.area / 1e6, 3), "contains_B": contains_b,
            "return_cost_from_B_m": round(back_m, 1), "return_min_from_B": round(back_m / v, 2)},
            "geometry": mapping(ll(zone))}]}, ensure_ascii=False) + "\n")
    print(f"Zone de retour : seuil {threshold_min:.1f} min ≈ {threshold_m:.0f} m de plat · {zone.area / 1e6:.2f} km² · "
          f"B {'dedans' if contains_b else 'DEHORS'} (retour {back_m / v:.1f} min) · marge nominale {margin:.1f} min")

    # Cohérence zone ↔ marge (même coût, même vitesse) : B ∈ zone ⇔ marge ≥ réserve
    if contains_b != (margin >= C.RESERVE_MIN) or abs(back_m - analysis["return"]["cost_m"]) > 1:
        print("ERREUR : zone de retour incohérente avec la marge ou avec le retour de route_analysis.json")
        sys.exit(1)


if __name__ == "__main__":
    main()
