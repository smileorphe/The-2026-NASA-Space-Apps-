/**
 * Données statiques de la mission, chargées une fois au démarrage (FRONTEND_SPEC §6).
 * - fichiers locaux de public/data/
 * - analyse du tracé : backend FastAPI, sinon mock src/mocks/routeAnalysis.json
 */
import mockAnalysis from './mocks/routeAnalysis.json';
import { distanceAlong, pathLength, type XY } from './domain/geometry';

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
  tiles: string | null; // gabarit d'URL {z}/{x}/{y}, null tant que les tuiles ne sont pas générées
  footprint: XY[] | null;
}

export interface RouteAnalysis {
  distance_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  max_slope_deg: number;
  profile: { d: number; z: number }[];
  segments: { from: WaypointId; to: WaypointId; length_m: number; slope_deg: number }[];
}

export interface MissionData {
  route: XY[];
  routeLength: number;
  waypoints: Waypoint[];
  detour: XY[];
  obstacle: XY | null;
  scenarios: Record<IncidentId, Scenario>;
  projection: string;
  extent: [XY, XY];
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
  layersFile: { projection: string; extent: [XY, XY]; layers: LayerInfo[] };
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
  const route = line.geometry.coordinates as XY[];

  const waypoints: Waypoint[] = aller.features
    .filter((f) => f.geometry.type === 'Point')
    .map((f) => {
      const xy = f.geometry.coordinates as XY;
      return { id: f.properties.id as WaypointId, name: String(f.properties.name ?? f.properties.id), xy, d: distanceAlong(route, xy) };
    })
    .sort((a, b) => a.d - b.d);

  const detourLine = detour.features[0];

  return {
    route,
    routeLength: pathLength(route),
    waypoints,
    detour: detourLine.geometry.coordinates as XY[],
    obstacle: (detourLine.properties.obstacle as XY | undefined) ?? null,
    scenarios,
    projection: layersFile.projection,
    extent: layersFile.extent,
    layers: layersFile.layers,
    analysis,
    analysisSource: source,
  };
}
