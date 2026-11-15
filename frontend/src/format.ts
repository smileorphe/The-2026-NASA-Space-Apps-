/** Formatage des valeurs affichées (français, chiffres en police mono côté CSS). */

const pad = (n: number) => String(n).padStart(2, '0');

/** 28.5 → « T+28:30 » (minutes:secondes de temps simulé). */
export function fmtT(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  const total = Math.max(0, Math.round(min * 60));
  return `T+${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Écart signé : 0.25 → « +0:15 ». */
export function fmtDelta(min: number): string {
  const total = Math.round(Math.abs(min) * 60);
  return `${min < 0 ? '−' : '+'}${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export const fmtMin = (min: number) => `${Math.round(min)} min`.replace('-', '−');

export function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(2).replace('.', ',')} km`;
}

/** 98 → « 1 h 38 ». */
export function fmtDuration(min: number): string {
  const m = Math.round(min);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)}`;
}

/** 14.7 → « 14,7° ». */
export const fmtDeg = (deg: number) => `${deg.toFixed(1).replace('.', ',')}°`;
