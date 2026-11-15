import { useState } from 'react';
import { Icon } from '../components/Icon';
import { TimeCursor } from '../components/TimeCursor';
import { momentAt } from '../domain/mission';
import { MissionLog } from '../components/MissionLog';
import { MapLegend } from '../components/MapLegend';
import { MissionMap } from '../components/MissionMap';
import { Card, cssColor, Stat } from '../components/ui';
import { fmtDistance, fmtDuration, fmtT } from '../format';
import { useMission } from '../store';
import { Header } from './HabitatLayout';
import { ProvenanceTable } from '../components/ProvenanceTable';

export function Bilan() {
  const { s, view, data } = useMission();
  const [atT, setAtT] = useState<number | null>(null); // relecture (null = fin de sortie)
  const moment = atT === null ? null : momentAt(s, data, atT);
  const done = s.phase === 'done';
  const reserveKept = view.remaining >= s.params.reserve;
  const summary = {
    durationMin: Math.round(s.clock.t),
    distanceM: Math.round(s.traveledM),
    autonomyAtArrivalMin: Math.round(view.remaining),
    minMarginMin: s.minMargin,
    incidents: s.incident ? 1 : 0,
    logEntries: s.log.length,
  };
  const objectives = [
    { label: 'Atteindre B et revenir à A', ok: s.reached.B !== undefined && done },
    { label: 'Photographier la formation', ok: s.objectives.photo },
    { label: 'Enregistrer une observation', ok: s.objectives.observation },
    { label: 'Documenter un échantillon', ok: s.objectives.sample },
  ];

  const exportJson = () => {
    const payload = {
      mission: 'Jezero · A → B',
      note: 'Temps, autonomie, seuils et imprévus simulés (paramètres de démonstration).',
      exportedAt: new Date().toISOString(),
      params: s.params,
      summary,
      objectives,
      log: s.log.map((e) => ({ ...e, time: fmtT(e.t) })),
      trail: s.trail,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'eva-planner-journal.json' });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Header
        title="Bilan de la sortie"
        subtitle={done ? `Retour à l’habitat A · ${fmtT(s.clock.t)} · valeurs de temps et d’autonomie simulées` : 'Sortie non terminée · bilan provisoire'}
      />
      <div className="grid">
        <section className="card s12">
          <div className="card-head">
            <h2>Synthèse</h2>
            {done && (
              <span role="status" className="status" style={cssColor(reserveKept ? 'var(--green)' : 'var(--red)')}>
                <Icon name={reserveKept ? 'shield' : 'warning'} />
                {reserveKept ? 'Réserve respectée' : 'Réserve dépassée'}
              </span>
            )}
          </div>
          <div className="stats">
            <Stat label="Durée" tag="sim" value={fmtDuration(summary.durationMin)} />
            <Stat label="Distance" tag="der" value={fmtDistance(summary.distanceM)} />
            <Stat label="Autonomie à l’arrivée" tag="sim" value={`${summary.autonomyAtArrivalMin} min`} />
            <Stat label="Marge minimale" tag="sim" value={`${summary.minMarginMin} min`} />
            <Stat label="Imprévus" tag="sim" value={summary.incidents} />
            <Stat label="Entrées au journal" tag="obs" value={summary.logEntries} />
          </div>
        </section>

        <Card title="Relecture de la sortie" className="s7" extra={moment && <span className="small muted mono">{fmtT(moment.t)} · marge {moment.margin ?? '—'} min · autonomie {Math.round(moment.remaining)} min</span>}>
          <MissionMap height={420} live atT={atT} />
          {s.phase !== 'prep' && <TimeCursor t={s.clock.t} value={atT} onChange={setAtT} end={s.clock.t} />}
          <MapLegend />
          <p className="small muted">Épingles : observations de la tablette à leur position simulée (clic pour le détail). Le curseur rejoue position, marge et journal.</p>
        </Card>

        <Card title="Objectifs" className="s5">
          {objectives.map((o) => (
            <div key={o.label} className={`task${o.ok ? ' done' : ''}`}>
              <span className="box">{o.ok && <Icon name="check" />}</span>
              <span className="grow">{o.label}</span>
              <span className="small" style={{ fontWeight: 800, color: o.ok ? 'var(--green)' : 'var(--muted)' }}>{o.ok ? 'ATTEINT' : 'NON ATTEINT'}</span>
            </div>
          ))}
        </Card>

        <Card title={moment ? `Journal jusqu’à ${fmtT(moment.t)}` : 'Journal complet'} className="s7" extra={<button className="btn" onClick={exportJson} disabled={s.log.length === 0}>Exporter (JSON)</button>}>
          <MissionLog entries={moment ? moment.log : s.log} chronological maxHeight={420} />
        </Card>

        <Card title="Sources utilisées" className="s5">
          <ProvenanceTable />
        </Card>
      </div>
    </>
  );
}
