/**
 * Données statiques de la mission, chargées une fois au démarrage (FRONTEND_SPEC §6).
 * - fichiers locaux de public/data/ (coordonnées lon/lat Mars 2000), convertis en mètres au chargement
 * - analyse du tracé : backend FastAPI, sinon mock src/mocks/routeAnalysis.json
 */
import mockAnalysis from './mocks/routeAnalysis.json';
import { distanceAlong, pathLength, type XY } from './domain/geometry';
import { localProjection, type LocalProjection, type LonLat } from './domain/projection';

/** Provenance d'une valeur (FRONTEND_SPEC §3) : observé, dérivé, interprétation, simulé. */
export type ProvenanceKind = 'obs' | 'der' | 'int' | 'sim';
export type WaypointId = 'A' | 'W1' | 'W2' | 'W3' | 'B';
export type IncidentId = 'obstacle' | 'storm';

export interface Waypoint {
  id: WaypointId;
  name: string;
  xy: XY;
  d: number; // distance le long du tracé aller (m)
}

export interface ScenarioOption {
  id: string;
  label: string;
  detail: string;
  allerRestant: number;
  retour: number;
  keepObservation: boolean;
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
  footprint: LonLat[] | null;
  wmts?: WmtsConfig; // couche tuilée servie en WMTS (ex. Mars Trek)
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
  localTiles?: string; // gabarit du cache local (scripts/fetch-hirise-tiles.mjs) utilisé si le serveur ne répond pas
  boundingBox: [number, number, number, number]; // lon min, lat min, lon max, lat max
}

export interface RouteAnalysis {
  distance_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  max_slope_deg: number;
  profile: { d: number; z: number }[];
  segments: { from: WaypointId; to: WaypointId; length_m: number; slope_deg: number }[];
}

/** Toutes les géométries ci-dessous sont en mètres dans le repère local (voir domain/projection.ts). */
export interface MissionData {
  route: XY[];
  routeLength: number;
  waypoints: Waypoint[];
  detour: XY[];
  obstacle: XY | null;
  scenarios: Record<IncidentId, Scenario>;
  projection: LocalProjection; // conversion repère local ↔ lon/lat, origine = A
  projectionLabel: string;
  extent: [LonLat, LonLat]; // emprise de la vue initiale
  layers: LayerInfo[];
  analysis: RouteAnalysis;
  analysisSource: 'api' | 'mock';
}

const API_URL = import.meta.env.VITE_API_URL ?? '/api';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export interface GeoJson {
  features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[];
}

async function loadAnalysis(): Promise<{ analysis: RouteAnalysis; source: 'api' | 'mock' }> {
  try {
    return { analysis: await getJson<RouteAnalysis>(`${API_URL}/route/analysis`), source: 'api' };
  } catch {
    console.info('[EVA Planner] Backend indisponible : analyse du tracé chargée depuis le mock.');
    return { analysis: mockAnalysis as RouteAnalysis, source: 'mock' };
  }
}

let current: MissionData | null = null;

export function getData(): MissionData {
  if (!current) throw new Error('Données de mission non chargées');
  return current;
}

export interface RawFiles {
  aller: GeoJson;
  detour: GeoJson;
  scenarios: Record<IncidentId, Scenario>;
  layersFile: { projection: string; extent: [LonLat, LonLat]; layers: LayerInfo[] };
  analysis: RouteAnalysis;
  source: 'api' | 'mock';
}

export async function loadMissionData(): Promise<MissionData> {
  const [aller, detour, scenarios, layersFile, { analysis, source }] = await Promise.all([
    getJson<GeoJson>('/data/route_aller.geojson'),
    getJson<GeoJson>('/data/route_detour.geojson'),
    getJson<RawFiles['scenarios']>('/data/scenarios.json'),
    getJson<RawFiles['layersFile']>('/data/layers.json'),
    loadAnalysis(),
  ]);
  current = buildMissionData({ aller, detour, scenarios, layersFile, analysis, source });
  return current;
}

/** Assemble les fichiers bruts en données prêtes à l'emploi (pur, utilisé aussi par les tests). */
export function buildMissionData({ aller, detour, scenarios, layersFile, analysis, source }: RawFiles): MissionData {
  const line = aller.features.find((f) => f.geometry.type === 'LineString');
  if (!line) throw new Error('route_aller.geojson : LineString manquante');
  const lonLatRoute = line.geometry.coordinates as LonLat[];
  const projection = localProjection(lonLatRoute[0]);
  const route = lonLatRoute.map(projection.toLocal);

  const waypoints: Waypoint[] = aller.features
    .filter((f) => f.geometry.type === 'Point')
    .map((f) => {
      const xy = projection.toLocal(f.geometry.coordinates as LonLat);
      return { id: f.properties.id as WaypointId, name: String(f.properties.name ?? f.properties.id), xy, d: distanceAlong(route, xy) };
    })
    .sort((a, b) => a.d - b.d);

  const detourLine = detour.features[0];
  const obstacle = detourLine.properties.obstacle as LonLat | undefined;

  return {
    route,
    routeLength: pathLength(route),
    waypoints,
    detour: (detourLine.geometry.coordinates as LonLat[]).map(projection.toLocal),
    obstacle: obstacle ? projection.toLocal(obstacle) : null,
    scenarios,
    projection,
    projectionLabel: layersFile.projection,
    extent: layersFile.extent,
    layers: layersFile.layers,
    analysis,
    analysisSource: source,
  };
}
