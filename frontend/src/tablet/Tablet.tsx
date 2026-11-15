import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { MissionLog } from '../components/MissionLog';
import { PointBFacts } from '../components/PointB';
import { cssColor, Notice, type NoticeMsg, STATUS } from '../components/ui';
import { isAllowed } from '../domain/autonomy';
import { canExtend, extensionMargin, type ObjectiveKey } from '../domain/mission';
import { fmtT } from '../format';
import { dispatch, setRole, useMission } from '../store';

const EXTEND_MIN = 15;

const TASKS: { key: ObjectiveKey; label: string }[] = [
  { key: 'photo', label: 'Photographier la formation' },
  { key: 'observation', label: 'Enregistrer une observation' },
  { key: 'sample', label: 'Documenter un échantillon' },
];

const ACTIONS: { label: string; icon: IconName; text: string; objective?: ObjectiveKey }[] = [
  { label: 'Photographier', icon: 'camera', text: 'Photo géolocalisée · formation stratifiée', objective: 'photo' },
  { label: 'Observer', icon: 'spark', text: 'Observation · teinte claire, grain fin', objective: 'observation' },
  { label: 'Mesurer', icon: 'ruler', text: 'Mesure · pendage ≈ 12°' },
  { label: 'Prélever', icon: 'tube', text: 'Échantillon simulé · documenté', objective: 'sample' },
  { label: 'Ajouter une note', icon: 'mic', text: 'Note vocale enregistrée' },
];

/** Carnet d'exploration — 1024×768, cibles tactiles ≥ 56 px. */
export function Tablet() {
  useEffect(() => setRole('tablette'), []);
  const { s, view, data } = useMission();
  const [refusal, setRefusal] = useState<NoticeMsg | null>(null);
  const kind = s.leg?.kind;
  const active = s.phase === 'eva';

  const lastWp = data.waypoints.filter((w) => s.reached[w.id] !== undefined).pop();
  const where = kind === 'site' ? 'au point B' : lastWp ? `près de ${lastWp.id}` : '';
  const title =
    s.phase === 'prep' ? 'Sortie non lancée' : s.phase === 'done' ? 'Sortie terminée' : kind === 'site' ? 'Point B · Affleurement' : kind === 'back' ? 'Retour vers l’habitat A' : `En route vers ${view.next?.id ?? 'B'}`;

  const act = (a: (typeof ACTIONS)[number]) => dispatch({ type: 'LOG', source: 'TABLETTE', text: where ? `${a.text} ${where}` : a.text, objective: a.objective });

  const extend = () => {
    const m = extensionMargin(s, data, EXTEND_MIN);
    if (!isAllowed(m, s.params.reserve)) {
      setRefusal({ color: STATUS.red.color, title: 'Refusé.', text: `La marge passerait à ${m} min, sous la réserve de ${s.params.reserve} min.` });
      return;
    }
    setRefusal({ color: STATUS.green.color, title: 'Accepté.', text: `Observation prolongée de ${EXTEND_MIN} min · marge ${m} min.` });
    dispatch({ type: 'EXTEND_OBSERVATION', minutes: EXTEND_MIN, source: 'TABLETTE' });
  };

  const done = TASKS.filter((t) => s.objectives[t.key]).length;
  const incident = s.incident ? data.scenarios[s.incident.id] : null;

  return (
    <div className="tablet">
      <header className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
        <div className="grow">
          <span className="kicker">Mode tablette · carnet d’exploration · <span className="mono">{fmtT(s.clock.t)}</span> · simulation</span>
          <h1 style={{ fontSize: 28, fontWeight: 800 }}>{title}</h1>
        </div>
        <HeadStat label="Autonomie" value={`${Math.round(view.remaining)} min`} />
        <HeadStat label="Retour" value={`${Math.round(view.budget.retour)} min`} />
        <HeadStat label="Marge" value={`${view.margin} min`} color={STATUS[view.status].color} />
      </header>

      {view.alert !== 'none' && (
        <div role="alert" className="alert" style={cssColor(view.alert === 'return' ? 'var(--red)' : 'var(--amber)')}>
          <span style={{ color: 'var(--c)' }}><Icon name="warning" size={28} /></span>
          <div className="grow stack" style={{ gap: 2 }}>
            <strong>
              {view.alert === 'return' ? `Retour prioritaire · ${incident ? incident.title.charAt(0).toLowerCase() + incident.title.slice(1) : 'réserve dépassée'} · simulé` : `Imprévu simulé · ${incident?.title}`}
            </strong>
            <span className="small">
              {view.alert === 'return'
                ? kind === 'back' ? 'Retour engagé par le tracé connu. Décision transmise par l’habitat.' : `Marge ${view.margin} min, sous la réserve de ${s.params.reserve} min.`
                : 'Décision de l’habitat en attente. Restez sur le tracé.'}
            </span>
          </div>
          {view.alert === 'return' && kind !== 'back' && (
            <button className="btn btn-lg" style={{ background: 'var(--red)', borderColor: 'var(--red)', color: 'var(--ink)' }} onClick={() => dispatch({ type: 'RETURN_NOW', source: 'TABLETTE' })}>
              Rentrer
            </button>
          )}
        </div>
      )}

      <div className="row grow" style={{ gap: 16, alignItems: 'stretch', flexWrap: 'nowrap', minHeight: 0 }}>
        <section className="grow stack" style={{ gap: 10 }}>
          <div className="row">
            <span className="kicker grow">Objectifs du site</span>
            <span className="mono">{done} / 3</span>
          </div>
          {TASKS.map((t) => (
            <div key={t.key} className={`task${s.objectives[t.key] ? ' done' : ''}`}>
              <span className="box">{s.objectives[t.key] && <Icon name="check" size={20} />}</span>
              <strong className="grow" style={{ fontSize: 17 }}>{t.label}</strong>
              <span className="small" style={{ fontWeight: 700, color: s.objectives[t.key] ? 'var(--green)' : 'var(--muted)' }}>{s.objectives[t.key] ? 'FAIT' : 'À FAIRE'}</span>
            </div>
          ))}
          <div className="row" style={{ flexWrap: 'nowrap', marginTop: 4 }}>
            {ACTIONS.slice(0, 3).map((a) => <ActionButton key={a.label} a={a} disabled={!active} onClick={() => act(a)} />)}
          </div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            {ACTIONS.slice(3).map((a) => <ActionButton key={a.label} a={a} disabled={!active} onClick={() => act(a)} />)}
          </div>
        </section>

        <section className="stack" style={{ width: 360, gap: 12, minHeight: 0 }}>
          <div className="inner stack" style={{ gap: 8 }}>
            <span className="kicker">Fiche de la zone</span>
            <PointBFacts compact />
          </div>
          <div className="inner stack grow" style={{ gap: 4, minHeight: 0, overflow: 'hidden' }}>
            <span className="kicker">Journal · partagé avec l’habitat</span>
            <MissionLog entries={s.log.slice(-6)} />
          </div>
          <button className="btn btn-lg" style={{ fontSize: 16, minHeight: 56 }} disabled={!canExtend(s)} onClick={extend}>
            Prolonger l’observation · +{EXTEND_MIN} min
          </button>
          <Notice msg={refusal} />
        </section>
      </div>

      <footer>
        <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={!active || kind === 'back'} onClick={() => dispatch({ type: 'RETURN_NOW', source: 'TABLETTE' })}>
          {kind === 'back' ? 'Retour en cours vers l’habitat A' : kind === 'site' ? 'Terminer le site et rentrer' : 'Rentrer à l’habitat'} <Icon name="arrow" size={22} />
        </button>
      </footer>
    </div>
  );
}

function HeadStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="chipstat" style={color ? cssColor(color) : undefined}>
      <span className="small muted">{label}</span>
      <span className="mono" style={{ fontSize: 22, fontWeight: 600, color }}>{value}</span>
    </div>
  );
}

function ActionButton({ a, disabled, onClick }: { a: (typeof ACTIONS)[number]; disabled: boolean; onClick: () => void }) {
  return (
    <button className="action" disabled={disabled} onClick={onClick}>
      <Icon name={a.icon} size={30} />
      {a.label}
    </button>
  );
}
