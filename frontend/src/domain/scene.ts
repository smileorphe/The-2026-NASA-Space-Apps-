/**
 * Vue 3D du casque : géométrie pure (sans three.js), testable.
 *
 * Repère de la scène (mètres) : X vers l'est, Y vers le haut, Z vers le sud (Z = −nord), origine au centre de la
 * grille 5 m et à l'altitude du point A. Les positions au sol sont exprimées dans la projection des grilles
 * (pipeline : eqc lat_ts 18,55°, `toGridXY`), pas dans le repère local de la mission.
 *
 * Sol : DTM 1 m du couloir là où il existe, sinon grille 5 m, sinon anneau CTX ; interpolation bilinéaire
 * entre centres de cellules (comme le profil de route_analysis.json).
 * Exagération verticale : Y = (altitude − altitude de A) × exagération ; la hauteur des yeux (1,7 m) n'est pas exagérée.
 */
import type { MissionData, WaypointId } from '../data';
import type { LonLat } from './projection';
import { fromGridXY, toGridXY, type TerrainGrid } from './terrain';

export const EYE_HEIGHT_M = 1.7;
export const FOV_DEG = 70;

type XY = [number, number];
export type Vec3 = [number, number, number];

/** Description d'un fichier de terrain dans grid.json (`datasets`). */
export interface Dataset {
  file: string;
  width: number;
  height: number;
  cell_m: number;
  origin: { x: number; y: number }; // coin haut-gauche
  extent_local_m: [number, number, number, number]; // x0, y bas, x1, y haut
  extent_lonlat: [number, number, number, number];
  source: string;
  resolution: string;
  vertical_offset_m?: number;
}

/** Grille de valeurs (altitudes) alignée sur la projection des grilles. */
export interface Raster {
  width: number;
  height: number;
  cell_m: number;
  origin: { x: number; y: number };
  values: Float32Array;
}

export interface SceneData {
  grid: TerrainGrid;
  corridor: Raster; // DTM 1 m, NaN hors du couloir
  horizon: Raster; // DTM CTX réduit, aligné sur HiRISE
  ortho: Dataset;
  datasets: Record<string, Dataset>;
  center: XY; // origine de la scène (projection des grilles)
  baseAlt: number; // altitude de A (m)
}

export function rasterOf(d: Pick<Dataset, 'width' | 'height' | 'cell_m' | 'origin'>, values: Float32Array): Raster {
  if (values.length !== d.width * d.height) throw new Error('Grille de scène : taille incohérente avec grid.json');
  return { width: d.width, height: d.height, cell_m: d.cell_m, origin: d.origin, values };
}

const gridRaster = (g: TerrainGrid): Raster => ({ width: g.width, height: g.height, cell_m: g.cell_m, origin: g.origin, values: g.altitude });

/** Interpolation bilinéaire entre centres de cellules ; NaN hors de la grille ou si un voisin manque. */
export function sample(r: Raster, x: number, y: number): number {
  const c = (x - r.origin.x) / r.cell_m - 0.5;
  const l = (r.origin.y - y) / r.cell_m - 0.5;
  const c0 = Math.floor(c), l0 = Math.floor(l);
  if (c0 < 0 || l0 < 0 || c0 + 1 >= r.width || l0 + 1 >= r.height) return NaN;
  const fc = c - c0, fl = l - l0;
  const v = r.values, i = l0 * r.width + c0;
  return v[i] * (1 - fc) * (1 - fl) + v[i + 1] * fc * (1 - fl) + v[i + r.width] * (1 - fc) * fl + v[i + r.width + 1] * fc * fl;
}

/** Altitude du sol (m) au point (projection des grilles) : couloir 1 m, sinon 5 m, sinon CTX. */
export function groundAt(sd: Pick<SceneData, 'grid' | 'corridor' | 'horizon'>, x: number, y: number): number {
  for (const r of [sd.corridor, gridRaster(sd.grid), sd.horizon]) {
    const z = sample(r, x, y);
    if (Number.isFinite(z)) return z;
  }
  return NaN;
}

export function makeScene(grid: TerrainGrid, corridor: Raster, horizon: Raster, datasets: Record<string, Dataset>, a: LonLat): SceneData {
  const center: XY = [grid.origin.x + (grid.width * grid.cell_m) / 2, grid.origin.y - (grid.height * grid.cell_m) / 2];
  const [ax, ay] = toGridXY(grid, a);
  const sd = { grid, corridor, horizon, ortho: datasets.ortho, datasets, center, baseAlt: 0 };
  sd.baseAlt = groundAt(sd, ax, ay);
  return sd;
}

/** Point au sol (projection des grilles, altitude) → repère de la scène. */
export function toScene(sd: Pick<SceneData, 'center' | 'baseAlt'>, [x, y]: XY, alt: number, exag = 1): Vec3 {
  return [x - sd.center[0], (alt - sd.baseAlt) * exag, -(y - sd.center[1])];
}

/** Repère de la scène → point au sol (projection des grilles). */
export function fromScene(sd: Pick<SceneData, 'center'>, [X, , Z]: Vec3): XY {
  return [X + sd.center[0], -Z + sd.center[1]];
}

/** lon/lat → position au sol dans la scène (point posé sur le terrain). */
export function groundPoint(sd: SceneData, p: LonLat, exag = 1, lift = 0): Vec3 {
  const xy = toGridXY(sd.grid, p);
  const v = toScene(sd, xy, groundAt(sd, xy[0], xy[1]), exag);
  return [v[0], v[1] + lift, v[2]];
}

export function sceneToLonLat(sd: SceneData, v: Vec3): LonLat {
  return fromGridXY(sd.grid, fromScene(sd, v));
}

export interface CameraPose {
  position: Vec3;
  target: Vec3; // à hauteur des yeux, dans la direction du prochain point
  ground: number; // altitude du sol sous la caméra (m)
}

/** Caméra à 1,7 m au-dessus du sol, regard horizontal vers `toward` (lon/lat). */
export function cameraPose(sd: SceneData, here: LonLat, toward: LonLat | null, exag = 1): CameraPose {
  const xy = toGridXY(sd.grid, here);
  const ground = groundAt(sd, xy[0], xy[1]);
  const p = toScene(sd, xy, ground, exag);
  const position: Vec3 = [p[0], p[1] + EYE_HEIGHT_M, p[2]];
  let dir: XY = [0, -1]; // nord par défaut
  if (toward) {
    const t = toScene(sd, toGridXY(sd.grid, toward), 0);
    const dx = t[0] - p[0], dz = t[2] - p[2];
    const n = Math.hypot(dx, dz);
    if (n > 0.5) dir = [dx / n, dz / n];
  }
  return { position, target: [position[0] + dir[0] * 50, position[1], position[2] + dir[1] * 50], ground };
}

export interface Beacon {
  id: WaypointId;
  label: string;
  lonlat: LonLat;
  position: Vec3; // pied de la balise, posé au sol
}

/** Balises aux points du tracé (A, W1–W3, B), posées sur le sol. */
export function beacons(sd: SceneData, data: MissionData, exag = 1): Beacon[] {
  return data.waypoints.map((w) => {
    const lonlat = data.projection.toLonLat(w.xy);
    return { id: w.id, label: w.id === 'A' ? 'A · habitat' : w.id === 'B' ? 'B · site' : w.id, lonlat, position: groundPoint(sd, lonlat, exag) };
  });
}

/** Tracé drapé : sommets échantillonnés tous les `step` m, posés `lift` m au-dessus du sol. */
export function drape(sd: SceneData, path: LonLat[], exag = 1, step = 2, lift = 0.25): Vec3[] {
  const pts = path.map((p) => toGridXY(sd.grid, p));
  const out: Vec3[] = [];
  const push = (x: number, y: number) => {
    const z = groundAt(sd, x, y);
    if (Number.isFinite(z)) {
      const v = toScene(sd, [x, y], z, exag);
      out.push([v[0], v[1] + lift, v[2]]);
    }
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) push(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
  }
  if (pts.length) push(...pts[pts.length - 1]);
  return out;
}
