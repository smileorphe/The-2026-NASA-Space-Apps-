/**
 * Légende statique de la carte : composant purement visuel, contenu écrit en dur.
 * - Aucune lecture du store ni de l'état de la carte, aucun effet : l'afficher ou la replier ne déclenche aucun calcul.
 * - Repli natif (<details>) : pas d'état React, donc pas de nouveau rendu.
 * - Couleurs importées des mêmes constantes que les styles de la carte (map/palette.ts, domain/slope.ts).
 */
import type { ReactNode } from 'react';
import { SLOPE_CLASSES } from '../domain/slope';
import { BASEMAP_TONES, CRISM_COLORS, CRISM_FILL_OPACITY, CRISM_FOOTPRINT, GEOLOGY, POINTS, ROUTE, SAFETY } from '../map/palette';

const S = 20; // taille des symboles (px)

type LineSpec = { color: string; width: number; dash?: readonly number[]; opacity?: number };

function Swatch({ children }: { children: ReactNode }) {
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden="true" className="legend-swatch">
      {children}
    </svg>
  );
}

const Line = ({ color, width, dash, opacity }: LineSpec) => (
  <Swatch>
    <line x1={1} y1={10} x2={19} y2={10} stroke={color} strokeWidth={Math.min(width, 6)} strokeOpacity={opacity ?? 1} strokeDasharray={dash?.map((d) => d / 2).join(' ')} />
  </Swatch>
);

const Area = ({ fill, opacity = 1, stroke, dash }: { fill?: string; opacity?: number; stroke?: string; dash?: readonly number[] }) => (
  <Swatch>
    <rect x={1.5} y={1.5} width={17} height={17} fill={fill ?? 'none'} fillOpacity={opacity} stroke={stroke ?? 'none'} strokeWidth={stroke ? 1.5 : 0}
      strokeDasharray={dash?.map((d) => d / 2).join(' ')} />
  </Swatch>
);

const Dot = ({ fill, stroke, r = 6 }: { fill: string; stroke?: string; r?: number }) => (
  <Swatch>
    <circle cx={10} cy={10} r={r} fill={fill} stroke={stroke} strokeWidth={stroke ? 2.5 : 0} />
  </Swatch>
);

const Square = ({ fill }: { fill: string }) => (
  <Swatch>
    <rect x={3} y={3} width={14} height={14} fill={fill} />
  </Swatch>
);

const Diamond = ({ fill }: { fill: string }) => (
  <Swatch>
    <polygon points="10,1 19,10 10,19 1,10" fill={fill} />
  </Swatch>
);

const Cross = ({ color }: { color: string }) => (
  <Swatch>
    <path d="M4 4 L16 16 M16 4 L4 16" stroke={color} strokeWidth={3} />
  </Swatch>
);

const Image = ({ tone }: { tone: string }) => (
  <Swatch>
    <rect x={1} y={1} width={18} height={18} fill={tone} />
    <path d="M1 15 L7 9 L11 13 L15 8 L19 12 L19 19 L1 19 Z" fill="#000" fillOpacity={0.25} />
  </Swatch>
);

function Row({ symbol, children, detail }: { symbol: ReactNode; children: ReactNode; detail?: string }) {
  return (
    <div className="legend-row">
      {symbol}
      <span>
        {children}
        {detail && <span className="legend-detail">{detail}</span>}
      </span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="legend-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

const Title = ({ children }: { children: ReactNode }) => <div className="legend-title">{children}</div>;

export function MapLegend() {
  return (
    <details className="map-legend" open>
      <summary>Légende</summary>
      <div className="map-legend-body">
        <Group title="Itinéraire">
          <Title>Tracé de mission · couleur = pente du segment</Title>
          {SLOPE_CLASSES.map((c) => (
            <Row key={c.label} symbol={<Line color={c.color} width={ROUTE.width} />}>pente {c.label}</Row>
          ))}
          <Row symbol={<Square fill={POINTS.A} />}>A · habitat</Row>
          <Row symbol={<Dot fill={POINTS.waypointFill} stroke={POINTS.waypointTodo} />}>W1–W3 · à venir</Row>
          <Row symbol={<Dot fill={POINTS.waypointFill} stroke={POINTS.waypointDone} />}>W1–W3 · franchi</Row>
          <Row symbol={<Diamond fill={POINTS.B} />}>B · site</Row>
          <Row symbol={<Dot fill={POINTS.position} stroke={POINTS.positionRing} />}>Astronaute (position simulée)</Row>
          <Row symbol={<Line {...ROUTE.trail} />}>Trajet réalisé</Row>
          <Row symbol={<Line {...ROUTE.detour} />}>Contournement de l’obstacle</Row>
          <Title>Itinéraires calculés vers B</Title>
          <Row symbol={<Line {...ROUTE.shortest} />}>plus court (distance seule)</Row>
          <Row symbol={<Line {...ROUTE.leastCost} />}>moindre coût</Row>
          <Title>Itinéraire proposé (choix de B)</Title>
          <Row symbol={<Line {...ROUTE.previewOk} />}>accepté</Row>
          <Row symbol={<Line {...ROUTE.previewRefused} />}>refusé (marge sous la réserve)</Row>
        </Group>

        <Group title="Sécurité">
          <Row symbol={<Area fill={SAFETY.obstacle} opacity={SAFETY.obstacleFillOpacity} stroke={SAFETY.obstacle} />} detail="cellules bloquées dans un rayon de 15 m">Obstacle</Row>
          <Row symbol={<Area fill={SAFETY.returnZone} opacity={SAFETY.returnZoneAlpha / 255} />} detail="retour à A sous le seuil : autonomie − réserve − (aller + observation)">Zone de retour à pied</Row>
          <Row symbol={<Line {...ROUTE.back} />}>Retour vers A</Row>
          <Row symbol={<Line {...ROUTE.backAlert} />}>Retour prioritaire (alerte)</Row>
        </Group>

        <Group title="Terrain">
          <Title>Pente du terrain (DTM 5 m)</Title>
          {SLOPE_CLASSES.map((c, i) => (
            <Row key={c.label} symbol={i === 0 ? <Area stroke="#aba39b" dash={[6, 4]} /> : <Area fill={c.color} opacity={0.75} />}>
              {i === 0 ? `${c.label} · non coloré` : c.label}
            </Row>
          ))}
          <Title>Géologie · USGS SIM 3464</Title>
          <Row symbol={<Area stroke={GEOLOGY.unit} />}>Unité géologique (code sur la carte)</Row>
          <Row symbol={<Line color={GEOLOGY.deltaFront} width={2.5} />}>Front de lobe du delta</Row>
          <Row symbol={<Line color={GEOLOGY.otherLine} width={2.5} />}>Chenal fluvial</Row>
          <Row symbol={<Line {...GEOLOGY.ellipse} />}>Ellipse d’atterrissage Mars 2020</Row>
          <Row symbol={<Cross color={POINTS.probe} />}>Point inspecté</Row>
        </Group>

        <Group title="Science">
          <Title>Régions CRISM · Zastrow &amp; Glotch 2021</Title>
          <Row symbol={<Area fill={CRISM_COLORS.MC} opacity={CRISM_FILL_OPACITY.default} stroke={CRISM_COLORS.MC} />}>Carbonates marginaux (MC)</Row>
          <Row symbol={<Area fill={CRISM_COLORS.MT} opacity={CRISM_FILL_OPACITY.default} stroke={CRISM_COLORS.MT} />}>Terrain moucheté (MT)</Row>
          <Row symbol={<Area fill={CRISM_COLORS.sand} opacity={CRISM_FILL_OPACITY.default} stroke={CRISM_COLORS.sand} />}>Sable (majoritaire)</Row>
          <Row symbol={<Area fill={CRISM_COLORS.mixture} opacity={CRISM_FILL_OPACITY.mixture} stroke={CRISM_COLORS.mixture} />}>Mélange roche claire / sable</Row>
          <Row symbol={<Area stroke={CRISM_FOOTPRINT.color} dash={CRISM_FOOTPRINT.dash} />}>Emprise CRISM 040ff</Row>
          <Row symbol={<Dot fill={POINTS.pin} stroke={POINTS.pinRing} r={5} />}>Observation de la tablette (cliquable)</Row>
        </Group>

        <Group title="Fonds">
          <Row symbol={<Image tone={BASEMAP_TONES.hirise} />} detail="NASA/JPL-Caltech/University of Arizona · 25 cm/px nominal, ≈ 1–2 m/px effectif">HiRISE</Row>
          <Row symbol={<Image tone={BASEMAP_TONES.ctx} />} detail="NASA/JPL-Caltech/MSSS, mosaïque Murray Lab · ≈ 20 m/px affiché (niveau 10)">CTX</Row>
          <Row symbol={<Image tone={BASEMAP_TONES.mola} />} detail="NASA/JPL-Caltech/GSFC · 463 m/px">MOLA relief ombré</Row>
        </Group>
      </div>
    </details>
  );
}
