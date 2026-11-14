import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { loadMissionData } from './data';
import { Bilan } from './habitat/Bilan';
import { HabitatLayout } from './habitat/HabitatLayout';
import { Preparation } from './habitat/Preparation';
import { Supervision } from './habitat/Supervision';
import { Helmet } from './helmet/Helmet';
import { Tablet } from './tablet/Tablet';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

// Les données de mission sont chargées une fois avant le premier rendu : les écrans les lisent de façon synchrone.
loadMissionData()
  .then(() =>
    root.render(
      <StrictMode>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/habitat/preparation" replace />} />
            <Route path="/habitat" element={<HabitatLayout />}>
              <Route index element={<Navigate to="preparation" replace />} />
              <Route path="preparation" element={<Preparation />} />
              <Route path="supervision" element={<Supervision />} />
              <Route path="bilan" element={<Bilan />} />
            </Route>
            <Route path="/tablette" element={<Tablet />} />
            <Route path="/casque" element={<Helmet />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </StrictMode>,
    ),
  )
  .catch((err: Error) => {
    root.render(<p style={{ padding: 24 }}>Impossible de charger les données de mission : {err.message}</p>);
  });
