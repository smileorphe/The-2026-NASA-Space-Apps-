import { useEffect, useState } from 'react';
import { fmtT } from '../format';

/**
 * Curseur de temps : relit la sortie à n'importe quel instant (position, marge, journal, épingles).
 * - Sans `end` (Supervision) : l'extrémité droite et « Direct » reviennent au présent (`null`).
 * - Avec `end` (Bilan) : relecture complète de 0 à `end`, avec lecture automatique.
 */
export function TimeCursor({ t, value, onChange, end }: { t: number; value: number | null; onChange: (v: number | null) => void; end?: number }) {
  const max = end ?? t;
  const replay = end !== undefined;
  const [playing, setPlaying] = useState(false);
  const shown = value ?? max;

  // Lecture : ~20 s pour toute la sortie, quelle que soit sa durée
  useEffect(() => {
    if (!playing) return;
    const step = Math.max(max / 200, 0.25);
    const id = setInterval(() => {
      const next = Math.min((value ?? 0) + step, max);
      onChange(next);
      if (next >= max) setPlaying(false);
    }, 100);
    return () => clearInterval(id);
  }, [playing, value, max, onChange]);

  return (
    <div className="row" role="group" aria-label="Curseur de temps">
      {replay && (
        <button className="chip" aria-pressed={playing} onClick={() => {
          if (!playing && shown >= max) onChange(0);
          setPlaying((p) => !p);
        }}>{playing ? 'Pause' : 'Lecture'}</button>
      )}
      <span className="small muted">Temps</span>
      <input type="range" className="grow" min={0} max={Math.max(max, 0.1)} step={0.25} value={shown}
        onChange={(e) => {
          setPlaying(false);
          const v = Number(e.target.value);
          onChange(v >= max && !replay ? null : v);
        }} aria-label="Instant affiché" />
      <span className="mono small">{fmtT(shown)}</span>
      {!replay && <button className="chip" aria-pressed={value === null} onClick={() => onChange(null)}>Direct</button>}
    </div>
  );
}
