# EVA Planner — Front-end

Implémentation de [`FRONTEND_SPEC.md`](../FRONTEND_SPEC.md) : React + TypeScript + Vite, Leaflet, Zustand.

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
  data.ts            chargement de public/data/ + analyse du tracé (API, sinon mock)
  store.ts           store Zustand, persistance localStorage, synchronisation BroadcastChannel
  format.ts          T+mm:ss, distances, durées
  components/        briques d’interface partagées (carte, graphiques, journal, étiquettes)
  habitat/ tablet/ helmet/   un dossier par mode
  styles.css         tokens de design (spec §3) + classes partagées
public/data/         tracés GeoJSON, scénarios d’imprévu, couches (MOCK à remplacer au Data Gate)
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

## Brancher les vraies données (après le Scope & Data Gate)

- **Analyse du tracé** : `data.ts` appelle `GET ${VITE_API_URL ?? '/api'}/route/analysis` (proxy Vite vers `localhost:8000`) et attend le contrat de la spec §6. En cas d’échec, le mock `src/mocks/routeAnalysis.json` est utilisé ; le tableau de provenance indique la source réellement utilisée.
- **Tracés** : remplacer `public/data/route_aller.geojson` / `route_detour.geojson`. Les coordonnées doivent être **métriques** (mètres, x = est, y = nord) : les distances et la position sont calculées en géométrie plane. Les points `A`, `W1`…`B` sont des `Point` avec `properties.id`.
- **Tuiles** : générer avec `gdal2tiles --profile=raster --xyz` dans `public/tiles/{topo,crism}/`, puis renseigner `tiles` (`/tiles/topo/{z}/{x}/{y}.png`) dans `layers.json`. Les tuiles et le GeoJSON doivent partager le même repère ; sinon, adapter **uniquement** la fonction `ll()` de `components/MissionMap.tsx`.
- **Provenance** : compléter `source`, `date`, `resolution`, `projection` dans `layers.json` (affichés sur Préparation et Bilan).

## Limites connues

- Une seule occurrence d’imprévu par sortie (réinitialiser pour rejouer).
- Si deux onglets Habitat sont ouverts, les deux font avancer l’horloge : n’en garder qu’un.
- Synchronisation limitée aux onglets d’un même navigateur (pas de réseau, conforme à la spec).
