import { useMission } from '../store';
import { ProvenanceTag } from './ProvenanceTag';

/** Tableau des sources : couches (public/data/layers.json), analyse du tracé, paramètres simulés. */
export function ProvenanceTable() {
  const { data } = useMission();
  return (
    <table className="table">
      <thead>
        <tr><th>COUCHE</th><th>SOURCE</th><th>RÉSOLUTION · DATE</th><th>NATURE</th></tr>
      </thead>
      <tbody>
        {data.layers.map((l) => (
          <tr key={l.id}>
            <td>{l.name}</td>
            <td>{l.source}</td>
            <td className="mono small">{l.resolution} · {l.date}</td>
            <td><ProvenanceTag kind={l.kind} /></td>
          </tr>
        ))}
        <tr>
          <td>Analyse du tracé</td>
          <td>{data.analysisSource === 'api' ? 'Backend FastAPI · DTM' : 'Mock local (backend indisponible)'}</td>
          <td className="mono small">—</td>
          <td><ProvenanceTag kind="der" /></td>
        </tr>
        <tr>
          <td>Autonomie, seuils, imprévus</td>
          <td>Paramètres de démonstration</td>
          <td className="mono small">—</td>
          <td><ProvenanceTag kind="sim" /></td>
        </tr>
      </tbody>
    </table>
  );
}
