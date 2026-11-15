import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SLOPE_CLASSES } from '../domain/slope';
import { CRISM_COLORS, GEOLOGY, POINTS, ROUTE, SAFETY } from '../map/palette';

// Espions sur tous les calculs d'itinéraire : la légende ne doit en déclencher aucun
const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../domain/routing', async (orig) => {
  const m = await orig<typeof import('../domain/routing')>();
  return {
    ...m,
    astar: (...a: Parameters<typeof m.astar>) => (calls.n++, m.astar(...a)),
    costField: (...a: Parameters<typeof m.costField>) => (calls.n++, m.costField(...a)),
  };
});

const { MapLegend } = await import('./MapLegend');
const source = readFileSync(new URL('./MapLegend.tsx', import.meta.url), 'utf8');

describe('légende statique', () => {
  it('afficher ou replier la légende ne relance aucun calcul d’itinéraire', () => {
    // Le repli est natif (<details>) : il ne provoque aucun rendu React. On rend plusieurs fois pour s'en assurer.
    const html = renderToStaticMarkup(createElement(MapLegend));
    for (let i = 0; i < 5; i++) expect(renderToStaticMarkup(createElement(MapLegend))).toBe(html);
    expect(html).toMatch(/^<details class="map-legend" open="">\s*<summary>Légende<\/summary>/);
    expect(calls.n).toBe(0);
    // Aucune dépendance au store, à la carte, au routage, ni effet ou état React
    for (const forbidden of ['../store', 'domain/routing', 'domain/plan', 'domain/obstacle', 'domain/inspect', 'domain/mission', '../data', 'useEffect', 'useState', 'useMission', 'ol/']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('groupes Itinéraire · Sécurité · Terrain · Science · Fonds', () => {
    const html = renderToStaticMarkup(createElement(MapLegend));
    const groups = [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(groups).toEqual(['Itinéraire', 'Sécurité', 'Terrain', 'Science', 'Fonds']);
  });

  it('couleurs : les mêmes constantes que les styles de la carte', () => {
    const html = renderToStaticMarkup(createElement(MapLegend));
    const colors = [
      ...SLOPE_CLASSES.map((c) => c.color),
      ...Object.values(ROUTE).flatMap((v) => (typeof v === 'object' ? [v.color] : [])),
      POINTS.A, POINTS.B, POINTS.waypointTodo, POINTS.waypointDone, POINTS.position, POINTS.pin, POINTS.probe,
      SAFETY.obstacle, SAFETY.returnZone, ...Object.values(CRISM_COLORS), GEOLOGY.unit, GEOLOGY.deltaFront, GEOLOGY.otherLine,
    ];
    for (const c of colors) expect(html, c).toContain(c);
    // La carte importe ces mêmes constantes (pas de couleur de style écrite en dur pour ces éléments)
    const map = readFileSync(new URL('./MissionMap.tsx', import.meta.url), 'utf8');
    expect(map).toContain("from '../map/palette'");
    for (const c of [...Object.values(CRISM_COLORS), SAFETY.returnZone, GEOLOGY.deltaFront, ROUTE.leastCost.color, POINTS.B]) expect(map, c).not.toContain(`'${c}'`);
  });
});
