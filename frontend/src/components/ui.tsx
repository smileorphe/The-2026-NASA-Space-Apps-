import type { CSSProperties, ReactNode } from 'react';
import type { Status } from '../domain/autonomy';
import type { ProvenanceKind } from '../data';
import { Icon, type IconName } from './Icon';
import { ProvenanceTag } from './ProvenanceTag';

/** Couleur locale passée au CSS via la variable --c. */
export const cssColor = (c: string) => ({ '--c': c }) as CSSProperties;

/** Statut de marge : jamais la couleur seule, toujours icône + libellé (FRONTEND_SPEC §3, §8). */
export const STATUS: Record<Status, { color: string; icon: IconName; label: string; short: string }> = {
  green: { color: 'var(--green)', icon: 'shield', label: 'Dans les limites configurées', short: 'Marge suffisante' },
  amber: { color: 'var(--amber)', icon: 'warning', label: 'Marge réduite', short: 'Marge réduite' },
  red: { color: 'var(--red)', icon: 'warning', label: 'Réserve dépassée · retour prioritaire', short: 'Retour prioritaire' },
};

export function StatusPill({ status, short }: { status: Status; short?: boolean }) {
  const st = STATUS[status];
  return (
    <span role="status" className="status" style={cssColor(st.color)}>
      <Icon name={st.icon} />
      {short ? st.short : st.label}
    </span>
  );
}

export function Card({ title, tag, extra, className = '', children }: { title: string; tag?: ProvenanceKind; extra?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      <div className="card-head">
        <h2>{title}</h2>
        {extra}
        {tag && <ProvenanceTag kind={tag} />}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, tag, sub, color }: { label: string; value: ReactNode; tag?: ProvenanceKind; sub?: ReactNode; color?: string }) {
  return (
    <div className="stat" style={color ? cssColor(color) : undefined}>
      <span className="label">
        {label}
        {tag && <ProvenanceTag kind={tag} />}
      </span>
      <span className="value">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export interface NoticeMsg {
  color: string;
  title: string;
  text: string;
}

export function Notice({ msg }: { msg: NoticeMsg | null }) {
  if (!msg) return null;
  return (
    <div role="status" className="notice" style={cssColor(msg.color)}>
      <b>{msg.title}</b> {msg.text}
    </div>
  );
}
