"""Chargement du tracé GeoJSON prédéfini (le MVP ne calcule pas de chemin : guide, section 2)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Route:
    geojson: dict

    @classmethod
    def load(cls, path: Path) -> "Route":
        with open(path, encoding="utf-8") as f:
            gj = json.load(f)
        route = cls(gj)
        route.validate()
        return route

    def _features(self, geom_type: str, role: str | None = None):
        for f in self.geojson.get("features", []):
            if f["geometry"]["type"] != geom_type:
                continue
            if role is None or f.get("properties", {}).get("role") == role:
                yield f

    def line(self, role: str) -> list[tuple[float, float]] | None:
        f = next(self._features("LineString", role), None)
        return [tuple(c[:2]) for c in f["geometry"]["coordinates"]] if f else None

    def point_b(self) -> tuple[float, float]:
        f = next(self._features("Point", "point_b"))
        return tuple(f["geometry"]["coordinates"][:2])

    def habitat(self) -> tuple[float, float]:
        f = next(self._features("Point", "habitat"))
        return tuple(f["geometry"]["coordinates"][:2])

    def name(self, role: str, default: str = "") -> str:
        f = next(self._features("Point", role), None)
        return f.get("properties", {}).get("nom", default) if f else default

    def all_coords(self) -> list[tuple[float, float]]:
        out = []
        for f in self.geojson.get("features", []):
            g = f["geometry"]
            if g["type"] == "Point":
                out.append(tuple(g["coordinates"][:2]))
            elif g["type"] == "LineString":
                out.extend(tuple(c[:2]) for c in g["coordinates"])
        return out

    def validate(self):
        if self.geojson.get("type") != "FeatureCollection":
            raise ValueError("route.geojson doit être une FeatureCollection")
        if next(self._features("Point", "habitat"), None) is None:
            raise ValueError("route.geojson : point 'habitat' (A) manquant")
        if next(self._features("Point", "point_b"), None) is None:
            raise ValueError("route.geojson : point 'point_b' (B) manquant")
        if self.line("aller") is None:
            raise ValueError("route.geojson : LineString 'aller' manquante")
        for lon, lat in self.all_coords():
            if not (-180 <= lon <= 360 and -90 <= lat <= 90):
                raise ValueError(f"Coordonnée invalide (lon, lat) = ({lon}, {lat})")
