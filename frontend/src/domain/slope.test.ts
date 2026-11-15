import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SLOPE_CLASSES, slopeClass } from './slope';

describe('classes de pente', () => {
  it('bornes supérieures incluses', () => {
    expect(slopeClass(0).label).toBe('≤ 10°');
    expect(slopeClass(10).label).toBe('≤ 10°');
    expect(slopeClass(10.1).label).toBe('10–15°');
    expect(slopeClass(15).label).toBe('10–15°');
    expect(slopeClass(20).label).toBe('15–20°');
    expect(slopeClass(20.1).label).toBe('> 20°');
  });

  it('mêmes seuils que les tuiles produites par pipeline/', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../public/tiles/slope/manifest.json', import.meta.url), 'utf8'));
    const maxima = manifest.classes.map((c: { max_deg: number }) => c.max_deg);
    expect(maxima.slice(0, 3)).toEqual(SLOPE_CLASSES.slice(0, 3).map((c) => c.max));
  });
});
