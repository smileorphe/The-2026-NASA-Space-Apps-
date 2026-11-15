"""P3 / P4 — Vecteurs exportés en GeoJSON lon/lat Mars 2000 pour le front-end.

- crism_regions.geojson : régions de marginal_region_040ff (sphère CRISM 3 394 840 m convertie en lon/lat : les
  angles planétocentriques sont conservés), avec la légende de Zastrow & Glotch 2021 (voir CRISM_LEGEND).
- crism_footprint_040ff.geojson : contour de la zone couverte par les polygones 040ff (sans classe).
- geology.geojson : unités géologiques, éléments linéaires et ellipse Mars 2020 (USGS SIM 3464), découpés sur la zone.
"""
import json
import os

os.environ["GDAL_PAM_ENABLED"] = "NO"

import pyogrio
import shapely
from shapely.geometry import box, mapping
from shapely.ops import transform as shp_transform, unary_union
from pyproj import CRS, Transformer

import config as C

LONLAT = CRS.from_proj4(C.LONLAT)
LOCAL = CRS.from_proj4(C.LOCAL)
ROUND = 7  # ≈ 6 mm


def read_layer(path, layer=None, to=LONLAT):
    meta, _, geoms, fields = pyogrio.raw.read(str(path), layer=layer)
    t = Transformer.from_crs(CRS(meta["crs"]), to, always_xy=True)
    attrs = dict(zip(meta["fields"], fields))
    return [shp_transform(t.transform, shapely.from_wkb(g)) for g in geoms], attrs


def zone_box(pad_deg=0.002):
    l, b, r, u = C.ZONE
    return box(l - pad_deg, b - pad_deg, r + pad_deg, u + pad_deg)


def rounded(geom):
    return shapely.set_precision(geom, 10 ** -ROUND)


def feature(geom, **props):
    return {"type": "Feature", "properties": props, "geometry": mapping(rounded(geom))}


def write(filename, features, **meta):
    out = C.FRONT_DATA / filename
    out.write_text(json.dumps({"type": "FeatureCollection", **meta, "features": features}, ensure_ascii=False) + "\n")
    print(f"  {out.relative_to(C.ROOT)} : {len(features)} entités, {out.stat().st_size / 1024:.0f} Ko")


# Légende des classes de marginal_region_040ff.
# Source : Zastrow & Glotch (2021), « Distinct Carbonate Lithologies in Jezero Crater, Mars », GRL,
# doi:10.1029/2020GL092365 (PMC8243932), section sur la région d'intérêt : « Each pixel was mapped as majority
# light-toned, majority sand, or a mixture of light-toned and sand. The majority light-toned units were then split
# into the Marginal Carbonates and the Mottled Terrain […]. In the ROI, there are two other features that do not
# fall into any of these three categories. These areas have been masked out for the analysis. »
# Les sigles MT / MC ne sont pas écrits dans l'article : la correspondance repose sur ce schéma de classes,
# l'image (HRL000040FF ↔ « 040ff »), l'auteur du shapefile (azastrow) et la séparation spatiale MC / MT.
CRISM_SOURCE = "CRISM HRL000040FF, Zastrow & Glotch 2021 (GRL, doi:10.1029/2020GL092365)"
CRISM_LEGEND = {
    "Majority MC": ("MC", "Carbonates marginaux", "Marginal Carbonates"),
    "Majority MT": ("MT", "Terrain moucheté", "Mottled Terrain"),
    "Majority sand": ("sand", "Sable (majoritaire)", "majority sand"),
    "Mixture": ("mixture", "Mélange roche claire / sable", "mixture of light-toned and sand"),
    # « Other » : régions masquées dans l'étude, non exportées
}


def crism_class_polygons(cls, to=LONLAT):
    geoms, attrs = read_layer(C.ROI_CRISM, to=to)
    return unary_union([g for g, t in zip(geoms, attrs["Type"]) if t == cls])


def sand_polygons(to=LONLAT):
    geoms, attrs = read_layer(C.ROI_CRISM, to=to)
    return unary_union([g for g, t in zip(geoms, attrs["Type"]) if t == "Majority sand"])


def main():
    print("Vecteurs :")
    # --- CRISM : régions avec légende (classe « Other » masquée, comme dans l'étude)
    geoms, attrs = read_layer(C.ROI_CRISM)
    feats = []
    for cls, (code, fr, en) in CRISM_LEGEND.items():
        # Fermeture ≈ 3 m (5e-5°) : fusionne les pixels CRISM jointifs, comme pour la classe du point B (route.py)
        merged = unary_union([g for g, t in zip(geoms, attrs["Type"]) if t == cls]).buffer(5e-5).buffer(-5e-5).simplify(1e-5)
        for part in getattr(merged, "geoms", [merged]):
            feats.append(feature(part, code=code))  # libellés dans `legend`
    write("crism_regions.geojson", feats, name="crism_regions", source=CRISM_SOURCE,
          legend={code: {"label": fr, "label_en": en} for code, fr, en in CRISM_LEGEND.values()},
          note="Classes par pixel CRISM (≈ 18 m), sur la mosaïque HiRISE. Les régions « Other » (masquées dans l'étude) ne sont pas exportées.")
    # Contour extérieur seul (trous entre polygones fermés par une fermeture de ≈ 12 m, sous la taille d’un pixel CRISM), lissé à ≈ 2 m
    closed = unary_union(geoms).buffer(2e-4).buffer(-2e-4)
    footprint = unary_union([shapely.Polygon(p.exterior) for p in getattr(closed, "geoms", [closed])]).simplify(3e-5)
    write("crism_footprint_040ff.geojson", [feature(footprint, label="Emprise CRISM 040ff")],
          name="crism_footprint_040ff", source="nasa/data/data_roi/marginal_region_040ff.shp (contour, sans classes)")

    # --- Géologie USGS SIM 3464, découpée sur la zone
    clip = zone_box()
    feats = []
    units, ua = read_layer(C.GEOLOGY_GDB, "GeoUnits_v1")
    for g, sym, name in zip(units, ua["symbol"], ua["name"]):
        if g.intersects(clip):
            name = "Crater rim unit" if name == "Crater riim unit" else name  # coquille de la source
            feats.append(feature(g.intersection(clip).simplify(2e-5), kind="unit", symbol=sym, name=name))
    lines, la = read_layer(C.GEOLOGY_GDB, "LinearFeatures")
    for g, t in zip(lines, la["TYPE"]):
        if g.intersects(clip):
            feats.append(feature(g.intersection(clip).simplify(1e-5), kind="line", type=t))
    ell, _ = read_layer(C.GEOLOGY_GDB, "LandingEllipse")
    feats.append(feature(ell[0].boundary.simplify(1e-5), kind="ellipse", name="Ellipse d'atterrissage Mars 2020"))
    write("geology.geojson", feats, name="geology",
          source="USGS SIM 3464 (Nili.gdb : GeoUnits_v1, LinearFeatures, LandingEllipse), échelle 1:75 000")


if __name__ == "__main__":
    main()
