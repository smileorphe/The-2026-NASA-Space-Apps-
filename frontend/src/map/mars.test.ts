/**
 * Vérifie la configuration WMTS de layers.json contre les GetCapabilities archivés dans public/data/wmts/.
 * Les entrées de TileMatrix en double (même identifiant, autre échelle) sont ignorées : seule la première compte.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayerInfo } from '../data';
import { wmtsResolutions } from './mars';

const read = (f: string) => readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8');
const layers: LayerInfo[] = JSON.parse(read('layers.json')).layers;
const ARCHIVES: Record<string, string> = {
  imagery: 'wmts/hirise_jezero_WMTSCapabilities.xml',
  basemap: 'wmts/mola_clrshade_global_WMTSCapabilities.xml',
  ctx: 'wmts/ctx_global_beta01_WMTSCapabilities.xml',
};

const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:ows:)?${name}>\\s*([^<]*?)\\s*</`))?.[1];

function firstMatrices(xml: string) {
  const byId = new Map<number, { mw: number; topLeft: number[]; tile: number }>();
  for (const m of xml.match(/<TileMatrix>[\s\S]*?<\/TileMatrix>/g) ?? []) {
    const id = Number(tag(m, 'Identifier'));
    if (!byId.has(id)) byId.set(id, { mw: Number(tag(m, 'MatrixWidth')), topLeft: tag(m, 'TopLeftCorner')!.split(/\s+/).map(Number), tile: Number(tag(m, 'TileWidth')) });
  }
  return byId;
}

describe.each(Object.entries(ARCHIVES))('WMTS %s', (id, file) => {
  const cfg = layers.find((l) => l.id === id)!.wmts!;
  const xml = read(file);

  it('identifiants, format, style et gabarit conformes au GetCapabilities', () => {
    const layerBlock = xml.match(/<Layer>[\s\S]*?<\/Layer>/)![0];
    expect(tag(layerBlock, 'ows:Identifier')).toBe(cfg.layer);
    expect(tag(layerBlock, 'Format')).toBe(cfg.format);
    expect(tag(xml.match(/<Style[\s\S]*?<\/Style>/)![0], 'ows:Identifier')).toBe(cfg.style);
    expect(tag(layerBlock, 'TileMatrixSet')).toBe(cfg.matrixSet);
    expect(layerBlock).toContain(`template="${cfg.url}"`);
  });

  it('résolutions identiques niveau par niveau (360° / (TileWidth × MatrixWidth))', () => {
    const matrices = firstMatrices(xml);
    const res = wmtsResolutions(cfg);
    expect(matrices.size).toBe(res.length);
    res.forEach((r, z) => {
      const m = matrices.get(z)!;
      expect(m.topLeft).toEqual(cfg.topLeftCorner);
      expect(m.tile).toBe(cfg.tileSize);
      expect(r).toBeCloseTo(360 / (m.tile * m.mw), 15);
    });
  });
});
