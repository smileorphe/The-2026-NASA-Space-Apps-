import type { CSSProperties } from 'react';
import type { ProvenanceKind } from '../data';
import { Icon, type IconName } from './Icon';

/** Étiquette de provenance obligatoire sur chaque valeur (FRONTEND_SPEC §3). */
export const PROVENANCE: Record<ProvenanceKind, { label: string; color: string; icon: IconName }> = {
  obs: { label: 'Observé', color: 'var(--text)', icon: 'camera' },
  der: { label: 'Dérivé', color: 'var(--nav)', icon: 'ruler' },
  int: { label: 'Interprétation', color: 'var(--carb)', icon: 'spark' },
  sim: { label: 'Simulé', color: 'var(--amber)', icon: 'sim' },
};

export function ProvenanceTag({ kind }: { kind: ProvenanceKind }) {
  const p = PROVENANCE[kind];
  return (
    <span className="tag" style={{ '--c': p.color } as CSSProperties}>
      <Icon name={p.icon} size={12} />
      {p.label}
    </span>
  );
}
