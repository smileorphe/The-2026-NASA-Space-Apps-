import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMissionData, type RawFiles } from '../data';
import { isAllowed } from './autonomy';
import { type Action, type MissionState, defaultParams, deriveView, initialState, momentAt, optionMargin, plannedTimeAt, reduce } from './mission';

const read = (f: string) => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
const data = buildMissionData({
  aller: read('route_aller.geojson'),
  scenarios: read('scenarios.json'),
  layersFile: read('layers.json'),
  analysis: read('route_analysis.json') as RawFiles['analysis'],
  source: 'pipeline',
});
const nominal = data.analysis.nominal;
const start = () => initialState(defaultParams(data), data);

const run = (s: MissionState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a, data), s);
/** Avance l'horloge par pas de 0,25 min, comme l'habitat le ferait à ×60. */
const advance = (s: MissionState, minutes: number) => {
  for (let i = 0; i < minutes * 4; i++) s = reduce(s, { type: 'TICK', dt: 0.25 }, data);
  return s;
};
const toB = () => advance(run(start(), { type: 'LAUNCH' }), nominal.aller_min + 1);

describe('simulation de la sortie', () => {
  it('lancement : marge nominale, horloge à 0, départ journalisé', () => {
    const s = run(start(), { type: 'LAUNCH' });
    expect(s.phase).toBe('eva');
    expect(deriveView(s, data).margin).toBe(Math.round(nominal.margin_min));
    expect(s.log[0].text).toContain('Départ');
  });

  it('départ bloqué si la marge passe sous la réserve', () => {
    const s = run(initialState({ ...defaultParams(data), autonomy: 100 }, data), { type: 'LAUNCH' });
    expect(s.phase).toBe('prep');
  });

  it('les waypoints sont atteints à l’heure prévue par le coût du terrain', () => {
    const s = advance(run(start(), { type: 'LAUNCH' }), plannedTimeAt(start(), data, data.waypoints[3]) + 0.5);
    for (const w of data.waypoints.slice(1, 4)) {
      expect(s.reached[w.id]).toBeDefined();
      expect(Math.abs(s.reached[w.id]! - plannedTimeAt(s, data, w))).toBeLessThanOrEqual(0.5); // un pas d'horloge
    }
    expect(deriveView(s, data).margin).toBe(Math.round(nominal.margin_min));
  });

  it('arrivée au point B à la durée aller du plan, horloge en temps réel', () => {
    const s = toB();
    expect(s.reached.B).toBeCloseTo(nominal.aller_min, 0);
    expect(s.leg?.kind).toBe('site');
    expect(s.clock.speed).toBe(1);
  });

  it('tempête à mi-parcours : « poursuivre » refusé, « retour immédiat » accepté', () => {
    let s = advance(run(start(), { type: 'LAUNCH' }), nominal.aller_min / 2);
    s = run(s, { type: 'TRIGGER_INCIDENT', id: 'storm' });
    const [go, back] = data.scenarios.storm!.options;
    expect(isAllowed(optionMargin(s, data, go), s.params.reserve)).toBe(false);
    expect(isAllowed(optionMargin(s, data, back), s.params.reserve)).toBe(true);
    expect(run(s, { type: 'CHOOSE_OPTION', optionId: 'go' })).toBe(s);
    s = run(s, { type: 'CHOOSE_OPTION', optionId: 'back' });
    expect(s.leg?.kind).toBe('back');
    expect(deriveView(s, data).alert).toBe('return');
  });

  it('au point B : +10 min d’observation accepté, +15 refusé', () => {
    const s = toB();
    expect(run(s, { type: 'EXTEND_OBSERVATION', minutes: 15, source: 'TABLETTE' })).toBe(s);
    expect(run(s, { type: 'EXTEND_OBSERVATION', minutes: 10, source: 'TABLETTE' }).observationExtra).toBe(10);
  });

  it('retour depuis B par l’itinéraire de moindre coût, mission terminée avec la réserve', () => {
    let s = run(toB(), { type: 'RETURN_NOW', source: 'TABLETTE' });
    expect(s.leg?.path).toEqual(data.returnPath);
    expect(s.leg?.duration).toBeCloseTo(nominal.retour_min, 0);
    s = advance(s, nominal.retour_min + 1);
    expect(s.phase).toBe('done');
    expect(deriveView(s, data).remaining).toBeGreaterThanOrEqual(s.params.reserve);
  });

  it('observation de la tablette : épingle à la position simulée', () => {
    const s = run(advance(run(start(), { type: 'LAUNCH' }), 10), { type: 'LOG', source: 'TABLETTE', text: 'Photo', kind: 'Photo' });
    const e = s.log[s.log.length - 1];
    const here = data.projection.toLonLat(deriveView(s, data).position);
    expect(e.pos).toBeDefined();
    expect(e.pos![0]).toBeCloseTo(here[0], 7);
    expect(e.pos![1]).toBeCloseTo(here[1], 7);
  });

  it('curseur de temps : position, marge et journal à un instant passé', () => {
    let s = advance(run(start(), { type: 'LAUNCH' }), 10);
    s = run(s, { type: 'LOG', source: 'TABLETTE', text: 'Note', kind: 'Observation' });
    s = advance(s, 10);
    const m = momentAt(s, data, 5);
    expect(m.t).toBe(5);
    expect(m.log.every((e) => e.t <= 5)).toBe(true);
    expect(m.log.some((e) => e.text === 'Note')).toBe(false);
    expect(m.margin).toBe(Math.round(nominal.margin_min));
    const d = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    expect(d(m.position, data.route[0])).toBeLessThan(d(deriveView(s, data).position, data.route[0]));
  });
});
