"""Chaîne complète, dans l'ordre. Usage : python run_all.py (depuis pipeline/)."""
import dtm
import paths
import route
import route_analysis
import slope_tiles
import vectors

if __name__ == "__main__":
    dtm.main()  # P1 : extrait DTM 5 m + pente
    vectors.main()  # P3/P4 : sable CRISM, emprise CRISM, géologie
    route.main()  # P0 : tracé A–B et détour (GeoJSON)
    route_analysis.main()  # P1 : route_analysis.json (échoue si pente > 20°)
    slope_tiles.main()  # P2 : tuiles de pente
    paths.main()  # P5 : itinéraires calculés + zone de retour
