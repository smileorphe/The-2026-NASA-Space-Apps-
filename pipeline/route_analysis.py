"""P1 — Analyse du tracé sur l'extrait DTM à 5 m, au format FRONTEND_SPEC §6 enrichi des durées.

Entrée : frontend/public/data/route_aller.geojson et route_detour.geojson.
Sortie : frontend/public/data/route_analysis.json.

Définitions :
- distance : longueur du tracé dans la projection locale à pixels carrés (mètres réels) ;
- profil : altitude interpolée (bilinéaire) tous les 10 m ; dénivelé : cumul sur un profil tous les 5 m ;
- pente d'un segment : MAXIMUM de la pente du terrain le long du segment (échantillonnée tous les mètres) ;
- coût d'un segment : longueur équivalente (m de plat), carte de coût de terrain.py, échantillonnée tous les mètres ;
- durée = coût ÷ vitesse. Le front-end recalcule les durées pour la vitesse choisie à partir des `cost_m` ;
- retour : itinéraire de moindre coût B → A (skimage.graph.route_through_array) ; son coût est le coût cumulé
  sur la grille, le même que celui de la zone de retour (paths.py).
Code de sortie 1 si une pente dépasse config.SLOPE_MAX_DEG.
"""
import json
import sys
from datetime import date

import numpy as np

import config as C
from terrain import Terrain, densify, load_detour, load_route, m_per_min, to_lonlat

SEGMENT_IDS = ["A", "W1", "W2", "W3", "B"]


def minutes(cost_m: float) -> float:
    return round(cost_m / m_per_min(C.SPEED_KMH), 1)


def return_route(t: Terrain, b, a):
    """Moindre coût B → A : géométrie simplifiée et coût cumulé sur la grille (m de plat)."""
    from skimage.graph import route_through_array

    idx, grid_cost = route_through_array(t.cost, t.cell(*b), t.cell(*a), fully_connected=True, geometric=True)
    coords = t.least_cost(b, a)
    return coords, float(grid_cost * C.RES_M)


def nominal(aller_cost, retour_cost):
    aller, retour = aller_cost / m_per_min(C.SPEED_KMH), retour_cost / m_per_min(C.SPEED_KMH)
    margin = C.AUTONOMY_MIN - (aller + C.OBSERVATION_MIN + retour)
    return {"aller_min": round(aller, 1), "observation_min": C.OBSERVATION_MIN, "retour_min": round(retour, 1),
            "margin_min": round(margin, 1)}


def main():
    t = Terrain()
    path, pts = load_route()
    summary = t.analyse(path)

    x10, y10, d10 = densify(path, 10.0)
    profile = [{"d": round(float(d), 1), "z": round(float(z), 1)} for d, z in zip(d10, t.dtm.sample(x10, y10))]

    segments = []
    for a, b in zip(SEGMENT_IDS, SEGMENT_IDS[1:]):
        p0, p1 = pts[a], pts[b]
        xs, ys, ds = densify([p0, p1], 1.0)
        cost, _ = t.along([p0, p1])
        segments.append({"from": a, "to": b, "length_m": round(float(ds[-1]), 1),
                         "slope_deg": round(float(np.nanmax(t.slope.sample(xs, ys))), 1),
                         "cost_m": round(cost, 1), "duration_min": minutes(cost)})
    aller_cost = sum(s["cost_m"] for s in segments)

    back, back_cost = return_route(t, pts["B"], pts["A"])
    detour = load_detour()
    detour_cost, _ = t.along(detour)
    nom = nominal(aller_cost, back_cost)

    out = {
        **summary, "profile": profile, "segments": segments,
        "aller": {"cost_m": round(aller_cost, 1), "duration_min": minutes(aller_cost)},
        "return": {"cost_m": round(back_cost, 1), "duration_min": minutes(back_cost), **t.analyse(back),
                   "coordinates": to_lonlat(back)},
        "detour": {"cost_m": round(detour_cost, 1), "duration_min": minutes(detour_cost), **t.analyse(detour)},
        "defaults": {"autonomy_min": C.AUTONOMY_MIN, "speed_kmh": C.SPEED_KMH,
                     "observation_min": C.OBSERVATION_MIN, "reserve_min": C.RESERVE_MIN},
        "nominal": nom,
        "method": {
            "source": "DTM HiRISE 1 m (JEZ_hirise_soc_006, équipe data) → extrait reprojeté, moyenne à 5 m",
            "projection": C.LOCAL,
            "slope": "pente du terrain (différences centrées sur 5 m) ; pente d'un segment = maximum le long du segment",
            "cost": f"(1 + {C.ALPHA_PER_DEG} × pente°) × {C.SAND_FACTOR} dans le sable CRISM ; pentes > {C.SLOPE_MAX_DEG:.0f}° interdites ; coût 1 = 1 m de plat",
            "duration": "coût ÷ vitesse (m/min) ; durées indiquées pour la vitesse par défaut",
            "return": "itinéraire de moindre coût B → A (route_through_array, coût cumulé sur la grille)",
            "generated": date.today().isoformat(),
        },
    }
    (C.FRONT_DATA / "route_analysis.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")

    print(f"Analyse : {summary['distance_m']:.0f} m · +{summary['elevation_gain_m']:.0f} / −{summary['elevation_loss_m']:.0f} m · "
          f"pente max {summary['max_slope_deg']:.1f}°")
    for s in segments:
        print(f"  {s['from']} → {s['to']} : {s['length_m']:.0f} m · pente max {s['slope_deg']:.1f}° · coût {s['cost_m']:.0f} m · {s['duration_min']:.1f} min")
    print(f"  retour B → A (moindre coût) : {out['return']['distance_m']:.0f} m · coût {back_cost:.0f} m · {nom['retour_min']:.1f} min")
    print(f"Nominal ({C.SPEED_KMH} km/h) : marge = {C.AUTONOMY_MIN} − ({nom['aller_min']} + {C.OBSERVATION_MIN} + {nom['retour_min']}) = {nom['margin_min']} min")

    errors = [s for s in segments if s["slope_deg"] > C.SLOPE_MAX_DEG or not np.isfinite(s["cost_m"])]
    if errors:
        print(f"ERREUR : segment(s) au-delà de {C.SLOPE_MAX_DEG:.0f}° : {[(s['from'], s['to']) for s in errors]}")
        sys.exit(1)
    if not any(10 < s["slope_deg"] <= C.SLOPE_MAX_DEG for s in segments):
        print("Avertissement : aucun segment entre 10 et 20° (exigence de la démo).")
    if abs(nom["margin_min"] - C.TARGET_MARGIN_MIN) > 5:
        best = round((nom["aller_min"] + C.OBSERVATION_MIN + nom["retour_min"] + C.TARGET_MARGIN_MIN) / 5) * 5
        print(f"Avertissement : marge nominale {nom['margin_min']} min ; régler config.AUTONOMY_MIN ≈ {best} min.")


if __name__ == "__main__":
    main()
