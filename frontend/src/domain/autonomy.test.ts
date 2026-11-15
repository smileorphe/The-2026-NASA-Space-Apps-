import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RouteAnalysis } from '../data';

/** Zone de retour du pipeline (paths.py), référence pour les contrôles de cohérence. */
interface ReturnZone {
  parameters: { threshold_min: number; threshold_cost_m: number; aller_min: number; autonomy_min: number; reserve_min: number; observation_min: number; speed_kmh: number };
  features: { properties: { contains_B: boolean; return_min_from_B: number; return_cost_from_B_m: number; area_km2: number } }[];
}
import {
  isAllowed,
  latestLeaveB,
  margin,
  minutesFor,
  plannedDurations,
  plannedMargin,
  returnZoneThreshold,
  type SimParams,
  statusOf,
} from './autonomy';

const read = <T,>(f: string): T => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
const analysis = read<RouteAnalysis>('route_analysis.json');
const zone = read<ReturnZone>('return_zone.geojson');
const costs = { allerCostM: analysis.aller.cost_m, retourCostM: analysis.return.cost_m };
const d = analysis.defaults;
const DEFAULTS: SimParams = { autonomy: d.autonomy_min, speedKmh: d.speed_kmh, observation: d.observation_min, reserve: d.reserve_min };

describe('formule d’autonomie (spec §4)', () => {
  it('marge = autonomie − (aller + observation + retour)', () => {
    expect(margin({ autonomy: 120, allerRestant: 35, observation: 15, retour: 40 })).toBe(30);
    expect(statusOf(30, 20)).toBe('green');
    expect(statusOf(20, 20)).toBe('amber');
    expect(statusOf(19, 20)).toBe('red');
    expect(isAllowed(19, 20)).toBe(false);
  });

  it('heure limite pour quitter B', () => {
    expect(latestLeaveB(35, 85, 40, 20)).toBe(60); // arrivée T+35, autonomie à B 85, retour 40, réserve 20
  });
});

describe('durées issues des coûts du terrain', () => {
  it('durée = coût ÷ vitesse ; aller = somme des segments, retour = moindre coût B → A', () => {
    expect(minutesFor(55, 3.3)).toBeCloseTo(1, 10); // 3,3 km/h = 55 m/min
    const sum = analysis.segments.reduce((a, s) => a + s.cost_m, 0);
    expect(analysis.aller.cost_m).toBeCloseTo(sum, 0);
    const { aller, retour } = plannedDurations(costs, d.speed_kmh);
    expect(aller).toBeCloseTo(analysis.nominal.aller_min, 0);
    expect(retour).toBeCloseTo(analysis.nominal.retour_min, 0);
  });

  it('la vitesse modifie les durées en proportion inverse', () => {
    const slow = plannedDurations(costs, 2.4);
    const fast = plannedDurations(costs, 3.3);
    expect(slow.aller / fast.aller).toBeCloseTo(3.3 / 2.4, 10);
  });

  it('valeurs par défaut : marge nominale ≈ 30 min, statut vert', () => {
    const m = plannedMargin(DEFAULTS, costs);
    expect(Math.abs(m - 30)).toBeLessThanOrEqual(5);
    expect(m).toBe(Math.round(analysis.nominal.margin_min));
    expect(statusOf(m, DEFAULTS.reserve)).toBe('green');
  });

  it('+10 min d’observation : accepté ; +15 min : refusé (sous la réserve)', () => {
    const m10 = plannedMargin({ ...DEFAULTS, observation: DEFAULTS.observation + 10 }, costs);
    const m15 = plannedMargin({ ...DEFAULTS, observation: DEFAULTS.observation + 15 }, costs);
    expect(isAllowed(m10, DEFAULTS.reserve)).toBe(true);
    expect(isAllowed(m15, DEFAULTS.reserve)).toBe(false);
  });
});

describe('cohérence zone de retour ↔ marge', () => {
  const zp = zone.parameters;
  const zb = zone.features[0].properties;

  it('la zone utilise les mêmes paramètres, le même coût et la même vitesse que la marge', () => {
    expect(zp.autonomy_min).toBe(DEFAULTS.autonomy);
    expect(zp.reserve_min).toBe(DEFAULTS.reserve);
    expect(zp.observation_min).toBe(DEFAULTS.observation);
    expect(zp.speed_kmh).toBe(DEFAULTS.speedKmh);
    expect(zp.threshold_min).toBeCloseTo(returnZoneThreshold(DEFAULTS, costs), 1);
    expect(zb.return_cost_from_B_m).toBeCloseTo(analysis.return.cost_m, 0);
  });

  it('B est dans la zone ⇔ marge nominale ≥ réserve', () => {
    const { aller, retour } = plannedDurations(costs, DEFAULTS.speedKmh);
    const rawMargin = margin({ autonomy: DEFAULTS.autonomy, allerRestant: aller, observation: DEFAULTS.observation, retour });
    expect(zb.contains_B).toBe(rawMargin >= DEFAULTS.reserve);
    expect(zb.contains_B).toBe(retour <= returnZoneThreshold(DEFAULTS, costs));
  });
});
