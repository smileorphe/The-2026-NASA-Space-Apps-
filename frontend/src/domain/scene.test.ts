import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMissionData, type RawFiles } from '../data';
import { beacons, cameraPose, type Dataset, drape, EYE_HEIGHT_M, makeScene, rasterOf, sceneToLonLat } from './scene';
import { fromGridXY, makeGrid, toGridXY, type GridMeta } from './terrain';
import type { LonLat } from './projection';

const pub = (f: string) => new URL(`../../public/data/${f}`, import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(pub(f), 'utf8'));
const meta = read('terrain/grid.json') as GridMeta & { datasets: Record<string, Dataset> };
const f32 = (f: string) => new Float32Array(new Uint8Array(readFileSync(pub(`terrain/${f}`))).buffer);
const grid = makeGrid(meta, f32('altitude.f32'), f32('slope.f32'), f32('cost.f32'));
const ds = meta.datasets;
const aller = read('route_aller.geojson');
const data = buildMissionData({
  aller, scenarios: read('scenarios.json'), layersFile: read('layers.json'),
  analysis: read('route_analysis.json') as RawFiles['analysis'], source: 'pipeline',
});
const sd = makeScene(grid, rasterOf(ds.corridor, f32(ds.corridor.file)), rasterOf(ds.horizon, f32(ds.horizon.file)), ds, data.projection.toLonLat(data.route[0]));

describe('vue 3D du casque', () => {
  it('altitude sous la caméra le long du tracé = profil de route_analysis.json à 0,5 m près', () => {
    // Le profil est échantillonné tous les 10 m le long du tracé, dans la projection des grilles
    const line = (aller.features.find((f: { geometry: { type: string } }) => f.geometry.type === 'LineString').geometry.coordinates as LonLat[])
      .map((p) => toGridXY(grid, p));
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    let worst = 0;
    for (const { d, z } of data.analysis.profile) {
      let i = 1;
      while (i < line.length - 1 && cum[i] < d) i++;
      const f = Math.min(1, Math.max(0, (d - cum[i - 1]) / (cum[i] - cum[i - 1])));
      const xy: [number, number] = [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f];
      const pose = cameraPose(sd, fromGridXY(grid, xy), null);
      worst = Math.max(worst, Math.abs(pose.ground - z));
      expect(pose.position[1]).toBeCloseTo(pose.ground - sd.baseAlt + EYE_HEIGHT_M, 6);
    }
    expect(data.analysis.profile.length).toBeGreaterThan(100);
    expect(worst).toBeLessThanOrEqual(0.5);
  });

  it('les balises de la scène correspondent aux coordonnées lon/lat des points du tracé', () => {
    const points = aller.features.filter((f: { geometry: { type: string } }) => f.geometry.type === 'Point');
    const bs = beacons(sd, data);
    expect(bs.map((b) => b.id)).toEqual(points.map((f: { properties: { id: string } }) => f.properties.id));
    for (const b of bs) {
      const ref = points.find((f: { properties: { id: string } }) => f.properties.id === b.id).geometry.coordinates as LonLat;
      const back = sceneToLonLat(sd, b.position);
      expect(back[0]).toBeCloseTo(ref[0], 7);
      expect(back[1]).toBeCloseTo(ref[1], 7);
    }
    // Le tracé drapé part de A et finit à B
    const line = drape(sd, data.route.map(data.projection.toLonLat));
    const [a, b] = [bs[0].position, bs[bs.length - 1].position];
    expect(Math.hypot(line[0][0] - a[0], line[0][2] - a[2])).toBeLessThan(0.01);
    expect(Math.hypot(line.at(-1)![0] - b[0], line.at(-1)![2] - b[2])).toBeLessThan(0.01);
  });

  it('exagération ×2 : relief doublé, hauteur des yeux inchangée', () => {
    const b = data.projection.toLonLat(data.waypoints.at(-1)!.xy);
    const p1 = cameraPose(sd, b, null, 1), p2 = cameraPose(sd, b, null, 2);
    expect(p2.position[1] - EYE_HEIGHT_M).toBeCloseTo(2 * (p1.position[1] - EYE_HEIGHT_M), 6);
  });

  it('caméra orientée vers le prochain point, à l’horizontale', () => {
    const [a, w1] = [data.waypoints[0], data.waypoints[1]].map((w) => data.projection.toLonLat(w.xy));
    const pose = cameraPose(sd, a, w1);
    const t = beacons(sd, data)[1].position;
    const dir = [pose.target[0] - pose.position[0], pose.target[2] - pose.position[2]];
    const want = [t[0] - pose.position[0], t[2] - pose.position[2]];
    const cos = (dir[0] * want[0] + dir[1] * want[1]) / (Math.hypot(...dir) * Math.hypot(...want));
    expect(cos).toBeGreaterThan(0.9999);
    expect(pose.target[1]).toBe(pose.position[1]);
  });

  it('hors ligne : toutes les données de la scène sont des fichiers locaux décrits dans grid.json', () => {
    for (const k of ['altitude', 'slope', 'cost', 'ortho', 'corridor', 'horizon']) {
      const d = ds[k];
      expect(d, k).toBeDefined();
      expect(d.file).not.toMatch(/^https?:/);
      expect(existsSync(pub(`terrain/${d.file}`)), d.file).toBe(true);
      expect(d.source.length).toBeGreaterThan(0);
      expect(d.resolution.length).toBeGreaterThan(0);
      expect(d.extent_lonlat).toHaveLength(4);
      if (d.file.endsWith('.f32')) expect(statSync(pub(`terrain/${d.file}`)).size).toBe(d.width * d.height * 4);
    }
    // L'emprise de l'ortho couvre la grille 5 m
    const [x0, y0, x1, y1] = ds.ortho.extent_local_m;
    expect(x0).toBeLessThanOrEqual(grid.origin.x);
    expect(y1).toBeGreaterThanOrEqual(grid.origin.y);
    expect(x1).toBeGreaterThanOrEqual(grid.origin.x + grid.width * grid.cell_m);
    expect(y0).toBeLessThanOrEqual(grid.origin.y - grid.height * grid.cell_m);
  });
});

