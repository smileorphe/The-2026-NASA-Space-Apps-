import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { Icon } from '../components/Icon';
import { fmtT } from '../format';
import { dispatch, setRole, useClock, useMission, usePresence } from '../store';

/** Coquille commune Préparation / Supervision / Bilan. L'Habitat est la source de l'horloge. */
export function HabitatLayout() {
  useEffect(() => setRole('habitat'), []);
  useClock();

  const reset = () => {
    if (confirm('Réinitialiser la démo ? Le journal et la progression seront effacés (paramètres conservés).')) dispatch({ type: 'RESET' });
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
            <path d="M30 18a12 12 0 1 1-6-10.4" fill="none" stroke="#F3EFEA" strokeWidth="3" strokeLinecap="round" />
            <circle cx="27.5" cy="9.5" r="3.5" fill="#EE8A1B" />
            <path d="M12 24 L18 12 L24 24" fill="none" stroke="#F3EFEA" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          EVA Planner
        </div>
        <div className="stack" style={{ gap: 4, padding: '0 18px' }}>
          <span className="kicker">Mission</span>
          <strong>Jezero · A → B</strong>
          <span className="small muted">Rejoindre l’affleurement et documenter le site</span>
        </div>
        <nav className="sidenav" aria-label="Étapes de la mission">
          <NavLink to="/habitat/preparation"><Icon name="route" size={22} />Préparation</NavLink>
          <NavLink to="/habitat/supervision"><Icon name="pulse" size={22} />Supervision</NavLink>
          <NavLink to="/habitat/bilan"><Icon name="book" size={22} />Bilan</NavLink>
        </nav>
        <div className="sim-card">
          <span className="row" style={{ color: 'var(--amber)', fontWeight: 800 }}><Icon name="sim" />Mode simulation</span>
          <span className="muted">Autonomie, seuils et imprévus sont des paramètres de démonstration, pas des normes NASA.</span>
          <Link to="/habitat/preparation#params">Voir les paramètres</Link>
          <button className="btn" onClick={reset}>Réinitialiser la démo</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

/** En-tête d'écran : titre, sélecteur de mode, horloge, état de synchronisation. */
export function Header({ title, subtitle, children }: { title: string; subtitle: ReactNode; children?: ReactNode }) {
  const { s } = useMission();
  const presence = usePresence();
  const online = Object.values(presence).filter(Boolean).length;
  return (
    <header className="header">
      <div className="grow">
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      {children}
      <nav className="switch" aria-label="Mode d’affichage">
        <a className="active" aria-current="page">Habitat</a>
        <a href="/tablette" target="_blank" rel="noopener">Tablette</a>
        <a href="/casque" target="_blank" rel="noopener">Casque</a>
      </nav>
      <span className="row mono" style={{ fontSize: 18 }} aria-label="Horloge de mission simulée">
        <Icon name="clock" />
        {s.phase === 'prep' ? 'Avant départ' : fmtT(s.clock.t)}
      </span>
      <span className="row small" style={{ color: online === 3 ? 'var(--green)' : 'var(--muted)' }} title="Onglets Habitat / Tablette / Casque ouverts dans ce navigateur">
        <Icon name={online === 3 ? 'check' : 'pulse'} />
        {online} / 3 modes synchronisés
      </span>
    </header>
  );
}
