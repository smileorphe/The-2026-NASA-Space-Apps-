/**
 * Couleurs et traits de la carte, partagés par les styles OpenLayers (components/MissionMap.tsx) et la légende
 * statique (components/MapLegend.tsx). Modifier une couleur ici la change aux deux endroits.
 * Les classes de pente sont dans domain/slope.ts (mêmes valeurs que les tuiles de pipeline/config.py).
 */

/** Tracé de mission, déplacements et repères. */
export const ROUTE = {
  width: 5,
  fadedOpacity: 0.35, // tracé de référence après un contournement
  trail: { color: '#4CC6EA', width: 3 },
  detour: { color: '#4CC6EA', width: 3, dash: [8, 8] },
  back: { color: '#4CC6EA', width: 3, dash: [10, 8] },
  backAlert: { color: '#F4605A', width: 3, dash: [10, 8] },
  shortest: { color: '#F3EFEA', width: 3, dash: [10, 6] },
  leastCost: { color: '#B59CFF', width: 3, dash: [10, 6] },
  previewOk: { color: '#1FC48F', width: 4, dash: [8, 6] },
  previewRefused: { color: '#F4605A', width: 4, dash: [8, 6] },
} as const;

export const POINTS = {
  A: '#F3EFEA',
  B: '#EE8A1B',
  waypointFill: '#1A1817',
  waypointTodo: '#4CC6EA',
  waypointDone: '#1FC48F',
  position: '#4CC6EA',
  positionRing: '#F3EFEA',
  pin: '#B59CFF',
  pinRing: '#F3EFEA',
  probe: '#F3EFEA',
  hover: '#EE8A1B',
} as const;

export const SAFETY = {
  obstacle: '#F4605A',
  obstacleFillOpacity: 0.35,
  returnZone: '#1FC48F',
  returnZoneAlpha: 70, // 0–255, raster calculé en direct
} as const;

/** Classes CRISM (Zastrow & Glotch 2021). */
export const CRISM_COLORS: Record<'MC' | 'MT' | 'sand' | 'mixture', string> = { MC: '#B59CFF', MT: '#F28AB3', sand: '#E8C27A', mixture: '#8FA3B8' };
export const CRISM_FILL_OPACITY = { default: 0.3, mixture: 0.12 } as const;
export const CRISM_FOOTPRINT = { color: '#B59CFF', width: 2, dash: [8, 6] } as const;

export const GEOLOGY = {
  unit: '#FFE650',
  unitStrokeOpacity: 0.85,
  deltaFront: '#FF4FD8',
  otherLine: '#4CC6EA',
  ellipse: { color: '#F3EFEA', width: 1.5, dash: [4, 6], opacity: 0.8 },
} as const;

/** Rappel des fonds (texte écrit en dur dans la légende ; détail dans layers.json et le tableau de provenance). */
export const BASEMAP_TONES = { hirise: '#8E8A86', ctx: '#6F6B67', mola: '#55514D' } as const;
