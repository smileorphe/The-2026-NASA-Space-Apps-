import type { ReactNode } from 'react';
import { useMission } from '../store';
import { ProvenanceTag } from './ProvenanceTag';

/**
 * Texte carbonates imposé (guide §3), en trois niveaux : signature (dérivé) / interprétation / limite.
 * Affiché UNIQUEMENT si le point B est dans une région « Marginal Carbonates » (MC) du produit CRISM retenu
 * (route_aller.geojson, propriété crism_class, déterminée par pipeline/route.py).
 */
export const CARBONATES = {
  signature: 'Les données minéralogiques disponibles signalent une signature compatible avec la présence de carbonates dans cette zone.',
  interpretation: 'Ces minéraux peuvent renseigner sur d’anciennes interactions avec l’eau et sur l’habitabilité passée.',
  limit: 'Leur présence ne constitue pas une preuve de vie.',
  source: 'CRISM, Zastrow & Glotch 2021',
};

function Line({ kind, children }: { kind: 'obs' | 'der' | 'int'; children: ReactNode }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
      <ProvenanceTag kind={kind} />
      <span className="small">{children}</span>
    </div>
  );
}

/** Fiche du point B : classe CRISM, texte carbonates (si MC) et unité géologique (USGS SIM 3464). */
export function PointBFacts({ compact = false }: { compact?: boolean }) {
  const { data } = useMission();
  const b = data.waypoints.find((w) => w.id === 'B');
  const unit = b?.geologicUnit;
  const crism = b?.crismClass;
  const carbonates = crism?.code === 'MC';
  return (
    <div className="stack" style={{ gap: 8 }}>
      {carbonates ? (
        <>
          <Line kind="der">
            {CARBONATES.signature} <span className="muted">Région « {crism.label} » ({crism.label_en}) · source : {CARBONATES.source}.</span>
          </Line>
          <Line kind="int">{CARBONATES.interpretation}</Line>
          <p className="small" style={{ fontWeight: 700 }}>{CARBONATES.limit}</p>
        </>
      ) : (
        <Line kind="der">
          {crism ? `Région CRISM : ${crism.label} (${CARBONATES.source}).` : 'Point B hors des régions CRISM classées.'} Aucune signature carbonatée n’est annoncée.
        </Line>
      )}
      <Line kind="int">
        Unité géologique : <strong>{unit ? `${unit.name} (${unit.symbol})` : 'non renseignée'}</strong>
        {!compact && <span className="muted"> · carte USGS SIM 3464, 1:75 000</span>}
      </Line>
    </div>
  );
}

/** Emplacements d'images : à remplir après le Scope & Data Gate (source, date, résolution obligatoires). */
export function SiteImages() {
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <div className="placeholder grow">[Image orbitale du site]<br />source · date · résolution</div>
      <div className="placeholder grow">[Extrait CRISM]<br />HRL000040FF</div>
    </div>
  );
}
