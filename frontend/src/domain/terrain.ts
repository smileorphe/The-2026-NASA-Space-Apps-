/**
 * Grilles de terrain exportées par pipeline/terrain_export.py (extrait 5 m, public/data/terrain/).
 * Projection : équirectangulaire lat_ts 18,55° sur la sphère Mars 2000 (pixels carrés, mètres réels).
 * Cellule (r, c) : ligne r depuis le haut (nord), colonne c vers l'est ; index = r × width + c.
 */
import type { LonLat } from './projection';

const RAD = Math.PI / 180;

export interface GridMeta {
  width: number;
  height: number;
  cell_m: number;
  origin: { x: number; y: number }; // coin haut-gauche de la cellule (0, 0)
  projection: { lat_ts: number; lon_0: number; radius_m: number };
  files: { altitude: string; slope: string; cost: string };
  cost: { alpha_per_deg: number; sand_factor: number; slope_max_deg: number };
}

export interface TerrainGrid extends Omit<GridMeta, 'cost'> {
  costParams: GridMeta['cost'];
  altitude: Float32Array; // m, NaN = NoData
  slope: Float32Array; // degrés, NaN = NoData
  cost: Float32Array; // multiplicateur (m de plat par m) ; < 0 = interdit
}

export function makeGrid(meta: GridMeta, altitude: Float32Array, slope: Float32Array, cost: Float32Array): TerrainGrid {
  const n = meta.width * meta.height;
  if (altitude.length !== n || slope.length !== n || cost.length !== n) throw new Error('Grilles de terrain : taille incohérente avec grid.json');
  const { cost: costParams, ...rest } = meta;
  return { ...rest, costParams, altitude, slope, cost };
}

type Geo = Pick<GridMeta, 'projection' | 'origin' | 'cell_m' | 'width' | 'height'>;

/** lon/lat Mars 2000 → mètres en projection de la grille. */
export function toGridXY(g: Geo, [lon, lat]: LonLat): [number, number] {
  const { lat_ts, lon_0, radius_m } = g.projection;
  return [radius_m * Math.cos(lat_ts * RAD) * (lon - lon_0) * RAD, radius_m * lat * RAD];
}

export function fromGridXY(g: Geo, [x, y]: [number, number]): LonLat {
  const { lat_ts, lon_0, radius_m } = g.projection;
  return [lon_0 + x / (radius_m * Math.cos(lat_ts * RAD) * RAD), y / (radius_m * RAD)];
}

/** Index de la cellule contenant le point, ou −1 hors de la grille. */
export function cellAt(g: Geo, p: LonLat): number {
  const [x, y] = toGridXY(g, p);
  const c = Math.floor((x - g.origin.x) / g.cell_m);
  const r = Math.floor((g.origin.y - y) / g.cell_m);
  return r < 0 || c < 0 || r >= g.height || c >= g.width ? -1 : r * g.width + c;
}

export function cellCenter(g: Geo, i: number): LonLat {
  const r = Math.floor(i / g.width);
  const c = i % g.width;
  return fromGridXY(g, [g.origin.x + (c + 0.5) * g.cell_m, g.origin.y - (r + 0.5) * g.cell_m]);
}

export const isPassable = (g: TerrainGrid, i: number) => i >= 0 && Number.isFinite(g.cost[i]) && g.cost[i] >= 0;

/** Cellule de sable : coût / (1 + α·pente) ≈ facteur sable (le sable n'est pas exporté à part). */
export function isSand(g: TerrainGrid, i: number): boolean {
  const base = 1 + g.costParams.alpha_per_deg * g.slope[i];
  return isPassable(g, i) && g.cost[i] / base > (1 + g.costParams.sand_factor) / 2;
}
