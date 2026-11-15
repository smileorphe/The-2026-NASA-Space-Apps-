/**
 * Outils de terrain de la préparation : inspecteur au clic, choix de B, sites candidats.
 * Toute la logique est dans domain/ (inspect.ts, plan.ts, routing.ts) ; ce fichier ne fait que l'état d'écran.
 */
import { type ReactNode, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { ProvenanceTag } from '../components/ProvenanceTag';
import { cssColor, Notice, type NoticeMsg, STATUS, StatusPill } from '../components/ui';
import { isAllowed, plannedMargin, statusOf } from '../domain/autonomy';
import { candidateSites, inspectPoint, type Candidate, type Inspection } from '../domain/inspect';
import { planCosts } from '../domain/mission';
import { buildPlan } from '../domain/plan';
import type { LonLat } from '../domain/projection';
import { slopeClass } from '../domain/slope';
import { fmtDeg, fmtDistance } from '../format';
import { costFromA, dispatch, useMission, useTerrain } from '../store';

type ClickMode = 'inspect' | 'chooseB';
const fmtMin = (m: number) => `${m.toFixed(1).replace('.', ',')} min`;

export function useTerrainTools() {
  const { s, data } = useMission();
  const { grid, error } = useTerrain();
  const [mode, setMode] = useState<ClickMode>('inspect');
  const [probe, setProbe] = useState<LonLat | null>(null);
  const [preview, setPreview] = useState<{ coords: LonLat[]; ok: boolean } | null>(null);
  const [msg, setMsg] = useState<NoticeMsg | null>(null);
  const editable = s.phase === 'prep';
  const costs = planCosts(data);
  const field = useMemo(() => (grid ? costFromA(grid) : null), [grid]);

  const info: Inspection | null = grid && field && probe ? inspectPoint(grid, data.overlays, field, probe, s.params, costs) : null;
  const sites: Candidate[] = useMemo(
    () => (grid && field ? candidateSites(grid, data.overlays, field, s.params, costs) : []),
    [grid, field, data.overlays, s.params, costs.allerCostM, costs.retourCostM],
  );

  /** Choisit B : itinéraire aller / retour au moindre coût, refus si la marge passe sous la réserve. */
  function chooseB(p: LonLat) {
    setProbe(p);
    if (!grid) return;
    if (!editable) {
      setMsg({ color: STATUS.amber.color, title: 'Sortie en cours.', text: 'B ne peut être changé qu’avant le départ.' });
      return;
    }
    const r = buildPlan(grid, data.overlays, data.projection.toLonLat(data.route[0]), p);
    if (!r.ok) {
      setPreview(null);
      setMsg({ color: STATUS.red.color, title: 'Point refusé.', text: r.reason });
      return;
    }
    const m = plannedMargin(s.params, { allerCostM: r.plan.allerCostM, retourCostM: r.plan.retourCostM });
    if (!isAllowed(m, s.params.reserve)) {
      setPreview({ coords: r.plan.route, ok: false });
      setMsg({ color: STATUS.red.color, title: 'Refusé.', text: `Avec ce point B, la marge passerait à ${m} min, sous la réserve de ${s.params.reserve} min.` });
      return;
    }
    dispatch({ type: 'SET_PLAN', plan: r.plan });
    setPreview(null);
    setMsg({
      color: STATUS[statusOf(m, s.params.reserve)].color,
      title: 'Point B choisi.',
      text: `${fmtDistance(r.plan.distance_m)} · pente max ${fmtDeg(r.plan.max_slope_deg)} · sable ${Math.round(r.plan.sand_m)} m · marge ${m} min. Partagé avec la tablette et le casque.`,
    });
  }

  function resetB() {
    dispatch({ type: 'SET_PLAN', plan: null });
    setPreview(null);
    setMsg({ color: 'var(--muted)', title: 'Tracé de référence rétabli.', text: 'B revient au site de démonstration (pipeline/route.py).' });
  }

  const onPick = (p: LonLat) => (mode === 'chooseB' ? chooseB(p) : (setProbe(p), setPreview(null)));
  return { s, data, grid, error, mode, setMode, probe, preview, msg, info, sites, editable, chooseB, resetB, onPick };
}

export type TerrainTools = ReturnType<typeof useTerrainTools>;

/** Choix du mode de clic, message de choix de B, retour au tracé de référence. */
export function PickBar({ t }: { t: TerrainTools }) {
  const custom = !!t.s.plan;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" role="group" aria-label="Clic sur la carte">
        <span className="small muted">Clic sur la carte :</span>
        <button className="chip" aria-pressed={t.mode === 'inspect'} onClick={() => t.setMode('inspect')}>Inspecter</button>
        <button className="chip" aria-pressed={t.mode === 'chooseB'} onClick={() => t.setMode('chooseB')} disabled={!t.editable || !t.grid}>
          Choisir B
        </button>
        {custom && t.editable && <button className="chip" onClick={t.resetB}>Revenir au B de référence</button>}
        {!t.grid && !t.error && <span className="small muted">Chargement du terrain…</span>}
        {t.error && <span className="small" style={{ color: 'var(--red)' }}>Terrain indisponible : {t.error}</span>}
      </div>
      <Notice msg={t.msg} />
    </div>
  );
}

function Row({ label, tag, children }: { label: string; tag: 'obs' | 'der' | 'int' | 'sim'; children: ReactNode }) {
  return (
    <tr>
      <td className="muted">{label}</td>
      <td>{children}</td>
      <td><ProvenanceTag kind={tag} /></td>
    </tr>
  );
}

export function TerrainInspector({ t }: { t: TerrainTools }) {
  const i = t.info;
  if (t.error) return <p className="small muted">Grilles de terrain indisponibles : {t.error}</p>;
  if (!t.grid) return <p className="small muted">Chargement des grilles de terrain (≈ 4,7 Mo)…</p>;
  if (!i) return <p className="small muted">Cliquez sur la carte pour inspecter un point : altitude, pente, géologie, minéralogie et retour vers l’habitat.</p>;
  if (!i.inGrid) return <p className="small muted">Point hors de l’extrait de terrain (DTM 5 m).</p>;
  return (
    <>
      <table className="table">
        <tbody>
          <Row label="Position" tag="obs"><span className="mono">{i.lonlat[1].toFixed(5)}° N · {i.lonlat[0].toFixed(5)}° E</span></Row>
          <Row label="Altitude" tag="der"><span className="mono">{i.altitude !== null ? `${Math.round(i.altitude)} m` : '—'}</span></Row>
          <Row label="Pente" tag="der">
            {i.slope !== null ? (
              <span className="mono" style={{ color: slopeClass(i.slope).color }}>{fmtDeg(i.slope)} {i.passable ? '' : '· interdit'}</span>
            ) : '—'}
          </Row>
          <Row label="Unité géologique" tag="int">{i.unit ? `${i.unit.name} (${i.unit.symbol})` : '—'}</Row>
          <Row label="Classe CRISM" tag="der">{i.crism ? <>{i.crism.label} <span className="muted small">· CRISM, Zastrow &amp; Glotch 2021</span></> : 'hors régions classées'}</Row>
          <Row label="Zone de retour" tag="sim">
            {i.returnMin === null ? 'inaccessible depuis A' : (
              <>
                <strong style={{ color: i.inZone ? 'var(--green)' : 'var(--red)' }}>{i.inZone ? 'Oui' : 'Non'}</strong>
                <span className="mono"> · retour {fmtMin(i.returnMin)} {i.inZone ? '≤' : '>'} seuil {fmtMin(i.thresholdMin)}</span>
              </>
            )}
          </Row>
        </tbody>
      </table>
      <button className="btn" disabled={!t.editable || !i.passable} onClick={() => t.chooseB(i.lonlat)}>
        <Icon name="route" /> Choisir ce point comme B
      </button>
    </>
  );
}

export function SiteCandidates({ t }: { t: TerrainTools }) {
  if (!t.grid) return <p className="small muted">Chargement des grilles de terrain…</p>;
  if (t.sites.length === 0) return <p className="small muted">Aucune région « Carbonates marginaux » dans la zone de retour avec les paramètres actuels.</p>;
  return (
    <>
      <p className="small muted">
        {t.sites.length} région{t.sites.length > 1 ? 's' : ''} MC dans la zone de retour (CRISM, Zastrow &amp; Glotch 2021), triées par temps de retour vers A. Marge estimée si B y est placé : aller = retour au moindre coût.
      </p>
      <ul className="log" style={{ maxHeight: 300 }}>
        {t.sites.map((c, k) => (
          <li key={k} style={{ alignItems: 'center' }}>
            <span className="mono muted" style={{ minWidth: 28 }}>{k + 1}</span>
            <span className="grow small">
              retour <span className="mono">{fmtMin(c.returnMin)}</span> · marge <span className="mono" style={{ color: STATUS[statusOf(Math.round(c.marginIfChosen), t.s.params.reserve)].color }}>{Math.round(c.marginIfChosen)} min</span>
              <span className="muted"> · {Math.round(c.areaM2)} m²</span>
            </span>
            <button className="chip" onClick={() => (t.editable ? t.chooseB(c.center) : t.onPick(c.center))}>{t.editable ? 'Choisir' : 'Voir'}</button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Résumé du B courant (référence ou choisi), pour la carte de préparation. */
export function CurrentB({ t, margin }: { t: TerrainTools; margin: number }) {
  const plan = t.s.plan;
  const sand = plan ? plan.sand_m : t.data.overlays.routes?.mission.sand_m;
  return (
    <div className="row small" style={{ gap: 12 }}>
      <span className="tag" style={cssColor(plan ? 'var(--accent)' : 'var(--muted)')}>{plan ? 'B choisi sur la carte' : 'B de référence'}</span>
      <span>Sable sur l’aller : <span className="mono">{sand !== undefined ? `${Math.round(sand)} m` : '—'}</span></span>
      <StatusPill status={statusOf(margin, t.s.params.reserve)} short />
    </div>
  );
}
