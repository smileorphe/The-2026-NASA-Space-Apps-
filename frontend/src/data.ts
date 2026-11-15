/**
 * Données statiques de la mission, chargées une fois au démarrage (FRONTEND_SPEC §6).
 * - fichiers de public/data/ (coordonnées lon/lat Mars 2000), produits par pipeline/ ; le tracé est converti
 *   en mètres au chargement ;
 * - analyse du tracé : backend FastAPI, sinon public/data/route_analysis.json (calculé par pipeline/route_analysis.py).
 */
import { distanceAlong, pathLength, type XY } from './domain/geometry';
import { localProjection, type LocalProjection, type LonLat } from './domain/projection';
import { makeScene, rasterOf, type Dataset, type SceneData } from './domain/scene';
import { makeGrid, type GridMeta, type TerrainGrid } from './domain/terrain';

/** Provenance d'une valeur (FRONTEND_SPEC §3) : observé, dérivé, interprétation, simulé. */
export type ProvenanceKind = 'obs' | 'der' | 'int' | 'sim';
export type WaypointId = 'A' | 'W1' | 'W2' | 'W3' | 'B';
export type IncidentId = 'obstacle' | 'storm';

export interface GeologicUnit {
  symbol: string;
  name: string;
}

/** Classe CRISM à l'emplacement d'un point (Zastrow & Glotch 2021). */
export interface CrismClass {
  code: 'MC' | 'MT' | 'sand' | 'mixture';
  label: string;
  label_en: string;
  source: string;
}

export interface Waypoint {
  id: WaypointId;
  name: string;
  xy: XY;
  d: number; // distance le long du tracé aller (m)
  geologicUnit?: GeologicUnit | null;
  crismClass?: CrismClass | null;
}

/**
 * Option d'imprévu. Les durées ne sont pas écrites dans le scénario : elles sont calculées à partir des coûts
 * de route_analysis.json (domain/mission.ts, optionPlan).
 * - continue : poursuivre vers B sur le tracé ; back : rentrer à A.
 * L'obstacle n'est pas un scénario : il est placé sur la carte et recalculé par A* (domain/obstacle.ts).
 */
export interface ScenarioOption {
  id: string;
  label: string;
  detail: string;
  kind: 'continue' | 'back';
  speedFactor?: number; // ex. 0,6 par tempête (allure réduite)
}

export interface Scenario {
  title: string;
  options: ScenarioOption[];
}

export interface LayerInfo {
  id: string;
  name: string;
  source: string;
  date: string;
  resolution: string;
  projection: string;
  kind: ProvenanceKind;
  effectiveResolution?: string; // résolution effective mesurée (étiquetée « Observé »)
  wmts?: WmtsConfig; // couche tuilée (Mars Trek ou tuiles locales)
}

/** Paramètres WMTS relevés dans le GetCapabilities du service (ne pas les deviner). */
export interface WmtsConfig {
  url: string; // gabarit REST : {Style}, {TileMatrixSet}, {TileMatrix}, {TileRow}, {TileCol}
  layer: string;
  matrixSet: string;
  format: string;
  style: string;
  crs: string;
  topLeftCorner: LonLat;
  tileSize: number;
  matrixWidth0: number; // nombre de tuiles en largeur au niveau 0 (puis ×2 par niveau)
  maxMatrix: number; // dernier niveau régulier annoncé par le GetCapabilities
  maxUsableMatrix?: number; // plafond d'utilisation si les niveaux supérieurs sont défectueux (raison dans _source)
  localTiles?: string; // gabarit du cache local (scripts/fetch-tiles.mjs) utilisé si le serveur ne répond pas
  boundingBox: [number, number, number, number]; // lon min, lat min, lon max, lat max
}

/** Analyse du tracé (spec §6 + coûts). Coût = longueur équivalente en mètres de plat ; durée = coût ÷ vitesse. */
export interface RouteAnalysis {
  distance_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  max_slope_deg: number;
  profile: { d: number; z: number }[];
  segments: { from: WaypointId; to: WaypointId; length_m: number; slope_deg: number; cost_m: number; duration_min: number }[];
  aller: { cost_m: number };
  return: { cost_m: number; distance_m: number; max_slope_deg: number; coordinates: LonLat[] }; // moindre coût B → A
  defaults: { autonomy_min: number; speed_kmh: number; observation_min: number; reserve_min: number };
  nominal: { aller_min: number; observation_min: number; retour_min: number; margin_min: number };
}

export interface GeoJson<P = Record<string, unknown>> {
  features: { properties: P; geometry: { type: string; coordinates: unknown } }[];
}

/** Indicateurs d'un itinéraire (pipeline/paths.py). */
export interface RouteStats {
  id: string;
  label: string;
  distance_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  max_slope_deg: number;
  cost: number;
  sand_m: number;
}

export interface RoutesComputed extends GeoJson<RouteStats> {
  parameters: { alpha_per_deg: number; sand_factor: number; slope_max_deg: number };
  mission: RouteStats;
}

export interface CrismRegions extends GeoJson<{ code: CrismClass['code'] }> {
  source: string;
  legend: Record<CrismClass['code'], { label: string; label_en: string }>;
}

/** Couches produites par pipeline/ ; chacune est facultative (null si le fichier manque). */
export interface Overlays {
  crismRegions: CrismRegions | null;
  crismFootprint: GeoJson | null;
  geology: GeoJson<{ kind: 'unit' | 'line' | 'ellipse'; symbol?: string; name?: string; type?: string }> | null;
  routes: RoutesComputed | null; // statistiques du tracé de référence (sable) ; les itinéraires affichés sont recalculés en direct
}

/** Les géométries de mission sont en mètres dans le repère local (voir domain/projection.ts). */
export interface MissionData {
  route: XY[];
  routeLength: number;
  waypoints: Waypoint[];
  returnPath: XY[]; // itinéraire de moindre coût B → A
  scenarios: Partial<Record<IncidentId, Scenario>>; // scénarios prédéfinis (tempête) ; l'obstacle est placé sur la carte
  projection: LocalProjection; // conversion repère local ↔ lon/lat, origine = A
  projectionLabel: string;
  layers: LayerInfo[];
  analysis: RouteAnalysis;
  analysisSource: 'api' | 'pipeline';
  overlays: Overlays;
}

const API_URL = import.meta.env.VITE_API_URL ?? '/api';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const getOptional = <T>(url: string) => getJson<T>(url).catch(() => null);

async function loadAnalysis(): Promise<{ analysis: RouteAnalysis; source: 'api' | 'pipeline' }> {
  try {
    return { analysis: await getJson<RouteAnalysis>(`${API_URL}/route/analysis`), source: 'api' };
  } catch {
    console.info('[EVA Planner] Backend indisponible : analyse du tracé lue dans route_analysis.json (pipeline).');
    return { analysis: await getJson<RouteAnalysis>('/data/route_analysis.json'), source: 'pipeline' };
  }
}

let current: MissionData | null = null;

export function getData(): MissionData {
  if (!current) throw new Error('Données de mission non chargées');
  return current;
}

export interface RawFiles {
  aller: GeoJson;
  scenarios: Record<IncidentId, Scenario>;
  layersFile: { projection: string; layers: LayerInfo[] };
  analysis: RouteAnalysis;
  source: 'api' | 'pipeline';
  overlays?: Overlays;
}

export async function loadMissionData(): Promise<MissionData> {
  const [aller, scenarios, layersFile, { analysis, source }, crismRegions, crismFootprint, geology, routes] = await Promise.all([
    getJson<GeoJson>('/data/route_aller.geojson'),
    getJson<RawFiles['scenarios']>('/data/scenarios.json'),
    getJson<RawFiles['layersFile']>('/data/layers.json'),
    loadAnalysis(),
    getOptional<CrismRegions>('/data/crism_regions.geojson'),
    getOptional<GeoJson>('/data/crism_footprint_040ff.geojson'),
    getOptional<NonNullable<Overlays['geology']>>('/data/geology.geojson'),
    getOptional<RoutesComputed>('/data/routes_computed.geojson'),
  ]);
  current = buildMissionData({ aller, scenarios, layersFile, analysis, source, overlays: { crismRegions, crismFootprint, geology, routes } });
  return current;
}

const NO_OVERLAYS: Overlays = { crismRegions: null, crismFootprint: null, geology: null, routes: null };

/** Assemble les fichiers bruts en données prêtes à l'emploi (pur, utilisé aussi par les tests). */
export function buildMissionData({ aller, scenarios, layersFile, analysis, source, overlays = NO_OVERLAYS }: RawFiles): MissionData {
  const line = aller.features.find((f) => f.geometry.type === 'LineString');
  if (!line) throw new Error('route_aller.geojson : LineString manquante');
  const lonLatRoute = line.geometry.coordinates as LonLat[];
  const projection = localProjection(lonLatRoute[0]);
  const route = lonLatRoute.map(projection.toLocal);

  const waypoints: Waypoint[] = aller.features
    .filter((f) => f.geometry.type === 'Point')
    .map((f) => {
      const p = f.properties;
      const xy = projection.toLocal(f.geometry.coordinates as LonLat);
      return {
        id: p.id as WaypointId,
        name: String(p.name ?? p.id),
        xy,
        d: distanceAlong(route, xy),
        geologicUnit: (p.geologic_unit as GeologicUnit | null | undefined) ?? null,
        crismClass: (p.crism_class as CrismClass | null | undefined) ?? null,
      };
    })
    .sort((a, b) => a.d - b.d);


  return {
    route,
    routeLength: pathLength(route),
    waypoints,
    returnPath: analysis.return.coordinates.map(projection.toLocal),
    scenarios,
    projection,
    projectionLabel: layersFile.projection,
    layers: layersFile.layers,
    analysis,
    analysisSource: source,
    overlays,
  };
}

const fetchF32 = async (file: string) => {
  const res = await fetch(`/data/terrain/${file}`);
  if (!res.ok) throw new Error(`terrain/${file} : HTTP ${res.status}`);
  return new Float32Array(await res.arrayBuffer());
};

let scene: Promise<SceneData> | null = null;

/** Données de la vue 3D du casque (couloir 1 m, horizon CTX, description de l'ortho), chargées à la demande. */
export function loadScene(): Promise<SceneData> {
  scene ??= (async () => {
    const [grid, meta] = await Promise.all([loadTerrain(), getJson<{ datasets?: Record<string, Dataset> }>('/data/terrain/grid.json')]);
    const ds = meta.datasets;
    if (!ds?.corridor || !ds.horizon || !ds.ortho) throw new Error('grid.json sans données de scène (relancer pipeline/terrain_export.py)');
    const [corridor, horizon] = await Promise.all([fetchF32(ds.corridor.file), fetchF32(ds.horizon.file)]);
    const data = current ?? (await loadMissionData());
    return makeScene(grid, rasterOf(ds.corridor, corridor), rasterOf(ds.horizon, horizon), ds, data.projection.toLonLat(data.route[0]));
  })();
  scene.catch(() => (scene = null));
  return scene;
}

let terrain: Promise<TerrainGrid> | null = null;

/** Grilles altitude / pente / coût (public/data/terrain/, ≈ 4,7 Mo), chargées une seule fois à la demande. */
export function loadTerrain(): Promise<TerrainGrid> {
  terrain ??= (async () => {
    const meta = await getJson<GridMeta>('/data/terrain/grid.json');
    const [altitude, slope, cost] = await Promise.all([fetchF32(meta.files.altitude), fetchF32(meta.files.slope), fetchF32(meta.files.cost)]);
    return makeGrid(meta, altitude, slope, cost);
  })();
  terrain.catch(() => (terrain = null)); // nouvel essai au prochain appel
  return terrain;
}
