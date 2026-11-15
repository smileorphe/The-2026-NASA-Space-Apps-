import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMissionData, type CrismRegions, type Overlays, type RawFiles } from '../data';
import { plannedDurations, returnZoneThreshold } from './autonomy';
import { zoneMask } from './inspect';
import { type Action, type MissionState, defaultParams, initialState, planCosts, reduce } from './mission';
import { blockedMask, obstacleOptions } from './obstacle';
import { buildPlan, withPlan } from './plan';
import { astar, costField } from './routing';
import { cellAt, cellCenter, makeGrid, type GridMeta } from './terrain';

const pub = (f: string) => new URL(`../../public/data/${f}`, import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(pub(f), 'utf8'));
const meta = read('terrain/grid.json') as GridMeta;
const f32 = (f: string) => new Float32Array(new Uint8Array(readFileSync(pub(`terrain/${f}`))).buffer);
const grid = makeGrid(meta, f32('altitude.f32'), f32('slope.f32'), f32('cost.f32'));
const overlays: Overlays = { crismRegions: read('crism_regions.geojson') as CrismRegions, geology: read('geology.geojson'), crismFootprint: null, routes: null };
const data = buildMissionData({
  aller: read('route_aller.geojson'), scenarios: read('scenarios.json'), layersFile: read('layers.json'),
  analysis: read('route_analysis.json') as RawFiles['analysis'], source: 'pipeline', overlays,
});
const A = cellAt(grid, data.projection.toLonLat(data.route[0]));
const B = cellAt(grid, data.projection.toLonLat(data.waypoints[data.waypoints.length - 1].xy));

const run = (s: MissionState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a, data), s);
const advance = (s: MissionState, minutes: number) => {
  for (let i = 0; i < minutes * 4; i++) s = reduce(s, { type: 'TICK', dt: 0.25 }, data);
  return s;
};

describe('obstacle recalculé', () => {
  it('un obstacle sur l’itinéraire force un contournement de coût supérieur', () => {
    const free = astar(grid, A, B)!;
    const mid = cellCenter(grid, free.cells[Math.floor(free.cells.length / 2)]);
    const blocked = blockedMask(grid, [{ lonlat: mid, radiusM: 15 }]);
    expect(blocked.reduce((n, v) => n + v, 0)).toBeGreaterThan(20); // disque de 15 m sur des cellules de 5 m
    const around = astar(grid, A, B, 'cost', blocked)!;
    expect(around).not.toBeNull();
    expect(around.costM).toBeGreaterThan(free.costM);
    expect(around.cells.some((c) => blocked[c])).toBe(false);
  });

  it('deux options depuis la position actuelle ; une option sous la réserve est refusée', () => {
    // Tracé A* vers le B de référence (moindre coût : tout contournement coûte plus) et marge au départ au ras de la réserve
    const r = buildPlan(grid, overlays, data.projection.toLonLat(data.route[0]), data.projection.toLonLat(data.waypoints[data.waypoints.length - 1].xy));
    if (!r.ok) throw new Error(r.reason);
    const planned = withPlan(data, r.plan);
    const { aller, retour } = plannedDurations(planCosts(planned), 3.3);
    const params = { ...defaultParams(data), autonomy: aller + 15 + retour + 19.6 }; // marge 19,6 → affichée 20 = réserve
    let s = reduce(initialState(params, data), { type: 'SET_PLAN', plan: r.plan }, data);
    s = advance(run(s, { type: 'LAUNCH' }), aller * 0.2);
    expect(s.phase).toBe('eva');

    // Obstacle placé par l'habitat au point du trajet restant où le contournement coûte le plus (≈ 16 m de plat)
    const free = astar(grid, A, B)!;
    s = run(s, { type: 'OBSTACLE', source: 'HABITAT', lonlat: cellCenter(grid, free.cells[217]) });
    expect(s.incident?.id).toBe('obstacle');
    expect(s.clock.speed).toBe(0);
    expect(s.obstacles).toHaveLength(1);
    expect(run(s, { type: 'RETURN_NOW', source: 'TABLETTE' })).toBe(s); // pas de retour par le tracé connu avant la décision

    const opts = obstacleOptions(grid, planned, s);
    const go = opts.find((o) => o.kind === 'continue')!;
    const back = opts.find((o) => o.kind === 'back')!;
    expect(go.ok).toBe(false);
    expect(go.margin).toBeLessThan(params.reserve);
    expect(run(s, { type: 'CHOOSE_OBSTACLE_OPTION', kind: 'continue', path: go.path, allerRestant: go.allerRestant, retour: go.retour, returnPath: go.returnPath })).toBe(s);

    expect(back.ok).toBe(true);
    const next = run(s, { type: 'CHOOSE_OBSTACLE_OPTION', kind: 'back', path: back.path, allerRestant: 0, retour: back.retour });
    expect(next.leg?.kind).toBe('back');
    expect(next.log[next.log.length - 1].text).toContain('Décision');
    expect(next.obstacles).toHaveLength(1); // l'obstacle reste jusqu'à la fin de la sortie
  });
});

describe('obstacle signalé par la tablette', () => {
  it('à la position actuelle : recul hors de la zone bloquée puis deux options', () => {
    let s = advance(run(initialState(defaultParams(data), data), { type: 'LAUNCH' }), 7);
    s = run(s, { type: 'OBSTACLE', source: 'TABLETTE' });
    expect(s.obstacles[0].source).toBe('TABLETTE');
    expect(s.log[s.log.length - 1].pos).toEqual(s.obstacles[0].lonlat);
    const blocked = blockedMask(grid, s.obstacles);
    expect(blocked[cellAt(grid, s.obstacles[0].lonlat)]).toBe(1); // l'astronaute est dans la zone bloquée
    const opts = obstacleOptions(grid, data, s);
    expect(opts.map((o) => o.kind)).toEqual(['continue', 'back']);
    for (const o of opts) expect(o.ok).toBe(true);
  });
});

describe('zone de retour calculée dans le navigateur', () => {
  const zone = read('return_zone.geojson');
  const ref = zone.features[0].properties;
  const params = defaultParams(data);

  it('correspond à celle du pipeline pour le B de référence', () => {
    const threshold = returnZoneThreshold(params, planCosts(data));
    expect(threshold).toBeCloseTo(zone.parameters.threshold_min, 1);
    const mask = zoneMask(costField(grid, A), threshold, params.speedKmh);
    expect(mask[B] === 1).toBe(ref.contains_B);
    const areaKm2 = (mask.reduce((n, v) => n + v, 0) * meta.cell_m ** 2) / 1e6;
    expect(Math.abs(areaKm2 - ref.area_km2) / ref.area_km2).toBeLessThan(0.02);
  });
});
