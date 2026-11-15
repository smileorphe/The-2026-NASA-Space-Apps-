# EVA Planner — Chaîne de traitement des données

Produit, à partir des données de l’équipe data (`nasa/`, **jamais modifié**), les fichiers affichés par le front-end (`frontend/public/`).

```bash
cd pipeline
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Python 3.11–3.13
.venv/bin/python run_all.py
```

Le dossier `nasa/data/` doit contenir le DTM HiRISE 1 m (`JEZ_hirise_soc_006_DTM_…_1m_….tif`, 1,8 Go, non versionné), `data_roi/marginal_region_040ff.shp` et `sim3464_JezeroNili_FINAL/`. GDAL est configuré pour ne jamais écrire de `.aux.xml` à côté des sources.

## Étapes

| Script | Rôle | Sorties |
|---|---|---|
| `dtm.py` | extrait la zone de l’équipe data du DTM, le reprojette en équirectangulaire `lat_ts=18,55°` (pixels carrés, mètres réels) et le moyenne à 5 m ; calcule la pente | `output/dtm_5m.tif`, `output/slope_5m.tif` |
| `vectors.py` | régions CRISM légendées (MC, MT, sable, mélange ; « Other » masqué comme dans l’étude), emprise CRISM 040ff, géologie USGS SIM 3464 découpée | `crism_regions.geojson`, `crism_footprint_040ff.geojson`, `geology.geojson` |
| `route.py` | tracé de démonstration A → W1–W3 → B et détour, définis en mètres, exportés en lon/lat ; unité géologique de chaque point | `route_aller.geojson`, `route_detour.geojson` |
| `route_analysis.py` | distance, dénivelé, profil, pente et coût par segment, retour de moindre coût B → A, valeurs par défaut et marge nominale ; **échoue si une pente dépasse 20°** | `route_analysis.json` |
| `slope_tiles.py` | tuiles de pente, grille géographique identique à `gdal2tiles --profile=geodetic --xyz` (niveaux 11–15) | `frontend/public/tiles/slope/` |
| `paths.py` | itinéraires « plus court » et « moindre coût » (`route_through_array`), zone de retour (`MCP_Geometric`) avec contrôle de cohérence | `routes_computed.geojson`, `return_zone.geojson` |
| `terrain.py` | outils communs : rasters, carte de coût unique, échantillonnage, moindre coût | — |
| `terrain_export.py` | grilles altitude, pente et coût de l’extrait 5 m en Float32 + `grid.json` (dimensions, origine, cellule, projection, nodata, coûts de référence pour les tests du routage TypeScript) | `frontend/public/data/terrain/` (≈ 4,7 Mo, versionné) |

Les paramètres (zone, projection, résolution, seuils de pente, α, facteur sable, budget de retour) sont dans `config.py`.

## Définitions

- **Pente du terrain** : différences centrées sur le DTM 5 m. La **pente d’un segment** est le maximum rencontré le long du segment (échantillonné tous les mètres, interpolation bilinéaire) ; c’est elle qui fixe sa couleur.
- **Classes** (identiques dans le front-end, `src/domain/slope.ts`) : ≤ 10° vert · 10–15° jaune · 15–20° orange · > 20° rouge (interdit pour les itinéraires calculés). Sur les tuiles, ≤ 10° est transparent.
- **Dénivelé** : cumul des montées / descentes sur un profil échantillonné tous les 5 m.
- **Coût** : `(1 + α · pente[°]) × facteur sable`, α = 0,1, sable × 2 ; coût 1 = 1 m de terrain plat. Les trois tracés comparés sont évalués de la même façon (échantillonnage tous les mètres).
- **Durées** : coût ÷ vitesse. Le front-end n’utilise que ces durées (`cost_m` de `route_analysis.json`) et les recalcule pour la vitesse choisie.
- **Zone de retour** : cellules d’où le retour à A coûte au plus (autonomie − réserve − (aller + observation)) × vitesse, avec les paramètres par défaut.

## Résultats actuels (2026-11-15)

- **Tracé de mission :** 1 956 m · +49 / −37 m · pente maximale 10,7° (A→W1, segment 10–20° de la démo).
- **B :** dans une région **Marginal Carbonates** (MC) de Zastrow & Glotch 2021, sur l’unité Nue.
- **Durées** (coût ÷ vitesse, 3,3 km/h) : aller 51,3 min ; retour au moindre coût B → A 47,4 min (2 067 m).
- **Marge nominale :** 145 − (51,3 + 15 + 47,4) = 31,3 min. `config.AUTONOMY_MIN` vaut 145 ; `route_analysis.py` avertit si la marge s’écarte de plus de 5 min de 30.
- **Zone de retour :** seuil = autonomie − réserve − (aller + observation) = 58,7 min ; 7,1 km² ; B dedans. `paths.py` échoue si « B dans la zone » ne coïncide pas avec « marge ≥ réserve ».

**Légende CRISM.** Source : Zastrow & Glotch 2021, GRL, doi:10.1029/2020GL092365 (PMC8243932). Passage cité : « Each pixel was mapped as majority light-toned, majority sand, or a mixture of light-toned and sand. The majority light-toned units were then split into the Marginal Carbonates and the Mottled Terrain […] two other features that do not fall into any of these three categories […] have been masked out. »

Les sigles MT et MC ne sont pas écrits dans l’article. La correspondance MC = Marginal Carbonates et MT = Mottled Terrain repose sur quatre éléments :
- le schéma de classes ;
- l’image CRISM : HRL000040FF ↔ « 040ff » ;
- l’auteur du shapefile : `azastrow` ;
- la séparation spatiale des deux classes par une droite (2 polygones sur 278 mal placés), MC du côté du rempart.

## Quand relancer

- **`run_all.py` :** quand un fichier source de `nasa/` change, ou quand `config.py` ou un point de `route.py` est modifié. Committer ensuite les fichiers régénérés de `frontend/public/data/` et `frontend/public/tiles/slope/`.
- **`npm run tiles -- --clean` (dans `frontend/`) :** quand le tracé change, car la zone HiRISE mise en cache en dépend.
