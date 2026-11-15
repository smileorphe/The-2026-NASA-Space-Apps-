/**
 * Inspecteur de terrain et sites candidats (préparation).
 * Zone de retour : un point en fait partie si le retour au moindre coût vers A (champ de coût depuis A, coûts
 * symétriques) ≤ seuil = autonomie − réserve − (aller + observation) du plan courant (domain/autonomy.ts).
 */
import type { CrismClass, GeologicUnit, Overlays } from '../data';
import { minutesFor, returnZoneThreshold, type PlanCosts, type SimParams } from './autonomy';
import { crismAt, polygonCenter, unitAt } from './geo';
import type { LonLat } from './projection';
import { cellAt, isPassable, toGridXY, type TerrainGrid } from './terrain';

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

export interface Candidate {
  center: LonLat;
  areaM2: number;
  returnMin: number; // retour au moindre coût vers A
  marginIfChosen: number; // marge si B est placé ici (aller = retour au moindre coût)
}

/** Régions « Marginal Carbonates » dont le centre est dans la zone de retour, triées par temps de retour. */
export function candidateSites(g: TerrainGrid, overlays: Overlays, fromA: Float64Array, params: SimParams, costs: PlanCosts): Candidate[] {
  const threshold = returnZoneThreshold(params, costs);
  const out: Candidate[] = [];
  for (const f of overlays.crismRegions?.features ?? []) {
    if (f.properties.code !== 'MC') continue;
    const center = polygonCenter(f.geometry);
    const i = cellAt(g, center);
    if (i < 0 || !isPassable(g, i) || !Number.isFinite(fromA[i])) continue;
    const returnMin = minutesFor(fromA[i], params.speedKmh);
    if (returnMin > threshold) continue;
    const ring = (f.geometry.type === 'Polygon' ? (f.geometry.coordinates as LonLat[][])[0] : (f.geometry.coordinates as LonLat[][][])[0][0]).map((q) => toGridXY(g, q));
    let area = 0;
    for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) area += (ring[j][0] + ring[k][0]) * (ring[j][1] - ring[k][1]);
    out.push({ center, areaM2: Math.abs(area) / 2, returnMin, marginIfChosen: params.autonomy - (params.observation + 2 * returnMin) });
  }
  return out.sort((a, b) => a.returnMin - b.returnMin);
}
