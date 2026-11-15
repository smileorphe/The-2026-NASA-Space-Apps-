import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { astar, costField } from './routing';
import { cellAt, makeGrid, type GridMeta, type TerrainGrid } from './terrain';

const dir = new URL('../../public/data/terrain/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('grid.json', dir), 'utf8')) as GridMeta & {
  references: {
    cells: Record<string, [number, number]>;
    least_cost_m: { from: string; to: string; cost_m: number }[];
    shortest_m: { from: string; to: string; cost_m: number }[];
    cost_from_A_m: Record<string, number>;
    cell_centers_lonlat: { cell: [number, number]; lonlat: [number, number] }[];
  };
};
const f32 = (name: string) => {
  const buf = readFileSync(new URL(name, dir));
  return new Float32Array(new Uint8Array(buf).buffer); // copie alignée
};
const grid: TerrainGrid = makeGrid(meta, f32(meta.files.altitude), f32(meta.files.slope), f32(meta.files.cost));
const ref = meta.references;
const idx = (name: string) => ref.cells[name][0] * meta.width + ref.cells[name][1];

describe('grille de terrain', () => {
  it('conversion lon/lat → cellule identique au pipeline', () => {
    for (const { cell, lonlat } of ref.cell_centers_lonlat) expect(cellAt(grid, lonlat)).toBe(cell[0] * meta.width + cell[1]);
  });
});

describe('routage (même coût que le pipeline, à 1 % près)', () => {
  it.each(ref.least_cost_m)('moindre coût $from → $to', ({ from, to, cost_m }) => {
    const r = astar(grid, idx(from), idx(to))!;
    expect(r).not.toBeNull();
    expect(Math.abs(r.costM - cost_m) / cost_m).toBeLessThan(0.01);
    expect(r.cells[0]).toBe(idx(from));
    expect(r.cells[r.cells.length - 1]).toBe(idx(to));
  });

  it.each(ref.shortest_m)('plus court $from → $to', ({ from, to, cost_m }) => {
    const r = astar(grid, idx(from), idx(to), 'uniform')!;
    expect(Math.abs(r.costM - cost_m) / cost_m).toBeLessThan(0.01);
  });

  it('aucune cellule interdite (pente > 20°) sur l’itinéraire', () => {
    const r = astar(grid, idx('A'), idx('B'))!;
    for (const i of r.cells) expect(grid.slope[i]).toBeLessThanOrEqual(meta.cost.slope_max_deg);
  });

  it('champ de coût depuis A (zone de retour) identique au pipeline', () => {
    const field = costField(grid, idx('A'));
    for (const [name, cost] of Object.entries(ref.cost_from_A_m)) expect(Math.abs(field[idx(name)] - cost) / cost).toBeLessThan(0.01);
  });
});
