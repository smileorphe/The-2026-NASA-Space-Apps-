"""Paramètres centralisés du backend EVA Planner.

Toutes les valeurs de simulation (vitesse, autonomie, seuils) sont ici, pour que
la même formule soit utilisée partout (règle du guide d'architecture, section 5).
Chaque valeur peut être surchargée par une variable d'environnement EVA_<NOM>.
"""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent          # dossier nasa/
DATA_DIR = PROJECT_DIR / "data"           # données NASA brutes
BACKEND_DATA = BACKEND_DIR / "data"       # tracé, sources, incidents


def _env(name: str, default):
    raw = os.environ.get(f"EVA_{name}")
    if raw is None:
        return default
    return type(default)(raw)


# --- Données -----------------------------------------------------------------
DTM_PATH = Path(_env("DTM_PATH", str(
    DATA_DIR / "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
)))
ROI_PATH = Path(_env("ROI_PATH", str(DATA_DIR / "data_roi" / "marginal_region_040ff.shp")))
ROUTE_PATH = Path(_env("ROUTE_PATH", str(BACKEND_DATA / "route.geojson")))
SOURCES_PATH = BACKEND_DATA / "sources.json"
INCIDENTS_DIR = BACKEND_DATA / "incidents"
MINERALS_NC = Path(_env("MINERALS_NC", str(
    DATA_DIR / "data_models" / "040ff_2cuts_final_standard_tomurray.nc"
)))
METEO_SUMMARY = BACKEND_DATA / "meteo" / "meda_summary.json"
RAD_SUMMARY = BACKEND_DATA / "radiation" / "rad_summary.json"

# --- Géodésie Mars -----------------------------------------------------------
# Sphère Mars 2000 IAU, utilisée par le DTM HiRISE (Equirectangular, lat_ts=0, lon0=0).
MARS_RADIUS_DTM = 3396190.0
# Sphère utilisée par les produits CRISM / ROI Zastrow & Glotch (CRISM_LAT_15_0).
MARS_RADIUS_CRISM = 3394839.813316312
CRISM_STD_PARALLEL_DEG = 15.0

# Zone de travail 3x3 km centrée sur la ROI carbonates (en mètres, projection du DTM).
ZONE_BBOX_M = (4584155.0, 1097784.0, 4587155.0, 1100784.0)

# --- Calcul d'itinéraire -----------------------------------------------------
SAMPLE_STEP_M = _env("SAMPLE_STEP_M", 2.0)     # pas d'échantillonnage du DTM le long du tracé
SLOPE_WINDOW_M = _env("SLOPE_WINDOW_M", 10.0)  # fenêtre de calcul de pente (lisse le bruit pixel)
GAIN_THRESHOLD_M = _env("GAIN_THRESHOLD_M", 0.5)  # hystérésis pour le cumul de dénivelé positif

# Seuils de pente (degrés) — paramètres de simulation, pas des normes NASA.
SLOPE_CAUTION_DEG = _env("SLOPE_CAUTION_DEG", 10.0)
SLOPE_HARD_DEG = _env("SLOPE_HARD_DEG", 15.0)
SLOPE_MAX_DEG = _env("SLOPE_MAX_DEG", 20.0)

# --- Autonomie simulée -------------------------------------------------------
WALK_SPEED_KMH = _env("WALK_SPEED_KMH", 2.5)
AUTONOMY_MIN = _env("AUTONOMY_MIN", 120.0)
RESERVE_MIN = _env("RESERVE_MIN", 20.0)
CAUTION_BUFFER_MIN = _env("CAUTION_BUFFER_MIN", 15.0)  # orange si marge < réserve + ce tampon

# --- Minéralogie (cartes d'abondance Zastrow & Glotch 2021) ------------------
# Seuil de démonstration pour annoncer « signature compatible avec des carbonates » au point B,
# appliqué à la moyenne 3x3 pixels (≈ 108 m) pour tolérer un petit décalage de recalage.
# Repère : médiane de la zone ≈ 14 %, 90e percentile ≈ 31 %.
CARBONATE_MIN_PCT = _env("CARBONATE_MIN_PCT", 20.0)

# --- Météo et radiations (seuils de simulation, pas des normes NASA) ---------
WIND_CAUTION_MS = _env("WIND_CAUTION_MS", 15.0)
WIND_NOGO_MS = _env("WIND_NOGO_MS", 25.0)
AIR_TEMP_MIN_C = _env("AIR_TEMP_MIN_C", -90.0)   # en dessous : NO-GO (limite de combinaison simulée)
# Limite de carrière NASA (NASA-STD-3001 Vol. 1, rév. 2022) : 600 mSv, donnée comme repère.
CAREER_LIMIT_MSV = 600.0

# --- API ---------------------------------------------------------------------
CORS_ORIGINS = [o.strip() for o in _env(
    "CORS_ORIGINS", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173"
).split(",") if o.strip()]
