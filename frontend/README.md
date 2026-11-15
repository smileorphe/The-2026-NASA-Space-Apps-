# EVA Planner — Front-end

Implémentation de [`FRONTEND_SPEC.md`](../FRONTEND_SPEC.md) : React + TypeScript + Vite, OpenLayers, Zustand.
Fond de carte : mosaïque HiRISE de Jezero servie en WMTS par NASA Mars Trek (connexion internet nécessaire).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests unitaires (domaine)
npm run build      # vérification des types + build de production
```

Pour la démo, ouvrir l’Habitat puis **Tablette** et **Casque** depuis le sélecteur de l’en-tête (nouveaux onglets du même navigateur) ; ils se synchronisent par `BroadcastChannel`.

| Route | Écran |
|---|---|
| `/habitat/preparation` | Préparation : paramètres, budget, carte, provenance |
| `/habitat/supervision` | Supervision : horloge, décisions, imprévus, journal |
| `/habitat/bilan` | Bilan + export JSON |
| `/tablette` | Carnet d’exploration (1024×768) |
| `/casque` | vue 3D du terrain + HUD (1280×720, plein écran) |

## Organisation

```
src/
  domain/            logique pure, sans React — c’est ici que se trouvent les règles
    autonomy.ts      LA formule d’autonomie, statuts, règle de refus (spec §4)
    mission.ts       état de mission, actions (réducteur), avance de l’horloge, valeurs dérivées
    geometry.ts      distances et interpolation le long d’un tracé métrique
    projection.ts    lon/lat Mars 2000 ↔ mètres dans un repère local centré sur A
    slope.ts         classes de pente (≤10 / 10–15 / 15–20 / >20°), mêmes seuils que pipeline/config.py
  data.ts            chargement de public/data/ + analyse du tracé (API, sinon route_analysis.json)
  store.ts           store Zustand, persistance localStorage, synchronisation BroadcastChannel
  format.ts          T+mm:ss, distances, durées
  map/mars.ts        projection EPSG:104905 pour OpenLayers + fabrique de couches WMTS
  components/        briques d’interface partagées (carte, graphiques, journal, étiquettes)
  habitat/ tablet/ helmet/   un dossier par mode
  styles.css         tokens de design (spec §3) + classes partagées
public/data/         produits de ../pipeline/ (tracés, analyse, sable CRISM, géologie, itinéraires, zone de retour),
                     scénarios d’imprévu, description des couches (layers.json)
  wmts/              GetCapabilities archivés (traçabilité des paramètres WMTS)
```

**Règle d’or :** un écran ne calcule jamais une marge lui-même. Il lit `useMission()` (`view.margin`, `view.status`…) ou appelle une fonction de `domain/` (`extensionMargin`, `optionMargin`, `returnMargin`). Toute nouvelle règle va dans `domain/` avec un test.

## Flux de données

1. `main.tsx` charge les données statiques (`loadMissionData`) avant le premier rendu.
2. Un écran appelle `dispatch({ type: … })`. Le réducteur pur `reduce()` (domain/mission.ts) produit le nouvel état ; il refuse lui-même toute action qui ferait passer la marge sous la réserve.
3. L’onglet **Habitat** fait avancer l’horloge (`TICK` toutes les 250 ms) et diffuse l’état complet.
   **Tablette** et **Casque** appliquent leurs actions localement et les envoient à l’Habitat, dont l’état rediffusé fait foi.
4. L’état est persisté dans `localStorage` (clé `eva-planner`) : un rechargement ne perd rien. Bouton « Réinitialiser la démo » dans la barre latérale.

## Modèle de simulation

La sortie est une suite d’étapes (`leg`) : **aller → site B → retour**, chacune avec son tracé et sa durée ; la position est interpolée dans le temps. L’autonomie restante vaut `autonomie − t`.

- Pendant l’aller : `marge = restante − (allerRestant + observation prévue + retour depuis B)`.
- Au point B : l’observation restante décroît ; une fois écoulée, la marge baisse d’une minute par minute jusqu’à l’alerte.
- Le retour suit le tracé réellement parcouru, inversé (« tracé connu »).
- À l’arrivée en B, l’horloge repasse à ×1 pour laisser le temps d’agir sur la tablette.
- Les options d’imprévu utilisent les durées de `public/data/scenarios.json`.

## Données géographiques

**Coordonnées.** Tous les fichiers de `public/data/` sont en **longitude/latitude Mars 2000** (EPSG:104905, longitudes est), comme les exports Mars Trek. Au chargement, `data.ts` les convertit en mètres dans un repère local centré sur A (`domain/projection.ts`) : toutes les distances, positions et pentes sont calculées en mètres, jamais en degrés.

**Ajouter une couche Mars Trek (WMTS).**
1. Ouvrir `<endpoint>/1.0.0/WMTSCapabilities.xml` et l’archiver dans `public/data/wmts/`.
2. Relever, sans les deviner : gabarit `ResourceURL`, `Identifier`, `TileMatrixSet`, `Format`, `Style`, `TopLeftCorner`, `TileWidth`, `MatrixWidth` du niveau 0, dernier niveau, `BoundingBox`.
3. Les reporter dans un bloc `wmts` de `layers.json` (modèle : couche `imagery`), puis ajouter la couche dans `components/MissionMap.tsx` avec `wmtsLayer()`.

Couches actuelles, de bas en haut. Relevés du 2026-11-15, vérifiés par `src/map/mars.test.ts` contre les XML archivés :

| | MOLA relief ombré (`basemap`) | CTX global beta01 (`ctx`) | HiRISE Jezero (`imagery`) |
|---|---|---|---|
| Serveur | trek.nasa.gov | astro.arcgis.com (gabarit sans `{Style}`) | trek.nasa.gov |
| Format | `image/jpeg` (`.jpg`) | `image/png`, **tuiles 512 px** | `image/png` |
| Niveaux annoncés | 0–7 | 0–11 | 0–17 |
| Niveaux utilisés | 0–7 | 0–10 | 0–15 (plafond de la vue) |

- **CRS :** EPSG:104905 pour les trois couches. **CORS :** autorisé.
- **Doublons dans les GetCapabilities :** les trois documents listent deux niveaux « 0 » et « 1 » en double, avec d’autres échelles. La grille est donc construite explicitement au lieu d’utiliser `optionsFromCapabilities` ; pour utiliser cette fonction, il faut d’abord supprimer ces doublons du XML.
- **CTX plafonné au niveau 10 :** autour de Jezero, les tuiles du niveau 11 sont tronquées côté serveur. Le défaut est reproductible : PNG incomplet servi avec un code 200. Ailleurs, ce niveau est intact.
- **Vue de la carte :** limitée à l’emprise de la mosaïque HiRISE et calée sur ses niveaux, avec un **maximum au niveau 15** (≈ 1,3 m/px). Près de A, la résolution effective mesurée des tuiles est d’environ 1–2 m/px ; les niveaux 16–17 semblent suréchantillonnés côté serveur.
- **Diagnostic :** en développement, la carte est exposée dans la console sous `window.__evaMap`.

**Cache local des tuiles (démo hors ligne).** Les tuiles sont versionnées dans `public/tiles/` (environ 9 Mo) : un simple `git clone` suffit pour que la carte fonctionne sans réseau.

| Couche | Niveaux | Zone couverte | Dossier |
|---|---|---|---|
| HiRISE | 11–15 | tracé aller + 500 m | `public/tiles/hirise/` (106 tuiles) |
| CTX | 0–10 | toute l’emprise navigable (mosaïque HiRISE) | `public/tiles/ctx/` (23 tuiles) |
| MOLA | 0–7 | toute l’emprise navigable | `public/tiles/mola/` (9 tuiles) |

```bash
npm run tiles                           # les trois couches
npm run tiles -- --layer imagery        # une seule couche : imagery | ctx | basemap
npm run tiles -- --margin 800           # autre marge autour du tracé (HiRISE)
npm run tiles -- --clean                # vide le dossier de chaque couche traitée, puis retélécharge
npm run tiles -- --layer ctx --clean    # idem pour une seule couche
```

- **Validation :** chaque tuile est **décodée** avant d’être enregistrée (PNG : blocs complets, flux zlib, pixels lus ; JPEG : décodage strict avec `jpeg-js`). Les tuiles invalides, transparentes ou uniformes sont écartées : un code HTTP 200 ne suffit jamais.
- **Reprise :** les tuiles déjà présentes et valides ne sont pas retéléchargées. Un `manifest.json` par couche indique l’emprise, la date et les comptes par niveau.
- **Anomalies connues :** elles sont déclarées dans `PLAN[].knownAnomalies` (`scripts/fetch-tiles.mjs`) et recopiées dans le champ `knownAnomalies` du manifeste, avec leur statut lors du dernier passage (`reproduite`, `non reproduite`, `autre erreur`, `non vérifiée`). Le script les affiche **en avertissement** (⚠), sans code d’erreur.
  - Aujourd’hui, une seule : CTX `1/0/2` renvoie une erreur 500 reproductible. Ce niveau n’est jamais affiché, car la vue ne descend pas en dessous du niveau 10 de CTX.
- **Code de sortie :** `npm run tiles` ne sort en erreur (code 1) que pour des tuiles invalides **inattendues**, listées (✗) et recopiées dans le champ `unexpectedFailures` du manifeste. Une anomalie connue qui échoue avec une autre erreur que celle déclarée est traitée comme inattendue.
  - Pour déclarer une nouvelle anomalie, l’ajouter à `knownAnomalies` avec la tuile (`niveau/ligne/colonne`), le message d’erreur attendu et la raison pour laquelle elle est sans effet sur la carte.

**Quand relancer `npm run tiles`, puis committer `public/tiles/` :**
- le tracé change (`route_aller.geojson`, en particulier quand le point A sera fixé au Scope & Data Gate) : la zone HiRISE en dépend ;
- un paramètre WMTS change dans `layers.json` (`url`, `layer`, niveaux, `localTiles`) ou une couche est ajoutée ;
- le plafond de zoom `MAX_VIEW_LEVEL` (`MissionMap.tsx`) ou les niveaux du script (`PLAN` dans `scripts/fetch-tiles.mjs`) changent ;
- un `manifest.json` signale des tuiles invalides (serveur indisponible au moment du téléchargement).

Sans `--clean`, le script complète le cache et garde les tuiles existantes. Il ne supprime pas celles qui ne servent plus.

Utiliser **`--clean`** quand :
- la zone rétrécit ou que des niveaux sont retirés ;
- un paramètre WMTS change (`url`, `layer`, `localTiles`) : il ne faut pas mélanger les tuiles de deux sources.

L’option ne supprime que le dossier des couches traitées (`--layer` pour en cibler une), et uniquement sous `public/tiles/`. Après `--clean`, vérifier le résumé avant de committer : une tuile qui n’a pas pu être retéléchargée manquera dans le cache.

**Bascule automatique (`src/map/mars.ts`), pour les trois couches :**
- si le serveur ne répond pas (réseau, délai de 5 s, erreur 5xx), toutes les tuiles de la couche sont lues dans le cache pendant 60 s, puis le serveur est réessayé ;
- une tuile distante isolée invalide (404, image non décodable) est remplacée par sa copie locale ;
- un bandeau sur la carte indique les couches servies par le cache.

**Vérification hors ligne :** toutes les requêtes Mars Trek bloquées (trek.nasa.gov et astro.arcgis.com), aucun pixel de fond visible dans 9 vues (zoom 11 aux quatre coins, zoom 13, zoom 15 sur A, sur B et hors zone HiRISE). Au-delà de la zone de la mission, CTX remplace HiRISE.

En développement, une tuile absente du cache est servie par Vite sous forme de page HTML (statut 200) : elle est rejetée au décodage, ce qui est normal.


**Données de mission (produites par `../pipeline/`, voir son README).** Le front-end n’affiche que ces valeurs :

| Fichier | Contenu | Utilisé par |
|---|---|---|
| `route_aller.geojson` | tracé A → W1–W3 → B (lon/lat) ; unité géologique et statut de chaque point | simulation, carte, fiche du point B |
| `route_analysis.json` | distance, dénivelé, profil, pente maximale par segment (spec §6) | caractéristiques, profils, couleurs des segments, pente courante |
| `public/tiles/slope/` | tuiles de pente (DTM 5 m) | couche « Pentes » |
| `crism_regions.geojson` | régions CRISM légendées (Zastrow & Glotch 2021) | couche « Régions CRISM », classe du point B |
| `crism_footprint_040ff.geojson` | contour de l’observation 040ff, sans classes | couche « Emprise CRISM » |
| `geology.geojson` | unités, fronts de delta, cratères, ellipse Mars 2020 (USGS SIM 3464) | couche « Géologie » |
| `routes_computed.geojson` | statistiques du tracé de mission de référence (sable) | « Comparaison des itinéraires » |
| `scenarios.json` | tempête fictive (l’obstacle est recalculé, voir plus bas) | carte « Imprévu » |

**Outils de terrain (écran Préparation).** Ils fonctionnent entièrement dans le navigateur, sur les grilles de `public/data/terrain/` chargées à la demande (≈ 4,7 Mo) :
- **Inspecteur :** au clic, il donne l’altitude, la pente, l’unité géologique, la classe CRISM, l’appartenance à la zone de retour et le temps de retour, chaque valeur avec son étiquette de provenance (`domain/inspect.ts`).
- **Choix de B :** au clic (mode « Choisir B ») ou depuis la liste des sites, il calcule l’itinéraire de moindre coût A → B avec l’A* (`domain/routing.ts`, même coût que le pipeline, testé à 1 % près) ; le retour suit le même chemin, au même coût.
  - Marge et statut passent par `domain/autonomy.ts`. Si la marge passe sous la réserve, le choix est refusé, la marge résultante est affichée et l’itinéraire apparaît en rouge.
  - Le plan accepté (`domain/plan.ts`) est stocké dans l’état de mission et partagé avec la tablette et le casque.
- **Sites candidats :** régions « Carbonates marginaux » voisines fusionnées (cellules MC à au plus une cellule d’écart), d’au moins `SITE_MIN_AREA_M2` = 5 000 m² (`domain/inspect.ts`), dans la zone de retour ; les 10 premiers par temps de retour, avec surface et marge, puis « Voir tout ».
- **Couches en direct pour le B courant :** la zone de retour est un raster calculé dans le navigateur à partir du champ de coût depuis A, au seuil courant (autonomie − réserve − (aller + observation)) ; la comparaison des itinéraires (plus court = distance seule, moindre coût) est recalculée par A*. Un test vérifie que la zone du navigateur correspond à `return_zone.geojson` du pipeline pour le B de référence (B dedans, surface à 2 % près).
- **Survol lié :** survoler le profil place un repère sur la carte, et longer le tracé sur la carte place un repère sur le profil.

- **Analyse du tracé :** `data.ts` appelle d’abord `GET ${VITE_API_URL ?? '/api'}/route/analysis` (proxy Vite vers `localhost:8000`), avec le contrat de la spec §6. S’il échoue, il lit `route_analysis.json`. Le tableau de provenance indique la source réellement utilisée.
- **Fichiers facultatifs :** les couches issues de la chaîne de traitement le sont ; si un fichier manque, la couche disparaît et l’application fonctionne avec le tracé GeoJSON seul.
- **Durées :** uniquement les coûts de `route_analysis.json` divisés par la vitesse (`domain/autonomy.ts`). Le retour depuis B suit l’itinéraire de moindre coût B → A ; les options de la tempête sont calculées à partir de ces coûts (`optionPlan`).

**Carte.** Le bouton « Plein écran » (à droite des couches) affiche la carte et sa barre de couches sur tout l’écran ; Échap ou « Quitter le plein écran » revient à la page. Disponible partout où la carte apparaît (Préparation, Supervision, Bilan).

**Supervision et bilan.**
- **Obstacle recalculé** (`domain/obstacle.ts`, remplace l’ancien détour prédéfini) : l’habitat place un obstacle d’un clic sur la carte de Supervision (« Placer un obstacle ») ; la tablette le signale à sa position simulée (« Signaler un obstacle ici »).
  - Les cellules à moins de `OBSTACLE_RADIUS_M` = 15 m (`domain/mission.ts`) sont bloquées et l’horloge se met en pause.
  - L’A* propose deux options : contourner et poursuivre vers B (retour B → A contournant aussi), ou rentrer à A. Si l’astronaute est dans la zone bloquée, l’itinéraire recule d’abord sur le trajet parcouru ; ce recul est compté.
  - Chaque option affiche sa marge ; une option sous la réserve est refusée. Tant que l’habitat n’a pas décidé, le retour par le tracé connu est bloqué (il pourrait traverser l’obstacle).
  - L’alerte s’affiche dans les trois modes, la décision est inscrite au journal et l’obstacle reste sur la carte jusqu’à la fin de la sortie.
  - Comme l’A* depuis la position courante est souvent moins coûteux que le tracé dessiné, contourner un obstacle de 15 m peut améliorer la marge : un refus n’apparaît que si la marge est déjà proche de la réserve.
- **Épingles :** chaque action de la tablette crée une épingle à la position simulée, visible dans Supervision et dans le Bilan ; un clic ouvre le détail (type, heure, texte, provenance Observé).
- **Curseur de temps** (`components/TimeCursor.tsx`, `momentAt` dans `domain/mission.ts`) : dans Supervision, position, marge, autonomie, journal, obstacles et épingles suivent l’instant choisi (« Direct » revient au présent) ; dans le Bilan, relecture complète de la sortie avec lecture automatique.
- **Texte carbonates :** affiché sur la fiche du point B et sur la tablette seulement si B est dans une région MC (`crism_class` dans `route_aller.geojson`).

**Vue 3D du casque** (`helmet/HelmetView3D.tsx`, géométrie et caméra dans `domain/scene.ts`).
- three.js (@react-three/fiber, drei) n’est chargé que sur `/casque` et dans le panneau « Vue casque » de Supervision (`React.lazy`, chunk séparé). Le panneau utilise le même composant.
- **Terrain :**
  - grille 5 m, plus le couloir DTM 1 m (±150 m autour du tracé de référence) affiché sur 300 m autour de la caméra ;
  - anneau d’horizon tiré du DTM CTX 20 m, réduit à 100 m sur ~10 km ;
  - texture : ortho HiRISE moyennée à 1,5 m, en niveaux de gris, avec une teinte de rendu.
  
  Ces fichiers sont produits par `pipeline/scene_export.py` et décrits dans `grid.json` (`datasets` : emprise, cellule, source, résolution).
- **Caméra :**
  - placée à la position simulée, 1,7 m au-dessus du sol, regard horizontal vers le prochain point, FOV 70°, synchronisée avec le store ;
  - sol sous la caméra : couloir 1 m, sinon 5 m, sinon CTX, en interpolation bilinéaire. Un test vérifie l’écart au profil de `route_analysis.json` : 0,5 m au plus (0,35 m mesuré).
- **Repères :** tracé drapé au sol, balises A, W1–W3 et B, obstacle (cylindre du rayon bloqué), contournement en jaune, retour en rouge pendant l’alerte. Aucun rocher ni détail généré.
- **Commandes :**
  - suivi automatique par défaut ; glisser la souris passe en regard libre, et la touche S ou Échap revient au suivi ;
  - « Relief ×2 » double l’exagération verticale, ce qui est signalé à l’écran (la hauteur des yeux reste 1,7 m) ;
  - la provenance des données est rappelée en bas de la vue.
- **Hors ligne :** toutes les données sont locales (`public/data/terrain/`). Aucun composant drei qui charge une ressource distante n’est utilisé : les étiquettes sont dessinées sur un canvas, sans `Text` ni `Html`.
- `npm run dev` expose `window.__eva3d` (caméra, scène, pose) pour les contrôles automatiques, comme `window.__evaMap`.

## Limites connues

- Une seule occurrence d’imprévu par sortie (réinitialiser pour rejouer).
- Vue 3D : le couloir 1 m n’existe que le long du tracé de référence ; pour un B choisi ailleurs, la vue utilise la grille 5 m. L’anneau CTX est recalé verticalement par la médiane des écarts avec le HiRISE (−3,83 m), sans correction locale.
- Si deux onglets Habitat sont ouverts, les deux font avancer l’horloge : n’en garder qu’un.
- Synchronisation limitée aux onglets d’un même navigateur (pas de réseau, conforme à la spec).
- Hors ligne, le fond de carte vient du cache local (`public/tiles/`), limité à la zone de mission pour HiRISE.
