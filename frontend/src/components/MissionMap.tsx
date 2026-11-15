/**
 * Carte de mission (OpenLayers).
 * Fonds WMTS (MOLA, CTX, HiRISE) et tuiles de pente locales ; couches issues de pipeline/ (sable CRISM, géologie,
 * itinéraires calculés, zone de retour, emprise CRISM) ; tracé coloré par pente, waypoints et, en mode `live`,
 * position simulée, trajet réalisé, détour et retour.
 * Les géométries de mission sont en mètres locaux ; `data.projection.toLonLat` est la seule conversion vers la carte.
 */
import { useEffect, useRef, useState } from 'react';
import 'ol/ol.css';
import OlMap from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import GeoJSON from 'ol/format/GeoJSON';
import { LineString, Point, Polygon } from 'ol/geom';
import ImageLayer from 'ol/layer/Image';
import ImageStatic from 'ol/source/ImageStatic';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import { defaults as defaultInteractions } from 'ol/interaction';
import { asArray } from 'ol/color';
import { boundingExtent } from 'ol/extent';
import type BaseLayer from 'ol/layer/Base';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import { dist, distanceAlong, pointAt, slicePath, type XY } from '../domain/geometry';
import type { LonLat } from '../domain/projection';
import type { MissionData, Waypoint } from '../data';
import { SLOPE_CLASSES, slopeClass } from '../domain/slope';
import { momentAt, type Moment, type MissionState, type View as MissionView } from '../domain/mission';
import { fromGridXY } from '../domain/terrain';
import { fmtT } from '../format';
import { MARS_2000, type TileOrigin, wmtsLayer, wmtsResolutions } from '../map/mars';
import { alternativesFor, useMission, useTerrain, zoneFor } from '../store';
import { Icon } from './Icon';
import { ProvenanceTag } from './ProvenanceTag';
import { cssColor } from './ui';

type LayerKey = 'imagery' | 'slope' | 'regions' | 'geology' | 'routes' | 'returnZone' | 'crism';
const TOGGLES: { id: LayerKey; label: string; color: string }[] = [
  { id: 'imagery', label: 'HiRISE', color: 'var(--text)' },
  { id: 'slope', label: 'Pentes', color: '#F28A2E' },
  { id: 'regions', label: 'Régions CRISM', color: '#B59CFF' },
  { id: 'geology', label: 'Géologie', color: '#FFE650' },
  { id: 'routes', label: 'Itinéraires calculés', color: '#B59CFF' }, // en direct : plus court / moindre coût vers le B courant
  { id: 'returnZone', label: 'Zone de retour', color: '#1FC48F' },
  { id: 'crism', label: 'Emprise CRISM', color: 'var(--carb)' },
];
const DEFAULT_ON: Record<LayerKey, boolean> = { imagery: true, slope: true, regions: true, geology: false, routes: false, returnZone: false, crism: false };

/**
 * Zoom maximal de la vue : niveau 15 de la grille HiRISE (≈ 1,3 m/px).
 * Au-delà, le détail mesuré des tuiles n'augmente plus (résolution effective ≈ 1–2 m/px près de A).
 */
const MAX_VIEW_LEVEL = 15;

/* ---------------- Styles ---------------- */

const FONT = 'Manrope, sans-serif';
const line = (color: string, width: number, lineDash?: number[], opacity = 1) => {
  const [r, g, b] = asArray(color);
  return new Style({ stroke: new Stroke({ color: [r, g, b, opacity], width, lineDash }) });
};
const label = (text: string, offsetY: number) =>
  new Text({ text, offsetY, font: `600 12px ${FONT}`, fill: new Fill({ color: '#F3EFEA' }), backgroundFill: new Fill({ color: 'rgba(16,13,11,0.85)' }), padding: [3, 6, 3, 6] });

function waypointStyle(w: Waypoint, done: boolean): Style[] {
  const text = new Text({ text: w.id, font: `800 ${w.id.length > 1 ? 10 : 14}px ${FONT}`, fill: new Fill({ color: w.id === 'A' ? '#1A1817' : w.id === 'B' ? '#120F0D' : '#F3EFEA' }) });
  const image =
    w.id === 'A'
      ? new RegularShape({ points: 4, radius: 18, angle: Math.PI / 4, fill: new Fill({ color: '#F3EFEA' }) })
      : w.id === 'B'
        ? new RegularShape({ points: 4, radius: 19, fill: new Fill({ color: '#EE8A1B' }) })
        : new Circle({ radius: 12, fill: new Fill({ color: '#1A1817' }), stroke: new Stroke({ color: done ? '#1FC48F' : '#4CC6EA', width: 3 }) });
  const styles = [new Style({ image, text })];
  if (w.id === 'A' || w.id === 'B') styles.push(new Style({ text: label(w.name, w.id === 'A' ? 30 : -32) }));
  return styles;
}

const positionStyle = new Style({ image: new Circle({ radius: 9, fill: new Fill({ color: '#4CC6EA' }), stroke: new Stroke({ color: '#F3EFEA', width: 3 }) }) });
const obstacleStyle = new Style({
  fill: new Fill({ color: 'rgba(244,96,90,0.35)' }),
  stroke: new Stroke({ color: '#F4605A', width: 2 }),
  text: new Text({ text: 'Obstacle', offsetY: -22, font: `700 12px ${FONT}`, fill: new Fill({ color: '#F3EFEA' }), backgroundFill: new Fill({ color: 'rgba(120,20,16,0.9)' }), padding: [2, 6, 2, 6] }),
});
const pinStyle = new Style({
  image: new Circle({ radius: 7, fill: new Fill({ color: '#B59CFF' }), stroke: new Stroke({ color: '#F3EFEA', width: 2 }) }),
});

/* ---------------- Construction des entités ---------------- */

const format = new GeoJSON(); // fichiers en lon/lat Mars 2000 = projection de la carte : aucune transformation

/** Couche vectorielle à partir d'un GeoJSON de pipeline/ ; `style` reçoit les propriétés de chaque entité. */
function geojsonLayer(gj: object | null, style: (p: Record<string, unknown>) => Style | Style[] | undefined) {
  if (!gj) return undefined;
  const features = format.readFeatures(gj);
  for (const f of features) f.setStyle(style(f.getProperties()));
  return new VectorLayer({ source: new VectorSource({ features }) });
}

/** Couleurs des classes CRISM (Zastrow & Glotch 2021) ; légende : CrismLegend. */
export const CRISM_COLORS: Record<string, string> = { MC: '#B59CFF', MT: '#F28AB3', sand: '#E8C27A', mixture: '#8FA3B8' };
const crismStyles = Object.fromEntries(
  Object.entries(CRISM_COLORS).map(([code, color]) => {
    const [r, g, b] = asArray(color);
    return [code, new Style({ fill: new Fill({ color: [r, g, b, code === 'mixture' ? 0.12 : 0.3] }), stroke: new Stroke({ color, width: 1 }) })];
  }),
);
const crismStyle = new Style({ stroke: new Stroke({ color: '#B59CFF', width: 2, lineDash: [8, 6] }) });

function geologyStyle(p: Record<string, unknown>): Style {
  if (p.kind === 'unit')
    return new Style({
      stroke: new Stroke({ color: 'rgba(255,230,80,0.85)', width: 1.2 }),
      text: new Text({ text: String(p.symbol), font: `700 12px ${FONT}`, fill: new Fill({ color: '#FFE650' }), stroke: new Stroke({ color: '#120F0D', width: 3 }), overflow: false }),
    });
  if (p.kind === 'ellipse') return line('#F3EFEA', 1.5, [4, 6], 0.8);
  return line(String(p.type).includes('delta') ? '#FF4FD8' : '#4CC6EA', 2.5);
}

/** Cercle d'obstacle (rayon en mètres) en lon/lat, via le repère local métrique. */
function circle(data: MissionData, center: LonLat, radiusM: number): Polygon {
  const [cx, cy] = data.projection.toLocal(center);
  const ring = Array.from({ length: 33 }, (_, k) => data.projection.toLonLat([cx + radiusM * Math.cos((k / 32) * 2 * Math.PI), cy + radiusM * Math.sin((k / 32) * 2 * Math.PI)]));
  return new Polygon([ring]);
}

/** Entités de mission ; `moment` : état à l'instant du curseur de temps (sinon état courant). */
function missionFeatures(data: MissionData, s: MissionState, view: MissionView, live: boolean, moment: Moment | null): Feature[] {
  const ll = (p: XY) => data.projection.toLonLat(p);
  const path = (pts: XY[], style: Style) => {
    const f = new Feature(new LineString(pts.map(ll)));
    f.setStyle(style);
    return f;
  };
  const point = (p: XY, style: Style | Style[]) => {
    const f = new Feature(new Point(ll(p)));
    f.setStyle(style);
    return f;
  };

  const byId = Object.fromEntries(data.waypoints.map((w) => [w.id, w]));
  const rerouted = s.incident?.id === 'obstacle' && s.incident.choice === 'continue';
  const out: Feature[] = data.analysis.segments.map((sg) =>
    path(slicePath(data.route, byId[sg.from].d, byId[sg.to].d), line(slopeClass(sg.slope_deg).color, 5, undefined, rerouted ? 0.35 : 1)),
  );
  if (!live) {
    for (const w of data.waypoints) out.push(point(w.xy, waypointStyle(w, false)));
    return out;
  }

  const obstacles = moment ? moment.obstacles : s.obstacles;
  for (const o of obstacles) {
    const f = new Feature(circle(data, o.lonlat, o.radiusM));
    f.setStyle(obstacleStyle);
    out.push(f);
  }
  if (!moment && rerouted && s.leg?.kind === 'out') out.push(path(s.leg.path, line('#4CC6EA', 3, [8, 8])));
  if (!moment && s.leg?.kind === 'back' && s.phase === 'eva') out.push(path(s.leg.path, line(view.alert === 'return' ? '#F4605A' : '#4CC6EA', 3, [10, 8])));
  const trail = moment ? moment.trail : [...s.trail, view.position];
  if (trail.length > 1) out.push(path(trail, line('#4CC6EA', 3)));

  for (const w of data.waypoints) out.push(point(w.xy, waypointStyle(w, s.reached[w.id] !== undefined && (!moment || s.reached[w.id]! <= moment.t))));
  // Épingles d'observation (tablette), cliquables
  const t = moment ? moment.t : Infinity;
  s.log.forEach((e, i) => {
    if (!e.pos || e.source !== 'TABLETTE' || e.t > t) return;
    const f = new Feature(new Point(e.pos));
    f.setStyle(pinStyle);
    f.set('pin', i);
    out.push(f);
  });
  if (moment || s.phase === 'eva') out.push(point(moment ? moment.position : view.position, positionStyle));
  return out;
}

/* ---------------- Composant ---------------- */

interface MapHandle {
  map: OlMap;
  layers: Record<LayerKey, BaseLayer | undefined>;
  mission: VectorSource;
  extras: VectorSource; // point inspecté, aperçu d'itinéraire, repère de survol
}

const probeStyle = new Style({
  image: new RegularShape({ points: 4, radius: 11, radius2: 0, angle: Math.PI / 4, stroke: new Stroke({ color: '#F3EFEA', width: 3 }) }),
});
const hoverStyle = new Style({ image: new Circle({ radius: 7, fill: new Fill({ color: '#EE8A1B' }), stroke: new Stroke({ color: '#120F0D', width: 2 }) }) });

export interface MissionMapProps {
  height?: number;
  live?: boolean;
  /** Clic sur la carte (lon/lat) ; le curseur devient une croix. */
  onPick?: (p: LonLat) => void;
  /** Point inspecté (marqueur en croix). */
  probe?: LonLat | null;
  /** Itinéraire proposé : vert pointillé s'il est accepté, rouge s'il est refusé. */
  preview?: { coords: LonLat[]; ok: boolean } | null;
  /** Survol lié au profil : distance le long du tracé (m) à marquer, et rappel quand le pointeur longe le tracé. */
  hoverD?: number | null;
  onRouteHover?: (d: number | null) => void;
  /** Curseur de temps (min) : position, trajet, obstacles et épingles à cet instant ; null = direct. */
  atT?: number | null;
}

export function MissionMap({ height = 460, live = false, onPick, probe = null, preview = null, hoverD = null, onRouteHover, atT = null }: MissionMapProps) {
  const { s, view, data } = useMission();
  const { grid } = useTerrain();
  const [pin, setPin] = useState<number | null>(null); // épingle ouverte (index dans le journal)
  // Plein écran : carte + barre des couches (API Fullscreen du navigateur ; Échap pour sortir)
  const wrap = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : wrap.current?.requestFullscreen())?.catch(() => {});
  const target = useRef<HTMLDivElement>(null);
  const handle = useRef<MapHandle | null>(null);
  const [on, setOn] = useState<Record<LayerKey, boolean>>(DEFAULT_ON);
  // Valeurs courantes lues par les gestionnaires d'événements OpenLayers (créés une seule fois)
  const latest = useRef({ data, on, onPick, onRouteHover });
  latest.current = { data, on, onPick, onRouteHover };
  const imageryCfg = data.layers.find((l) => l.id === 'imagery')?.wmts;
  const slopeCfg = data.layers.find((l) => l.id === 'slope')?.wmts;
  const ov = data.overlays;
  const basemapCfg = data.layers.find((l) => l.id === 'basemap')?.wmts;
  const ctxCfg = data.layers.find((l) => l.id === 'ctx')?.wmts;
  // Couches actuellement servies par le cache local (serveur injoignable)
  const [cached, setCached] = useState<Record<string, boolean>>({});
  const track = (name: string) => (o: TileOrigin) => setCached((c) => ({ ...c, [name]: o === 'local' }));

  // Création de la carte (une fois)
  useEffect(() => {
    // Fond global sous HiRISE : plus de zone grise hors couverture de la mosaïque
    const basemap = basemapCfg ? wmtsLayer(basemapCfg, 'MOLA : NASA/JPL-Caltech/GSFC · NASA Mars Trek', track('MOLA')) : undefined;
    const ctx = ctxCfg ? wmtsLayer(ctxCfg, 'CTX : NASA/JPL-Caltech/MSSS · mosaïque Murray Lab (Caltech) · NASA Mars Trek', track('CTX')) : undefined;
    const imagery = imageryCfg ? wmtsLayer(imageryCfg, 'HiRISE : NASA/JPL-Caltech/University of Arizona · NASA Mars Trek', track('HiRISE')) : undefined;
    const slope = slopeCfg ? wmtsLayer(slopeCfg, 'Pentes : DTM HiRISE 1 m → 5 m (EVA Planner)') : undefined;
    const layers: Record<LayerKey, BaseLayer | undefined> = {
      imagery,
      slope,
      returnZone: new ImageLayer({ opacity: 0.9 }), // zone de retour calculée en direct (raster)
      regions: geojsonLayer(ov.crismRegions, (p) => crismStyles[String(p.code)]),
      geology: geojsonLayer(ov.geology, geologyStyle),
      crism: geojsonLayer(ov.crismFootprint, () => crismStyle),
      routes: new VectorLayer({ source: new VectorSource() }), // itinéraires calculés en direct
    };
    const mission = new VectorSource();
    const extras = new VectorSource();
    const map = new OlMap({
      target: target.current!,
      layers: [basemap, ctx, imagery, slope, layers.returnZone, layers.regions, layers.geology, layers.crism, layers.routes,
        new VectorLayer({ source: mission }), new VectorLayer({ source: extras })].filter(
        (l): l is NonNullable<typeof l> => !!l,
      ),
      // Vue limitée à l'emprise de la mosaïque, zoom calé sur les niveaux de la grille HiRISE :
      // le zoom maximal est MAX_VIEW_LEVEL.
      view: new View({
        projection: MARS_2000,
        extent: imageryCfg?.boundingBox,
        resolutions: imageryCfg ? wmtsResolutions(imageryCfg).slice(0, MAX_VIEW_LEVEL + 1) : undefined,
        constrainResolution: true,
      }),
      controls: defaultControls({ attributionOptions: { collapsible: true } }).extend([new ScaleLine({ units: 'metric' })]),
      interactions: defaultInteractions({ mouseWheelZoom: false }), // la page défile, la carte zoome aux boutons
    });
    // Vue initiale : tracé aller
    const d0 = latest.current.data;
    map.getView().fit(boundingExtent(d0.route.map(d0.projection.toLonLat)), { padding: [50, 50, 50, 50] });
    for (const key of Object.keys(layers) as LayerKey[]) layers[key]?.setVisible(latest.current.on[key]);
    map.on('singleclick', (e) => {
      const hit = map.forEachFeatureAtPixel(e.pixel, (f) => f.get('pin') as number | undefined, { hitTolerance: 4 });
      if (hit !== undefined) setPin(hit);
      else latest.current.onPick?.(e.coordinate as LonLat);
    });
    // Survol du tracé : distance le long du tracé si le pointeur est à moins de 20 px
    let hovering = false;
    map.on('pointermove', (e) => {
      const { data: d, onRouteHover: cb } = latest.current;
      if (!cb || e.dragging) return;
      const along = distanceAlong(d.route, d.projection.toLocal(e.coordinate as LonLat));
      const px = map.getPixelFromCoordinate(d.projection.toLonLat(pointAt(d.route, along).p));
      const near = !!px && dist(px as XY, e.pixel as XY) < 20;
      if (near) cb(along);
      else if (hovering) cb(null);
      hovering = near;
    });
    handle.current = { map, layers, mission, extras };
    if (import.meta.env.DEV) (window as unknown as { __evaMap?: OlMap }).__evaMap = map; // diagnostic (console / tests)
    return () => {
      map.setTarget(undefined);
      handle.current = null;
    };
  }, [imageryCfg, basemapCfg, ctxCfg, slopeCfg, ov]); // pas `data` : un nouveau tracé ne recrée pas la carte

  // Mise à jour des entités de mission à chaque changement d'état
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.mission.clear(true);
    h.mission.addFeatures(missionFeatures(data, s, view, live, atT === null ? null : momentAt(s, data, atT)));
  }, [data, s, view, live, atT]);

  // Zone de retour en direct : masque raster du champ de coût depuis A au seuil courant
  const zoneKey = `${s.params.autonomy}|${s.params.reserve}|${s.params.observation}|${s.params.speedKmh}|${data.analysis.aller.cost_m}`;
  useEffect(() => {
    const layer = handle.current?.layers.returnZone as ImageLayer<ImageStatic> | undefined;
    if (!grid || !layer) return;
    const { mask } = zoneFor(grid, data, s);
    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(grid.width, grid.height);
    for (let i = 0; i < mask.length; i++) if (mask[i]) img.data.set([31, 196, 143, 70], i * 4);
    ctx.putImageData(img, 0, 0);
    const [w, n] = fromGridXY(grid, [grid.origin.x, grid.origin.y]);
    const [e, so] = fromGridXY(grid, [grid.origin.x + grid.width * grid.cell_m, grid.origin.y - grid.height * grid.cell_m]);
    layer.setSource(new ImageStatic({ url: canvas.toDataURL(), imageExtent: [w, so, e, n], projection: MARS_2000, interpolate: false }));
  }, [grid, zoneKey]);

  // Itinéraires calculés en direct vers le B courant : plus court (distance seule) et moindre coût
  const bKey = data.waypoints[data.waypoints.length - 1].xy.join(',');
  useEffect(() => {
    const layer = handle.current?.layers.routes as VectorLayer<VectorSource> | undefined;
    if (!grid || !layer) return;
    const { shortest, leastCost } = alternativesFor(grid, data);
    const src = layer.getSource()!;
    src.clear(true);
    for (const [r, color] of [[shortest, '#F3EFEA'], [leastCost, '#B59CFF']] as const) {
      if (!r) continue;
      const f = new Feature(new LineString(r.path));
      f.setStyle(line(color, 3, [10, 6]));
      src.addFeature(f);
    }
  }, [grid, bKey]);

  // Point inspecté, aperçu d'itinéraire, repère de survol
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.extras.clear(true);
    const add = (geom: Point | LineString, style: Style) => {
      const f = new Feature(geom);
      f.setStyle(style);
      h.extras.addFeature(f);
    };
    if (preview) add(new LineString(preview.coords), line(preview.ok ? '#1FC48F' : '#F4605A', 4, [8, 6]));
    if (probe) add(new Point(probe), probeStyle);
    if (hoverD !== null) add(new Point(data.projection.toLonLat(pointAt(data.route, hoverD).p)), hoverStyle);
  }, [probe, preview, hoverD, data]);

  // Visibilité des couches
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    for (const key of Object.keys(on) as LayerKey[]) h.layers[key]?.setVisible(on[key]);
  }, [on]);

  const available: Record<LayerKey, boolean> = {
    imagery: !!imageryCfg, slope: !!slopeCfg, regions: !!ov.crismRegions, geology: !!ov.geology, routes: !!grid, returnZone: !!grid, crism: !!ov.crismFootprint,
  };
  return (
    <div ref={wrap} className={`stack map-wrap${full ? ' is-full' : ''}`} style={{ gap: 8 }}>
      <div className="row" role="group" aria-label="Couches de la carte">
        {TOGGLES.filter((t) => available[t.id]).map((t) => (
          <button key={t.id} className="chip" aria-pressed={on[t.id]} onClick={() => setOn({ ...on, [t.id]: !on[t.id] })}>
            <span className="dot" style={cssColor(t.color)} />
            {t.label}
          </button>
        ))}
        {document.fullscreenEnabled && (
          <button className="chip map-full-btn" aria-pressed={full} onClick={toggleFull} title={full ? 'Quitter le plein écran (Échap)' : 'Afficher la carte en plein écran'}>
            {full ? '✕ Quitter le plein écran' : '⛶ Plein écran'}
          </button>
        )}
      </div>
    <div className="map" style={full ? undefined : { height }}>
      <div ref={target} className="map-target" style={onPick ? { cursor: 'crosshair' } : undefined} />
      {Object.values(cached).some(Boolean) && (
        <div className="map-badge" role="status">
          <Icon name="warning" size={14} /> Serveur injoignable · cache local : {Object.keys(cached).filter((k) => cached[k]).join(', ')}
        </div>
      )}
      {pin !== null && s.log[pin] && <PinCard entry={s.log[pin]} onClose={() => setPin(null)} />}
    </div>
    </div>
  );
}

export function SlopeLegend() {
  return (
    <div className="legend">
      {SLOPE_CLASSES.map((c) => (
        <span key={c.label}>
          <span className="dot" style={cssColor(c.color)} />
          {c.label}
        </span>
      ))}
      <span>Pente du terrain (DTM 5 m) · tuiles : ≤ 10° non teinté · seuils : paramètres de démonstration</span>
    </div>
  );
}

/** Légende des régions CRISM, libellés lus dans crism_regions.geojson. */
export function CrismLegend() {
  const { data } = useMission();
  const regions = data.overlays.crismRegions;
  if (!regions) return null;
  return (
    <div className="legend">
      {Object.entries(regions.legend).map(([code, l]) => (
        <span key={code}>
          <span className="dot" style={cssColor(CRISM_COLORS[code])} />
          {l.label}
        </span>
      ))}
      <span>CRISM, Zastrow &amp; Glotch 2021</span>
    </div>
  );
}

/** Détail d'une épingle d'observation (tablette). */
function PinCard({ entry, onClose }: { entry: { t: number; text: string; kind?: string; pos?: LonLat }; onClose: () => void }) {
  return (
    <div className="map-pin" role="dialog" aria-label="Observation">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <strong>{entry.kind ?? 'Observation'}</strong>
        <button className="chip" onClick={onClose} aria-label="Fermer">×</button>
      </div>
      <span className="mono small">{fmtT(entry.t)}{entry.pos ? ` · ${entry.pos[1].toFixed(5)}° N, ${entry.pos[0].toFixed(5)}° E` : ''}</span>
      <span className="small">{entry.text}</span>
      <ProvenanceTag kind="obs" />
    </div>
  );
}
