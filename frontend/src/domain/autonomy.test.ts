import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, isAllowed, latestLeaveB, margin, plannedDurations, plannedMargin, statusOf } from './autonomy';

const R = DEFAULT_PARAMS.reserve;

describe('autonomie simulée (FRONTEND_SPEC §4)', () => {
  it('valeurs par défaut : marge 30 min, statut vert', () => {
    expect(plannedDurations(3.3)).toEqual({ aller: 35, retour: 40 });
    expect(plannedMargin(DEFAULT_PARAMS)).toBe(30);
    expect(statusOf(30, R)).toBe('green');
  });

  it('+10 min d’observation : marge 20, orange, accepté', () => {
    const m = plannedMargin({ ...DEFAULT_PARAMS, observation: 25 });
    expect(m).toBe(20);
    expect(statusOf(m, R)).toBe('amber');
    expect(isAllowed(m, R)).toBe(true);
  });

  it('+15 min d’observation : marge 15, refusé', () => {
    const m = plannedMargin({ ...DEFAULT_PARAMS, observation: 30 });
    expect(m).toBe(15);
    expect(statusOf(m, R)).toBe('red');
    expect(isAllowed(m, R)).toBe(false);
  });

  it('tempête, « poursuivre » à T+28 : marge −2, refusé', () => {
    const m = margin({ autonomy: 120 - 28, allerRestant: 12, observation: 15, retour: 67 });
    expect(m).toBe(-2);
    expect(isAllowed(m, R)).toBe(false);
  });

  it('tempête, « retour immédiat » à T+28 : marge 55, accepté', () => {
    expect(margin({ autonomy: 92, allerRestant: 0, observation: 0, retour: 37 })).toBe(55);
  });

  it('heure limite pour quitter B', () => {
    // arrivée T+35, autonomie à B 85, retour 40, réserve 20 → quitter à T+60
    expect(latestLeaveB(35, 85, 40, 20)).toBe(60);
  });

  it('la vitesse modifie les durées', () => {
    expect(plannedDurations(2.4)).toEqual({ aller: 48, retour: 55 });
  });
});
