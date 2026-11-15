import { useState } from 'react';
import type { LogEntry, Source } from '../domain/mission';
import { fmtT } from '../format';
import { cssColor } from './ui';

export const SOURCE_COLOR: Record<Source, string> = {
  HABITAT: 'var(--accent)',
  TABLETTE: 'var(--carb)',
  CASQUE: 'var(--nav)',
  SYSTÈME: 'var(--amber)',
};

const FILTERS: (Source | 'TOUS')[] = ['TOUS', 'TABLETTE', 'CASQUE', 'HABITAT', 'SYSTÈME'];

/** Journal de mission, du plus récent au plus ancien (ou chronologique avec `chronological`). */
export function MissionLog({ entries, filterable, chronological, maxHeight }: { entries: LogEntry[]; filterable?: boolean; chronological?: boolean; maxHeight?: number }) {
  const [filter, setFilter] = useState<Source | 'TOUS'>('TOUS');
  const shown = entries.filter((e) => filter === 'TOUS' || e.source === filter);
  const ordered = chronological ? shown : [...shown].reverse();
  return (
    <>
      {filterable && (
        <div className="row" role="group" aria-label="Filtrer le journal">
          {FILTERS.map((f) => (
            <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'TOUS' ? 'Tous' : f.charAt(0) + f.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      )}
      <ul className="log" style={{ maxHeight }}>
        {ordered.length === 0 && <li className="muted">Aucune entrée.</li>}
        {ordered.map((e, i) => (
          <li key={i}>
            <span className="mono muted">{fmtT(e.t)}</span>
            <span className="src" style={cssColor(SOURCE_COLOR[e.source])}>{e.source}</span>
            <span>{e.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
