import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMissionData, type RawFiles } from '../data';
import analysis from '../mocks/routeAnalysis.json';
import { type Action, type MissionState, deriveView, initialState, optionMargin, reduce } from './mission';

const read = (f: string) => JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8'));
const data = buildMissionData({
  aller: read('route_aller.geojson'),
  detour: read('route_detour.geojson'),
  scenarios: read('scenarios.json'),
  layersFile: read('layers.json'),
  analysis: analysis as RawFiles['analysis'],
  source: 'mock',
});

const run = (s: MissionState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a, data), s);
/** Avance l'horloge par pas de 0,25 min, comme l'habitat le ferait à ×60. */
const advance = (s: MissionState, minutes: number) => {
  for (let i = 0; i < minutes * 4; i++) s = reduce(s, { type: 'TICK', dt: 0.25 }, data);
  return s;
};

describe('simulation de la sortie', () => {
  it('lancement : marge 30, horloge à 0, départ journalisé', () => {
    const s = run(initialState(), { type: 'LAUNCH' });
    expect(s.phase).toBe('eva');
    expect(deriveView(s, data).margin).toBe(30);
    expect(s.log[0].text).toContain('Départ');
  });

  it('départ bloqué si la marge passe sous la réserve', () => {
    const s = run(initialState({ autonomy: 100, speedKmh: 3.3, observation: 15, reserve: 20 }), { type: 'LAUNCH' });
    expect(s.phase).toBe('prep');
  });

  it('la marge reste stable en suivant le plan, les waypoints sont journalisés', () => {
    const s = advance(run(initialState(), { type: 'LAUNCH' }), 28);
    expect(deriveView(s, data).margin).toBe(30);
    expect(Object.keys(s.reached)).toEqual(expect.arrayContaining(['A', 'W1', 'W2']));
    expect(s.log.some((l) => l.text.startsWith('W1 atteint'))).toBe(true);
  });

  it('arrivée au point B vers T+35, horloge en temps réel', () => {
    const s = advance(run(initialState(), { type: 'LAUNCH' }), 36);
    expect(s.reached.B).toBeCloseTo(35, 5);
    expect(s.leg?.kind).toBe('site');
    expect(s.clock.speed).toBe(1);
  });

  it('tempête à T+28 : « poursuivre » refusé (−2), « retour immédiat » accepté (55)', () => {
    let s = advance(run(initialState(), { type: 'LAUNCH' }), 28);
    s = run(s, { type: 'TRIGGER_INCIDENT', id: 'storm' });
    const [go, back] = data.scenarios.storm.options;
    expect(optionMargin(s, go)).toBe(-2);
    expect(optionMargin(s, back)).toBe(55);
    expect(run(s, { type: 'CHOOSE_OPTION', optionId: 'go' })).toBe(s);
    s = run(s, { type: 'CHOOSE_OPTION', optionId: 'back' });
    expect(s.leg?.kind).toBe('back');
    expect(deriveView(s, data).alert).toBe('return');
  });

  it('obstacle : le détour mène à B', () => {
    let s = advance(run(initialState(), { type: 'LAUNCH' }), 25);
    s = run(s, { type: 'TRIGGER_INCIDENT', id: 'obstacle' }, { type: 'CHOOSE_OPTION', optionId: 'detour' });
    s = advance(s, 16);
    expect(s.leg?.kind).toBe('site');
    expect(s.reached.B).toBeDefined();
  });

  it('prolonger +15 min au point B : refusé ; +10 accepté', () => {
    const s = advance(run(initialState(), { type: 'LAUNCH' }), 36);
    expect(run(s, { type: 'EXTEND_OBSERVATION', minutes: 15, source: 'TABLETTE' })).toBe(s);
    expect(run(s, { type: 'EXTEND_OBSERVATION', minutes: 10, source: 'TABLETTE' }).observationExtra).toBe(10);
  });

  it('boucle complète : retour à A, mission terminée', () => {
    let s = advance(run(initialState(), { type: 'LAUNCH' }), 36);
    s = run(s, { type: 'RETURN_NOW', source: 'TABLETTE' });
    s = advance(s, 45);
    expect(s.phase).toBe('done');
    expect(deriveView(s, data).remaining).toBeGreaterThanOrEqual(s.params.reserve);
  });
});
