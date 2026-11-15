/**
 * État de mission partagé (FRONTEND_SPEC §5).
 *
 * - Un seul store Zustand, persisté dans localStorage.
 * - Synchronisation entre onglets par BroadcastChannel('eva-planner') :
 *   l'Habitat fait avancer l'horloge, applique les actions et diffuse l'état complet ;
 *   Tablette et Casque appliquent leurs actions localement (retour immédiat) et les envoient
 *   à l'Habitat, dont l'état rediffusé fait foi.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getData } from './data';
import { type Action, type MissionState, defaultParams, deriveView, initialState, reduce } from './domain/mission';

export type Role = 'habitat' | 'tablette' | 'casque';

type Message =
  | { kind: 'state'; state: MissionState }
  | { kind: 'action'; action: Action }
  | { kind: 'hello' }
  | { kind: 'presence'; role: Role };

// version 3 : durées issues des coûts du terrain ; les états persistés des versions précédentes sont ignorés
const STORAGE_KEY = 'eva-planner';
export const useMissionStore = create<{ mission: MissionState }>()(
  persist(() => ({ mission: initialState() }), { name: STORAGE_KEY, version: 3 }),
);

/**
 * À appeler une fois les données chargées : sans état mémorisé, la mission démarre avec les valeurs par défaut
 * de route_analysis.json (réglées dans pipeline/config.py).
 */
export function initMission() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* stockage indisponible : on part des valeurs par défaut */
  }
  const savedVersion = saved ? (JSON.parse(saved) as { version?: number }).version : undefined;
  if (savedVersion !== 3) {
    const data = getData();
    useMissionStore.setState({ mission: initialState(defaultParams(data), data) });
  }
}

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('eva-planner') : null;
const post = (m: Message) => channel?.postMessage(m);

const roleFromPath = (path: string): Role =>
  path.startsWith('/tablette') ? 'tablette' : path.startsWith('/casque') ? 'casque' : 'habitat';

let role: Role = roleFromPath(location.pathname);

/** Déclare le rôle de l'onglet courant (appelé par le layout de chaque mode). */
export function setRole(r: Role) {
  role = r;
  if (r !== 'habitat') post({ kind: 'hello' });
}

export function dispatch(action: Action) {
  const prev = useMissionStore.getState().mission;
  const next = reduce(prev, action, getData());
  if (next !== prev) useMissionStore.setState({ mission: next });
  post(role === 'habitat' ? { kind: 'state', state: next } : { kind: 'action', action });
}

/* --- Présence des modes (indicateur « 3 modes synchronisés ») --- */
const lastSeen: Partial<Record<Role, number>> = {};

if (channel) {
  channel.onmessage = ({ data: m }: MessageEvent<Message>) => {
    switch (m.kind) {
      case 'state':
        useMissionStore.setState({ mission: m.state });
        break;
      case 'action':
        if (role === 'habitat') dispatch(m.action);
        break;
      case 'hello':
        if (role === 'habitat') post({ kind: 'state', state: useMissionStore.getState().mission });
        break;
      case 'presence':
        lastSeen[m.role] = Date.now();
        break;
    }
  };
  setInterval(() => post({ kind: 'presence', role }), 2000);
}

/** Modes vus récemment (cet onglet compris). */
export function usePresence(): Record<Role, boolean> {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  const alive = (r: Role) => r === role || now - (lastSeen[r] ?? 0) < 5000;
  return { habitat: alive('habitat'), tablette: alive('tablette'), casque: alive('casque') };
}

/** Horloge de simulation : seul l'Habitat la fait avancer. */
export function useClock() {
  useEffect(() => {
    const STEP_MS = 250;
    const id = setInterval(() => {
      const { phase, clock } = useMissionStore.getState().mission;
      if (phase === 'eva' && clock.speed > 0) dispatch({ type: 'TICK', dt: (clock.speed * STEP_MS) / 60_000 });
    }, STEP_MS);
    return () => clearInterval(id);
  }, []);
}

/** État brut + valeurs dérivées + données statiques. */
export function useMission() {
  const s = useMissionStore((st) => st.mission);
  const data = getData();
  return { s, view: deriveView(s, data), data };
}
