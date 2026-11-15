/**
 * Plan de mission pour un point B choisi sur la carte.
 *
 * `buildPlan` calcule l'itinéraire de moindre coût A → B (A*, domain/routing.ts), place W1–W3 à 25 / 50 / 75 % de
 * la distance, et produit segments, profil et coûts. Le retour B → A a le même coût (coûts symétriques) et suit le
 * même chemin inversé. Le plan est sérialisable : il est stocké dans l'état de mission et partagé avec les trois modes.
 * `withPlan` dérive les données de mission (MissionData) du plan ; sans plan, les données de référence sont inchangées.
 */
import type { CrismClass, GeologicUnit, MissionData, Overlays, RouteAnalysis, Waypoint, WaypointId } from '../data';
import { crismAt, unitAt } from './geo';
import { distanceAlong, pathLength, type XY } from './geometry';
import type { LonLat } from './projection';
import { astar } from './routing';
import { cellAt, cellCenter, isSand, toGridXY, type TerrainGrid } from './terrain';

export interface CustomPlan {
  id: string;
  b: LonLat;
  route: LonLat[]; // A → B, simplifié (W1–W3 sont des sommets)
  waypoints: Record<'W1' | 'W2' | 'W3', LonLat>;
  segments: RouteAnalysis['segments'];
  profile: RouteAnalysis['profile'];
  distance_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  max_slope_deg: number;
  sand_m: number;
  allerCostM: number;
  retourCostM: number;
  geologicUnit: GeologicUnit | null;
  crismClass: CrismClass | null;
}

export type PlanResult = { ok: true; plan: CustomPlan } | { ok: false; reason: string };

const IDS: WaypointId[] = ['A', 'W1', 'W2', 'W3', 'B'];

/** Douglas–Peucker sur des points en mètres ; renvoie les indices conservés. */
function simplify(pts: XY[], tol: number, lo = 0, hi = pts.length - 1, keep = new Set<number>([lo, hi])): Set<number> {
  const [ax, ay] = pts[lo];
  const [bx, by] = pts[hi];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let best = -1, far = tol;
  for (let i = lo + 1; i < hi; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
    if (d > far) { far = d; best = i; }
  }
  if (best >= 0) {
    keep.add(best);
    simplify(pts, tol, lo, best, keep);
    simplify(pts, tol, best, hi, keep);
  }
  return keep;
}

/** Analyse d'un chemin de cellules : distances et coûts cumulés, sable, dénivelé, profil (pas de 10 m). */
export function analyseCells(g: TerrainGrid, cells: number[]) {
  const xy = cells.map((i) => toGridXY(g, cellCenter(g, i)));
  const dist = [0], cost = [0];
  let sand = 0, gain = 0, loss = 0, maxSlope = 0;
  const profile: RouteAnalysis['profile'] = [{ d: 0, z: g.altitude[cells[0]] }];
  for (let k = 1; k < cells.length; k++) {
    const step = Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]);
    dist.push(dist[k - 1] + step);
    cost.push(cost[k - 1] + ((g.cost[cells[k - 1]] + g.cost[cells[k]]) / 2) * step);
    if (isSand(g, cells[k])) sand += step;
    const dz = g.altitude[cells[k]] - g.altitude[cells[k - 1]];
    if (dz > 0) gain += dz; else loss -= dz;
    if (k === cells.length - 1 || Math.floor(dist[k] / 10) > Math.floor(dist[k - 1] / 10)) profile.push({ d: dist[k], z: g.altitude[cells[k]] });
  }
  for (const i of cells) maxSlope = Math.max(maxSlope, g.slope[i]);
  return { xy, dist, cost, sand, gain, loss, maxSlope, profile, distance: dist[dist.length - 1], costM: cost[cost.length - 1] };
}

/** Tracé simplifié (Douglas–Peucker 2,5 m) en lon/lat ; `keepAt` : indices de cellules à garder comme sommets. */
export function simplifiedPath(g: TerrainGrid, cells: number[], xy: XY[], keepAt: number[] = []): LonLat[] {
  const cuts = [0, ...keepAt, cells.length - 1];
  const keep = new Set<number>();
  for (let s = 0; s < cuts.length - 1; s++) for (const i of simplify(xy, 2.5, cuts[s], cuts[s + 1])) keep.add(i);
  return [...keep].sort((x, y) => x - y).map((i) => cellCenter(g, cells[i]));
}

/** Indicateurs d'un itinéraire (comparaison, options d'obstacle). */
export interface PathSummary {
  path: LonLat[];
  distance_m: number;
  elevation_gain_m: number;
  elevation_loss_m: number;
  max_slope_deg: number;
  sand_m: number;
  cost_m: number; // m de plat (coût du terrain, même si l'itinéraire a été cherché en distance seule)
}

export function summarise(g: TerrainGrid, cells: number[]): PathSummary {
  const a = analyseCells(g, cells);
  return { path: simplifiedPath(g, cells, a.xy), distance_m: a.distance, elevation_gain_m: a.gain, elevation_loss_m: a.loss, max_slope_deg: a.maxSlope, sand_m: a.sand, cost_m: a.costM };
}

/** Itinéraires de comparaison A → B : plus court (distance seule) et moindre coût. */
export function routeAlternatives(g: TerrainGrid, a: LonLat, b: LonLat): { shortest: PathSummary | null; leastCost: PathSummary | null } {
  const [s, e] = [cellAt(g, a), cellAt(g, b)];
  const short = astar(g, s, e, 'uniform');
  const least = astar(g, s, e, 'cost');
  return { shortest: short ? summarise(g, short.cells) : null, leastCost: least ? summarise(g, least.cells) : null };
}

export function buildPlan(g: TerrainGrid, overlays: Overlays, a: LonLat, b: LonLat): PlanResult {
  const start = cellAt(g, a);
  const goal = cellAt(g, b);
  if (goal < 0) return { ok: false, reason: 'Point hors de l’extrait de terrain (DTM 5 m).' };
  if (!(g.cost[goal] >= 0)) return { ok: false, reason: `Point interdit : pente ${g.slope[goal].toFixed(1)}° > ${g.costParams.slope_max_deg}° ou donnée absente.` };
  const r = astar(g, start, goal);
  if (!r) return { ok: false, reason: 'Aucun itinéraire sans pente > 20° ne relie A à ce point.' };

  const cells = r.cells;
  const an = analyseCells(g, cells);
  const split = [0, 0.25, 0.5, 0.75].map((f) => an.dist.findIndex((d) => d >= f * an.distance)).concat(cells.length - 1);
  const route = simplifiedPath(g, cells, an.xy, split.slice(1, 4)); // W1–W3 restent des sommets

  const segments = IDS.slice(0, 4).map((from, k) => {
    const [i0, i1] = [split[k], split[k + 1]];
    let maxSlope = 0;
    for (let q = i0; q <= i1; q++) maxSlope = Math.max(maxSlope, g.slope[cells[q]]);
    return { from, to: IDS[k + 1], length_m: an.dist[i1] - an.dist[i0], slope_deg: Math.round(maxSlope * 10) / 10, cost_m: an.cost[i1] - an.cost[i0], duration_min: 0 };
  });
  const bCenter = cellCenter(g, goal);
  return {
    ok: true,
    plan: {
      id: `${bCenter[0].toFixed(7)},${bCenter[1].toFixed(7)}`,
      b: bCenter,
      route,
      waypoints: { W1: cellCenter(g, cells[split[1]]), W2: cellCenter(g, cells[split[2]]), W3: cellCenter(g, cells[split[3]]) },
      segments,
      profile: an.profile,
      distance_m: an.distance,
      elevation_gain_m: an.gain,
      elevation_loss_m: an.loss,
      max_slope_deg: Math.max(...segments.map((x) => x.slope_deg)),
      sand_m: an.sand,
      allerCostM: r.costM,
      retourCostM: r.costM, // coûts symétriques : retour B → A au moindre coût = même chemin, même coût
      geologicUnit: unitAt(overlays.geology, bCenter),
      crismClass: crismAt(overlays.crismRegions, bCenter),
    },
  };
}

let last: { base: MissionData; id: string; data: MissionData } | null = null;

/** Données de mission pour le plan choisi (mises en cache : le plan circule souvent entre les onglets). */
export function withPlan(base: MissionData, plan: CustomPlan | null | undefined): MissionData {
  if (!plan) return base;
  if (last && last.base === base && last.id === plan.id) return last.data;
  const toLocal = base.projection.toLocal;
  const route = plan.route.map(toLocal);
  const at = (id: WaypointId, p: LonLat, extra: Partial<Waypoint> = {}): Waypoint => {
    const w = toLocal(p);
    return { ...base.waypoints.find((x) => x.id === id)!, ...extra, id, xy: w, d: distanceAlong(route, w) };
  };
  const waypoints = [
    at('A', plan.route[0]),
    ...(['W1', 'W2', 'W3'] as const).map((id) => at(id, plan.waypoints[id], { name: id, geologicUnit: null, crismClass: null })),
    at('B', plan.b, { name: 'Point B · choisi sur la carte', geologicUnit: plan.geologicUnit, crismClass: plan.crismClass }),
  ];
  const back = [...route].reverse();
  const data: MissionData = {
    ...base,
    route,
    routeLength: pathLength(route),
    waypoints,
    returnPath: back,
    analysis: {
      ...base.analysis,
      distance_m: plan.distance_m,
      elevation_gain_m: plan.elevation_gain_m,
      elevation_loss_m: plan.elevation_loss_m,
      max_slope_deg: plan.max_slope_deg,
      profile: plan.profile,
      segments: plan.segments,
      aller: { cost_m: plan.allerCostM },
      return: { cost_m: plan.retourCostM, distance_m: plan.distance_m, max_slope_deg: plan.max_slope_deg, coordinates: [...plan.route].reverse() },
    },
  };
  last = { base, id: plan.id, data };
  return data;
}
