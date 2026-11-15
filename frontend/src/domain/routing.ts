/**
 * Routage sur la grille de coût (même modèle que pipeline/ et skimage.graph.MCP_Geometric) :
 * 8 voisins ; coût d'un pas = (c1 + c2) / 2 × longueur du pas (cellule ou diagonale) ; cellules à coût < 0 interdites
 * (pente > 20° ou NoData). Résultat en « m de plat ».
 * - `astar` : itinéraire de moindre coût entre deux cellules (heuristique admissible : distance × coût minimal 1) ;
 * - `costField` : coût minimal depuis une cellule vers toutes les autres (Dijkstra), pour la zone de retour.
 * Les coûts étant symétriques, le retour B → A a le même coût que l'aller A → B au moindre coût.
 */
import { isPassable, type TerrainGrid } from './terrain';

export type CostMode = 'cost' | 'uniform'; // uniform : « plus court », coût 1 partout où c'est permis

const SQRT2 = Math.SQRT2;
const STEPS = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, SQRT2], [-1, 1, SQRT2], [1, -1, SQRT2], [1, 1, SQRT2],
] as const;

/** File de priorité minimale (tas binaire), entrées dupliquées tolérées (suppression paresseuse). */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.keys, v = this.vals;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const cellCost = (g: TerrainGrid, i: number, mode: CostMode) => (mode === 'uniform' ? 1 : g.cost[i]);

function* neighbours(g: TerrainGrid, i: number): Generator<[number, number]> {
  const r = Math.floor(i / g.width), c = i % g.width;
  for (const [dr, dc, len] of STEPS) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= g.height || cc >= g.width) continue;
    const j = rr * g.width + cc;
    if (isPassable(g, j)) yield [j, len];
  }
}

export interface RouteResult {
  cells: number[]; // de la cellule de départ à l'arrivée
  costM: number; // m de plat
}

/** Itinéraire de moindre coût ; null si départ / arrivée interdits ou inaccessibles. */
export function astar(g: TerrainGrid, start: number, goal: number, mode: CostMode = 'cost'): RouteResult | null {
  if (!isPassable(g, start) || !isPassable(g, goal)) return null;
  const n = g.width * g.height;
  const gScore = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gr = Math.floor(goal / g.width), gc = goal % g.width;
  const h = (i: number) => Math.hypot(Math.floor(i / g.width) - gr, (i % g.width) - gc) * g.cell_m; // coût min = 1
  const heap = new MinHeap();
  gScore[start] = 0;
  heap.push(h(start), start);
  while (heap.size) {
    const [, u] = heap.pop();
    if (closed[u]) continue;
    if (u === goal) break;
    closed[u] = 1;
    const cu = cellCost(g, u, mode);
    for (const [v, len] of neighbours(g, u)) {
      if (closed[v]) continue;
      const tentative = gScore[u] + ((cu + cellCost(g, v, mode)) / 2) * len * g.cell_m;
      if (tentative < gScore[v]) {
        gScore[v] = tentative;
        from[v] = u;
        heap.push(tentative + h(v), v);
      }
    }
  }
  if (!Number.isFinite(gScore[goal])) return null;
  const cells = [goal];
  while (cells[cells.length - 1] !== start) cells.push(from[cells[cells.length - 1]]);
  return { cells: cells.reverse(), costM: gScore[goal] };
}

/** Coût minimal (m de plat) depuis `start` vers chaque cellule ; Infinity si inaccessible. */
export function costField(g: TerrainGrid, start: number): Float64Array {
  const n = g.width * g.height;
  const dist = new Float64Array(n).fill(Infinity);
  if (!isPassable(g, start)) return dist;
  const heap = new MinHeap();
  dist[start] = 0;
  heap.push(0, start);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    const cu = g.cost[u];
    for (const [v, len] of neighbours(g, u)) {
      const nd = d + ((cu + g.cost[v]) / 2) * len * g.cell_m;
      if (nd < dist[v]) {
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
  }
  return dist;
}
