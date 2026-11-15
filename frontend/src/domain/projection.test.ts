import { describe, expect, it } from 'vitest';
import { localProjection, MARS_RADIUS_M } from './projection';

describe('projection locale', () => {
  const proj = localProjection([77.45, 18.44]);

  it('l’origine vaut (0, 0) et l’aller-retour est exact', () => {
    expect(proj.toLocal([77.45, 18.44])).toEqual([0, 0]);
    const [lon, lat] = proj.toLonLat(proj.toLocal([77.47, 18.45]));
    expect(lon).toBeCloseTo(77.47, 10);
    expect(lat).toBeCloseTo(18.45, 10);
  });

  it('1° de latitude ≈ 59,27 km sur Mars ; la longitude est réduite par cos(latitude)', () => {
    const [, y] = proj.toLocal([77.45, 19.44]);
    expect(y).toBeCloseTo((MARS_RADIUS_M * Math.PI) / 180, 3);
    const [x] = proj.toLocal([78.45, 18.44]);
    expect(x / y).toBeCloseTo(Math.cos((18.44 * Math.PI) / 180), 10);
  });
});
