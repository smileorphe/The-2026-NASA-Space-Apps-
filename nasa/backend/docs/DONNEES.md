# EVA Planner — Formats des données et traitements

*15 novembre 2026. Complément de [DOCUMENTATION.md](../DOCUMENTATION.md).*

Pour chaque jeu de données : **d'où il vient, sous quel format il arrive, comment il est lu, ce qu'on en fait,
ce qu'on produit, comment on a vérifié le résultat, et ses limites.**

---

## Sommaire

0. [Vue d'ensemble](#0-vue-densemble)
1. [Les systèmes de coordonnées (à lire en premier)](#1-les-systèmes-de-coordonnées)
2. [Relief : DTM HiRISE 1 m](#2-relief--dtm-hirise-1-m)
3. [Image : orthomosaïque HiRISE 25 cm](#3-image--orthomosaïque-hirise-25-cm)
4. [Thermique : THEMIS IR de jour](#4-thermique--themis-ir-de-jour)
5. [Zone carbonates : shapefile ROI](#5-zone-carbonates--shapefile-roi)
6. [Minéralogie : cubes CRISM](#6-minéralogie--cubes-crism)
7. [Météo : MEDA](#7-météo--meda)
8. [Radiations : RAD](#8-radiations--rad)
9. [Météo spatiale : DONKI](#9-météo-spatiale--donki)
10. [Itinéraire : route.geojson](#10-itinéraire--routegeojson)
11. [Données présentes mais non traitées](#11-données-présentes-mais-non-traitées)
12. [Formats des fichiers produits](#12-formats-des-fichiers-produits)
13. [Outils utilisés](#13-outils-utilisés)

---

## 0. Vue d'ensemble

```
DONNÉES BRUTES (nasa/data/ + téléchargements)       TRAITEMENT (backend/scripts, app/)          PRODUITS
───────────────────────────────────────────         ─────────────────────────────────         ─────────────────────────
DTM HiRISE 1 m      GeoTIFF float32  1,8 Go  ──┬──> échantillonnage le long du tracé  ──> /route/stats (JSON)
                                               ├──> pentes + couleurs + tuiles        ──> tiles/slope/*.png
                                               └──> grille 1025² + normal map         ──> assets/data.json, normal.jpg
Ortho HiRISE 25 cm  BigTIFF uint8    6,9 Go  ──┬──> contraste + pyramide + tuiles     ──> tiles/ortho/*.png
                                               ├──> teinte martienne                  ──> assets/albedo.jpg
                                               └──> détection des ombres de blocs     ──> rochers dans data.json
THEMIS IR jour      GeoTIFF uint8    1 Mo    ────> reprojection + palette + tuiles    ──> tiles/thermal/*.png
ROI carbonates      Shapefile        186 Ko  ────> test « point B dedans ? »          ──> /gate
Cubes CRISM         ENVI float32     1,6 Go  ────> (à faire : indice carbonate)       ──> (couche minéraux)
MEDA                CSV ~1 Hz        ~50 Mo  ────> médiane, moyennes 1 min, horaire   ──> /weather (JSON)
RAD                 ASCII PDS3       ~150 Mo ────> extraction des doses               ──> /radiation (JSON, CSV)
DONKI               JSON (API)       petit   ────> sélection de l'événement           ──> /incidents (JSON)
route.geojson       GeoJSON          petit   ────> validation                         ──> /route, calculs
```

---

## 1. Les systèmes de coordonnées

C'est **la principale source d'erreurs** sur Mars : les fichiers n'utilisent ni la même projection, ni le même
rayon de la planète.

| Données | Projection | Rayon de Mars | Unité |
|---|---|---|---|
| DTM et ortho HiRISE | Equirectangulaire, parallèle standard 0°, méridien 0° | **3 396 190 m** | mètre |
| THEMIS, géologie SIM 3464 | Transverse Mercator, méridien central 77,5°E (« MTM ») | 3 396 190 m | mètre |
| ROI carbonates (CRISM) | Equirectangulaire, **parallèle standard 15°** (`CRISM_LAT_15_0`) | **3 394 839,8 m** | mètre |
| Échanges avec le front (GeoJSON) | Degrés : longitude Est, latitude planétocentrique | — | degré |

**Choix** : la projection du DTM HiRISE est la **référence**. Tout est ramené dans ce système ou converti en degrés.

**Conversions écrites à la main** dans `app/geo.py`. pyproj gère mal certains systèmes martiens ; ces formules
sont simples et vérifiées par un test :

```
HiRISE  : x = 3396190 × lon(rad)                  y = 3396190 × lat(rad)
CRISM   : x = 3394839,8 × cos(15°) × lon(rad)     y = 3394839,8 × lat(rad)
```

**Vérification** : le coin du GeoTIFF (x = 4 577 366 m) redonne bien 77,2229°E (`test_projection_dtm_coherente_avec_emprise_du_fichier`).

**Distances** : jamais en degrés. On utilise le grand cercle (haversine) sur la sphère de 3 396 190 m. À 18,5°N,
1° de longitude ne vaut que 0,95 × 1° de latitude (testé).

**Zone de travail** : 3 × 3 km, x 4 584 155 → 4 587 155 m, y 1 097 784 → 1 100 784 m
(77,3375–77,3881°E, 18,5203–18,5709°N).

---

## 2. Relief : DTM HiRISE 1 m

### Format d'arrivée

| Propriété | Valeur |
|---|---|
| Fichier | `data/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif` |
| Source | Mosaïque Mars 2020 TRN (USGS Astrogeology / NASA JPL / UArizona) |
| Format | GeoTIFF classique (en-tête `II*`), 1 bande |
| Type | **float32**, altitude en mètres (négative : Jezero est sous le niveau de référence) |
| Taille | 21 400 × 21 488 px, 1,8 Go |
| Résolution | 1 m/pixel |
| Emprise | x 4 577 366 → 4 598 766 m, y 1 085 130 → 1 106 618 m (≈ 21 × 21 km) |
| « Pas de donnée » | −3,4 × 10³⁸ |
| Sur la zone 3 × 3 km | altitudes de −2 451 à −2 322 m ; **1,35 %** de trous |

Ces informations ont été lues directement dans les balises GeoTIFF (ModelTiepoint, PixelScale, GDAL_NODATA).

### Traitement 1 : caractéristiques du tracé (`app/terrain.py`, route `/route/stats`)

1. Le tracé GeoJSON est **densifié** : un point tous les 2 m.
2. Chaque point est converti en mètres HiRISE, puis lu avec `rasterio.sample()`. **Seuls ces pixels sont lus**,
   jamais les 1,8 Go.
3. Les valeurs « pas de donnée » ou hors emprise deviennent `NaN`, puis sont **interpolées** le long du tracé.
4. Le profil est rééchantillonné **tous les 10 m**. Pente = `atan(|Δz| / Δd)`. La fenêtre de 10 m évite que le
   bruit des pixels de 1 m crée de fausses pentes.
5. Dénivelé : max − min, plus un cumul positif et négatif avec un **seuil de 0,5 m** (hystérésis anti-bruit).
6. Les tronçons ≥ 10° sont classés attention (10–15°), difficile (15–20°) ou interdit (≥ 20°).

**Vérifié par des tests synthétiques** (terrain plat, rampe exacte de 10°, trous, tracé hors DTM).

### Traitement 2 : carte des pentes (`scripts/make_tiles.py`)

1. Lecture d'une **fenêtre** de 3000 × 3000 px (la zone).
2. Trous → `NaN`, puis lissage 3 × 3, puis gradient avec `numpy.gradient` (pas de 1 m), puis pente = `atan(‖∇z‖)`.
3. **Pyramide par maximum** : en dézoomant, chaque bloc 2 × 2 garde sa pente la plus forte. Un passage
   dangereux ne disparaît pas quand on dézoome (choix de sécurité).
4. Couleurs : transparent < 10°, jaune 10–15°, orange 15–20°, rouge > 20°.
5. Découpage en tuiles 256 px, zooms 13 à 17.

**Résultat** : pente médiane 4,5° ; 0,87 % de la zone au-dessus de 20°.

### Traitement 3 : relief de la vue 3D (`scripts/export_3d.py`)

1. Fenêtre de la zone, trous **comblés par le plus proche voisin valide** (`scipy.ndimage.distance_transform_edt`).
2. Redimensionnement à **1025 × 1025** (un point tous les 2,9 m), interpolation bilinéaire.
3. Altitude − (−2540 m), puis quantification sur **16 bits** (0–65535 entre hmin et hmax), puis base64 dans
   `data.json`. Précision : environ 2 mm.
4. **Normal map** : gradient du DTM 1 m lissé, normale `(−∂z/∂x, −∂z/∂nord, 1)` normalisée, encodée en RGB,
   puis `normal.jpg`.

---

## 3. Image : orthomosaïque HiRISE 25 cm

### Format d'arrivée

| Propriété | Valeur |
|---|---|
| Fichier | `data/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif` |
| Format | **BigTIFF** (en-tête `II+`, nécessaire au-delà de 4 Go), 1 bande |
| Type | **uint8**, niveaux de gris |
| Taille | 85 600 × 85 952 px, **6,9 Go** |
| Résolution | 0,25 m/pixel |
| Projection et emprise | identiques au DTM |
| « Pas de donnée » | 0 |
| Sur la zone | 12 000 × 12 000 px ; niveaux utiles 65 → 194 (percentiles 1–99 %) |

### Traitement 1 : tuiles de fond de carte

1. Lecture de la fenêtre de la zone (144 Mo en mémoire).
2. **Étirement du contraste** : 65–194 ramené à 1–255. Le 0 reste réservé à « pas de donnée ».
3. **Pyramide par moyenne** en ignorant les 0 (8 niveaux).
4. Pour chaque tuile : calcul de la longitude et de la latitude de chaque pixel, puis position dans l'image,
   puis lecture au plus proche voisin dans le bon niveau de pyramide.
5. PNG en niveaux de gris avec transparence (alpha = 0 hors données), zooms 13 à 18 (≈ 0,3 m/px au zoom 18).

**Résultat** : 2 122 tuiles, 94 Mo. Alignement vérifié à l'œil avec la carte des pentes : les crêtes coïncident.

### Traitement 2 : texture couleur de la vue 3D

1. Lecture rééchantillonnée en **moyenne** à 4096 × 4096 px (0,73 m/px).
2. Étirement 1–99 %, puis **palette martienne** (brun foncé, ocre, beige). Il n'existe pas de HiRISE couleur sur la
   zone, donc **les couleurs sont une interprétation**.
3. Les trous prennent la valeur médiane (pas de tache noire).

Limite : les ombres déjà présentes dans la photo ne sont pas retirées (il faudrait l'angle du soleil à la prise de vue).

### Traitement 3 : détection des rochers

**Idée** : un bloc éclairé par le soleil projette une ombre **sombre et compacte**.

1. Image 25 cm de la zone, puis **fond local** = moyenne sur 41 px (≈ 10 m).
2. Contraste = fond − image. On garde les pixels plus sombres que **3 écarts-types**.
3. Nettoyage morphologique (ouverture), puis **étiquetage des taches** (`scipy.ndimage.label`).
4. Surface, puis diamètre équivalent. On garde les taches de **0,7 à 5 m**. Rayon du rocher ≈ 0,45 × diamètre de l'ombre.
5. Les 4 000 plus grosses sont gardées.

**Vérification visuelle** : la plupart des détections tombent sur de vraies ombres de blocs, avec quelques faux
positifs dans les fractures entre dalles claires. **Méthode approximative**, à présenter comme telle.

---

## 4. Thermique : THEMIS IR de jour

### Format d'arrivée

| Propriété | Valeur |
|---|---|
| Fichier | `data/sim3464_JezeroNili_FINAL/Rasters/USGS_THEMIS_IR_controlled_mosaic_oct2018/nili_THEMIS_DayIR_Controlled_oct2018.tif` |
| Source | Mars Odyssey THEMIS, mosaïque contrôlée USGS (octobre 2018) |
| Format | GeoTIFF + `.tfw`, 1 bande, **uint8** (luminosité IR, sans unité physique) |
| Taille / résolution | 565 × 594 px, **100 m/pixel** |
| Projection | Transverse Mercator, méridien 77,5°E, sphère 3 396 190 m |
| Sur la zone | ≈ 30 × 30 pixels d'origine ; niveaux 87–160 (percentiles 2–98 %) |

### Traitement (`make_tiles.py`, couche `thermal`)

1. **Reprojection** MTM → projection HiRISE avec `rasterio.warp.reproject`, sur une grille de **5 m**
   (600 × 600 px), interpolation **bilinéaire** pour éviter l'effet « gros carrés ».
2. Étirement 2–98 %, puis palette sombre → clair (bleu nuit, violet, orange, jaune pâle), opacité 170/255.
3. Tuiles zooms 13 à 16.

**Lecture** : clair = plus chaud l'après-midi (souvent sable ou poussière, faible inertie thermique) ;
sombre = plus froid (souvent roche). **Limites** : l'orientation des pentes compte aussi (une pente face au
soleil paraît chaude), et la résolution est de 100 m. C'est un indice qualitatif, pas une carte d'inertie thermique.

---

## 5. Zone carbonates : shapefile ROI

### Format d'arrivée

| Propriété | Valeur |
|---|---|
| Fichiers | `data/data_roi/marginal_region_040ff.{shp,shx,dbf,prj,cpg,sbn,sbx,shp.xml}` |
| Source | Zastrow & Glotch (2021), *Distinct Lithologies in Jezero Crater*, GRL ; Zenodo 4699583 |
| Format | **Shapefile** ESRI, type Polygon |
| Contenu | **897 polygones** = les pixels CRISM classés « carbonates marginaux » par les auteurs |
| Projection | `CRISM_LAT_15_0` (equirectangulaire, parallèle 15°, rayon 3 394 839,8 m) |
| Emprise | 77,338–77,388°E, 18,524–18,567°N (≈ 2,8 × 2,6 km) |

### Traitement (`app/gate.py`)

1. Lecture avec **geopandas** (moteur pyogrio).
2. Le point B (degrés) est converti **à la main** dans `CRISM_LAT_15_0`, avec le bon rayon.
3. Test d'inclusion avec **shapely** : `contains` sur les 897 polygones.

**Résultat** : point B **dans** la zone carbonates. La ROI a aussi servi à **placer** le point B, dans un amas dense
de pixels, à environ 1,2 km de l'habitat.

**Pas encore fait** : afficher cette zone comme couche sur la carte.

---

## 6. Minéralogie : cubes CRISM

### Qu'est-ce qu'un cube ?

CRISM est le spectromètre de la sonde MRO. Un **cube** est une pile d'images de la même zone, une par longueur d'onde :
`x (285) × y (478) × λ (244)`. Chaque pixel contient donc un **spectre**. Les carbonates s'y reconnaissent à deux
creux d'absorption, **vers 2,30 µm et 2,50 µm**.

### Format d'arrivée

| Propriété | Valeur |
|---|---|
| Fichiers | `data/data_input/*_ssa.img` (données) + `*_ssa.hdr` (description texte) |
| Source | Zastrow & Glotch (2021), Zenodo 4699583 (`data_input.zip`) |
| Observations | **040ff**, **047a3**, **05c5e** (identifiants d'observations CRISM) ; plusieurs variantes de traitement des auteurs (`td`, `ti`, `ps` dans le nom) |
| Format | **ENVI Standard** : binaire brut + en-tête texte |
| Organisation | **BSQ** (bande par bande : toute l'image de la bande 1, puis la bande 2…) |
| Type | **float32** (`data type = 4`), little-endian (`byte order = 0`) |
| Dimensions | 285 colonnes × 478 lignes × **244 bandes** (194 pour les fichiers `_2cuts`, bandes bruitées retirées) |
| Longueurs d'onde | listées dans le `.hdr`, de **2,646 µm à ≈ 1,0 µm** (ordre décroissant), pas ≈ 6,6 nm |
| Grandeur | **Albédo de diffusion simple** (SSA) : réflectance retraitée pour le démélange |
| Géoréférencement | **Absent** du `.hdr` (pas de `map info`) |
| Taille totale | 1,6 Go |

**Lecture prévue** : `spectral.open_image("x.hdr").load()` ou `numpy.fromfile` avec reshape
`(244, 478, 285)` (ordre BSQ).

### Traitement : **pas encore fait**

| Étape | Méthode | Statut |
|---|---|---|
| Indice carbonate rapide | Profondeur des bandes à 2,30 et 2,50 µm (continuum linéaire de part et d'autre) | ⏳ prêt à coder |
| Abondances | Démélange linéaire non négatif (méthode de l'article, scripts Davinci `code_unmixing/` + bibliothèque n,k HDF) | ⏳ ou directement via `data_models.zip` |
| Géoréférencement | Recaler le cube sur la ROI (même observation 040ff) | ⏳ à vérifier, indispensable |
| Produit final | Couche « minéraux » (tuiles PNG) + validation du point B dans `/gate` | ⏳ |

**Piège** : les argiles Fe/Mg absorbent aussi vers 2,3 µm. Il faut **les deux** creux (2,3 et 2,5 µm) pour parler
de carbonate. Formulation autorisée : « signature compatible avec des carbonates ».

---

## 7. Météo : MEDA

### Format d'arrivée

| Propriété | Valeur |
|---|---|
| Source | Station MEDA de **Perseverance (à Jezero)**, archive PDS4 du nœud Atmosphères (NMSU) |
| URL | `https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/` |
| Organisation | `data_calibrated_env/` et `data_derived_env/`, puis `sol_XXXX_YYYY/sol_NNNN/` |
| Format | **CSV**, un fichier par produit et par sol, + étiquette PDS4 `.xml` |
| Fréquence | ≈ 1 mesure par seconde (≈ 54 000 lignes par sol et par produit, ≈ 3–4 Mo) |
| Temps | colonnes `SCLK` (horloge sonde), `LMST` (heure solaire moyenne), `LTST` (heure solaire vraie, format `0300 07:15:42`) |
| Valeur manquante | `999999999` |
| Sols téléchargés | 300, 301, 302 (≈ 23–25 décembre 2021) |

| Produit | Colonnes utilisées | Unité |
|---|---|---|
| `CAL_ATS` | `ATS_LOCAL_TEMP1` à `5` (5 capteurs de température de l'air) | K |
| `DER_PS` | `PRESSURE` | Pa |
| `DER_WS` | `HORIZONTAL_WIND_SPEED`, `WIND_DIRECTION` | m/s, ° |
| `DER_TIRS` | `UPWARD_LW_IRRADIANCE` (infrarouge émis par le sol) | W/m² |

### Traitement (`scripts/fetch_meda.py`)

1. **Téléchargement** du CSV le plus récent (P01 < P02) de chaque produit, mis en cache dans `data/meda_raw/`.
2. Lecture ligne à ligne (module `csv`) ; les `999999999` sont ignorés ; `LTST` est converti en heure décimale.
3. **Air** : **médiane** des 5 capteurs valides (100–350 K). La médiane est robuste à un capteur chauffé par le rover.
4. **Sol** : température de brillance par la loi de Stefan-Boltzmann, `T = (L / 5,67×10⁻⁸)^¼`, émissivité supposée = 1.
5. **Vent** : **moyennes sur 1 minute** pour le « vent max » (une rafale d'une seconde n'est pas représentative) ;
   la rafale à 1 s est gardée à part.
6. **Agrégation** : min et max du sol, moyennes horaires (0–23 h LTST), statistiques du créneau de sortie
   07:00–14:00.
7. Date terrestre approximative : sol 0 = 18 février 2021, 1 sol = 1,0275 jour.

**Résultats** : air −78 à −6 °C, pression ≈ 625 Pa, vent max 10–11 m/s. Ces ordres de grandeur sont connus pour
Jezero (test de plausibilité automatique).

**Limite** : ce sont des **sols passés**, rejoués pour la démo, pas une prévision.

---

## 8. Radiations : RAD

### Format d'arrivée

| Propriété | Valeur |
|---|---|
| Source | Détecteur RAD de **Curiosity (cratère Gale, pas Jezero)**, archive PDS3 `MSL-M-RAD-3-RDR-V1.0` (nœud PPI, UCLA) |
| Organisation | `DATA/SOL_aaaaa_bbbbb/RAD_RDR_<année>_<jour>_<hh>_<mm>_<sol>_V00.TXT` + `.LBL` |
| Format | **ASCII** structuré en sections `[NOM: nn]`, décrit par une étiquette PDS3 détachée (`.LBL`) et des fichiers de format (`.FMT`) |
| Taille | ≈ 12 à 30 Mo par sol |
| Contenu | une **observation** toutes les ≈ 16 min : compteurs, histogrammes, **dosimétrie** |
| Sols téléchargés | 361 à 365 (11–16 août 2013), **364 observations valides** |

Extrait réel d'un fichier :
```
[OBSERVATION: 00]
START_OBS_UTC="2013-223 12:40:34"
...
[DOSIMETRY_TOTAL_DOSE_B: 00]
9.03778            ← débit de dose, détecteur silicium B, µGy/h
[DOSIMETRY_TOTAL_DOSE_E: 00]
8.76192            ← débit de dose, scintillateur plastique E (proche du tissu), µGy/h
```
Les unités viennent de l'étiquette `.LBL` (`UNIT = "microGray / Hour"`).

### Traitement (`scripts/fetch_rad.py`)

1. Recherche du dossier du sol, téléchargement, cache dans `data/rad_raw/`.
2. **Analyse ligne à ligne** : on suit la section courante, puis on lit `START_OBS_UTC` et la valeur sous
   `DOSIMETRY_TOTAL_DOSE_B` et `_E`.
3. Les valeurs ≤ 0 (codes −1 / −2 = pas de mesure) sont écartées.
4. Statistiques sur **E** (le plus proche du tissu humain) : moyenne, min, max, écart-type.
5. **Dose équivalente** = dose absorbée × **facteur de qualité 3,05** (valeur mesurée par RAD, Hassler et al. 2014).
6. Dose d'une sortie (`/radiation/eva`) = débit moyen × durée hors habitat.

**Résultats** : **8,76 µGy/h, soit 0,210 mGy/jour ; 0,64 mSv/jour.**

**Vérification** : ces chiffres sont **identiques** aux valeurs publiées (Hassler et al., *Science* 2014 :
0,210 ± 0,040 mGy/jour ; 0,64 ± 0,12 mSv/jour). Cela confirme qu'on lit le bon champ dans la bonne unité.

**Limites** : mesuré à Gale (ordre de grandeur pour Jezero) ; pas de modèle de dose pour un événement solaire.

---

## 9. Météo spatiale : DONKI

### Format d'arrivée

| Propriété | Valeur |
|---|---|
| Source | NASA CCMC DONKI, via `https://api.nasa.gov/DONKI/...` (clé `DEMO_KEY` ou personnelle) |
| Format | **JSON** : tableau d'événements |
| Endpoints utilisés | `SEP` (flux de particules solaires), `CME`, `notifications?type=FLR` |
| Endpoint en panne | `FLR` (éruptions) → **HTTP 404** côté NASA |
| Période | 8–15 mai 2024 (grande tempête solaire) |

Exemple de champs SEP : `sepID`, `eventTime`, `instruments[]`, `linkedEvents[]` (dont l'éruption associée), `link`.

### Traitement (`scripts/fetch_donki.py`)

1. Appel des trois endpoints. Les réponses brutes sont **mises en cache** dans `data/donki_raw/` ; une réponse vide
   (quota, erreur) n'écrase jamais un cache valide.
2. Pour chaque SEP : heure de l'éruption liée (dans `activityID`), puis classe de l'éruption la plus forte
   mentionnée dans les notifications à ± 6 h (expression régulière `[CMX]\d+(\.\d+)?`).
3. Choix du SEP lié à l'éruption la plus forte, puis fichier d'imprévu normalisé, en français, marqué
   `"simulation": true`.

**Résultat** : `solar_particles_2024-05-09` (flux du 9 mai 2024, 13:59 UTC). La classe d'éruption est vide car le
quota `DEMO_KEY` a été épuisé. Relancer avec une clé personnelle et `--refresh`.

---

## 10. Itinéraire : route.geojson

| Propriété | Valeur |
|---|---|
| Fichier | `backend/data/route.geojson` (créé par nous, **provisoire**) |
| Format | **GeoJSON** `FeatureCollection`, coordonnées `[longitude, latitude]` en degrés Mars 2000 |
| Objets obligatoires | `Point` rôle `habitat`, `Point` rôle `point_b`, `LineString` rôle `aller` ; facultatifs : `waypoint`, `retour` |

**Placement** (avec le DTM et la ROI) :
- **habitat** : zone la plus plate du quart sud-est (pente max < 4° sur 60 m) ;
- **point B** : amas dense de la ROI à ≈ 1,2 km ;
- **WP1** : déplacé par une recherche automatique, pour passer de 20,1° (interdit) à 14,4° de pente max.

**Validation** au chargement (`app/route.py`) : type, rôles obligatoires, coordonnées dans les bornes.

---

## 11. Données présentes mais non traitées

| Données | Format | Usage possible |
|---|---|---|
| Carte géologique SIM 3464 (`Nili.gdb`) | Esri File Geodatabase (unités, contacts, éléments linéaires) | Couche géologie (conversion en GeoJSON avec geopandas) |
| DTM CTX 20 m et ortho CTX 6 m | GeoTIFF + `.ovr` | Terrain autour de la zone et horizon de la vue 3D |
| DTM HRSC et ombrage | GeoTIFF + `.tfw` | Relief de contexte |
| Mosaïque CTX Caltech | GeoTIFF | Fond de carte élargi |
| Scripts de démélange + `n_k_jezeropaper.hdf` | Davinci (`.dvrc`) + HDF | Calcul des abondances CRISM (à porter en Python) |
| `PIA23179.tif` | TIFF (image presse) | Illustration seulement |
| `InSight_..._fgdc.xml` | Métadonnées FGDC | **Hors sujet** (Elysium Planitia, pas Jezero) |

---

## 12. Formats des fichiers produits

| Fichier | Format | Contenu |
|---|---|---|
| `backend/data/tiles/{ortho,slope,thermal}/{z}/{x}/{y}.png` | PNG 256 px, schéma XYZ (Web Mercator appliqué aux degrés martiens) | Tuiles de carte |
| `backend/data/tiles/metadata.json` | JSON | Emprise, centre, zooms, crédits, légende, texte de lecture |
| `nasa/assets/data.json` | JSON | `ext`, `grid`, `h16` (base64 uint16), `hmin`, `hmax`, `alt0`, `hab`, `tgt`, `path`, `rocks [x,z,rayon,rotation,forme]`, seuils, sources |
| `nasa/assets/albedo.jpg`, `normal.jpg`, `slope.png` | JPEG / PNG 4096 px | Textures 3D (haut = nord) |
| `backend/data/meteo/meda_sols_300_302.json` | JSON | Résumé par sol + 24 valeurs horaires |
| `backend/data/meteo/meda_summary.json` | JSON | Dernier sol (servi par `/weather`) |
| `backend/data/radiation/rad_dose_sols_361_365.csv` | CSV | Une ligne par observation : sol, UTC, heure Mars, dose B, dose E |
| `backend/data/radiation/rad_summary.json` | JSON | Débits moyens, facteur de qualité, sources |
| `backend/data/incidents/*.json` | JSON | Imprévus prêts à rejouer |

**Repère de la vue 3D** : origine au centre de la zone, x = Est, z = Sud (le Nord est vers −z),
y = altitude + 2540 m.

---

## 13. Outils utilisés

| Outil | Version | Rôle |
|---|---|---|
| Python | 3.14 | Langage |
| rasterio (GDAL 3.12 inclus) | 1.5.2 | Lecture des GeoTIFF par fenêtres, échantillonnage, reprojection THEMIS |
| NumPy | 2.x | Calculs sur les grilles |
| SciPy (`ndimage`) | 1.18 | Lissage, comblement des trous, étiquetage des rochers, redimensionnement |
| geopandas + pyogrio + shapely | 1.x / 2.x | Shapefile ROI, test d'inclusion |
| Pillow | 13 | Écriture des PNG / JPEG |
| FastAPI + uvicorn | — | API |
| pytest | — | 28 tests |
| Bibliothèque standard (`urllib`, `csv`, `json`, `re`) | — | Téléchargements PDS / DONKI, lecture CSV et ASCII |

Pas de GDAL en ligne de commande, pas de conda : tout passe par `pip` dans `nasa/.venv`.
