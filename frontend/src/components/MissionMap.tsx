/**
 * Carte de mission (Leaflet, L.CRS.Simple).
 * Les coordonnées des données sont en mètres (x = est, y = nord) ; la seule conversion vers Leaflet est `ll()`.
 * Quand les tuiles gdal2tiles seront prêtes, renseigner `tiles` dans public/data/layers.json :
 * les tuiles et le GeoJSON doivent partager le même repère (sinon adapter `ll()` uniquement).
 */
import { useState } from 'react';
import L, { type LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip } from 'react-leaflet';
import type { XY } from '../domain/geometry';
import { slicePath } from '../domain/geometry';
import type { Waypoint } from '../data';
import { useMission } from '../store';
import { cssColor } from './ui';

const ll = ([x, y]: XY): LatLngExpression => [y, x];

/** Seuils de pente : paramètres de démonstration, pas des normes. */
export const SLOPE_CLASSES = [
  { max: 8, color: '#1FC48F', label: 'Pente < 8°' },
  { max: 15, color: '#F2C230', label: '8–15°' },
  { max: Infinity, color: '#F4605A', label: '> 15°' },
];
const slopeColor = (deg: number) => SLOPE_CLASSES.find((c) => deg < c.max)!.color;

type LayerKey = 'topo' | 'crism' | 'footprints';
const TOGGLES: { id: LayerKey; label: string; color: string }[] = [
  { id: 'topo', label: 'Relief', color: 'var(--muted)' },
  { id: 'crism', label: 'CRISM', color: 'var(--carb)' },
  { id: 'footprints', label: 'Emprises', color: 'var(--text)' },
];

function waypointIcon(w: Waypoint, done: boolean) {
  const cls = w.id === 'A' ? 'wp wp-a' : w.id === 'B' ? 'wp wp-b' : `wp${done ? ' wp-done' : ''}`;
  return L.divIcon({ className: cls, html: w.id, iconSize: undefined });
}

export function MissionMap({ height = 460, live = false }: { height?: number; live?: boolean }) {
  const { s, view, data } = useMission();
  const [on, setOn] = useState<Record<LayerKey, boolean>>({ topo: true, crism: true, footprints: true });
  const [[x0, y0], [x1, y1]] = data.extent;
  const bounds: L.LatLngBoundsExpression = [[y0, x0], [y1, x1]];
  const byId = Object.fromEntries(data.waypoints.map((w) => [w.id, w]));
  const leg = s.leg;
  const onDetour = s.incident?.id === 'obstacle' && s.incident.choice === 'detour';

  return (
    <div className="map" style={{ height }}>
      <MapContainer crs={L.CRS.Simple} bounds={bounds} maxBounds={bounds} minZoom={-3} maxZoom={2} zoomSnap={0.25} scrollWheelZoom={false} attributionControl={false}>
        {data.layers
          .filter((l) => l.tiles && on[l.id as LayerKey])
          .map((l) => (
            <TileLayer key={l.id} url={l.tiles!} opacity={l.id === 'crism' ? 0.6 : 1} />
          ))}

        {on.footprints && data.layers.find((l) => l.id === 'topo')?.footprint && (
          <Polygon positions={data.layers.find((l) => l.id === 'topo')!.footprint!.map(ll)} pathOptions={{ color: '#ABA39B', weight: 1.5, dashArray: '3 6', fill: false }}>
            <Tooltip sticky>Emprise DTM</Tooltip>
          </Polygon>
        )}
        {on.crism && data.layers.find((l) => l.id === 'crism')?.footprint && (
          <Polygon positions={data.layers.find((l) => l.id === 'crism')!.footprint!.map(ll)} pathOptions={{ color: '#B59CFF', weight: 2, dashArray: '8 6', fillOpacity: 0.08 }}>
            <Tooltip sticky>Emprise CRISM · produit retenu</Tooltip>
          </Polygon>
        )}

        {/* Tracé aller coloré par pente (segments issus de l'analyse DTM) */}
        {data.analysis.segments.map((sg) => (
          <Polyline
            key={sg.from + sg.to}
            positions={slicePath(data.route, byId[sg.from].d, byId[sg.to].d).map(ll)}
            pathOptions={{ color: slopeColor(sg.slope_deg), weight: 5, opacity: onDetour && sg.to === 'B' ? 0.3 : 1 }}
          >
            <Tooltip sticky>{`${sg.from} → ${sg.to} · ${sg.length_m} m · ${sg.slope_deg}°`}</Tooltip>
          </Polyline>
        ))}

        {live && s.incident?.id === 'obstacle' && (
          <>
            <Polyline positions={data.detour.map(ll)} pathOptions={{ color: '#4CC6EA', weight: 3, dashArray: '8 8', opacity: onDetour ? 1 : 0.5 }} />
            {data.obstacle && (
              <CircleMarker center={ll(data.obstacle)} radius={9} pathOptions={{ color: '#F2C230', fillColor: '#F2C230', fillOpacity: 0.9 }}>
                <Tooltip permanent direction="right">Obstacle signalé</Tooltip>
              </CircleMarker>
            )}
          </>
        )}
        {live && leg?.kind === 'back' && s.phase === 'eva' && (
          <Polyline positions={leg.path.map(ll)} pathOptions={{ color: view.alert === 'return' ? '#F4605A' : '#4CC6EA', weight: 3, dashArray: '10 8' }} />
        )}
        {live && s.trail.length > 1 && <Polyline positions={[...s.trail, view.position].map(ll)} pathOptions={{ color: '#4CC6EA', weight: 3 }} />}

        {data.waypoints.map((w) => (
          <Marker key={w.id} position={ll(w.xy)} icon={waypointIcon(w, s.reached[w.id] !== undefined)} keyboard={false}>
            {(w.id === 'A' || w.id === 'B') && (
              <Tooltip permanent direction={w.id === 'A' ? 'bottom' : 'top'} offset={[0, w.id === 'A' ? 14 : -14]}>
                {w.name}
              </Tooltip>
            )}
          </Marker>
        ))}

        {live && s.phase === 'eva' && (
          <CircleMarker center={ll(view.position)} radius={8} pathOptions={{ color: '#F3EFEA', weight: 3, fillColor: '#4CC6EA', fillOpacity: 1 }}>
            <Tooltip direction="top">Position simulée EV1</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>

      <div className="map-overlay">
        {TOGGLES.filter((t) => t.id !== 'topo' || data.layers.some((l) => l.id === 'topo' && l.tiles)).map((t) => (
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
