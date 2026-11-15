"""Cartes d'abondance minérale CRISM (Zastrow & Glotch 2021, Zenodo 4699583, data_models).

Fichier NetCDF4 géoréférencé en CRISM_LAT_15_0 (pixels de ~36 m). Variables utilisées :
    gnc  (Group, y, x)       % par groupe : Carbonate, Opal, Phyllosilicate, Pyroxene, Feldspar, Olivine, Oxide, Dust
    mnc  (Mineral, y, x)     % par minéral (21)
    meas, mod (Wavelength, y, x)  spectre mesuré et spectre modélisé
    rms  (y, x)              erreur de l'ajustement
Le fichier (≈ 650 Mo) n'est jamais chargé en entier : on lit seulement les pixels demandés.
"""
from __future__ import annotations

import math
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import config
from .geo import lonlat_to_crism

_lock = threading.Lock()  # la bibliothèque netCDF4/HDF5 n'aime pas les lectures concurrentes


class MineralMaps:
    def __init__(self, path: Path):
        import netCDF4

        self.path = path
        self.ds = netCDF4.Dataset(path)
        self.x = np.asarray(self.ds["x"][:], dtype="float64")
        self.y = np.asarray(self.ds["y"][:], dtype="float64")
        self.groups = [str(g) for g in self.ds["Group"][:]]
        self.minerals = [str(m) for m in self.ds["Mineral"][:]]
        self.wavelengths = np.asarray(self.ds["Wavelength"][:], dtype="float64")
        self.res = float(abs(self.x[1] - self.x[0]))

    def pixel(self, lon: float, lat: float) -> tuple[int, int, float]:
        """(ligne, colonne, distance au centre du pixel en m) ; ValueError si hors de la carte."""
        X, Y = lonlat_to_crism(lon, lat)
        X, Y = float(X), float(Y)
        if not (min(self.x) - self.res / 2 <= X <= max(self.x) + self.res / 2 and
                min(self.y) - self.res / 2 <= Y <= max(self.y) + self.res / 2):
            raise ValueError("Point hors de l'emprise de l'observation CRISM 040ff")
        i = int(np.argmin(np.abs(self.x - X)))
        j = int(np.argmin(np.abs(self.y - Y)))
        return j, i, math.hypot(self.x[i] - X, self.y[j] - Y)

    def _read(self, var: str, j0: int, j1: int, i0: int, i1: int) -> np.ndarray:
        with _lock:
            a = self.ds[var][..., j0:j1, i0:i1]
        return np.ma.filled(a.astype("float64"), np.nan)

    def composition(self, lon: float, lat: float) -> dict:
        j, i, d = self.pixel(lon, lat)
        g = self._read("gnc", j, j + 1, i, i + 1)[:, 0, 0]
        m = self._read("mnc", j, j + 1, i, i + 1)[:, 0, 0]
        rms = self._read("rms", j, j + 1, i, i + 1)[0, 0]
        # moyenne 3x3 (≈ 108 m) : robuste à un décalage d'un pixel
        g3 = self._read("gnc", max(0, j - 1), j + 2, max(0, i - 1), i + 2)
        with np.errstate(invalid="ignore"):
            g3m = np.nanmean(g3.reshape(g3.shape[0], -1), axis=1)
        if not np.isfinite(g).any():
            raise ValueError("Pas de donnée minérale à ce point (hors de la zone modélisée)")
        r = lambda v: None if not np.isfinite(v) else round(float(v), 1)
        return {
            "lon": lon, "lat": lat,
            "pixel": {"ligne": j, "colonne": i, "distance_centre_m": round(d, 1), "taille_m": round(self.res, 1)},
            "groupes_pct": {n: r(v) for n, v in zip(self.groups, g)},
            "groupes_pct_moyenne_3x3": {n: r(v) for n, v in zip(self.groups, g3m)},
            "mineraux_pct": {n: r(v) for n, v in zip(self.minerals, m) if np.isfinite(v) and v > 0.05},
            "erreur_ajustement_rms": None if not np.isfinite(rms) else round(float(rms), 5),
            "source": source(),
        }

    def spectrum(self, lon: float, lat: float) -> dict:
        j, i, d = self.pixel(lon, lat)
        meas = self._read("meas", j, j + 1, i, i + 1)[:, 0, 0]
        mod = self._read("mod", j, j + 1, i, i + 1)[:, 0, 0]
        order = np.argsort(self.wavelengths)
        r = lambda v: None if not np.isfinite(v) else round(float(v), 5)
        return {
            "lon": lon, "lat": lat, "pixel": {"ligne": j, "colonne": i},
            "unite_longueur_onde": "µm",
            "grandeur": "albédo de diffusion simple (SSA)",
            "longueur_onde": [round(float(w), 4) for w in self.wavelengths[order]],
            "mesure": [r(v) for v in meas[order]],
            "modele": [r(v) for v in mod[order]],
            "bandes_carbonate_um": [2.30, 2.50],
            "lecture": "Les carbonates creusent le spectre vers 2,30 et 2,50 µm. Les argiles Fe/Mg absorbent aussi "
                       "vers 2,3 µm : c'est la présence des deux creux qui oriente vers les carbonates. Ce modèle "
                       "s'arrête à 2,49 µm (bandes bruitées retirées par les auteurs) : on ne voit que le début du "
                       "creux à 2,5 µm.",
            "source": source(),
        }

    def close(self):
        self.ds.close()


def source() -> dict:
    return {
        "nom": "Cartes d'abondance par démélange spectral CRISM (observation FRT 040FF)",
        "reference": "Zastrow & Glotch (2021), Distinct Lithologies in Jezero Crater, Mars, GRL",
        "url": "https://zenodo.org/records/4699583",
        "fichier": config.MINERALS_NC.name,
    }


@lru_cache(maxsize=1)
def maps() -> MineralMaps | None:
    return MineralMaps(config.MINERALS_NC) if config.MINERALS_NC.exists() else None


@lru_cache(maxsize=1)
def confirm_maps() -> MineralMaps | None:
    p = config.MINERALS_NC_CONFIRM
    return MineralMaps(p) if p.exists() else None


def confirmation(lon: float, lat: float) -> dict | None:
    """Carbonate au même point dans une seconde observation CRISM (05c5e), si elle le couvre."""
    mm = confirm_maps()
    if mm is None:
        return None
    try:
        c = mm.composition(lon, lat)
    except ValueError:
        return None
    return {"observation": mm.path.name.split("_")[0], "carbonate_pct": c["groupes_pct"]["Carbonate"],
            "carbonate_pct_3x3": c["groupes_pct_moyenne_3x3"]["Carbonate"]}


def carbonate_check(lon: float, lat: float) -> dict:
    """Contrôle du Data Gate : carbonate ≥ seuil (moyenne 3x3) au point B."""
    mm = maps()
    if mm is None:
        return {"ok": None, "detail": f"Cartes d'abondance absentes ({config.MINERALS_NC.name}) : "
                                      "télécharger data_models.zip (Zenodo 4699583)."}
    try:
        c = mm.composition(lon, lat)
    except ValueError as e:
        return {"ok": False, "detail": f"{e} : déplacer le point B."}
    carb3 = c["groupes_pct_moyenne_3x3"]["Carbonate"]
    carb = c["groupes_pct"]["Carbonate"]
    phy = c["groupes_pct"]["Phyllosilicate"]
    ok = carb3 is not None and carb3 >= config.CARBONATE_MIN_PCT
    conf = confirmation(lon, lat)
    conf_txt = ""
    if conf and conf["carbonate_pct_3x3"] is not None:
        agree = conf["carbonate_pct_3x3"] >= config.CARBONATE_MIN_PCT
        conf_txt = (f" Confirmé par une seconde observation CRISM ({conf['observation']}) : "
                    f"{conf['carbonate_pct']} %." if agree else
                    f" Attention : la seconde observation ({conf['observation']}) ne confirme pas "
                    f"({conf['carbonate_pct']} %).")
    return {
        "ok": ok,
        "detail": (f"Carbonate au point B : {carb} % (moyenne 3×3 : {carb3} %, seuil {config.CARBONATE_MIN_PCT} %) ; "
                   f"argiles : {phy} %. " +
                   ("Signature compatible avec des carbonates." if ok else
                    "Signature carbonate insuffisante : déplacer le point B.") + conf_txt),
        "carbonate_pct": carb, "carbonate_pct_3x3": carb3, "seuil_pct": config.CARBONATE_MIN_PCT,
        "confirmation": conf,
        "source": c["source"]["reference"],
    }
