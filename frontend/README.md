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
| `/casque` | HUD (1280×720, plein écran) |

## Organisation

```
src/
  domain/            logique pure, sans React — c’est ici que se trouvent les règles
    autonomy.ts      LA formule d’autonomie, statuts, règle de refus (spec §4)
    mission.ts       état de mission, actions (réducteur), avance de l’horloge, valeurs dérivées
    geometry.ts      distances et interpolation le long d’un tracé métrique
    projection.ts    lon/lat Mars 2000 ↔ mètres dans un repère local centré sur A
  data.ts            chargement de public/data/ + analyse du tracé (API, sinon mock)
  store.ts           store Zustand, persistance localStorage, synchronisation BroadcastChannel
  format.ts          T+mm:ss, distances, durées
  map/mars.ts        projection EPSG:104905 pour OpenLayers + fabrique de couches WMTS
  components/        briques d’interface partagées (carte, graphiques, journal, étiquettes)
  habitat/ tablet/ helmet/   un dossier par mode
  styles.css         tokens de design (spec §3) + classes partagées
public/data/         tracés GeoJSON, scénarios d’imprévu, couches (MOCK à remplacer au Data Gate)
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
| HiRISE | 11–15 | tracé aller + détour + 500 m | `public/tiles/hirise/` (106 tuiles) |
| CTX | 0–10 | toute l’emprise navigable (mosaïque HiRISE) | `public/tiles/ctx/` (23 tuiles) |
| MOLA | 0–7 | toute l’emprise navigable | `public/tiles/mola/` (9 tuiles) |

```bash
npm run tiles                           # les trois couches
npm run tiles -- --layer imagery        # une seule couche : imagery | ctx | basemap
npm run tiles -- --margin 800           # autre marge autour du tracé (HiRISE)
```

- **Validation :** chaque tuile est **décodée** avant d’être enregistrée (PNG : blocs complets, flux zlib, pixels lus ; JPEG : décodage strict avec `jpeg-js`). Les tuiles invalides, transparentes ou uniformes sont écartées : un code HTTP 200 ne suffit jamais.
- **Reprise :** les tuiles déjà présentes et valides ne sont pas retéléchargées. Un `manifest.json` par couche indique l’emprise, la date et les comptes par niveau.
- **Anomalie connue :** la tuile CTX `1/0/2` renvoie une erreur 500 de façon reproductible. Ce niveau n’est jamais affiché, car la vue ne descend pas en dessous du niveau 10 de CTX.

**Quand relancer `npm run tiles`, puis committer `public/tiles/` :**
- le tracé change (`route_aller.geojson` ou `route_detour.geojson`, en particulier quand le point A sera fixé au Scope & Data Gate) : la zone HiRISE en dépend ;
- un paramètre WMTS change dans `layers.json` (`url`, `layer`, niveaux, `localTiles`) ou une couche est ajoutée ;
- le plafond de zoom `MAX_VIEW_LEVEL` (`MissionMap.tsx`) ou les niveaux du script (`PLAN` dans `scripts/fetch-tiles.mjs`) changent ;
- un `manifest.json` signale des tuiles invalides (serveur indisponible au moment du téléchargement).

Si la zone rétrécit, supprimer d’abord le dossier de la couche concernée, car le script n’efface pas les tuiles devenues inutiles.

**Bascule automatique (`src/map/mars.ts`), pour les trois couches :**
- si le serveur ne répond pas (réseau, délai de 5 s, erreur 5xx), toutes les tuiles de la couche sont lues dans le cache pendant 60 s, puis le serveur est réessayé ;
- une tuile distante isolée invalide (404, image non décodable) est remplacée par sa copie locale ;
- un bandeau sur la carte indique les couches servies par le cache.

**Vérification hors ligne :** toutes les requêtes Mars Trek bloquées (trek.nasa.gov et astro.arcgis.com), aucun pixel de fond visible dans 9 vues (zoom 11 aux quatre coins, zoom 13, zoom 15 sur A, sur B et hors zone HiRISE). Au-delà de la zone de la mission, CTX remplace HiRISE.

En développement, une tuile absente du cache est servie par Vite sous forme de page HTML (statut 200) : elle est rejetée au décodage, ce qui est normal.


**Brancher les vraies données (après le Scope & Data Gate).**
- **Analyse du tracé :** `data.ts` appelle `GET ${VITE_API_URL ?? '/api'}/route/analysis` (proxy Vite vers `localhost:8000`) et attend le contrat de la spec §6. En cas d’échec, il utilise le mock `src/mocks/routeAnalysis.json` ; le tableau de provenance indique la source réellement utilisée.
- **Tracés :** remplacer `route_aller.geojson` et `route_detour.geojson` (lon/lat). Les points `A`, `W1`…`B` sont des `Point` avec `properties.id`. Le point A du mock est placé provisoirement au site d’atterrissage de Perseverance.
- **Emprises et provenance :** compléter `footprint`, `source`, `date`, `resolution` et `projection` dans `layers.json`.

## Limites connues

- Une seule occurrence d’imprévu par sortie (réinitialiser pour rejouer).
- Si deux onglets Habitat sont ouverts, les deux font avancer l’horloge : n’en garder qu’un.
- Synchronisation limitée aux onglets d’un même navigateur (pas de réseau, conforme à la spec).
- Le fond HiRISE nécessite internet ; hors ligne, la carte affiche seulement les calques vectoriels.
