"""Météo (MEDA, Jezero) et radiations (RAD, Gale) : lecture des résumés et critères GO / NO-GO.

Les résumés sont produits par scripts/fetch_meda.py et scripts/fetch_rad.py.
Les seuils sont des paramètres de simulation (config.py), pas des normes NASA.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import config


def _load(path: Path) -> dict | None:
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def weather() -> dict | None:
    data = _load(config.METEO_SUMMARY)
    if data is None:
        return None
    win = data.get("creneau_eva", {})
    wind_max = win.get("vent_m_s_max")
    t_min = data.get("air_temp_c", {}).get("min")
    reasons, status = [], "vert"
    if wind_max is not None and wind_max >= config.WIND_NOGO_MS:
        status = "rouge"
        reasons.append(f"Vent jusqu'à {wind_max} m/s pendant le créneau (seuil {config.WIND_NOGO_MS} m/s).")
    elif wind_max is not None and wind_max >= config.WIND_CAUTION_MS:
        status = "orange"
        reasons.append(f"Vent jusqu'à {wind_max} m/s pendant le créneau (attention dès {config.WIND_CAUTION_MS} m/s).")
    if t_min is not None and t_min < config.AIR_TEMP_MIN_C:
        status = "rouge"
        reasons.append(f"Température minimale {t_min} °C sous la limite simulée de {config.AIR_TEMP_MIN_C} °C.")
    if not reasons:
        reasons.append("Conditions compatibles avec la sortie pendant le créneau.")
    out = dict(data)
    out.pop("horaire", None)
    out["go_no_go"] = {"statut": status, "raisons": reasons, "seuils_simules": True}
    return out


def weather_hourly() -> dict | None:
    data = _load(config.METEO_SUMMARY)
    if data is None:
        return None
    return {"sol": data.get("sol"), "horaire": data.get("horaire", []), "source": data.get("source")}


def radiation() -> dict | None:
    return _load(config.RAD_SUMMARY)


def eva_dose(duration_min: float) -> dict | None:
    """Dose estimée d'une sortie = débit moyen mesuré × durée hors habitat."""
    rad = radiation()
    if rad is None:
        return None
    if duration_min < 0:
        raise ValueError("La durée ne peut pas être négative")
    rate = rad["debit_dose_tissu_uGy_h"]["moyenne"]
    q = rad["facteur_qualite"]
    hours = duration_min / 60.0
    dose_ugy = rate * hours
    dose_usv = dose_ugy * q
    return {
        "duree_min": round(duration_min, 1),
        "debit_uGy_h": rate,
        "dose_absorbee_uGy": round(dose_ugy, 2),
        "dose_equivalente_uSv": round(dose_usv, 2),
        "part_limite_carriere_pct": round(dose_usv / 1000.0 / config.CAREER_LIMIT_MSV * 100, 5),
        "limite_carriere_mSv": config.CAREER_LIMIT_MSV,
        "limite_source": "NASA-STD-3001 Vol. 1 (2022), donnée comme repère",
        "statut": "vert",
        "message": "Dose de fond attendue, sans événement solaire. En cas d'alerte de particules "
                   "solaires (imprévu DONKI), retour immédiat à l'abri.",
        "lieu_mesure": rad.get("lieu_mesure"),
        "avertissement": rad.get("avertissement"),
        "simulated": True,
    }
