/**
 * Obstacle recalculé (remplace le détour prédéfini).
 * Les cellules dont le centre est à moins de `radiusM` d'un obstacle sont bloquées ; l'A* recalcule :
 * - « poursuivre » : position actuelle → B en contournant, puis retour B → A en contournant aussi ;
 * - « rentrer » : position actuelle → A en contournant.
 * Chaque option porte sa marge (formule unique, domain/autonomy.ts) et est refusée si la marge passe sous la réserve.
 * Si la position actuelle est dans la zone bloquée (obstacle signalé « ici »), l'itinéraire recule d'abord le long du
 * trajet déjà parcouru jusqu'à la première cellule libre ; ce recul est compté dans le coût.
 */
import type { MissionData } from '../data';
import { isAllowed, margin, minutesFor } from './autonomy';
import { budgetOf, type MissionState, type Obstacle, positionOf } from './mission';
import { summarise } from './plan';
import type { LonLat } from './projection';
import { astar } from './routing';
import { cellAt, toGridXY, type TerrainGrid } from './terrain';

/** Masque des cellules bloquées par les obstacles. */
export function blockedMask(g: TerrainGrid, obstacles: Pick<Obstacle, 'lonlat' | 'radiusM'>[]): Uint8Array {
  const mask = new Uint8Array(g.width * g.height);
  for (const o of obstacles) {
    const [ox, oy] = toGridXY(g, o.lonlat);
    const c0 = Math.floor((ox - g.origin.x) / g.cell_m), r0 = Math.floor((g.origin.y - oy) / g.cell_m);
    const k = Math.ceil(o.radiusM / g.cell_m) + 1;
    for (let r = r0 - k; r <= r0 + k; r++) {
      for (let c = c0 - k; c <= c0 + k; c++) {
        if (r < 0 || c < 0 || r >= g.height || c >= g.width) continue;
        const cx = g.origin.x + (c + 0.5) * g.cell_m, cy = g.origin.y - (r + 0.5) * g.cell_m;
        if (Math.hypot(cx - ox, cy - oy) <= o.radiusM) mask[r * g.width + c] = 1;
      }
    }
  }
  return mask;
}

export interface ObstacleOption {
  kind: 'continue' | 'back';
  label: string;
  detail: string;
  path: LonLat[]; // tracé à suivre (lon/lat)
  returnPath?: LonLat[]; // pour « poursuivre » : retour B → A en contournant
  allerRestant: number; // min
  retour: number; // min
  margin: number; // min (arrondie)
  ok: boolean; // marge ≥ réserve
}

interface Leg {
  cells: number[];
  costM: number;
}

/** Sortie de la zone bloquée : de `here` à la première cellule libre du trajet parcouru (en remontant), sans obstacle. */
function exitBlocked(g: TerrainGrid, data: MissionData, s: MissionState, blocked: Uint8Array, here: number): Leg | null {
  if (!blocked[here]) return { cells: [here], costM: 0 };
  for (const p of [...s.trail].reverse().concat([data.route[0]])) {
    const c = cellAt(g, data.projection.toLonLat(p));
    if (c < 0 || blocked[c]) continue;
    return astar(g, here, c, 'cost');
  }
  return null;
}

const join = (a: Leg, b: Leg): Leg => ({ cells: a.cells.concat(b.cells.slice(1)), costM: a.costM + b.costM });

/** Options face aux obstacles présents, depuis la position simulée actuelle. */
export function obstacleOptions(g: TerrainGrid, data: MissionData, s: MissionState): ObstacleOption[] {
  const blocked = blockedMask(g, s.obstacles);
  const v = s.params.speedKmh;
  const b = budgetOf(s, data);
  const here = cellAt(g, data.projection.toLonLat(positionOf(s, data).p));
  const A = cellAt(g, data.projection.toLonLat(data.route[0]));
  const B = cellAt(g, data.projection.toLonLat(data.waypoints[data.waypoints.length - 1].xy));
  const out: ObstacleOption[] = [];

  const exit = here >= 0 ? exitBlocked(g, data, s, blocked, here) : null;
  if (!exit) return [];
  const start = exit.cells[exit.cells.length - 1];
  const ahead = astar(g, start, B, 'cost', blocked);
  const toB = ahead ? join(exit, ahead) : null;
  const fromB = toB ? astar(g, B, A, 'cost', blocked) : null;
  if (toB && fromB) {
    const go = summarise(g, toB.cells);
    const back = summarise(g, fromB.cells);
    const allerRestant = minutesFor(toB.costM, v);
    const retour = minutesFor(fromB.costM, v);
    const m = Math.round(margin({ autonomy: b.autonomy, allerRestant, observation: b.observation, retour }));
    out.push({
      kind: 'continue', label: 'Contourner et poursuivre vers B', detail: `${Math.round(go.distance_m)} m jusqu’à B · retour ${Math.round(back.distance_m)} m, obstacle évité`,
      path: go.path, returnPath: back.path, allerRestant, retour, margin: m, ok: isAllowed(m, s.params.reserve),
    });
  }
  const back = astar(g, start, A, 'cost', blocked);
  const home = back ? join(exit, back) : null;
  if (home) {
    const h = summarise(g, home.cells);
    const retour = minutesFor(home.costM, v);
    const m = Math.round(margin({ autonomy: b.autonomy, allerRestant: 0, observation: 0, retour }));
    out.push({ kind: 'back', label: 'Rentrer à l’habitat', detail: `${Math.round(h.distance_m)} m, obstacle évité · objectif scientifique abandonné`, path: h.path, allerRestant: 0, retour, margin: m, ok: isAllowed(m, s.params.reserve) });
  }
  return out;
}
