/**
 * Modèle d'autonomie simulée — LA formule unique (FRONTEND_SPEC §4).
 * Tous les écrans passent par ce module. Valeurs pédagogiques, pas un modèle physiologique.
 *
 *   marge = autonomie − (allerRestant + observation + retour)
 */

export interface SimParams {
  autonomy: number; // min, budget total de la sortie
  speedKmh: number; // vitesse de marche simulée
  observation: number; // min prévues au point B
  reserve: number; // min, seuil du statut rouge
}

export const DEFAULT_PARAMS: SimParams = { autonomy: 120, speedKmh: 3.3, observation: 15, reserve: 20 };

export const SPEEDS = [2.4, 2.7, 3.0, 3.3, 3.6] as const;
export const LIMITS = {
  autonomy: { min: 60, max: 240, step: 10 },
  observation: { min: 5, step: 5 },
  reserve: { min: 10, max: 40, step: 5 },
} as const;

/** Durées de référence à 3,3 km/h. Mock tant que le backend ne fournit pas les durées par segment. */
const REF_SPEED = 3.3;
const REF_ALLER = 35;
const REF_RETOUR = 40;

export function plannedDurations(speedKmh: number) {
  return {
    aller: Math.round((REF_ALLER * REF_SPEED) / speedKmh),
    retour: Math.round((REF_RETOUR * REF_SPEED) / speedKmh),
  };
}

export interface Budget {
  autonomy: number; // autonomie disponible maintenant (min)
  allerRestant: number;
  observation: number;
  retour: number;
}

export function margin(b: Budget): number {
  return b.autonomy - (b.allerRestant + b.observation + b.retour);
}

export type Status = 'green' | 'amber' | 'red';

export function statusOf(marginMin: number, reserve: number): Status {
  if (marginMin >= reserve + 10) return 'green';
  if (marginMin >= reserve) return 'amber';
  return 'red';
}

/** Règle de décision : une action qui ferait passer la marge sous la réserve est refusée. */
export function isAllowed(marginMin: number, reserve: number): boolean {
  return marginMin >= reserve;
}

/** Heure (minutes depuis le départ) à laquelle il faut quitter B au plus tard. */
export function latestLeaveB(arrivalB: number, autonomyAtB: number, retour: number, reserve: number): number {
  return arrivalB + (autonomyAtB - retour - reserve);
}

/** Marge du plan avant départ. */
export function plannedMargin(p: SimParams): number {
  const { aller, retour } = plannedDurations(p.speedKmh);
  return margin({ autonomy: p.autonomy, allerRestant: aller, observation: p.observation, retour });
}
