import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMissionData, type CrismRegions, type Overlays, type RawFiles } from '../data';
import { isAllowed, plannedMargin } from './autonomy';
import { defaultParams, deriveView, initialState, planCosts, reduce, type MissionState } from './mission';
import { buildPlan, withPlan, type CustomPlan } from './plan';
import { candidateSites, inspectPoint } from './inspect';
import { costField } from './routing';
import { cellAt, cellCenter, makeGrid, type GridMeta } from './terrain';

const pub = (f: string) => new URL(`../../public/data/${f}`, import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(pub(f), 'utf8'));
const meta = read('terrain/grid.json') as GridMeta & { references: { cells: Record<string, [number, number]>; least_cost_m: { from: string; to: string; cost_m: number }[] } };
const f32 = (f: string) => new Float32Array(new Uint8Array(readFileSync(pub(`terrain/${f}`))).buffer);
const grid = makeGrid(meta, f32('altitude.f32'), f32('slope.f32'), f32('cost.f32'));
const overlays: Overlays = { crismRegions: read('crism_regions.geojson') as CrismRegions, geology: read('geology.geojson'), crismFootprint: null, routes: null, returnZone: null };
const base = buildMissionData({
  aller: read('route_aller.geojson'), detour: read('route_detour.geojson'), scenarios: read('scenarios.json'),
  layersFile: read('layers.json'), analysis: read('route_analysis.json') as RawFiles['analysis'], source: 'pipeline', overlays,
});
const A = base.projection.toLonLat(base.route[0]);
const at = (name: string) => cellCenter(grid, meta.references.cells[name][0] * meta.width + meta.references.cells[name][1]);
const plan = (name: string): CustomPlan => {
  const r = buildPlan(grid, overlays, A, at(name));
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
};

describe('plan pour un B choisi sur la carte', () => {
  it('B de référence : même coût que le pipeline (1 %), retour = aller, W1–W3 sur le tracé', () => {
    const p = plan('B');
    const ref = meta.references.least_cost_m.find((r) => r.to === 'B')!.cost_m;
    expect(Math.abs(p.allerCostM - ref) / ref).toBeLessThan(0.01);
    expect(p.retourCostM).toBe(p.allerCostM);
    const sum = p.segments.reduce((s, x) => s + x.cost_m, 0);
    expect(sum).toBeCloseTo(p.allerCostM, 3);
    expect(p.max_slope_deg).toBeLessThanOrEqual(20);
    for (const id of ['W1', 'W2', 'W3'] as const) expect(p.route).toContainEqual(p.waypoints[id]);
    expect(p.crismClass?.code).toBe('MC');
  });

  it('simulation : départ, arrivée à B à la durée aller, retour par le même chemin', () => {
    const p = plan('MC2');
    let s: MissionState = reduce(initialState(defaultParams(base), base), { type: 'SET_PLAN', plan: p }, base);
    expect(s.plan?.id).toBe(p.id);
    const data = withPlan(base, s.plan);
    expect(deriveView(s, data).margin).toBe(plannedMargin(s.params, planCosts(data)));
    s = reduce(s, { type: 'LAUNCH' }, base);
    const aller = deriveView(s, data).budget.allerRestant;
    for (let i = 0; i < (aller + 1) * 4; i++) s = reduce(s, { type: 'TICK', dt: 0.25 }, base);
    expect(s.leg?.kind).toBe('site');
    expect(s.reached.B).toBeCloseTo(aller, 0);
    s = reduce(s, { type: 'RETURN_NOW', source: 'TABLETTE' }, base);
    expect(s.leg?.path).toEqual(data.returnPath);
  });

  it('refus si la marge passe sous la réserve', () => {
    const p = plan('MC3'); // le plus éloigné des points de contrôle
    const tight = { ...defaultParams(base), autonomy: 120 };
    const m = plannedMargin(tight, planCosts(withPlan(base, p)));
    expect(isAllowed(m, tight.reserve)).toBe(false);
    const s = initialState(tight, base);
    expect(reduce(s, { type: 'SET_PLAN', plan: p }, base)).toBe(s);
  });

  it('le scénario « obstacle » n’existe que pour le tracé de référence', () => {
    expect(withPlan(base, plan('MC1')).scenarios.obstacle).toBeUndefined();
    expect(withPlan(base, null).scenarios.obstacle).toBeDefined();
  });
});

describe('inspecteur et sites candidats', () => {
  const field = costField(grid, cellAt(grid, A));
  const params = defaultParams(base);
  const costs = planCosts(base);

  it('au point B de référence : région MC, unité Nue, dans la zone de retour', () => {
    const b = base.projection.toLonLat(base.waypoints.find((w) => w.id === 'B')!.xy);
    const info = inspectPoint(grid, overlays, field, b, params, costs);
    expect(info.crism?.code).toBe('MC');
    expect(info.unit?.symbol).toBe('Nue');
    expect(info.passable).toBe(true);
    expect(info.inZone).toBe(true);
    expect(info.returnMin!).toBeCloseTo(base.analysis.nominal.retour_min, 0);
  });

  it('sites candidats : régions MC dans la zone, triées par temps de retour', () => {
    const sites = candidateSites(grid, overlays, field, params, costs);
    expect(sites.length).toBeGreaterThan(0);
    for (let k = 1; k < sites.length; k++) expect(sites[k].returnMin).toBeGreaterThanOrEqual(sites[k - 1].returnMin);
    for (const c of sites) {
      expect(c.returnMin).toBeLessThanOrEqual(inspectPoint(grid, overlays, field, c.center, params, costs).thresholdMin + 1e-9);
      expect(inspectPoint(grid, overlays, field, c.center, params, costs).crism?.code).toBe('MC');
    }
  });
});
