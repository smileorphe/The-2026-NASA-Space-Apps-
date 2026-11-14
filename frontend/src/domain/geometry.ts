/**
 * Géométrie plane sur des coordonnées métriques (x = est, y = nord).
 * Le tracé doit être fourni dans une projection métrique : jamais de degrés ici.
 */

export type XY = [number, number];

export const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function pathLength(path: XY[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += dist(path[i - 1], path[i]);
  return total;
}

/** Point situé à `d` mètres le long du tracé, et cap (degrés, 0 = nord, sens horaire) du segment courant. */
export function pointAt(path: XY[], d: number): { p: XY; heading: number } {
  let rest = Math.max(0, d);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = dist(a, b);
    if (len === 0 && i < path.length - 1) continue; // segment nul : pas de cap exploitable
    if (rest <= len || i === path.length - 1) {
      const k = len === 0 ? 1 : Math.min(rest / len, 1);
      return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], heading: bearing(a, b) };
    }
    rest -= len;
  }
  return { p: path[0], heading: 0 };
}

/** Portion du tracé entre les distances d0 et d1 (d0 < d1). */
export function slicePath(path: XY[], d0: number, d1: number): XY[] {
  const out: XY[] = [pointAt(path, d0).p];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    acc += dist(path[i - 1], path[i]);
    if (acc > d0 && acc < d1) out.push(path[i]);
  }
  out.push(pointAt(path, d1).p);
  return out;
}

/** Distance le long du tracé de la projection de `p` sur ce tracé. */
export function distanceAlong(path: XY[], p: XY): number {
  let best = Infinity;
  let bestD = 0;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = dist(a, b);
    const k = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len ** 2));
    const e = dist(p, [a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1])]);
    if (e < best) {
      best = e;
      bestD = acc + k * len;
    }
    acc += len;
  }
  return bestD;
}

/** Cap de a vers b, en degrés (0 = nord, 90 = est). */
export function bearing(a: XY, b: XY): number {
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}
