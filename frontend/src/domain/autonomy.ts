/**
 * Modèle d'autonomie simulée — LA formule unique. Tous les écrans passent par ce module.
 * Valeurs pédagogiques, pas un modèle physiologique.
 *
 *   marge = autonomie − (allerRestant + observation + retour)
 *
 * Durées : uniquement celles de route_analysis.json, sous forme de coûts (longueur équivalente en mètres de
 * terrain plat, pipeline/terrain.py) divisés par la vitesse. Aller = somme des segments du tracé ;
 * retour = itinéraire de moindre coût B → A.
 */

export interface SimParams {
  autonomy: number; // min, budget total de la sortie
  speedKmh: number; // vitesse de marche sur terrain plat
  observation: number; // min prévues au point B
  reserve: number; // min, seuil du statut rouge
}

/** Coûts du plan (m de plat), lus dans route_analysis.json. */
export interface PlanCosts {
  allerCostM: number;
  retourCostM: number;
}

/** Valeurs de repli avant le chargement des données ; les valeurs par défaut viennent de route_analysis.json. */
export const FALLBACK_PARAMS: SimParams = { autonomy: 145, speedKmh: 3.3, observation: 15, reserve: 20 };

export const SPEEDS = [2.4, 2.7, 3.0, 3.3, 3.6] as const;
export const LIMITS = {
  autonomy: { min: 60, max: 240, step: 10 },
  observation: { min: 5, step: 5 },
  reserve: { min: 10, max: 40, step: 5 },
} as const;

export const metresPerMinute = (speedKmh: number) => (speedKmh * 1000) / 60;

/** Durée (min) correspondant à un coût (m de plat) à une vitesse donnée. */
export const minutesFor = (costM: number, speedKmh: number) => costM / metresPerMinute(speedKmh);

export function plannedDurations(costs: PlanCosts, speedKmh: number) {
  return { aller: minutesFor(costs.allerCostM, speedKmh), retour: minutesFor(costs.retourCostM, speedKmh) };
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

/** Marge du plan avant départ (arrondie à la minute, comme partout à l'affichage). */
export function plannedMargin(p: SimParams, costs: PlanCosts): number {
  const { aller, retour } = plannedDurations(costs, p.speedKmh);
  return Math.round(margin({ autonomy: p.autonomy, allerRestant: aller, observation: p.observation, retour }));
}

/**
 * Seuil de la zone de retour (min) : temps restant pour rentrer en gardant la réserve, une fois l'aller et
 * l'observation faits. B est dans la zone ⇔ retour ≤ seuil ⇔ marge ≥ réserve.
 */
export function returnZoneThreshold(p: SimParams, costs: PlanCosts): number {
  return p.autonomy - p.reserve - (plannedDurations(costs, p.speedKmh).aller + p.observation);
}
