/** Petits graphiques SVG sans bibliothèque : profil d'élévation, autonomie dans le temps, barre de budget. */
import type React from 'react';
import type { Budget } from '../domain/autonomy';
import { cssColor } from './ui';

const W = 600;
const H = 170;
const PAD = { l: 52, r: 12, t: 12, b: 26 };

const scale = (v: number, d0: number, d1: number, r0: number, r1: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

/** Profil d'élévation. `hover` / `onHover` : distance survolée (m), partagée avec la carte. */
export function ElevationProfile({ profile, marker, hover = null, onHover }: { profile: { d: number; z: number }[]; marker?: number; hover?: number | null; onHover?: (d: number | null) => void }) {
  const dMax = profile[profile.length - 1].d;
  const zs = profile.map((p) => p.z);
  const [zMin, zMax] = [Math.min(...zs) - 2, Math.max(...zs) + 2];
  const X = (d: number) => scale(d, 0, dMax, PAD.l, W - PAD.r);
  const Y = (z: number) => scale(z, zMin, zMax, H - PAD.b, PAD.t);
  const line = profile.map((p) => `${X(p.d)},${Y(p.z)}`).join(' ');
  const label = `Profil d’élévation sur ${Math.round(dMax)} m, de ${Math.round(zMin + 2)} à ${Math.round(zMax - 2)} m`;
  const zAt = (d: number) => {
    const i = profile.findIndex((p) => p.d >= d);
    if (i <= 0) return profile[Math.max(i, 0)].z;
    const a = profile[i - 1], b = profile[i];
    return a.z + ((b.z - a.z) * (d - a.d)) / (b.d - a.d || 1);
  };
  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    onHover?.(Math.max(0, Math.min(dMax, ((x - PAD.l) / (W - PAD.l - PAD.r)) * dMax)));
  };

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}
      onMouseMove={onHover ? move : undefined} onMouseLeave={onHover ? () => onHover(null) : undefined}>
      <polygon points={`${X(0)},${H - PAD.b} ${line} ${X(dMax)},${H - PAD.b}`} fill="#4CC6EA" opacity="0.12" />
      <polyline points={line} fill="none" stroke="#4CC6EA" strokeWidth="2.5" />
      <g fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#ABA39B">
        <text x={PAD.l - 6} y={Y(zMax - 2) + 4} textAnchor="end">{Math.round(zMax - 2)} m</text>
        <text x={PAD.l - 6} y={Y(zMin + 2) + 4} textAnchor="end">{Math.round(zMin + 2)} m</text>
        <text x={PAD.l} y={H - 6}>A · 0 m</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end">B · {Math.round(dMax)} m</text>
      </g>
      {hover !== null && (
        <g>
          <line x1={X(hover)} x2={X(hover)} y1={PAD.t} y2={H - PAD.b} stroke="#EE8A1B" strokeWidth="1.5" />
          <circle cx={X(hover)} cy={Y(zAt(hover))} r="4.5" fill="#EE8A1B" />
          <text x={Math.min(X(hover) + 6, W - 120)} y={PAD.t + 24} fontSize="11" fill="#EE8A1B" fontFamily="IBM Plex Mono, monospace">
            {Math.round(hover)} m · {Math.round(zAt(hover))} m
          </text>
        </g>
      )}
      {marker !== undefined && (
        <g>
          <line x1={X(marker)} x2={X(marker)} y1={PAD.t} y2={H - PAD.b} stroke="#EE8A1B" strokeWidth="2" strokeDasharray="4 4" />
          <text x={X(marker) + 6} y={PAD.t + 10} fontSize="11" fill="#EE8A1B" fontFamily="Manrope, sans-serif" fontWeight="700">EV1</text>
        </g>
      )}
    </svg>
  );
}

/** Autonomie (min) dans le temps : plan, simulé, projection, réserve. */
export function AutonomyChart(p: { autonomy: number; reserve: number; t: number; remaining: number; planEnd: number; planMargin: number; etaA: number; margin: number }) {
  const tMax = Math.max(p.autonomy, p.etaA, p.planEnd);
  const X = (t: number) => scale(t, 0, tMax, PAD.l, W - PAD.r);
  const Y = (a: number) => scale(a, 0, p.autonomy, H - PAD.b, PAD.t);
  const label = `Autonomie : ${Math.round(p.remaining)} min restantes à T+${Math.round(p.t)}, projection ${p.margin} min au retour, réserve ${p.reserve} min`;
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <line x1={PAD.l} x2={W - PAD.r} y1={Y(p.reserve)} y2={Y(p.reserve)} stroke="#F4605A" strokeWidth="1.5" strokeDasharray="4 4" />
        <text x={W - PAD.r} y={Y(p.reserve) - 5} textAnchor="end" fontSize="11" fill="#F4605A">Réserve {p.reserve} min</text>
        <line x1={X(0)} y1={Y(p.autonomy)} x2={X(p.planEnd)} y2={Y(p.planMargin)} stroke="#ABA39B" strokeWidth="2" strokeDasharray="2 5" />
        <line x1={X(0)} y1={Y(p.autonomy)} x2={X(p.t)} y2={Y(p.remaining)} stroke="#4CC6EA" strokeWidth="3" />
        <line x1={X(p.t)} y1={Y(p.remaining)} x2={X(p.etaA)} y2={Y(p.margin)} stroke="#EE8A1B" strokeWidth="2.5" strokeDasharray="8 5" />
        <circle cx={X(p.t)} cy={Y(p.remaining)} r="5" fill="#4CC6EA" />
        <g fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#ABA39B">
          <text x={PAD.l - 6} y={Y(p.autonomy) + 4} textAnchor="end">{p.autonomy}</text>
          <text x={PAD.l - 6} y={Y(0) + 4} textAnchor="end">0</text>
          <text x={PAD.l} y={H - 6}>T+0</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end">T+{Math.round(tMax)} min</text>
        </g>
      </svg>
      <div className="legend">
        <span><span className="dot" style={cssColor('#ABA39B')} />Plan</span>
        <span><span className="dot" style={cssColor('#4CC6EA')} />Simulé</span>
        <span><span className="dot" style={cssColor('#EE8A1B')} />Projection</span>
        <span><span className="dot" style={cssColor('#F4605A')} />Réserve</span>
      </div>
    </>
  );
}

/** Barre empilée aller / observation / retour / marge, sur le budget total. */
export function BudgetBar({ b, marginMin }: { b: Budget; marginMin: number }) {
  const parts = [
    { label: 'Aller', v: b.allerRestant, c: '#4CC6EA' },
    { label: 'Observation', v: b.observation, c: '#B59CFF' },
    { label: 'Retour', v: b.retour, c: '#ABA39B' },
    { label: 'Marge', v: Math.max(marginMin, 0), c: marginMin >= 0 ? '#1FC48F' : '#F4605A' },
  ];
  const aria = parts.map((p) => `${p.label} ${Math.round(p.v)} min`).join(', ') + `, sur ${b.autonomy} min`;
  return (
    <>
      <div className="budget-bar" role="img" aria-label={aria}>
        {parts.filter((p) => p.v > 0).map((p) => (
          <div key={p.label} style={{ ...cssColor(p.c), flexGrow: p.v }}>{Math.round(p.v)}</div>
        ))}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.label}><span className="dot" style={cssColor(p.c)} />{p.label}</span>
        ))}
      </div>
    </>
  );
}
