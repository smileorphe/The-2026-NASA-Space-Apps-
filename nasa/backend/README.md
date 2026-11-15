# EVA Planner — Backend (FastAPI)

Sert le tracé de la mission, les calculs faits sur le DTM HiRISE, le budget d'autonomie
simulé, les tuiles de carte et l'imprévu « éruption solaire » rejoué depuis NASA DONKI.

**Documentation complète (données, décisions, méthode, intégration front, reste à faire) :
[DOCUMENTATION.md](DOCUMENTATION.md)** — formats des données et traitements : **[docs/DONNEES.md](docs/DONNEES.md)**

## Installation (Windows, cmd)

```bat
cd nasa
python -m venv .venv
.venv\Scripts\activate
pip install -r backend\requirements.txt
```

## Lancer

```bat
cd backend
python scripts\make_tiles.py     :: une seule fois : tuiles de carte (~1 min 30)
python scripts\export_3d.py      :: une seule fois : données de la vue 3D
python scripts\fetch_meda.py     :: météo MEDA (lent)
python scripts\fetch_rad.py      :: radiations RAD (lent)
uvicorn app.main:app --reload
```
Documentation interactive : http://127.0.0.1:8000/docs

## Routes

| Route | Rôle |
|---|---|
| `GET /health` | État du serveur, DTM chargé ou non |
| `GET /config` | Paramètres de simulation (vitesse, autonomie, seuils) : le front affiche **ces** valeurs |
| `GET /map` | Centre, emprise, couches de tuiles et légende pour Leaflet |
| `GET /tiles/{ortho\|slope\|thermal}/{z}/{x}/{y}.png` | Tuiles de carte (ortho z13–18, pentes z13–17, thermique z13–16) |
| `GET /weather`, `GET /weather/hourly` | Météo MEDA réelle (Jezero) + critère GO / NO-GO |
| `GET /radiation`, `GET /radiation/eva` | Dose RAD (Curiosity, Gale) et dose estimée de la sortie |
| `GET /briefing` | Décision GO / GO sous réserve / NO-GO |
| `GET /minerals/point`, `GET /minerals/spectrum` | Composition minérale et spectre CRISM (par défaut au point B) |
| `GET /3d` | Vue 3D réaliste (index.html + données réelles de `nasa/assets/`) |
| `GET /route` | Tracé GeoJSON : habitat (A), waypoints, point B, aller, retour |
| `GET /route/stats?leg=aller\|retour` | Distance, altitudes, dénivelé ±, pente max/moyenne, durée, profil, segments difficiles |
| `GET /gate` | Scope & Data Gate : DTM couvre le tracé, B dans la ROI carbonates, signature (en attente) |
| `POST /autonomy` | Marge = autonomie − (aller + observation + retour), statut vert/orange/rouge |
| `POST /autonomy/add-stop` | Ajout d'un arrêt : refusé si la marge passe sous la réserve |
| `GET /autonomy/plan` | Budget au départ, calculé à partir des durées réelles du tracé |
| `GET /incidents`, `GET /incidents/{id}` | Imprévus enregistrés (DONKI) rejoués hors ligne |
| `GET /layers` | Sources et statut (réel / simulé) de chaque couche |

## Données

- `data/route.geojson` — tracé **provisoire** (lon/lat en degrés, Mars 2000). L'équipe peut le modifier ;
  relancer le serveur, puis vérifier `GET /gate` et `GET /route/stats`.
- `data/sources.json` — crédits affichés dans l'interface.
- `data/incidents/` — imprévus générés par `scripts/fetch_donki.py`.
- Le DTM est lu directement dans `../data/` (seuls les pixels utiles sont lus).
  Autre chemin : variable `EVA_DTM_PATH`.

## Imprévu DONKI

```bat
set NASA_API_KEY=votre_cle      :: gratuite sur api.nasa.gov (DEMO_KEY = ~30 requêtes/heure)
python scripts\fetch_donki.py --refresh
```
Les réponses brutes sont mises en cache dans `data/donki_raw/` : la démo marche sans internet.
Note : l'endpoint `DONKI/FLR` d'api.nasa.gov renvoie 404 ; le script utilise SEP + notifications.

## Tests

```bat
python -m pytest -q
```

## Paramètres de simulation

Tous dans `app/config.py`, surchargeables par variable d'environnement `EVA_<NOM>`
(ex. `set EVA_WALK_SPEED_KMH=3`). Ce sont des valeurs de démonstration, pas des normes NASA.
