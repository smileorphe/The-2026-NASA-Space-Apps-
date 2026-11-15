/**
 * Données statiques de la mission, chargées une fois au démarrage (FRONTEND_SPEC §6).
 * - fichiers de public/data/ (coordonnées lon/lat Mars 2000), produits par pipeline/ ; le tracé est converti
 *   en mètres au chargement ;
 * - analyse du tracé : backend FastAPI, sinon public/data/route_analysis.json (calculé par pipeline/route_analysis.py).
 */
import { distanceAlong, pathLength, type XY } from './domain/geometry';
import { localProjection, type LocalProjection, type LonLat } from './domain/projection';

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
 * - continue : poursuivre vers B sur le tracé ; detour : rejoindre B par route_detour ; back : rentrer à A.
 */
export interface ScenarioOption {
  id: string;
  label: string;
  detail: string;
  kind: 'continue' | 'detour' | 'back';
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
  detour: { cost_m: number; distance_m: number };
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

export interface ReturnZone extends GeoJson<{ label: string; area_km2: number; contains_B: boolean; return_cost_from_B_m: number; return_min_from_B: number }> {
  parameters: {
    autonomy_min: number; reserve_min: number; observation_min: number; speed_kmh: number;
    aller_min: number; threshold_min: number; threshold_cost_m: number; alpha_per_deg: number; sand_factor: number;
  };
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
  routes: RoutesComputed | null;
  returnZone: ReturnZone | null;
}

/** Les géométries de mission sont en mètres dans le repère local (voir domain/projection.ts). */
export interface MissionData {
  route: XY[];
  routeLength: number;
  waypoints: Waypoint[];
  detour: XY[];
  obstacle: XY | null;
  returnPath: XY[]; // itinéraire de moindre coût B → A
  scenarios: Record<IncidentId, Scenario>;
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
  detour: GeoJson;
  scenarios: Record<IncidentId, Scenario>;
  layersFile: { projection: string; layers: LayerInfo[] };
  analysis: RouteAnalysis;
  source: 'api' | 'pipeline';
  overlays?: Overlays;
}

export async function loadMissionData(): Promise<MissionData> {
  const [aller, detour, scenarios, layersFile, { analysis, source }, crismRegions, crismFootprint, geology, routes, returnZone] = await Promise.all([
    getJson<GeoJson>('/data/route_aller.geojson'),
    getJson<GeoJson>('/data/route_detour.geojson'),
    getJson<RawFiles['scenarios']>('/data/scenarios.json'),
    getJson<RawFiles['layersFile']>('/data/layers.json'),
    loadAnalysis(),
    getOptional<CrismRegions>('/data/crism_regions.geojson'),
    getOptional<GeoJson>('/data/crism_footprint_040ff.geojson'),
    getOptional<NonNullable<Overlays['geology']>>('/data/geology.geojson'),
    getOptional<RoutesComputed>('/data/routes_computed.geojson'),
    getOptional<ReturnZone>('/data/return_zone.geojson'),
  ]);
  current = buildMissionData({ aller, detour, scenarios, layersFile, analysis, source, overlays: { crismRegions, crismFootprint, geology, routes, returnZone } });
  return current;
}

const NO_OVERLAYS: Overlays = { crismRegions: null, crismFootprint: null, geology: null, routes: null, returnZone: null };

/** Assemble les fichiers bruts en données prêtes à l'emploi (pur, utilisé aussi par les tests). */
export function buildMissionData({ aller, detour, scenarios, layersFile, analysis, source, overlays = NO_OVERLAYS }: RawFiles): MissionData {
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

  const detourLine = detour.features[0];
  const obstacle = detourLine.properties.obstacle as LonLat | undefined;

  return {
    route,
    routeLength: pathLength(route),
    waypoints,
    detour: (detourLine.geometry.coordinates as LonLat[]).map(projection.toLocal),
    obstacle: obstacle ? projection.toLocal(obstacle) : null,
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
