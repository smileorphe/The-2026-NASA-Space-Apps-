/** Tests point-dans-polygone sur les GeoJSON lon/lat (régions CRISM, unités géologiques). */
import type { CrismClass, CrismRegions, GeologicUnit, Overlays } from '../data';
import type { LonLat } from './projection';

type Ring = LonLat[];
interface Geometry {
  type: string;
  coordinates: unknown;
}

function inRing([x, y]: LonLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPolygon = (p: LonLat, rings: Ring[]) => inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h));

export function inGeometry(p: LonLat, g: Geometry): boolean {
  if (g.type === 'Polygon') return inPolygon(p, g.coordinates as Ring[]);
  if (g.type === 'MultiPolygon') return (g.coordinates as Ring[][]).some((poly) => inPolygon(p, poly));
  return false;
}

/** Unité géologique (USGS SIM 3464) au point, ou null. */
export function unitAt(geology: Overlays['geology'], p: LonLat): GeologicUnit | null {
  const f = geology?.features.find((f) => f.properties.kind === 'unit' && inGeometry(p, f.geometry));
  return f ? { symbol: String(f.properties.symbol), name: String(f.properties.name) } : null;
}

/** Classe CRISM (Zastrow & Glotch 2021) au point, ou null. */
export function crismAt(regions: CrismRegions | null, p: LonLat): CrismClass | null {
  const f = regions?.features.find((f) => inGeometry(p, f.geometry));
  if (!regions || !f) return null;
  const code = f.properties.code;
  return { code, ...regions.legend[code], source: regions.source };
}

/** Point représentatif d'un polygone (moyenne des sommets de l'anneau extérieur ; les régions CRISM sont des blocs de pixels). */
export function polygonCenter(g: Geometry): LonLat {
  const ring = (g.type === 'Polygon' ? (g.coordinates as Ring[])[0] : (g.coordinates as Ring[][])[0][0]).slice(0, -1);
  const n = ring.length;
  return [ring.reduce((a, p) => a + p[0], 0) / n, ring.reduce((a, p) => a + p[1], 0) / n];
}
