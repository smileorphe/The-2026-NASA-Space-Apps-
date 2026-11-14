/**
 * Simulation de la sortie : état, actions (réducteur pur) et valeurs dérivées.
 * Aucune dépendance à React : tout est testable avec Vitest.
 *
 * Modèle : la sortie est une suite d'étapes (`Leg`) — aller, site B, retour.
 * Chaque étape porte son tracé et sa durée ; la position est interpolée dans le temps.
 * L'autonomie restante vaut `autonomie − t` (consommation simulée de 1 min/min).
 */
import {
  type Budget,
  type SimParams,
  type Status,
  DEFAULT_PARAMS,
  isAllowed,
  latestLeaveB,
  margin,
  plannedDurations,
  plannedMargin,
  statusOf,
} from './autonomy';
import { type XY, dist, distanceAlong, pathLength, pointAt, slicePath, bearing } from './geometry';
import type { IncidentId, MissionData, ScenarioOption, Waypoint, WaypointId } from '../data';

export type Source = 'HABITAT' | 'TABLETTE' | 'CASQUE' | 'SYSTÈME';
export type ClockSpeed = 0 | 1 | 10 | 60;
export type ObjectiveKey = 'photo' | 'observation' | 'sample';

export interface Leg {
  kind: 'out' | 'site' | 'back';
  startT: number;
  duration: number; // min (pour 'site' : observation prévue, informatif)
  path: XY[];
}

export interface LogEntry {
  t: number;
  source: Source;
  text: string;
}

export interface MissionState {
  phase: 'prep' | 'eva' | 'done';
  params: SimParams;
  clock: { t: number; speed: ClockSpeed }; // t : minutes depuis le départ
  leg: Leg | null;
  retourMin: number; // retour estimé depuis B (min)
  observationExtra: number;
  incident: null | { id: IncidentId; choice?: string };
  reached: Partial<Record<WaypointId, number>>; // heure de passage
  objectives: Record<ObjectiveKey, boolean>;
  trail: XY[]; // trajet réellement parcouru
  traveledM: number;
  minMargin: number;
  log: LogEntry[];
  lastMessageToHud?: string;
}

export type Action =
  | { type: 'SET_PARAMS'; params: SimParams }
  | { type: 'LAUNCH' }
  | { type: 'SET_CLOCK_SPEED'; speed: ClockSpeed }
  | { type: 'TICK'; dt: number }
  | { type: 'LOG'; source: Source; text: string; objective?: ObjectiveKey }
  | { type: 'EXTEND_OBSERVATION'; minutes: number; source: Source }
  | { type: 'TRIGGER_INCIDENT'; id: IncidentId }
  | { type: 'CHOOSE_OPTION'; optionId: string }
  | { type: 'RETURN_NOW'; source: Source }
  | { type: 'SEND_HUD_MESSAGE'; text: string }
  | { type: 'RESET' };

export function initialState(params: SimParams = DEFAULT_PARAMS): MissionState {
  return {
    phase: 'prep',
    params,
    clock: { t: 0, speed: 0 },
    leg: null,
    retourMin: plannedDurations(params.speedKmh).retour,
    observationExtra: 0,
    incident: null,
    reached: {},
    objectives: { photo: false, observation: false, sample: false },
    trail: [],
    traveledM: 0,
    minMargin: plannedMargin(params),
    log: [],
  };
}

/* ------------------------------------------------------------------ */
/* Lecture de l'état                                                   */
/* ------------------------------------------------------------------ */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function legProgress(leg: Leg, t: number): number {
  return leg.duration <= 0 ? 1 : clamp01((t - leg.startT) / leg.duration);
}

export function positionOf(s: MissionState, data: MissionData): { p: XY; heading: number } {
  if (!s.leg) return { p: data.route[0], heading: bearing(data.route[0], data.route[1]) };
  const len = pathLength(s.leg.path);
  return pointAt(s.leg.path, len * legProgress(s.leg, s.clock.t));
}

const observationPlanned = (s: MissionState) => s.params.observation + s.observationExtra;

/** Les termes de la formule d'autonomie à l'instant courant. */
export function budgetOf(s: MissionState): Budget {
  const { params, leg } = s;
  const t = s.clock.t;
  if (s.phase === 'prep' || !leg) {
    const { aller, retour } = plannedDurations(params.speedKmh);
    return { autonomy: params.autonomy, allerRestant: aller, observation: params.observation, retour };
  }
  const autonomy = params.autonomy - t;
  const rest = leg.duration * (1 - legProgress(leg, t));
  if (s.phase === 'done') return { autonomy, allerRestant: 0, observation: 0, retour: 0 };
  switch (leg.kind) {
    case 'out':
      return { autonomy, allerRestant: rest, observation: observationPlanned(s), retour: s.retourMin };
    case 'site':
      return { autonomy, allerRestant: 0, observation: Math.max(0, observationPlanned(s) - (t - leg.startT)), retour: s.retourMin };
    case 'back':
      return { autonomy, allerRestant: 0, observation: 0, retour: rest };
  }
}

export const marginNow = (s: MissionState) => Math.round(margin(budgetOf(s)));

/** Marge si l'on choisit cette option d'imprévu. */
export function optionMargin(s: MissionState, opt: ScenarioOption): number {
  const b = budgetOf(s);
  return Math.round(
    margin({ autonomy: b.autonomy, allerRestant: opt.allerRestant, observation: opt.keepObservation ? b.observation : 0, retour: opt.retour }),
  );
}

/** Marge si l'on prolonge l'observation au point B. */
export function extensionMargin(s: MissionState, minutes: number): number {
  const b = budgetOf(s);
  return Math.round(margin({ ...b, observation: b.observation + minutes }));
}

export const canExtend = (s: MissionState) => s.phase === 'eva' && (s.leg?.kind === 'out' || s.leg?.kind === 'site');

/** Retour par le tracé connu (trajet parcouru inversé), durée proportionnelle à la distance. */
export function returnPlan(s: MissionState, data: MissionData): { path: XY[]; duration: number } {
  const path = [...s.trail, positionOf(s, data).p].reverse();
  const duration = Math.max(1, Math.round((s.retourMin * pathLength(path)) / data.routeLength));
  return { path, duration };
}

export function returnMargin(s: MissionState, data: MissionData): number {
  return Math.round(s.params.autonomy - s.clock.t - returnPlan(s, data).duration);
}

/* ------------------------------------------------------------------ */
/* Valeurs dérivées pour l'affichage                                   */
/* ------------------------------------------------------------------ */

export type Alert = 'none' | 'incident' | 'return';

export interface View {
  budget: Budget;
  margin: number;
  status: Status;
  remaining: number; // autonomie restante (min)
  position: XY;
  heading: number;
  dAlong: number; // position projetée sur le tracé aller (m)
  next: { id: WaypointId; name: string; distance: number; relBearing: number } | null;
  progressPct: number;
  etaB: number | null;
  etaA: number;
  leaveB: number | null; // heure limite pour quitter B
  maxStayB: number | null;
  slope: number | null; // pente du segment courant (°)
  nextSlope: number | null;
  alert: Alert;
}

export function segmentAt(data: MissionData, d: number) {
  const byId = Object.fromEntries(data.waypoints.map((w) => [w.id, w]));
  const i = data.analysis.segments.findIndex((sg) => d >= byId[sg.from].d && d <= byId[sg.to].d);
  return { current: data.analysis.segments[i] ?? null, next: data.analysis.segments[i + 1] ?? null };
}

export function deriveView(s: MissionState, data: MissionData): View {
  const budget = budgetOf(s);
  const m = Math.round(margin(budget));
  const status = statusOf(m, s.params.reserve);
  const t = s.clock.t;
  const { p, heading } = positionOf(s, data);
  const dAlong = distanceAlong(data.route, p);
  const kind = s.leg?.kind;

  let target: Waypoint | undefined;
  if (s.phase === 'prep' || kind === 'out') target = data.waypoints.find((w) => w.id !== 'A' && s.reached[w.id] === undefined && w.d > dAlong);
  else if (kind === 'back' && s.phase === 'eva') target = data.waypoints[0];
  const next = target
    ? { id: target.id, name: target.name, distance: dist(p, target.xy), relBearing: bearing(p, target.xy) - heading }
    : null;

  // Progression = distance parcourue / (parcourue + restant à faire jusqu'au retour en A)
  let left = 2 * data.routeLength;
  if (kind === 'out') left = data.routeLength - dAlong + data.routeLength;
  else if (kind === 'site') left = data.routeLength;
  else if (kind === 'back' && s.leg) left = pathLength(s.leg.path) * (1 - legProgress(s.leg, t));
  const progressPct = s.phase === 'done' ? 100 : (100 * s.traveledM) / (s.traveledM + left || 1);

  const keepsB = s.phase === 'prep' || kind === 'out' || kind === 'site';
  const etaB = s.reached.B ?? (keepsB ? t + budget.allerRestant : null);
  const leaveB = keepsB && etaB !== null ? latestLeaveB(etaB, s.params.autonomy - etaB, s.retourMin, s.params.reserve) : null;

  const seg = segmentAt(data, dAlong);
  const returningAfterIncident = kind === 'back' && !!s.incident?.choice;
  const alert: Alert =
    s.phase === 'eva' && (status === 'red' || returningAfterIncident) ? 'return' : s.incident && !s.incident.choice ? 'incident' : 'none';

  return {
    budget,
    margin: m,
    status,
    remaining: budget.autonomy,
    position: p,
    heading,
    dAlong,
    next,
    progressPct: Math.round(progressPct),
    etaB,
    etaA: s.phase === 'done' ? t : t + budget.allerRestant + budget.observation + budget.retour,
    leaveB,
    maxStayB: leaveB !== null && etaB !== null ? leaveB - etaB : null,
    slope: kind === 'out' || s.phase === 'prep' ? (seg.current?.slope_deg ?? null) : null,
    nextSlope: seg.next?.slope_deg ?? null,
    alert,
  };
}

/** Heure de passage prévue au plan pour un point (allure constante). */
export function plannedTimeAt(s: MissionState, data: MissionData, w: Waypoint): number {
  return (plannedDurations(s.params.speedKmh).aller * w.d) / data.routeLength;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const lowerFirst = (txt: string) => txt.charAt(0).toLowerCase() + txt.slice(1);

const addLog = (s: MissionState, source: Source, text: string): MissionState => ({
  ...s,
  log: [...s.log, { t: s.clock.t, source, text }],
});

function startReturn(s: MissionState, data: MissionData, duration?: number): MissionState {
  const plan = returnPlan(s, data);
  return {
    ...s,
    leg: { kind: 'back', startT: s.clock.t, duration: duration ?? plan.duration, path: plan.path },
    trail: [...s.trail, positionOf(s, data).p],
  };
}

/** Tracé restant vers B par le détour : on rejoint le début du détour puis on le suit. */
function detourPath(s: MissionState, data: MissionData): XY[] {
  const path = s.leg!.path;
  const dNow = distanceAlong(path, positionOf(s, data).p);
  const dStart = distanceAlong(path, data.detour[0]);
  const lead = dNow < dStart ? slicePath(path, dNow, dStart) : [positionOf(s, data).p];
  return [...lead, ...data.detour.slice(1)];
}

function tick(s: MissionState, dt: number, data: MissionData): MissionState {
  const leg = s.leg;
  if (s.phase !== 'eva' || !leg || dt <= 0) return s;

  const legEnd = leg.startT + leg.duration;
  const ends = leg.kind !== 'site' && s.clock.t + dt >= legEnd;
  const t = ends ? legEnd : s.clock.t + dt;
  const prev = positionOf(s, data).p;
  let next: MissionState = { ...s, clock: { ...s.clock, t } };
  const pos = positionOf(next, data).p;

  // Points de passage franchis pendant ce pas de temps (sauf B, traité en fin d'étape)
  if (leg.kind === 'out') {
    const len = pathLength(leg.path);
    const d0 = len * legProgress(leg, s.clock.t);
    const d1 = len * legProgress(leg, t);
    for (const w of data.waypoints) {
      if (w.id === 'A' || w.id === 'B' || next.reached[w.id] !== undefined) continue;
      const dw = distanceAlong(leg.path, w.xy);
      if (dist(pointAt(leg.path, dw).p, w.xy) < 1 && dw > d0 && dw <= d1) {
        next = { ...next, reached: { ...next.reached, [w.id]: t } };
        next = addLog(next, 'CASQUE', `${w.id} atteint · marge ${marginNow(next)} min`);
      }
    }
  }

  const last = next.trail[next.trail.length - 1];
  next.traveledM += dist(prev, pos);
  if (!last || dist(last, pos) >= 10 || ends) next.trail = [...next.trail, pos];

  if (ends && leg.kind === 'out') {
    next = {
      ...next,
      leg: { kind: 'site', startT: t, duration: observationPlanned(next), path: [pos] },
      reached: { ...next.reached, B: t },
      clock: { t, speed: 1 }, // au point B l'horloge repasse en temps réel pour laisser le temps d'agir
    };
    next = addLog(next, 'CASQUE', `Arrivée au point B · marge ${marginNow(next)} min`);
  } else if (ends && leg.kind === 'back') {
    next = { ...next, phase: 'done', clock: { t, speed: 0 } };
    next = addLog(next, 'HABITAT', `Retour à l’habitat A · autonomie ${Math.round(s.params.autonomy - t)} min`);
  }

  next.minMargin = Math.min(next.minMargin, marginNow(next));
  return next;
}

export function reduce(s: MissionState, a: Action, data: MissionData): MissionState {
  const reserve = s.params.reserve;
  switch (a.type) {
    case 'SET_PARAMS': {
      if (s.phase !== 'prep') return s;
      const m = plannedMargin(a.params);
      if (a.params.observation > s.params.observation && !isAllowed(m, a.params.reserve)) return s;
      return { ...s, params: a.params, retourMin: plannedDurations(a.params.speedKmh).retour, minMargin: m };
    }

    case 'LAUNCH': {
      const m = plannedMargin(s.params);
      if (s.phase !== 'prep' || !isAllowed(m, reserve)) return s;
      const { aller, retour } = plannedDurations(s.params.speedKmh);
      const launched: MissionState = {
        ...initialState(s.params),
        phase: 'eva',
        clock: { t: 0, speed: 10 },
        leg: { kind: 'out', startT: 0, duration: aller, path: data.route },
        retourMin: retour,
        reached: { A: 0 },
        trail: [data.route[0]],
        minMargin: m,
      };
      return addLog(launched, 'HABITAT', `Départ de l’habitat A · marge ${m} min`);
    }

    case 'SET_CLOCK_SPEED':
      return s.phase === 'eva' ? { ...s, clock: { ...s.clock, speed: a.speed } } : s;

    case 'TICK':
      return tick(s, a.dt, data);

    case 'LOG': {
      if (s.phase !== 'eva') return s;
      const logged = addLog(s, a.source, a.text);
      return a.objective ? { ...logged, objectives: { ...logged.objectives, [a.objective]: true } } : logged;
    }

    case 'EXTEND_OBSERVATION': {
      const m = extensionMargin(s, a.minutes);
      if (!canExtend(s) || !isAllowed(m, reserve)) return s;
      const next = { ...s, observationExtra: s.observationExtra + a.minutes };
      return addLog(next, a.source, `Observation prolongée de ${a.minutes} min · marge ${m} min`);
    }

    case 'TRIGGER_INCIDENT': {
      if (s.phase !== 'eva' || s.leg?.kind !== 'out' || s.incident) return s;
      const next = { ...s, incident: { id: a.id } };
      return addLog(next, 'SYSTÈME', `Événement simulé : ${lowerFirst(data.scenarios[a.id].title)}`);
    }

    case 'CHOOSE_OPTION': {
      if (!s.incident || s.incident.choice || s.leg?.kind !== 'out') return s;
      const opt = data.scenarios[s.incident.id].options.find((o) => o.id === a.optionId);
      if (!opt) return s;
      const m = optionMargin(s, opt);
      if (!isAllowed(m, reserve)) return s;
      let next: MissionState = { ...s, incident: { ...s.incident, choice: opt.id } };
      if (opt.keepObservation) {
        const path =
          s.incident.id === 'obstacle'
            ? detourPath(s, data)
            : slicePath(s.leg.path, distanceAlong(s.leg.path, positionOf(s, data).p), pathLength(s.leg.path));
        next = { ...next, leg: { kind: 'out', startT: s.clock.t, duration: opt.allerRestant, path }, retourMin: opt.retour };
      } else {
        next = startReturn(next, data, opt.retour);
      }
      return addLog(next, 'HABITAT', `Décision : ${lowerFirst(opt.label)} · marge ${m} min`);
    }

    case 'RETURN_NOW': {
      if (s.phase !== 'eva' || s.leg?.kind === 'back') return s;
      const m = returnMargin(s, data);
      const text = s.leg?.kind === 'site' ? `Site terminé, retour vers A · marge ${m} min` : `Décision : retour à l’habitat · marge ${m} min`;
      return addLog(startReturn(s, data), a.source, text);
    }

    case 'SEND_HUD_MESSAGE':
      return addLog({ ...s, lastMessageToHud: a.text }, 'HABITAT', `Message au casque : « ${a.text} »`);

    case 'RESET':
      return initialState(s.params);
  }
}
