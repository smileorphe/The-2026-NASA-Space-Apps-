/**
 * Classes de pente — mêmes seuils partout (carte, segments, tuiles produites par pipeline/config.py).
 * Bornes supérieures incluses : ≤ 10°, ]10, 15], ]15, 20], > 20°. Au-delà de 20° : interdit pour les itinéraires calculés.
 * Paramètres de démonstration, pas des normes.
 */
export const SLOPE_CLASSES = [
  { max: 10, label: '≤ 10°', color: '#1FC48F' },
  { max: 15, label: '10–15°', color: '#F2C230' },
  { max: 20, label: '15–20°', color: '#F28A2E' },
  { max: Infinity, label: '> 20°', color: '#F4605A' },
] as const;

export const SLOPE_MAX_DEG = 20;

export function slopeClass(deg: number) {
  return SLOPE_CLASSES.find((c) => deg <= c.max)!;
}
