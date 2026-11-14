import { useEffect } from 'react';
import { Icon } from '../components/Icon';
import { cssColor, STATUS } from '../components/ui';
import { fmtDistance, fmtT } from '../format';
import { setRole, useMission } from '../store';

const BARS = 6;

/** HUD du casque — 1280×720 plein écran. Flèche, distance, progression, autonomie, alerte. Rien d'autre. */
export function Helmet() {
  useEffect(() => setRole('casque'), []);
  const { s, view, data } = useMission();
  const alert = view.alert;
  const guide = alert === 'return' ? '#F4605A' : '#1FC48F'; // hex : var() n'est pas fiable dans les attributs SVG
  const st = STATUS[view.status];
  const incident = s.incident ? data.scenarios[s.incident.id] : null;

  const target =
    s.phase === 'prep' ? 'En attente du départ' : s.phase === 'done' ? 'Habitat A · sortie terminée' : s.leg?.kind === 'site' ? 'Point B · observation en cours' : view.next?.id === 'A' ? 'Habitat A · tracé connu' : `Prochain point · ${view.next?.id ?? 'B'}`;

  return (
    <div className="hud" role="main" aria-label="Affichage casque (simulation)">
      <Scene guide={guide} />
      {alert === 'return' && <div className="hud-alert-frame" />}

      <div className="hud-box" style={{ left: 28, top: 28 }}>
        <div className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
          <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
            <circle cx="28" cy="28" r="26" fill="none" stroke={alert === 'return' ? '#F4605A' : '#4CC6EA'} strokeWidth="2" />
            {view.next && <path d="M28 8 L 40 40 L 28 32 L 16 40 Z" fill={alert === 'return' ? '#F4605A' : '#4CC6EA'} transform={`rotate(${view.next.relBearing.toFixed(0)} 28 28)`} />}
          </svg>
          <div className="stack" style={{ gap: 0 }}>
            <span className="lbl">{target}</span>
            <span className="mono" style={{ fontSize: 30, fontWeight: 600 }}>{view.next ? fmtDistance(view.next.distance) : '—'}</span>
          </div>
        </div>
      </div>

      <div className="hud-box" style={{ right: 28, top: 28 }}>
        <div className="row lbl" style={{ justifyContent: 'space-between' }}>
          <span>Progression</span>
          <span className="mono">{view.progressPct} %</span>
        </div>
        <div className="progress" role="progressbar" aria-valuenow={view.progressPct} aria-valuemin={0} aria-valuemax={100}>
          {Array.from({ length: BARS }, (_, i) => <span key={i} className={view.progressPct >= ((i + 1) * 100) / BARS ? 'on' : ''} />)}
        </div>
      </div>

      {s.lastMessageToHud && alert === 'none' && s.phase === 'eva' && (
        <div className="hud-box" style={{ left: '50%', top: 28, transform: 'translateX(-50%)', maxWidth: 520 }}>
          <span className="lbl">Message de l’habitat</span>
          <strong>{s.lastMessageToHud}</strong>
        </div>
      )}

      {alert !== 'none' && (
        <div role="alert" className="hud-banner" style={cssColor(alert === 'return' ? 'var(--red)' : 'var(--amber)')}>
          <strong>{alert === 'return' ? 'RETOUR PRIORITAIRE' : 'IMPRÉVU SIMULÉ'}</strong>
          <span style={{ fontSize: 16 }}>
            {alert === 'return'
              ? incident ? `${incident.title} · simulation · retour par le tracé connu` : `Marge ${view.margin} min, sous la réserve de ${s.params.reserve} min (simulation)`
              : `${incident?.title} · attendez la décision de l’habitat`}
          </span>
        </div>
      )}

      <div className="hud-box" style={{ left: 28, bottom: 28 }}>
        <span className="lbl">Autonomie · simulée</span>
        <span className="mono" style={{ fontSize: 28, fontWeight: 600 }}>{Math.round(view.remaining)} min</span>
        <span>
          Retour <b className="mono">{Math.round(view.budget.retour)} min</b> · marge <b className="mono" style={{ color: st.color }}>{view.margin} min</b>
        </span>
      </div>

      <div className="hud-box" style={{ right: 28, bottom: 28, alignItems: 'flex-end' }}>
        <span className="lbl">Mode casque · simulation</span>
        <span className="mono" style={{ fontSize: 16 }}>{s.phase === 'prep' ? 'T+00:00' : fmtT(s.clock.t)}</span>
      </div>

      <div className="hud-box row" style={{ left: '50%', bottom: 26, transform: 'translateX(-50%)', flexDirection: 'row', borderRadius: 999, padding: '8px 18px', fontWeight: 700, fontSize: 15, color: st.color }}>
        <Icon name={st.icon} />
        {st.short}
      </div>
    </div>
  );
}

/** Décor martien stylisé (repris de la maquette) et guide de cap au sol. */
function Scene({ guide }: { guide: string }) {
  return (
    <svg className="scene" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="1280" height="720" fill="#B88A66" />
      <rect width="1280" height="260" fill="#A97D5C" />
      <rect width="1280" height="120" fill="#9C7356" />
      <circle cx="1040" cy="220" r="16" fill="#FFF1D6" opacity="0.85" />
      <path d="M0 360 L 90 300 L 160 320 L 230 270 L 300 330 L 380 350 L 470 340 L 560 300 L 640 330 L 760 290 L 860 340 L 980 320 L 1100 280 L 1180 330 L 1280 320 L 1280 720 L 0 720 Z" fill="#8A6247" />
      <path d="M0 410 L 140 385 L 300 400 L 460 372 L 620 392 L 800 366 L 980 388 L 1140 372 L 1280 388 L 1280 720 L 0 720 Z" fill="#7D5539" />
      <path d="M0 470 C 300 440, 700 455, 1280 430 L 1280 720 L 0 720 Z" fill="#6E482F" />
      <path d="M0 600 C 400 570, 900 590, 1280 560 L 1280 720 L 0 720 Z" fill="#5E3C27" />
      <ellipse cx="300" cy="640" rx="40" ry="10" fill="#45291A" />
      <ellipse cx="1000" cy="600" rx="28" ry="8" fill="#45291A" />
      <path d="M560 720 L 720 720 L 652 430 L 628 430 Z" fill={guide} opacity="0.22" />
      <path d="M640 720 L 640 430" fill="none" stroke={guide} strokeWidth="3" strokeDasharray="14 10" />
      <circle cx="640" cy="470" r="14" fill="none" stroke={guide} strokeWidth="3" />
    </svg>
  );
}
