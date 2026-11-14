import { ProvenanceTag } from './ProvenanceTag';

/**
 * Texte carbonates imposé (guide §3, FRONTEND_SPEC §8), en trois niveaux :
 * signature (dérivé) / interprétation / limite. Ne jamais annoncer une détection sans preuve dans le jeu de données.
 */
export const CARBONATES = {
  signature: 'Signature compatible avec la présence de carbonates dans le produit CRISM retenu.',
  interpretation: 'Ces minéraux peuvent renseigner sur d’anciennes interactions avec l’eau et sur l’habitabilité passée.',
  limit: 'Leur présence ne constitue pas une preuve de vie.',
};

export function CarbonateText() {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <ProvenanceTag kind="der" />
        <span className="small">{CARBONATES.signature}</span>
      </div>
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <ProvenanceTag kind="int" />
        <span className="small">{CARBONATES.interpretation}</span>
      </div>
      <p className="small" style={{ fontWeight: 700 }}>{CARBONATES.limit}</p>
    </div>
  );
}

/** Emplacements d'images : à remplir après le Scope & Data Gate (source, date, résolution obligatoires). */
export function SiteImages() {
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <div className="placeholder grow">[Image orbitale du site]<br />source · date · résolution</div>
      <div className="placeholder grow">[Extrait CRISM]<br />identifiant produit</div>
    </div>
  );
}
