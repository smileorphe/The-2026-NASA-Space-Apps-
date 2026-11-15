"""P0 — Tracé de démonstration : A, W1–W3 et B, définis dans le repère local (mètres) puis exportés
en GeoJSON lon/lat Mars 2000 (spec §6). Les contraintes de pente sont vérifiées par route_analysis.py.

Choix (zone de l'équipe data, voir pipeline/README.md) :
- A, habitat, sur le dessus plat du lobe de delta (unité NHjf2) ;
- W1 sur le front du lobe ; A → W1 est le segment 10–20° de la démo ;
- B dans une région « Marginal Carbonates » (MC) de Zastrow & Glotch 2021, sur l'unité gravée supérieure (Nue),
  à ≈ 45 m du bord de la région et hors sable. La classe de B est lue dans les polygones, jamais saisie à la main.
"""
import json

from pyproj import CRS, Transformer
from shapely.geometry import Point

import config as C
import vectors as V

WAYPOINTS = [  # (id, nom, x, y) en mètres, repère config.LOCAL
    ("A", "Habitat", -200.0, 1097850.0),
    ("W1", "W1 · front du lobe", -360.0, 1098340.0),
    ("W2", "W2", -380.0, 1098820.0),
    ("W3", "W3", -175.0, 1099250.0),
    ("B", "Point B · affleurement carbonaté", -145.0, 1099733.0),
]
# L'obstacle n'est plus prédéfini : il est placé pendant la sortie et contourné par A* (frontend/src/domain/obstacle.ts).


def main():
    to_ll = Transformer.from_crs(CRS.from_proj4(C.LOCAL), CRS.from_proj4(C.LONLAT), always_xy=True)
    ll = lambda x, y: [round(v, 7) for v in to_ll.transform(x, y)]

    units, ua = V.read_layer(C.GEOLOGY_GDB, "GeoUnits_v1", to=CRS.from_proj4(C.LOCAL))
    # Fermeture de 3 m : comble les interstices entre pixels CRISM jointifs d'une même classe
    crism = {cls: V.crism_class_polygons(cls, to=CRS.from_proj4(C.LOCAL)).buffer(3).buffer(-3) for cls in V.CRISM_LEGEND}

    def crism_at(x, y):
        for cls, geom in crism.items():
            if geom.contains(Point(x, y)):
                code, fr, en = V.CRISM_LEGEND[cls]
                return {"code": code, "label": fr, "label_en": en, "source": V.CRISM_SOURCE}
        return None
    def unit_at(x, y):
        for g, sym, name in zip(units, ua["symbol"], ua["name"]):
            if g.contains(Point(x, y)):
                return {"symbol": sym, "name": name}
        return None

    note = ("Lon/lat Mars 2000 (EPSG:104905, longitudes est). Tracé de démonstration dans la zone de l'équipe data, "
            "généré par pipeline/route.py ; pentes vérifiées par pipeline/route_analysis.py.")
    features = [{"type": "Feature", "properties": {"id": "route_aller", "version": "v3-carbonates-marginaux"},
                 "geometry": {"type": "LineString", "coordinates": [ll(x, y) for _, _, x, y in WAYPOINTS]}}]
    for wid, name, x, y in WAYPOINTS:
        props = {"id": wid, "name": name, "geologic_unit": unit_at(x, y), "crism_class": crism_at(x, y)}
        features.append({"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": ll(x, y)}})
    (C.FRONT_DATA / "route_aller.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "name": "route_aller", "note": note, "features": features}, ensure_ascii=False, indent=1) + "\n")

    b = WAYPOINTS[-1]
    print(f"Tracé : {len(WAYPOINTS)} points · B : unité {unit_at(b[2], b[3])['symbol']}, classe CRISM {crism_at(b[2], b[3])}")


if __name__ == "__main__":
    main()
