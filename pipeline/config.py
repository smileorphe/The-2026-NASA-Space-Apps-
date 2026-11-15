"""Paramètres communs de la chaîne de traitement EVA Planner.

Les données sources (dossier nasa/) ne sont jamais modifiées : tout est lu en lecture seule
et les sorties vont dans pipeline/output/ (intermédiaires) et frontend/public/ (produits affichés).
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NASA = ROOT / "nasa" / "data"
OUT = ROOT / "pipeline" / "output"
FRONT_DATA = ROOT / "frontend" / "public" / "data"
FRONT_TILES = ROOT / "frontend" / "public" / "tiles"

# --- Sources (équipe data) ---------------------------------------------------------------
DTM_SRC = NASA / "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
ROI_CRISM = NASA / "data_roi" / "marginal_region_040ff.shp"
GEOLOGY_GDB = NASA / "sim3464_JezeroNili_FINAL" / "Geodatabase" / "Nili.gdb"

# --- Zone de travail : zone de l'équipe data (lon/lat Mars 2000) -------------------------------
ZONE = (77.337468, 18.52028, 77.388079, 18.570892)  # lon min, lat min, lon max, lat max

# --- Repères ---------------------------------------------------------------------------------
MARS_RADIUS_M = 3_396_190
LONLAT = "+proj=longlat +R=3396190 +no_defs"  # Mars 2000 géographique (EPSG:104905)
# Projection locale à pixels carrés : équirectangulaire tangente à la latitude de la zone
LOCAL = "+proj=eqc +lat_ts=18.55 +lat_0=0 +lon_0=77.36 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs"
RES_M = 5.0  # résolution de travail (m)

# --- Pentes (seuils appliqués partout : carte, segments, tuiles) --------------------------------
SLOPE_CLASSES = [  # borne supérieure incluse, couleur RGBA des tuiles
    (10.0, "≤ 10°", (31, 196, 143, 0)),  # transparent sur les tuiles : seules les pentes > 10° sont teintées
    (15.0, "10–15°", (242, 194, 48, 170)),
    (20.0, "15–20°", (242, 138, 46, 185)),
    (999.0, "> 20°", (244, 96, 90, 200)),
]
SLOPE_MAX_DEG = 20.0  # au-delà : interdit (itinéraires, zone de retour)

# --- Carte de coût ------------------------------------------------------------------------
ALPHA_PER_DEG = 0.1  # coût = (1 + α·pente[°]) × facteur sable ; coût 1 = 1 m de terrain plat
SAND_FACTOR = 2.0  # polygones « Majority sand » de marginal_region_040ff

# --- Paramètres nominaux de la sortie (valeurs par défaut du front-end, via route_analysis.json) ----
# Durée d'un segment = longueur équivalente en coût ÷ vitesse. Retour = itinéraire de moindre coût B → A.
SPEED_KMH = 3.3
OBSERVATION_MIN = 15
RESERVE_MIN = 20
# Autonomie réglée pour une marge nominale ≈ 30 min (route_analysis.py affiche la marge obtenue
# et avertit si elle s'écarte de TARGET_MARGIN_MIN de plus de 5 min).
AUTONOMY_MIN = 145
TARGET_MARGIN_MIN = 30
