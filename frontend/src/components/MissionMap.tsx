/**
 * Carte de mission (OpenLayers).
 * Fond : mosaïque HiRISE de Jezero en WMTS (Mars Trek). Calques vectoriels : emprises, tracé coloré par pente,
 * waypoints et, en mode `live`, position simulée, trajet réalisé, détour et retour.
 * Les géométries de mission sont en mètres locaux ; `data.projection.toLonLat` est la seule conversion vers la carte.
 */
import { useEffect, useRef, useState } from 'react';
import 'ol/ol.css';
import OlMap from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import { LineString, Point, Polygon } from 'ol/geom';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import { defaults as defaultInteractions } from 'ol/interaction';
import { asArray } from 'ol/color';
import { boundingExtent } from 'ol/extent';
import type BaseLayer from 'ol/layer/Base';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import { slicePath, type XY } from '../domain/geometry';
import type { MissionData, Waypoint } from '../data';
import type { MissionState, View as MissionView } from '../domain/mission';
import { MARS_2000, type TileOrigin, wmtsLayer, wmtsResolutions } from '../map/mars';
import { useMission } from '../store';
import { Icon } from './Icon';
import { cssColor } from './ui';

/** Seuils de pente : paramètres de démonstration, pas des normes. */
export const SLOPE_CLASSES = [
  { max: 8, color: '#1FC48F', label: 'Pente < 8°' },
  { max: 15, color: '#F2C230', label: '8–15°' },
  { max: Infinity, color: '#F4605A', label: '> 15°' },
];
const slopeColor = (deg: number) => SLOPE_CLASSES.find((c) => deg < c.max)!.color;

type LayerKey = 'imagery' | 'crism' | 'footprints';
const TOGGLES: { id: LayerKey; label: string; color: string }[] = [
  { id: 'imagery', label: 'HiRISE', color: 'var(--text)' },
  { id: 'crism', label: 'CRISM', color: 'var(--carb)' },
  { id: 'footprints', label: 'Emprises', color: 'var(--muted)' },
];

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
  image: new Circle({ radius: 9, fill: new Fill({ color: '#F2C230' }) }),
  text: new Text({ text: 'Obstacle signalé', offsetX: 14, textAlign: 'left', font: `600 12px ${FONT}`, fill: new Fill({ color: '#F3EFEA' }), backgroundFill: new Fill({ color: 'rgba(16,13,11,0.85)' }), padding: [3, 6, 3, 6] }),
});

/* ---------------- Construction des entités ---------------- */

function footprintFeatures(data: MissionData, id: 'topo' | 'crism'): Feature[] {
  const fp = data.layers.find((l) => l.id === id)?.footprint;
  if (!fp) return [];
  const f = new Feature(new Polygon([[...fp, fp[0]]]));
  f.setStyle(
    id === 'crism'
      ? new Style({ stroke: new Stroke({ color: '#B59CFF', width: 2, lineDash: [8, 6] }), fill: new Fill({ color: 'rgba(181,156,255,0.10)' }) })
      : new Style({ stroke: new Stroke({ color: '#ABA39B', width: 1.5, lineDash: [3, 6] }) }),
  );
  return [f];
}

function missionFeatures(data: MissionData, s: MissionState, view: MissionView, live: boolean): Feature[] {
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
  const onDetour = s.incident?.id === 'obstacle' && s.incident.choice === 'detour';
  const out: Feature[] = data.analysis.segments.map((sg) =>
    path(slicePath(data.route, byId[sg.from].d, byId[sg.to].d), line(slopeColor(sg.slope_deg), 5, undefined, onDetour && sg.to === 'B' ? 0.3 : 1)),
  );

  if (live && s.incident?.id === 'obstacle') {
    out.push(path(data.detour, line('#4CC6EA', 3, [8, 8], onDetour ? 1 : 0.5)));
    if (data.obstacle) out.push(point(data.obstacle, obstacleStyle));
  }
  if (live && s.leg?.kind === 'back' && s.phase === 'eva') out.push(path(s.leg.path, line(view.alert === 'return' ? '#F4605A' : '#4CC6EA', 3, [10, 8])));
  if (live && s.trail.length > 1) out.push(path([...s.trail, view.position], line('#4CC6EA', 3)));

  for (const w of data.waypoints) out.push(point(w.xy, waypointStyle(w, s.reached[w.id] !== undefined)));
  if (live && s.phase === 'eva') out.push(point(view.position, positionStyle));
  return out;
}

/* ---------------- Composant ---------------- */

interface MapHandle {
  map: OlMap;
  layers: Record<LayerKey, BaseLayer | undefined>;
  mission: VectorSource;
}

export function MissionMap({ height = 460, live = false }: { height?: number; live?: boolean }) {
  const { s, view, data } = useMission();
  const target = useRef<HTMLDivElement>(null);
  const handle = useRef<MapHandle | null>(null);
  const [on, setOn] = useState<Record<LayerKey, boolean>>({ imagery: true, crism: true, footprints: true });
  const imageryCfg = data.layers.find((l) => l.id === 'imagery')?.wmts;
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
    const crism = new VectorLayer({ source: new VectorSource({ features: footprintFeatures(data, 'crism') }) });
    const footprints = new VectorLayer({ source: new VectorSource({ features: footprintFeatures(data, 'topo') }) });
    const mission = new VectorSource();
    const map = new OlMap({
      target: target.current!,
      layers: [basemap, ctx, imagery, footprints, crism, new VectorLayer({ source: mission })].filter((l): l is NonNullable<typeof l> => !!l),
      // Vue limitée à l'emprise de la mosaïque, zoom calé sur les niveaux de la grille HiRISE :
      // le zoom maximal correspond au niveau 17 natif (pas de sur-agrandissement flou).
      view: new View({
        projection: MARS_2000,
        extent: imageryCfg?.boundingBox,
        resolutions: imageryCfg ? wmtsResolutions(imageryCfg).slice(0, MAX_VIEW_LEVEL + 1) : undefined,
        constrainResolution: true,
      }),
      controls: defaultControls({ attributionOptions: { collapsible: true } }).extend([new ScaleLine({ units: 'metric' })]),
      interactions: defaultInteractions({ mouseWheelZoom: false }), // la page défile, la carte zoome aux boutons
    });
    map.getView().fit(boundingExtent(data.extent), { padding: [30, 30, 30, 30] });
    handle.current = { map, layers: { imagery, crism, footprints }, mission };
    if (import.meta.env.DEV) (window as unknown as { __evaMap?: OlMap }).__evaMap = map; // diagnostic (console / tests)
    return () => {
      map.setTarget(undefined);
      handle.current = null;
    };
  }, [data, imageryCfg, basemapCfg, ctxCfg]);

  // Mise à jour des entités de mission à chaque changement d'état
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.mission.clear(true);
    h.mission.addFeatures(missionFeatures(data, s, view, live));
  }, [data, s, view, live]);

  // Visibilité des couches
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    for (const key of Object.keys(on) as LayerKey[]) h.layers[key]?.setVisible(on[key]);
  }, [on]);

  return (
    <div className="map" style={{ height }}>
      <div ref={target} className="map-target" />
      {Object.values(cached).some(Boolean) && (
        <div className="map-badge" role="status">
          <Icon name="warning" size={14} /> Serveur injoignable · cache local : {Object.keys(cached).filter((k) => cached[k]).join(', ')}
        </div>
      )}
      <div className="map-overlay">
        {TOGGLES.filter((t) => t.id !== 'imagery' || imageryCfg).map((t) => (
          <button key={t.id} className="chip" aria-pressed={on[t.id]} onClick={() => setOn({ ...on, [t.id]: !on[t.id] })}>
            <span className="dot" style={cssColor(t.color)} />
            {t.label}
          </button>
        ))}
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
      <span>Seuils de pente : paramètres de démonstration</span>
    </div>
  );
}
