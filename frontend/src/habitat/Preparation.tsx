import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BudgetBar, ElevationProfile } from '../components/charts';
import { Icon } from '../components/Icon';
import { CrismLegend, MissionMap, SlopeLegend } from '../components/MissionMap';
import { PointBFacts, SiteImages } from '../components/PointB';
import { ProvenanceTable } from '../components/ProvenanceTable';
import { Card, Notice, type NoticeMsg, Stat, StatusPill, STATUS } from '../components/ui';
import { isAllowed, LIMITS, plannedMargin, type SimParams, SPEEDS } from '../domain/autonomy';
import { fmtDeg, fmtDistance, fmtT } from '../format';
import { planCosts } from '../domain/mission';
import { slopeClass } from '../domain/slope';
import { cssColor } from '../components/ui';
import { dispatch, useMission } from '../store';
import { Header } from './HabitatLayout';

export function Preparation() {
  const { s, view, data } = useMission();
  const navigate = useNavigate();
  const [refusal, setRefusal] = useState<NoticeMsg | null>(null);
  const p = s.params;
  const editable = s.phase === 'prep';
  const ready = isAllowed(view.margin, p.reserve);
  const a = data.analysis;
  const hardest = a.segments.reduce((m, sg) => (sg.slope_deg > m.slope_deg ? sg : m), a.segments[0]);

  const update = (patch: Partial<SimParams>) => {
    const next = { ...p, ...patch };
    const m = plannedMargin(next, planCosts(data));
    if (next.observation > p.observation && !isAllowed(m, next.reserve)) {
      setRefusal({ color: STATUS.red.color, title: 'Observation +5 min refusée.', text: `La marge passerait à ${m} min, sous la réserve de ${p.reserve} min. Le plan reste inchangé.` });
      return;
    }
    setRefusal(null);
    dispatch({ type: 'SET_PARAMS', params: next });
  };
  const speedIdx = SPEEDS.indexOf(p.speedKmh as (typeof SPEEDS)[number]);

  const launch = () => {
    dispatch({ type: 'LAUNCH' });
    navigate('/habitat/supervision');
  };

  const planMsg: NoticeMsg = ready
    ? { color: STATUS[view.status].color, title: 'Plan prêt au départ.', text: `Marge de ${view.margin} min, au-dessus de la réserve de ${p.reserve} min.` }
    : { color: STATUS.red.color, title: 'Départ bloqué.', text: `La marge (${view.margin} min) est sous la réserve de ${p.reserve} min. Augmentez l’autonomie, réduisez l’observation ou la réserve.` };

  return (
    <>
      <Header title="Préparation de la sortie" subtitle="Cratère Jezero · tracé prédéfini · toutes les valeurs de temps et d’autonomie sont simulées" />

      <div className="grid">
        <section className="card s12">
          <div className="row" style={{ gap: 20 }}>
            <div className="grow stack" style={{ gap: 6 }}>
              <span className="kicker">Objectif principal</span>
              <strong style={{ fontSize: 20 }}>Rejoindre l’affleurement B, documenter le site et revenir à l’habitat A</strong>
              <span className="small muted">Objectifs secondaires : photographier la formation · enregistrer une observation · documenter un échantillon</span>
            </div>
            <StatusPill status={view.status} />
            {editable ? (
              <button className="btn btn-primary btn-lg" disabled={!ready} onClick={launch}>
                {ready ? 'Lancer la sortie' : 'Départ bloqué'} <Icon name="arrow" />
              </button>
            ) : (
              <Link className="btn btn-primary btn-lg" to="/habitat/supervision">
                Sortie en cours · Supervision <Icon name="arrow" />
              </Link>
            )}
          </div>
        </section>

        <Card title="Itinéraire A → B" tag="der" className="s7">
          <MissionMap height={460} />
          <div className="row small muted">
            <span>Tracé : <span className="mono">route_aller.geojson</span></span>·<span>Retour : tracé inversé</span>
          </div>
          <SlopeLegend />
          <CrismLegend />
        </Card>

        <Card title="Caractéristiques du tracé" extra={<span className="small muted">calculées sur le DTM</span>} className="s5">
          <div className="stats">
            <Stat label="Distance aller" tag="der" value={fmtDistance(a.distance_m)} />
            <Stat label="Dénivelé" tag="der" value={`+${Math.round(a.elevation_gain_m)} / −${Math.round(a.elevation_loss_m)} m`} />
            <Stat label="Pente max" tag="der" value={fmtDeg(a.max_slope_deg)} color={slopeClass(a.max_slope_deg).color} />
            <Stat label="Points de passage" tag="obs" value={data.waypoints.length - 2} />
            <Stat label="Durée aller" tag="sim" value={`${Math.round(view.budget.allerRestant)} min`} />
            <Stat label="Retour estimé" tag="sim" value={`${Math.round(view.budget.retour)} min`} />
          </div>
          <Notice msg={{ color: slopeClass(hardest.slope_deg).color, title: `Segment le plus raide : ${hardest.from} → ${hardest.to}.`, text: `Pente maximale ${fmtDeg(hardest.slope_deg)} sur ${Math.round(hardest.length_m)} m (classe ${slopeClass(hardest.slope_deg).label}).` }} />
        </Card>

        <Card title="Paramètres de simulation" tag="sim" className="s4">
          <div id="params" className="small muted">
            Valeurs de démonstration, modifiables avant le départ. Tout le plan est recalculé ; les trois modes reçoivent les mêmes valeurs.
          </div>
          <Stepper label="Autonomie disponible" hint="budget total de la sortie" value={`${p.autonomy} min`} disabled={!editable}
            onDec={() => update({ autonomy: Math.max(p.autonomy - LIMITS.autonomy.step, LIMITS.autonomy.min) })}
            onInc={() => update({ autonomy: Math.min(p.autonomy + LIMITS.autonomy.step, LIMITS.autonomy.max) })} />
          <Stepper label="Vitesse de marche" hint="terrain plat" value={`${p.speedKmh.toFixed(1).replace('.', ',')} km/h`} disabled={!editable}
            onDec={() => update({ speedKmh: SPEEDS[Math.max(speedIdx - 1, 0)] })}
            onInc={() => update({ speedKmh: SPEEDS[Math.min(speedIdx + 1, SPEEDS.length - 1)] })} />
          <Stepper label="Temps d’observation en B" hint="refusé s’il fait passer la marge sous la réserve" value={`${p.observation} min`} disabled={!editable}
            onDec={() => update({ observation: Math.max(p.observation - LIMITS.observation.step, LIMITS.observation.min) })}
            onInc={() => update({ observation: p.observation + LIMITS.observation.step })} />
          <Stepper label="Réserve minimale" hint="seuil du statut rouge" value={`${p.reserve} min`} disabled={!editable}
            onDec={() => update({ reserve: Math.max(p.reserve - LIMITS.reserve.step, LIMITS.reserve.min) })}
            onInc={() => update({ reserve: Math.min(p.reserve + LIMITS.reserve.step, LIMITS.reserve.max) })} />
        </Card>

        <Card title="Budget d’autonomie" tag="sim" className="s4">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <span className="mono" style={{ fontSize: 40, fontWeight: 600, color: STATUS[view.status].color }}>{view.margin} min</span>
            <span className="muted">de marge · réserve {p.reserve} min</span>
          </div>
          <BudgetBar b={view.budget} marginMin={view.margin} />
          <p className="mono small">
            Marge = {p.autonomy} − ({Math.round(view.budget.allerRestant)} + {p.observation} + {Math.round(view.budget.retour)}) = {view.margin} min
          </p>
          <div className="stats">
            <Stat label="Quitter B au plus tard" tag="sim" value={view.leaveB !== null && view.maxStayB! >= 0 ? fmtT(view.leaveB) : '—'} />
            <Stat label="Retour à A prévu" tag="sim" value={fmtT(view.etaA)} />
          </div>
          <Notice msg={refusal ?? planMsg} />
        </Card>

        <Card title={data.waypoints.find((w) => w.id === 'B')?.crismClass?.code === 'MC' ? 'Point B · carbonates marginaux' : 'Point B'} tag="der" className="s4">
          <SiteImages />
          <PointBFacts />
        </Card>

        <Card title="Profil d’élévation" tag="der" className="s6">
          <ElevationProfile profile={a.profile} />
        </Card>

        <Card title="Comparaison des itinéraires" tag="der" className="s6" extra={<span className="small muted">calculés sur le DTM 5 m</span>}>
          <RouteComparison />
        </Card>

        <Card title="Provenance des données" className="s12" extra={<span className="small muted">{data.projectionLabel}</span>}>
          <ProvenanceTable />
        </Card>
      </div>
    </>
  );
}

function Stepper({ label, hint, value, onDec, onInc, disabled }: { label: string; hint: string; value: string; onDec: () => void; onInc: () => void; disabled: boolean }) {
  return (
    <div className="stepper">
      <div className="grow">
        <strong>{label}</strong>
        <div className="small muted">{hint}</div>
      </div>
      <button onClick={onDec} disabled={disabled} aria-label={`Diminuer : ${label}`}>−</button>
      <span className="value mono">{value}</span>
      <button onClick={onInc} disabled={disabled} aria-label={`Augmenter : ${label}`}>+</button>
    </div>
  );
}

/** Tracé de mission et itinéraires calculés (pipeline/paths.py), évalués avec la même carte de coût. */
function RouteComparison() {
  const { data } = useMission();
  const { routes, returnZone } = data.overlays;
  if (!routes) return <p className="small muted">Itinéraires calculés indisponibles (routes_computed.geojson absent) : seul le tracé de mission est utilisé.</p>;
  const rows = [routes.mission, ...routes.features.map((f) => f.properties)];
  const zone = returnZone?.features[0]?.properties;
  const zp = returnZone?.parameters;
  return (
    <>
      <table className="table">
        <thead>
          <tr><th>ITINÉRAIRE</th><th>DISTANCE</th><th>DÉNIVELÉ</th><th>PENTE MAX</th><th>SABLE</th><th>COÛT</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.label}</strong></td>
              <td className="mono">{fmtDistance(r.distance_m)}</td>
              <td className="mono">+{Math.round(r.elevation_gain_m)} / −{Math.round(r.elevation_loss_m)} m</td>
              <td className="mono"><span className="dot" style={{ ...cssColor(slopeClass(r.max_slope_deg).color), display: 'inline-block', marginRight: 6 }} />{fmtDeg(r.max_slope_deg)}</td>
              <td className="mono">{Math.round(r.sand_m)} m</td>
              <td className="mono">{Math.round(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        Coût = (1 + {routes.parameters.alpha_per_deg} × pente°) × {routes.parameters.sand_factor} dans le sable ; pentes &gt; {routes.parameters.slope_max_deg}° interdites ;
        coût 1 = 1 m de terrain plat. Le tracé de mission reste celui de la démonstration ; couches « Itinéraires calculés » et « Zone de retour » sur la carte.
      </p>
      {zone && zp && (
        <Notice msg={zone.contains_B
          ? { color: STATUS.green.color, title: 'B dans la zone de retour.', text: `Retour depuis B ${fmtMinutes(zone.return_min_from_B)} ≤ seuil ${fmtMinutes(zp.threshold_min)} (autonomie ${zp.autonomy_min} − réserve ${zp.reserve_min} − aller ${fmtMinutes(zp.aller_min)} − observation ${zp.observation_min}), aux paramètres par défaut.` }
          : { color: STATUS.amber.color, title: 'B hors de la zone de retour.', text: `Retour depuis B ${fmtMinutes(zone.return_min_from_B)} > seuil ${fmtMinutes(zp.threshold_min)} : la marge nominale est sous la réserve.` }} />
      )}
    </>
  );
}

const fmtMinutes = (m: number) => `${m.toFixed(1).replace('.', ',')} min`;
