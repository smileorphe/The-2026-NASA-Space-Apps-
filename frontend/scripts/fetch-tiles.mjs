#!/usr/bin/env node
/**
 * Cache local des tuiles Mars Trek pour la démo hors ligne.
 * La carte bascule automatiquement sur ces tuiles si le serveur ne répond pas (src/map/mars.ts).
 *
 *   HiRISE (imagery)  niveaux 11–15  zone « mission » : tracé aller + détour + marge
 *   CTX    (ctx)      niveaux 0–10   zone « carte »   : toute l'emprise navigable (mosaïque HiRISE)
 *   MOLA   (basemap)  niveaux 0–7    zone « carte »
 *
 * Usage : npm run tiles [-- --layer imagery|ctx|basemap] [--margin 500] [--clean]
 *   --clean  vide le dossier de chaque couche traitée avant le téléchargement (zone qui rétrécit, niveaux retirés)
 *
 * Anomalies connues (PLAN[].knownAnomalies) : signalées en avertissement et recopiées dans le manifeste,
 * sans code d'erreur. Le script ne sort en erreur que pour des tuiles invalides inattendues.
 *
 * Chaque tuile est décodée avant d'être enregistrée (PNG : blocs complets, flux zlib, pixels ;
 * JPEG : décodage complet via jpeg-js). Un code HTTP 200 ne prouve pas qu'une tuile contient une image.
 * Les tuiles invalides, transparentes ou uniformes ne sont pas enregistrées.
 * Paramètres WMTS et gabarits locaux (wmts.localTiles) : public/data/layers.json.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const MARS_RADIUS_M = 3_396_190;
const RAD = Math.PI / 180;
const CONCURRENCY = 6;

/**
 * knownAnomalies : défauts constatés côté serveur, sans effet sur la carte. `error` doit apparaître dans le
 * message d'échec pour que l'anomalie soit reconnue ; tout autre échec de la même tuile reste inattendu.
 */
const PLAN = [
  { id: 'imagery', levels: [11, 15], zone: 'mission', knownAnomalies: [] },
  {
    id: 'ctx',
    levels: [0, 10],
    zone: 'carte',
    knownAnomalies: [
      { tile: '1/0/2', error: 'HTTP 500', reason: 'Erreur 500 reproductible côté serveur (constatée le 2026-11-15). Niveau jamais affiché : la vue ne descend pas sous le niveau 10 de CTX.' },
    ],
  },
  { id: 'basemap', levels: [0, 7], zone: 'carte', knownAnomalies: [] },
];

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((a) => a.trim().split(/\s+/)));
const MARGIN_M = Number(args.margin ?? 500);
const CLEAN = 'clean' in args;
const TILES_ROOT = join(PUBLIC, 'tiles') + sep;
const readJson = (p) => JSON.parse(readFileSync(join(PUBLIC, p), 'utf8'));
const layers = readJson('data/layers.json').layers;

/* ---------- Zones ---------- */
function missionExtent() {
  const coords = [];
  for (const f of ['data/route_aller.geojson', 'data/route_detour.geojson']) {
    for (const { geometry: g } of readJson(f).features) coords.push(...(g.type === 'Point' ? [g.coordinates] : g.coordinates));
  }
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const latMid = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLat = MARGIN_M / (MARS_RADIUS_M * RAD);
  const dLon = MARGIN_M / (MARS_RADIUS_M * Math.cos(latMid * RAD) * RAD);
  return [Math.min(...lons) - dLon, Math.min(...lats) - dLat, Math.max(...lons) + dLon, Math.max(...lats) + dLat];
}
/** La vue de la carte est limitée à l'emprise de la mosaïque HiRISE (MissionMap.tsx). */
const mapExtent = () => layers.find((l) => l.id === 'imagery').wmts.boundingBox;
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/* ---------- Grille WMTS (mêmes formules que src/map/mars.ts) ---------- */
function tileRange(cfg, z, extent) {
  const span = (360 / (cfg.tileSize * cfg.matrixWidth0 * 2 ** z)) * cfg.tileSize;
  const [ox, oy] = cfg.topLeftCorner;
  const maxCol = cfg.matrixWidth0 * 2 ** z - 1;
  const clamp = (v) => Math.max(0, Math.min(v, maxCol));
  return {
    col0: clamp(Math.floor((extent[0] - ox) / span)),
    col1: clamp(Math.floor((extent[2] - ox) / span)),
    row0: Math.max(0, Math.floor((oy - extent[3]) / span)),
    row1: Math.max(0, Math.floor((oy - extent[1]) / span)),
  };
}
const fill = (cfg, tpl, z, row, col) =>
  tpl.replace('{Style}', cfg.style).replace('{TileMatrixSet}', cfg.matrixSet).replace('{TileMatrix}', z).replace('{TileRow}', row).replace('{TileCol}', col);

/* ---------- Décodage ---------- */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** PNG 8 bits non entrelacé → pixels + masque de transparence. */
function decodePng(buf) {
  let p = 8, width = 0, height = 0, type = -1, ended = false, trnsGray = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error(`bloc ${kind} tronqué`);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || data[12] !== 0 || !(type in CHANNELS)) throw new Error(`PNG non géré (profondeur ${data[8]}, type ${type})`);
    }
    if (kind === 'tRNS' && type === 0) trnsGray = data.readUInt16BE(0);
    if (kind === 'IDAT') idat.push(data);
    if (kind === 'IEND') { ended = true; break; }
    p += 12 + len;
  }
  if (!ended) throw new Error('PNG incomplet (pas de IEND)');
  const bpp = CHANNELS[type];
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('taille des données incohérente');
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  const transparent = (i) => (type === 4 || type === 6 ? px[i + bpp - 1] === 0 : type === 0 && trnsGray !== null && px[i] === trnsGray);
  return { width, height, bpp, px, transparent };
}

/** JPEG → pixels RVB (décodage strict : une image tronquée ou corrompue lève une erreur). */
function decodeJpeg(buf) {
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) throw new Error('JPEG incomplet (pas de marqueur de fin)');
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false });
  return { width: img.width, height: img.height, bpp: 3, px: img.data, transparent: () => false };
}

/** 'image' | 'vide' (transparente ou uniforme) ; lève une erreur si la tuile ne se décode pas. */
function classify(buf, tileSize) {
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error('ni PNG ni JPEG');
  const img = isPng ? decodePng(buf) : decodeJpeg(buf);
  if (img.width !== tileSize || img.height !== tileSize) throw new Error(`taille ${img.width}×${img.height}`);
  let n = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < img.px.length; i += img.bpp) {
    if (img.transparent(i)) continue;
    n++;
    sum += img.px[i];
    sum2 += img.px[i] * img.px[i];
  }
  const mean = n ? sum / n : 0;
  const std = n ? Math.sqrt(Math.max(sum2 / n - mean * mean, 0)) : 0;
  return n > 0 && std > 0.5 ? 'image' : 'vide';
}

/* ---------- Téléchargement ---------- */
async function fetchTile(url, tileSize) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, kind: classify(buf, tileSize) };
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function fetchLayer({ id, levels: [min, max], zone, knownAnomalies }) {
  const layer = layers.find((l) => l.id === id);
  const cfg = layer?.wmts;
  if (!cfg?.localTiles) throw new Error(`layers.json : ${id}.wmts.localTiles manquant`);
  const top = Math.min(max, cfg.maxUsableMatrix ?? cfg.maxMatrix);
  const extent = intersect(zone === 'mission' ? missionExtent() : mapExtent(), cfg.boundingBox);
  const dir = join(PUBLIC, cfg.localTiles.split('{')[0]);
  if (!dir.startsWith(TILES_ROOT)) throw new Error(`${id} : dossier local hors de public/tiles/ (${dir})`);
  if (CLEAN) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`\n--clean : ${dir.slice(PUBLIC.length)} vidé`);
  }

  const jobs = [];
  for (let z = min; z <= top; z++) {
    const r = tileRange(cfg, z, extent);
    for (let row = r.row0; row <= r.row1; row++) for (let col = r.col0; col <= r.col1; col++) jobs.push({ z, row, col });
  }
  const jobs0 = new Set(jobs.map((j) => `${j.z}/${j.row}/${j.col}`));
  console.log(`\n${layer.name} · niveaux ${min}–${top} · zone ${zone} (lon ${extent[0].toFixed(4)}–${extent[2].toFixed(4)}, lat ${extent[1].toFixed(4)}–${extent[3].toFixed(4)}) · ${jobs.length} tuiles`);

  const stats = {};
  const failures = [];
  const worker = async () => {
    while (jobs.length) {
      const { z, row, col } = jobs.shift();
      const s = (stats[z] ??= { image: 0, vide: 0, invalide: 0, dejaPresente: 0 });
      const out = join(PUBLIC, fill(cfg, cfg.localTiles, z, row, col));
      try {
        if (existsSync(out) && classify(readFileSync(out), cfg.tileSize) === 'image') {
          s.dejaPresente++;
          continue;
        }
        const { buf, kind } = await fetchTile(fill(cfg, cfg.url, z, row, col), cfg.tileSize);
        s[kind]++;
        if (kind === 'image') {
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, buf);
        }
      } catch (err) {
        s.invalide++;
        failures.push({ tile: `${z}/${row}/${col}`, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Échecs attendus (anomalies connues) / inattendus
  const isKnown = (f) => knownAnomalies.some((a) => a.tile === f.tile && f.error.includes(a.error));
  const unexpected = failures.filter((f) => !isKnown(f));
  const anomalies = knownAnomalies.map((a) => {
    const f = failures.find((x) => x.tile === a.tile);
    const inRun = jobs0.has(a.tile);
    return { ...a, status: !inRun ? 'non vérifiée (hors niveaux/zone)' : f && isKnown(f) ? 'reproduite' : f ? 'autre erreur' : 'non reproduite (tuile valide)' };
  });

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      { layer: cfg.layer, source: cfg.url, generatedAt: new Date().toISOString(), zone, extent, marginM: zone === 'mission' ? MARGIN_M : null, levels: [min, top], stats, knownAnomalies: anomalies, unexpectedFailures: unexpected },
      null,
      2,
    ) + '\n',
  );
  console.table(stats);
  for (const a of anomalies) console.warn(`  ⚠ Anomalie connue ${a.tile} (${a.error}) : ${a.status}. ${a.reason}`);
  if (unexpected.length) console.error(`  ✗ Tuiles invalides inattendues (non enregistrées) :\n    ${unexpected.map((f) => `${f.tile} : ${f.error}`).join('\n    ')}`);
  return unexpected.length;
}

const selected = args.layer ? PLAN.filter((p) => p.id === args.layer) : PLAN;
if (!selected.length) throw new Error(`--layer inconnu : ${args.layer} (imagery, ctx, basemap)`);
let failed = 0;
for (const p of selected) failed += await fetchLayer(p);
if (failed) console.error(`\nÉchec : ${failed} tuile(s) invalide(s) inattendue(s). Voir unexpectedFailures dans les manifestes.`);
process.exitCode = failed ? 1 : 0;
