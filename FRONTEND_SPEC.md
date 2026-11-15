# EVA Planner — Spécification front-end (MVP)

Référence pour l'implémentation. Les maquettes sont dans `design/` (fichiers `.dc.html`, à lire comme référence visuelle et logique, pas à copier tels quels).
Source de vérité fonctionnelle : *Guide EVA Planner v2* (mission A → B, trois modes, autonomie simulée).

## 1. Stack

- React + TypeScript + Vite
- Leaflet + react-leaflet, `L.CRS.Simple`, tuiles locales (gdal2tiles `--profile=raster --xyz`)
- Zustand pour l'état de mission (un seul store)
- BroadcastChannel pour synchroniser les onglets Habitat / Tablette / Casque
- CSS : Tailwind ou CSS modules, au choix de l'équipe ; les tokens ci-dessous sont la référence
- Pas de serveur temps réel. Le backend FastAPI fournit seulement l'analyse du tracé (§6) ; tant qu'il n'est pas prêt, utiliser les mocks de `src/mocks/`.

## 2. Routes

| Route | Écran | Maquette |
|---|---|---|
| `/habitat/preparation` | Préparation | `Preparation.dc.html` |
| `/habitat/supervision` | Supervision | `Supervision.dc.html` |
| `/habitat/bilan` | Bilan | `Bilan.dc.html` |
| `/tablette` | Carnet au point B | `TabletStation.dc.html` |
| `/casque` | HUD (nominal / alerte selon l'état) | `HudNominal.dc.html`, `HudAlerte.dc.html` |

Les écrans Habitat partagent une coquille : barre latérale (Préparation, Supervision, Bilan, encart « Mode simulation ») + en-tête (titre, sélecteur Habitat / Tablette / Casque, horloge de mission, indicateur « 3 modes synchronisés »).
La tablette est en 1024×768 avec des cibles tactiles ≥ 56 px ; le casque en 1280×720 en plein écran.

## 3. Tokens de design

```ts
export const color = {
  frame: '#100F0E', side: '#0B0A0A', main: '#1A1817', card: '#252220', card2: '#312D2A', border: '#3A3531',
  text: '#F3EFEA', muted: '#ABA39B',
  accent: '#EE8A1B',   // action principale
  nav: '#4CC6EA',      // navigation, tracé, position
  carb: '#B59CFF',     // signature carbonates / tablette
  green: '#1FC48F', amber: '#F2C230', red: '#F4605A', // statuts
};
export const font = { ui: 'Manrope', mono: 'IBM Plex Mono' }; // Google Fonts
export const radius = { card: 24, inner: 16, control: 12, pill: 999 };
```

Règles : jamais la couleur seule (toujours icône + libellé) ; chiffres en police mono ; contraste texte ≥ 4.5:1.

### Étiquettes de provenance (obligatoires sur chaque valeur)

| Clé | Libellé | Usage |
|---|---|---|
| `obs` | Observé | image, mesure, saisie de l'astronaute |
| `der` | Dérivé | calculé à partir des données (distance, pente, signature CRISM) |
| `int` | Interprétation | lecture scientifique (sens des carbonates) |
| `sim` | Simulé | temps, autonomie, seuils, imprévus |

Composant : `<ProvenanceTag kind="sim" />`.

## 4. Modèle d'autonomie (formule unique)

À implémenter **une seule fois** dans `src/domain/autonomy.ts`. Tous les écrans lisent ce module.

```
aller        = round(35 × 3.3 / vitesse)   // mock tant que le backend ne fournit pas les durées par segment
retour       = round(40 × 3.3 / vitesse)
marge        = autonomie − (allerRestant + observation + retour)
quitterB     = arrivéeB + ((autonomie_à_B − retour) − réserve)
```

Statuts (paramètres de démonstration) :
- vert : marge ≥ réserve + 10
- orange : réserve ≤ marge < réserve + 10
- rouge : marge < réserve → retour prioritaire

Règle de décision : toute action (prolonger l'observation, poursuivre malgré un imprévu) qui ferait passer la marge sous la réserve est **refusée**, avec un message expliquant la marge qui en résulterait.

Valeurs par défaut : autonomie 120 min, vitesse 3,3 km/h, observation 15 min, réserve 20 min → marge 30 min.
Bornes des réglages : autonomie 60–240 (pas 10), vitesse 2,4 / 2,7 / 3,0 / 3,3 / 3,6, observation ≥ 5 (pas 5), réserve 10–40 (pas 5).

Tests unitaires obligatoires sur ce module (cas : défaut = 30 ; +10 obs = 20 orange accepté ; +15 obs = refusé ; tempête « poursuivre » = −2 refusé).

## 5. État de mission (store Zustand)

```ts
type Source = 'HABITAT' | 'TABLETTE' | 'CASQUE' | 'SYSTÈME';

interface MissionState {
  params: { autonomy: number; speedKmh: number; observation: number; reserve: number };
  clock: { t: number /* minutes depuis le départ */; speed: 0 | 1 | 10 | 60 };
  position: { distanceM: number; segmentIndex: number };   // interpolée le long du GeoJSON
  waypoints: { id: 'A'|'W1'|'W2'|'W3'|'B'; plannedT: number; actualT?: number; slopeDeg: number }[];
  incident: null | { id: 'obstacle' | 'storm'; choice?: string };
  returning: boolean;
  observationExtra: number;
  objectives: { photo: boolean; observation: boolean; sample: boolean };
  log: { t: number; source: Source; text: string }[];
  lastMessageToHud?: string;
}
```

- Le mode Habitat est la seule source qui fait avancer l'horloge ; il diffuse l'état complet par `BroadcastChannel('eva-planner')`.
- Tablette et Casque envoient des **actions** (`{ type: 'LOG_OBSERVATION', ... }`, `{ type: 'REPORT_OBSTACLE' }`) ; l'Habitat les applique puis rediffuse.
- Persistance `localStorage` pour survivre à un rechargement.

## 6. Données et contrats

Fichiers locaux (`public/data/`) :
- `route_aller.geojson` : LineString A → W1 → W2 → W3 → B (+ propriétés des waypoints)
- `route_detour.geojson` : détour prédéfini du scénario obstacle
- `scenarios.json` : imprévus (voir ci-dessous)
- `layers.json` : couches avec `source`, `date`, `resolution`, `projection`, `kind` (provenance)
- tuiles : `public/tiles/{topo,crism}/{z}/{x}/{y}.png`

Réponse attendue du backend (mock identique dans `src/mocks/routeAnalysis.json`) :

```json
{
  "distance_m": 1920,
  "elevation_gain_m": 38,
  "elevation_loss_m": 12,
  "max_slope_deg": 11,
  "profile": [{ "d": 0, "z": -2540.0 }],
  "segments": [{ "from": "W2", "to": "W3", "length_m": 520, "slope_deg": 9 }]
}
```

Scénarios d'imprévu (`scenarios.json`) :

```json
{
  "obstacle": { "title": "Obstacle sur le tracé W3 → B", "options": [
    { "id": "detour", "label": "Détour prédéfini", "allerRestant": 15, "retour": 40, "keepObservation": true },
    { "id": "back", "label": "Retour à l’habitat", "allerRestant": 0, "retour": 22, "keepObservation": false } ] },
  "storm": { "title": "Tempête de poussière locale (fictive)", "options": [
    { "id": "go", "label": "Poursuivre vers B", "allerRestant": 12, "retour": 67, "keepObservation": true },
    { "id": "back", "label": "Retour immédiat", "allerRestant": 0, "retour": 37, "keepObservation": false } ] }
}
```

Les identifiants, dates et résolutions entre crochets dans les maquettes sont à remplir après le Scope & Data Gate.

## 7. Contenu des écrans (résumé)

**Préparation** : objectif + statut + bouton « Lancer la sortie » (devient « Départ bloqué » si marge < réserve) ; carte (couches, A, W1–W3, B, pentes colorées, emprises DTM/CRISM) ; caractéristiques du tracé ; fiche point B (texte carbonates en 3 niveaux) ; paramètres de simulation (4 réglages) ; budget d'autonomie (barre empilée + formule écrite + heure limite pour quitter B) ; profil d'élévation ; tableau de provenance.

**Supervision** : bandeau 6 tuiles (marge, autonomie, retour, prochain point, écart horaire, pente actuelle) ; carte avec position, détour / retour selon décision ; options de décision avec marge recalculée (prolonger +5/+10/+15, rentrer) ; heures limites ; graphique autonomie (plan / simulé / projection / réserve) ; profil avec position ; tableau des points de passage ; imprévu ; messages prédéfinis vers le casque ; état des modes + horloge (pause, ×1, ×10, ×60) ; journal filtrable ; fiche point B.

**Bilan** : synthèse (durée, distance, autonomie à l'arrivée, marge minimale, imprévus, entrées) ; trajet réalisé ; objectifs ; journal complet + export JSON ; sources utilisées.

**Tablette** : en-tête autonomie / retour / marge ; objectifs du site ; 5 actions (Photographier, Observer, Mesurer, Prélever, Note) qui écrivent dans le journal ; fiche de zone ; « Prolonger +15 min » refusé selon la règle ; bannière d'alerte synchronisée.

**Casque** : flèche + distance au prochain point, progression, autonomie / retour / marge, horloge ; en alerte : bord rouge, cap vers A, bandeau « RETOUR PRIORITAIRE » étiqueté simulation. Rien d'autre.

## 8. Vocabulaire

- Ne jamais écrire « sûr » ou « safe » pour un itinéraire. Utiliser : « dans les limites configurées », « marge réduite », « réserve dépassée ».
- Pas de badges, récompenses ou animations de jeu. Feedback = progression, journal, statut.
- Texte carbonates imposé (guide §3) : signature compatible / interprétation / « ne constitue pas une preuve de vie ».

## 9. Ordre d'implémentation conseillé

1. Squelette Vite + routes + coquille Habitat + tokens.
2. `domain/autonomy.ts` + tests.
3. Store Zustand + BroadcastChannel + persistance.
4. Carte Leaflet avec mocks (GeoJSON + une couche de tuiles).
5. Préparation (paramètres, budget, refus).
6. Supervision (horloge, position interpolée, décisions, imprévus, journal).
7. Casque, puis Tablette.
8. Bilan + export JSON.
9. Brancher l'API backend à la place des mocks.

Critère de fin : les 8 étapes de la démo (guide §9) se déroulent sans rechargement, avec les trois modes ouverts côte à côte.
