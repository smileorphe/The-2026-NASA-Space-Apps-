import { lazy, Suspense, useEffect } from 'react';
import { Icon } from '../components/Icon';
import { cssColor, STATUS } from '../components/ui';
import { fmtDistance, fmtT } from '../format';
import { incidentTitle } from '../domain/mission';
import { setRole, useMission } from '../store';

const BARS = 6;
// three.js n'est chargé que dans ce mode (et dans le panneau « Vue casque » de Supervision)
const HelmetView3D = lazy(() => import('./HelmetView3D'));

/** HUD du casque — 1280×720 plein écran. Flèche, distance, progression, autonomie, alerte. Rien d'autre. */
export function Helmet() {
  useEffect(() => setRole('casque'), []);
  const { s, view, data } = useMission();
  const alert = view.alert;
  const st = STATUS[view.status];
  const title = incidentTitle(s, data);

  const target =
    s.phase === 'prep' ? 'En attente du départ' : s.phase === 'done' ? 'Habitat A · sortie terminée' : s.leg?.kind === 'site' ? 'Point B · observation en cours' : view.next?.id === 'A' ? 'Habitat A · tracé connu' : `Prochain point · ${view.next?.id ?? 'B'}`;

  return (
    <div className="hud" role="main" aria-label="Affichage casque (simulation)">
      <Suspense fallback={<div className="view3d view3d-hud"><div className="view3d-msg">Chargement de la vue 3D…</div></div>}>
        <HelmetView3D hud />
      </Suspense>
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
              ? title ? `${title} · simulation · retour en évitant l’obstacle ou par le tracé connu` : `Marge ${view.margin} min, sous la réserve de ${s.params.reserve} min (simulation)`
              : `${title} · arrêtez-vous, décision de l’habitat attendue`}
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
