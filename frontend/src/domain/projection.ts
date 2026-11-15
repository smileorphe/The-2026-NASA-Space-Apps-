/**
 * Passage entre coordonnées géographiques martiennes et repère métrique local.
 *
 * - Les fichiers de données (GeoJSON, emprises) sont en longitude/latitude, système Mars 2000
 *   (sphère IAU, EPSG:104905 côté Mars Trek), longitudes positives vers l'est.
 * - Les calculs (distance, position, pente) se font en mètres dans un repère local centré sur
 *   l'habitat A : projection équirectangulaire tangente, x = est, y = nord.
 *   Sur une zone de quelques kilomètres, l'erreur est négligeable devant la résolution du DTM.
 */
import type { XY } from './geometry';

export const MARS_RADIUS_M = 3_396_190;

export type LonLat = [number, number];

const RAD = Math.PI / 180;

export interface LocalProjection {
  toLocal: (p: LonLat) => XY;
  toLonLat: (p: XY) => LonLat;
}

export function localProjection(origin: LonLat): LocalProjection {
  const [lon0, lat0] = origin;
  const kx = MARS_RADIUS_M * Math.cos(lat0 * RAD) * RAD; // mètres par degré de longitude
  const ky = MARS_RADIUS_M * RAD; // mètres par degré de latitude
  return {
    toLocal: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}
