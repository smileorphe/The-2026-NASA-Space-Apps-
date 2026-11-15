import { useState } from 'react';
import { Link } from 'react-router';
import { AutonomyChart, ElevationProfile } from '../components/charts';
import { Icon } from '../components/Icon';
import { MissionLog } from '../components/MissionLog';
import { CrismLegend, MissionMap, SlopeLegend } from '../components/MissionMap';
import { PointBFacts } from '../components/PointB';
import { Card, cssColor, Notice, type NoticeMsg, Stat, StatusPill, STATUS } from '../components/ui';
import { isAllowed, plannedDurations, plannedMargin, statusOf } from '../domain/autonomy';
import { type ClockSpeed, canExtend, extensionMargin, optionMargin, planCosts, plannedTimeAt, returnMargin } from '../domain/mission';
import type { IncidentId } from '../data';
import { fmtDeg, fmtDelta, fmtDistance, fmtT } from '../format';
import { dispatch, useMission, usePresence } from '../store';
import { Header } from './HabitatLayout';

const QUICK_MESSAGES = ['Ralentissez sur le front du lobe (W1 → W2)', 'Point B confirmé, bonne observation', 'Préparez le retour', 'Signalez l’état du sol'];
const SPEEDS: { v: ClockSpeed; label: string }[] = [{ v: 0, label: 'Pause' }, { v: 1, label: '×1' }, { v: 10, label: '×10' }, { v: 60, label: '×60' }];

export function Supervision() {
  const { s, view, data } = useMission();
  const [msg, setMsg] = useState<NoticeMsg | null>(null);
  const reserve = s.params.reserve;
  const t = s.clock.t;

  if (s.phase === 'prep') {
    return (
      <>
        <Header title="Supervision" subtitle="La sortie n’est pas encore lancée." />
        <section className="card">
          <p>Vérifiez le plan et lancez la sortie depuis l’écran de préparation.</p>
          <Link className="btn btn-primary" to="/habitat/preparation">Aller à la préparation <Icon name="arrow" /></Link>
        </section>
      </>
    );
  }

  const { aller, retour } = plannedDurations(planCosts(data), s.params.speedKmh);
  const planEnd = aller + s.params.observation + retour;
  const byId = Object.fromEntries(data.waypoints.map((w) => [w.id, w]));
  const lastReached = data.waypoints.filter((w) => w.id !== 'A' && s.reached[w.id] !== undefined).pop();
  const drift = lastReached ? s.reached[lastReached.id]! - plannedTimeAt(s, data, lastReached) : 0;

  const etaOf = (id: string) => {
    if (id === 'B') return view.etaB;
    const w = byId[id];
    const rest = data.routeLength - view.dAlong;
    return s.leg?.kind === 'out' && rest > 0 ? t + (view.budget.allerRestant * (w.d - view.dAlong)) / rest : null;
  };

  // Options « que se passe-t-il si » : marge recalculée, refus sous la réserve
  const whatIf = [5, 10, 15].map((add) => {
    const m = extensionMargin(s, data, add);
    return {
      key: `+${add}`, name: 'Prolonger l’observation', detail: `+${add} min au point B`, margin: m, ok: canExtend(s) && isAllowed(m, reserve),
      apply: () => dispatch({ type: 'EXTEND_OBSERVATION', minutes: add, source: 'HABITAT' }),
      accepted: `Observation au point B portée à ${s.params.observation + s.observationExtra + add} min · marge ${m} min.`,
    };
  });
  const rm = returnMargin(s, data);
  whatIf.push({
    key: 'back', name: 'Rentrer maintenant', detail: 'Abandonner B · tracé connu', margin: rm, ok: s.phase === 'eva' && s.leg?.kind !== 'back',
    apply: () => dispatch({ type: 'RETURN_NOW', source: 'HABITAT' }), accepted: 'Consigne envoyée au casque et à la tablette.',
  });

  const pick = (o: (typeof whatIf)[number]) => {
    if (!o.ok) {
      setMsg({ color: STATUS.red.color, title: 'Refusé.', text: `${o.name} (${o.detail}) ferait passer la marge à ${o.margin} min, sous la réserve de ${reserve} min.` });
      return;
    }
    o.apply();
    setMsg({ color: STATUS[statusOf(o.margin, reserve)].color, title: 'Accepté.', text: o.accepted });
  };

  const incident = s.incident ? data.scenarios[s.incident.id] : null;
  const legLabel = s.phase === 'done' ? 'Retour à l’habitat effectué' : s.leg?.kind === 'site' ? 'EV1 au point B' : s.leg?.kind === 'back' ? 'EV1 en retour vers A' : `EV1 en route vers ${view.next?.id ?? 'B'}`;

  return (
    <>
      <Header title="Supervision" subtitle={`${legLabel} · tracé, relief et autonomie recalculés en continu`}>
        {s.phase === 'done' && <Link className="btn btn-primary" to="/habitat/bilan">Voir le bilan <Icon name="arrow" /></Link>}
      </Header>

      <div className="grid">
        <section className="card s12" aria-label={`État de la sortie · ${fmtT(t)}`}>
          <div className="card-head">
            <h2>État de la sortie · <span className="mono">{fmtT(t)}</span></h2>
            <StatusPill status={view.status} />
          </div>
          <div className="stats">
            <Stat label="Marge de retour" value={`${view.margin} min`} color={STATUS[view.status].color} sub={`réserve ${reserve} min · simulé`} />
            <Stat label="Autonomie restante" value={`${Math.round(view.remaining)} min`} sub={`sur ${s.params.autonomy} · simulé`} />
            <Stat label="Retour estimé" value={`${Math.round(view.budget.retour)} min`} sub={s.incident?.id === 'storm' ? 'vitesse × 0,6 · simulé' : 'tracé inversé · simulé'} />
            <Stat label="Prochain point" value={view.next ? `${view.next.id} · ${fmtDistance(view.next.distance)}` : '—'} sub={view.next ? `ETA ${fmtT(view.next.id === 'A' ? view.etaA : etaOf(view.next.id))}` : s.leg?.kind === 'site' ? 'au point B' : ''} />
            <Stat label="Écart horaire" value={fmtDelta(drift)} sub={lastReached ? `vs plan · ${lastReached.id} à ${fmtT(s.reached[lastReached.id])}` : 'aucun point franchi'} />
            <Stat label="Pente actuelle" value={view.slope !== null ? fmtDeg(view.slope) : '—'} sub={view.nextSlope !== null && view.slope !== null ? `max du segment · suivant ${fmtDeg(view.nextSlope)}` : 'dérivé du DTM'} />
          </div>
        </section>

        <Card title="Suivi de la sortie" className="s8" extra={<span className="tag" style={cssColor('var(--nav)')}>{s.phase === 'done' ? 'TERMINÉE' : 'EN COURS'}</span>}>
          {incident && (
            <div role="alert" className="alert" style={cssColor(s.incident!.id === 'storm' ? 'var(--red)' : 'var(--amber)')}>
              <Icon name="warning" size={24} />
              <strong>{incident.title}</strong>
              <span className="small">· événement simulé {s.incident!.choice ? '· décision prise' : '· décision attendue'}</span>
            </div>
          )}
          <MissionMap height={440} live />
          <div className="stats">
            <Stat label="Parcouru" value={`${fmtDistance(s.traveledM)}`} sub={`aller ${fmtDistance(data.routeLength)}`} />
            <Stat label="Arrivée B" tag="sim" value={view.etaB !== null ? fmtT(view.etaB) : 'annulée'} />
            <Stat label="Retour A" tag="sim" value={fmtT(view.etaA)} />
          </div>
          <SlopeLegend />
          <CrismLegend />
        </Card>

        <Card title="Options de décision" tag="sim" className="s4">
          <p className="small muted">Marge recalculée pour chaque option. Une option qui passe sous la réserve est refusée.</p>
          {whatIf.map((o) => (
            <OptionButton key={o.key} name={o.name} detail={o.detail} margin={o.margin} reserve={reserve} ok={o.ok} onPick={() => pick(o)} />
          ))}
          <Notice msg={msg ?? { color: 'var(--muted)', title: 'Plan actuel.', text: `Observation prévue : ${s.params.observation + s.observationExtra} min au point B.` }} />
        </Card>

        <Card title="Imprévu" className="s4" extra={<span className="small muted">scénarios JSON</span>}>
          <div className="row">
            {(Object.keys(data.scenarios) as IncidentId[]).map((id) => (
              <button key={id} className="btn" style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }} disabled={!!s.incident || s.leg?.kind !== 'out'}
                aria-pressed={s.incident?.id === id} onClick={() => dispatch({ type: 'TRIGGER_INCIDENT', id })}>
                <Icon name="warning" />
                {id === 'storm' ? 'Tempête (fictive)' : 'Obstacle'}
              </button>
            ))}
          </div>
          {incident ? (
            incident.options.map((o) => {
              const m = optionMargin(s, data, o);
              const chosen = s.incident?.choice === o.id;
              return (
                <OptionButton key={o.id} name={o.label} detail={o.detail} margin={m} reserve={reserve} chosen={chosen}
                  ok={!s.incident?.choice && isAllowed(m, reserve)}
                  onPick={() => dispatch({ type: 'CHOOSE_OPTION', optionId: o.id })} />
              );
            })
          ) : (
            <p className="small muted">Déclenche un événement fictif pendant l’aller : il s’affiche dans les trois modes avec des options recalculées.</p>
          )}
        </Card>

        <Card title="Heures limites" tag="sim" className="s4">
          <div className="stats">
            <Stat label="Quitter B au plus tard" value={view.leaveB !== null ? fmtT(view.leaveB) : '—'} />
            <Stat label="Temps max au point B" value={view.maxStayB !== null ? `${Math.max(0, Math.round(view.maxStayB))} min` : '—'} />
          </div>
          <p className="small muted">Calculées pour garder la réserve de {reserve} min au retour.</p>
        </Card>

        <Card title="Message à l’astronaute" className="s4" extra={<span className="small muted">affiché dans le casque</span>}>
          <div className="stack" style={{ gap: 8 }}>
            {QUICK_MESSAGES.map((txt) => (
              <button key={txt} className="btn" style={{ justifyContent: 'flex-start' }} disabled={s.phase !== 'eva'} onClick={() => dispatch({ type: 'SEND_HUD_MESSAGE', text: txt })}>{txt}</button>
            ))}
          </div>
          <span className="small muted">Dernier envoi : {s.lastMessageToHud ?? '—'}</span>
        </Card>

        <Card title="Modes et horloge" tag="sim" className="s4">
          <ModesStatus />
          <div className="row" role="group" aria-label="Vitesse de l’horloge simulée">
            <span className="small muted grow">Horloge simulée</span>
            {SPEEDS.map((sp) => (
              <button key={sp.v} className="chip" aria-pressed={s.clock.speed === sp.v} disabled={s.phase !== 'eva'} onClick={() => dispatch({ type: 'SET_CLOCK_SPEED', speed: sp.v })}>{sp.label}</button>
            ))}
          </div>
        </Card>

        <Card title="Autonomie dans le temps" tag="sim" className="s6">
          <AutonomyChart autonomy={s.params.autonomy} reserve={reserve} t={t} remaining={view.remaining} planEnd={planEnd} planMargin={plannedMargin(s.params, planCosts(data))} etaA={view.etaA} margin={view.margin} />
        </Card>

        <Card title="Relief devant l’astronaute" tag="der" className="s6">
          <ElevationProfile profile={data.analysis.profile} marker={view.dAlong} />
        </Card>

        <Card title="Points de passage" tag="sim" className="s7">
          <table className="table">
            <thead><tr><th>POINT</th><th>PRÉVU</th><th>RÉEL / ETA</th><th>PENTE</th><th>ÉTAT</th></tr></thead>
            <tbody>
              {data.waypoints.map((w) => {
                const real = s.reached[w.id];
                const seg = data.analysis.segments.find((sg) => sg.to === w.id);
                const planned = plannedTimeAt(s, data, w);
                const state = real !== undefined ? (w.id === 'A' ? 'Départ' : fmtDelta(real - planned)) : view.next?.id === w.id ? 'en cours' : s.leg?.kind === 'back' ? 'non atteint' : 'à venir';
                return (
                  <tr key={w.id}>
                    <td><strong>{w.id}</strong></td>
                    <td className="mono">{fmtT(planned)}</td>
                    <td className="mono">{real !== undefined ? fmtT(real) : fmtT(etaOf(w.id))}</td>
                    <td className="mono">{seg ? fmtDeg(seg.slope_deg) : '—'}</td>
                    <td>{state}</td>
                  </tr>
                );
              })}
              <tr>
                <td><strong>A</strong></td>
                <td className="mono">{fmtT(planEnd)}</td>
                <td className="mono">{fmtT(view.etaA)}</td>
                <td className="mono">—</td>
                <td>{s.phase === 'done' ? 'Rentré' : 'retour'}</td>
              </tr>
            </tbody>
          </table>
        </Card>

        <Card title="Journal de mission" className="s5">
          <MissionLog entries={s.log} filterable maxHeight={360} />
        </Card>

        <Card title="Point B" tag="der" className="s12">
          <PointBFacts />
          <div className="row small">
            <span className="kicker">Objectifs du site</span>
            <span>{s.objectives.photo ? '✓' : '○'} Photographier la formation</span>
            <span>{s.objectives.observation ? '✓' : '○'} Enregistrer une observation</span>
            <span>{s.objectives.sample ? '✓' : '○'} Documenter un échantillon</span>
          </div>
        </Card>
      </div>
    </>
  );
}

function OptionButton({ name, detail, margin, reserve, ok, chosen, onPick }: { name: string; detail: string; margin: number; reserve: number; ok: boolean; chosen?: boolean; onPick: () => void }) {
  const color = STATUS[statusOf(margin, reserve)].color;
  return (
    <button className={`option${chosen ? ' chosen' : ''}`} aria-disabled={!ok} onClick={onPick}>
      <span className="grow">
        <strong>{name}</strong>
        <span className="small muted" style={{ display: 'block' }}>{detail}</span>
      </span>
      <span className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
        <span className="mono" style={{ color, fontWeight: 600 }}>{margin} min</span>
        <span className="verdict" style={{ color: ok || chosen ? color : 'var(--red)' }}>{chosen ? 'CHOISI' : ok ? 'POSSIBLE' : 'REFUSÉ'}</span>
      </span>
    </button>
  );
}

function ModesStatus() {
  const presence = usePresence();
  const rows = [
    { id: 'habitat' as const, name: 'Habitat', role: 'source de l’horloge' },
    { id: 'tablette' as const, name: 'Tablette', role: 'carnet d’exploration' },
    { id: 'casque' as const, name: 'Casque', role: 'HUD' },
  ];
  return (
    <ul className="log">
      {rows.map((r) => (
        <li key={r.id}>
          <span className="grow"><strong>{r.name}</strong> <span className="muted small">· {r.role}</span></span>
          <span className="small" style={{ color: presence[r.id] ? 'var(--green)' : 'var(--muted)' }}>
            {presence[r.id] ? '● connecté' : '○ onglet non ouvert'}
          </span>
        </li>
      ))}
    </ul>
  );
}
