/**
 * Inspecteur de terrain et sites candidats (préparation).
 * Zone de retour : un point en fait partie si le retour au moindre coût vers A (champ de coût depuis A, coûts
 * symétriques) ≤ seuil = autonomie − réserve − (aller + observation) du plan courant (domain/autonomy.ts).
 */
import type { CrismClass, GeologicUnit, Overlays } from '../data';
import { minutesFor, returnZoneThreshold, type PlanCosts, type SimParams } from './autonomy';
import { crismAt, inGeometry, unitAt } from './geo';
import type { LonLat } from './projection';
import { cellAt, cellCenter, isPassable, toGridXY, type TerrainGrid } from './terrain';

export interface Inspection {
  lonlat: LonLat;
  inGrid: boolean;
  altitude: number | null; // m
  slope: number | null; // degrés
  passable: boolean; // pente ≤ 20° et donnée présente
  unit: GeologicUnit | null;
  crism: CrismClass | null;
  returnMin: number | null; // retour au moindre coût vers A, à la vitesse du plan
  inZone: boolean | null;
  thresholdMin: number;
}

export function inspectPoint(g: TerrainGrid, overlays: Overlays, fromA: Float64Array, p: LonLat, params: SimParams, costs: PlanCosts): Inspection {
  const i = cellAt(g, p);
  const thresholdMin = returnZoneThreshold(params, costs);
  const base = { lonlat: p, unit: unitAt(overlays.geology, p), crism: crismAt(overlays.crismRegions, p), thresholdMin };
  if (i < 0) return { ...base, inGrid: false, altitude: null, slope: null, passable: false, returnMin: null, inZone: null };
  const ret = Number.isFinite(fromA[i]) ? minutesFor(fromA[i], params.speedKmh) : null;
  const num = (v: number) => (Number.isFinite(v) ? v : null);
  return {
    ...base, inGrid: true, altitude: num(g.altitude[i]), slope: num(g.slope[i]), passable: isPassable(g, i),
    returnMin: ret, inZone: ret === null ? false : ret <= thresholdMin,
  };
}

/** Masque de la zone de retour : cellules dont le retour vers A coûte au plus `thresholdMin` à la vitesse donnée. */
export function zoneMask(fromA: Float64Array, thresholdMin: number, speedKmh: number): Uint8Array {
  const limit = thresholdMin * (speedKmh * 1000 / 60);
  const mask = new Uint8Array(fromA.length);
  for (let i = 0; i < fromA.length; i++) if (fromA[i] <= limit) mask[i] = 1;
  return mask;
}

/** Surface minimale d'un site candidat (m²) ; paramètre de démonstration. */
export const SITE_MIN_AREA_M2 = 5000;

export interface Candidate {
  center: LonLat; // cellule du site la plus proche de A en coût (là où B serait placé)
  areaM2: number;
  returnMin: number; // retour au moindre coût vers A
  marginIfChosen: number; // marge si B est placé ici (aller = retour au moindre coût)
}

const mcCache = new WeakMap<TerrainGrid, { overlays: Overlays; labels: Int32Array; mask: Uint8Array; count: number }>();

/** Rastérise les régions MC sur la grille (centres de cellules) et étiquette les régions fusionnées. */
function mcRegions(g: TerrainGrid, overlays: Overlays) {
  const hit = mcCache.get(g);
  if (hit && hit.overlays === overlays) return hit;
  const n = g.width * g.height;
  const mask = new Uint8Array(n);
  for (const f of overlays.crismRegions?.features ?? []) {
    if (f.properties.code !== 'MC') continue;
    const rings = f.geometry.type === 'Polygon' ? [(f.geometry.coordinates as LonLat[][])[0]] : (f.geometry.coordinates as LonLat[][][]).map((p) => p[0]);
    for (const ring of rings) {
      const xs = ring.map((q) => toGridXY(g, q));
      const c0 = Math.floor((Math.min(...xs.map((q) => q[0])) - g.origin.x) / g.cell_m), c1 = Math.floor((Math.max(...xs.map((q) => q[0])) - g.origin.x) / g.cell_m);
      const r0 = Math.floor((g.origin.y - Math.max(...xs.map((q) => q[1]))) / g.cell_m), r1 = Math.floor((g.origin.y - Math.min(...xs.map((q) => q[1]))) / g.cell_m);
      for (let r = Math.max(0, r0); r <= Math.min(g.height - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(g.width - 1, c1); c++) {
          const i = r * g.width + c;
          if (!mask[i] && inGeometry(cellCenter(g, i), f.geometry)) mask[i] = 1;
        }
      }
    }
  }
  // Étiquetage : deux cellules MC séparées d'au plus une cellule (distance de Tchebychev ≤ 2) sont dans la même région
  const labels = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || labels[i] >= 0) continue;
    const stack = [i];
    labels[i] = count;
    while (stack.length) {
      const u = stack.pop()!;
      const r = Math.floor(u / g.width), c = u % g.width;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.height || cc >= g.width) continue;
        const v = rr * g.width + cc;
        if (mask[v] && labels[v] < 0) {
          labels[v] = count;
          stack.push(v);
        }
      }
    }
    count++;
  }
  const out = { overlays, labels, mask, count };
  mcCache.set(g, out);
  return out;
}

/**
 * Sites candidats : régions « Marginal Carbonates » fusionnées, d'au moins `minAreaM2`, dont la cellule la plus proche
 * de A est dans la zone de retour ; triées par temps de retour.
 */
export function candidateSites(g: TerrainGrid, overlays: Overlays, fromA: Float64Array, params: SimParams, costs: PlanCosts, minAreaM2 = SITE_MIN_AREA_M2): Candidate[] {
  const threshold = returnZoneThreshold(params, costs);
  const { labels, mask, count } = mcRegions(g, overlays);
  const area = new Float64Array(count);
  const best = new Int32Array(count).fill(-1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l < 0 || !mask[i]) continue;
    area[l] += g.cell_m * g.cell_m;
    if (isPassable(g, i) && Number.isFinite(fromA[i]) && (best[l] < 0 || fromA[i] < fromA[best[l]])) best[l] = i;
  }
  const out: Candidate[] = [];
  for (let l = 0; l < count; l++) {
    if (area[l] < minAreaM2 || best[l] < 0) continue;
    const returnMin = minutesFor(fromA[best[l]], params.speedKmh);
    if (returnMin > threshold) continue;
    out.push({ center: cellCenter(g, best[l]), areaM2: area[l], returnMin, marginIfChosen: params.autonomy - (params.observation + 2 * returnMin) });
  }
  return out.sort((a, b) => a.returnMin - b.returnMin);
}
