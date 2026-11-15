/**
 * Socle cartographique martien pour OpenLayers.
 * - Projection Mars 2000 géographique (EPSG:104905), en degrés, utilisée par Mars Trek.
 * - Couches WMTS construites à partir des paramètres relevés dans le GetCapabilities (public/data/layers.json),
 *   avec bascule automatique sur un cache de tuiles local si le serveur ne répond pas.
 */
import type ImageTile from 'ol/ImageTile';
import TileLayer from 'ol/layer/Tile';
import type { LoadFunction } from 'ol/Tile';
import type Tile from 'ol/Tile';
import { addProjection, get as getProjection } from 'ol/proj';
import Projection from 'ol/proj/Projection';
import WMTS from 'ol/source/WMTS';
import WMTSTileGrid from 'ol/tilegrid/WMTS';
import type { WmtsConfig } from '../data';
import { MARS_RADIUS_M } from '../domain/projection';

const RAD = Math.PI / 180;

function createMarsProjection(): Projection {
  const existing = getProjection('EPSG:104905');
  if (existing) return existing;
  const proj = new Projection({
    code: 'EPSG:104905',
    units: 'degrees',
    extent: [-180, -90, 180, 90],
    global: true,
    // Rayon martien (et non terrestre) pour l'échelle graphique
    metersPerUnit: MARS_RADIUS_M * RAD,
    // Résolution au point : moyenne des directions est-ouest (réduite par cos φ) et nord-sud
    getPointResolution: (resolution, point) => (resolution * (1 + Math.cos(point[1] * RAD))) / 2,
  });
  addProjection(proj);
  return proj;
}

export const MARS_2000 = createMarsProjection();

/**
 * Résolutions (°/px) des niveaux 0..maxMatrix : 360° / (TileWidth × MatrixWidth), MatrixWidth doublant à chaque niveau.
 * Vérifié niveau par niveau contre les MatrixWidth du GetCapabilities archivé (map/mars.test.ts).
 */
export function wmtsResolutions(cfg: WmtsConfig): number[] {
  return Array.from({ length: cfg.maxMatrix + 1 }, (_, z) => 360 / (cfg.tileSize * cfg.matrixWidth0 * 2 ** z));
}

/** D'où proviennent les tuiles affichées : serveur distant ou cache local. */
export type TileOrigin = 'remote' | 'local';

const REMOTE_TIMEOUT_MS = 5000;
const RETRY_REMOTE_AFTER_MS = 60_000;

class ServerUnavailable extends Error {}

/** Télécharge une tuile et vérifie qu'elle se décode réellement : un code 200 ne prouve pas qu'il y a une image. */
async function fetchDecodedTile(url: string, timeoutMs?: number): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined);
  } catch {
    throw new ServerUnavailable(url); // réseau coupé ou délai dépassé
  }
  if (res.status >= 500) throw new ServerUnavailable(`${url} : HTTP ${res.status}`);
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  const blob = await res.blob();
  (await createImageBitmap(blob)).close(); // lève une erreur si l'image est tronquée ou n'en est pas une
  return blob;
}

const fillTemplate = (template: string, z: number, row: number, col: number) =>
  template.replace('{TileMatrix}', String(z)).replace('{TileRow}', String(row)).replace('{TileCol}', String(col));

/**
 * Chargeur de tuiles avec bascule automatique sur le cache local :
 * - serveur injoignable (réseau, délai, 5xx) → cache local pour toutes les tuiles pendant 60 s, puis nouvel essai ;
 * - tuile distante isolée invalide (404, image non décodable) → cache local pour cette tuile seulement.
 */
function loaderWithLocalFallback(localTemplate: string, onOrigin?: (o: TileOrigin) => void): LoadFunction {
  let remoteDownUntil = 0;
  let lastOrigin: TileOrigin | null = null;
  const report = (o: TileOrigin) => {
    if (o !== lastOrigin) onOrigin?.(o);
    lastOrigin = o;
  };

  return (tile: Tile, src: string) => {
    const image = (tile as ImageTile).getImage() as HTMLImageElement;
    const [z, col, row] = tile.getTileCoord(); // WMTS : tileCoord = [niveau, colonne, ligne]
    void (async () => {
      let blob: Blob | null = null;
      if (Date.now() >= remoteDownUntil) {
        try {
          blob = await fetchDecodedTile(src, REMOTE_TIMEOUT_MS);
          report('remote');
        } catch (err) {
          if (err instanceof ServerUnavailable) {
            remoteDownUntil = Date.now() + RETRY_REMOTE_AFTER_MS;
            report('local');
          }
        }
      }
      if (!blob) blob = await fetchDecodedTile(fillTemplate(localTemplate, z, row, col)).catch(() => null);
      if (!blob) {
        image.src = 'data:,'; // aucune source valide : la tuile passe en erreur (le fond reste visible)
        return;
      }
      const url = URL.createObjectURL(blob);
      image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      image.src = url;
    })();
  };
}

/** Couche tuilée WMTS (REST) construite à partir des paramètres relevés dans le GetCapabilities. */
export function wmtsLayer(cfg: WmtsConfig, attribution: string, onOrigin?: (o: TileOrigin) => void): TileLayer<WMTS> {
  // Les niveaux au-delà de maxUsableMatrix ne sont pas demandés : OpenLayers agrandit le dernier niveau utilisable.
  const resolutions = wmtsResolutions(cfg).slice(0, (cfg.maxUsableMatrix ?? cfg.maxMatrix) + 1);
  return new TileLayer({
    extent: cfg.boundingBox,
    source: new WMTS({
      url: cfg.url,
      requestEncoding: 'REST',
      layer: cfg.layer,
      matrixSet: cfg.matrixSet,
      format: cfg.format,
      style: cfg.style,
      projection: MARS_2000,
      wrapX: false,
      attributions: attribution,
      crossOrigin: 'anonymous',
      tileLoadFunction: cfg.localTiles ? loaderWithLocalFallback(cfg.localTiles, onOrigin) : undefined,
      tileGrid: new WMTSTileGrid({
        origin: cfg.topLeftCorner,
        tileSize: cfg.tileSize,
        resolutions,
        matrixIds: resolutions.map((_, z) => String(z)),
        extent: cfg.boundingBox,
      }),
    }),
  });
}
