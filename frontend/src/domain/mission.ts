/**
 * Simulation de la sortie : état, actions (réducteur pur) et valeurs dérivées.
 * Aucune dépendance à React : tout est testable avec Vitest.
 *
 * Modèle : la sortie est une suite d'étapes (`Leg`) — aller, site B, retour.
 * Chaque étape porte son tracé et sa durée ; la position est interpolée dans le temps, pondérée par le coût
 * du terrain quand il est connu (on avance moins vite dans les segments coûteux).
 * Toutes les durées viennent des coûts de route_analysis.json divisés par la vitesse (domain/autonomy.ts).
 * L'autonomie restante vaut `autonomie − t` (consommation simulée de 1 min/min).
 */
import {
  type Budget,
  type PlanCosts,
  type SimParams,
  type Status,
  FALLBACK_PARAMS,
  isAllowed,
  latestLeaveB,
  margin,
  minutesFor,
  plannedDurations,
  plannedMargin,
  statusOf,
} from './autonomy';
import { type XY, dist, distanceAlong, pathLength, pointAt, slicePath, bearing } from './geometry';
import type { LonLat } from './projection';
import type { IncidentId, MissionData, ScenarioOption, Waypoint, WaypointId } from '../data';
import { type CustomPlan, withPlan } from './plan';

export type Source = 'HABITAT' | 'TABLETTE' | 'CASQUE' | 'SYSTÈME';
export type ClockSpeed = 0 | 1 | 10 | 60;
export type ObjectiveKey = 'photo' | 'observation' | 'sample';

export interface Leg {
  kind: 'out' | 'site' | 'back';
  startT: number;
  duration: number; // min (pour 'site' : observation prévue, informatif)
  path: XY[];
  cum?: number[]; // coût cumulé à chaque sommet de `path` (m de plat) ; absent = allure uniforme
}

export interface LogEntry {
  t: number;
  source: Source;
  text: string;
  kind?: string; // type d'observation (Photo, Mesure…) pour les épingles
  pos?: LonLat; // position simulée au moment de l'entrée (observations de la tablette, obstacles)
}

/** Obstacle signalé pendant la sortie : cellules bloquées dans un rayon donné ; reste sur la carte jusqu'à la fin. */
export interface Obstacle {
  id: string;
  lonlat: LonLat;
  radiusM: number;
  t: number;
  source: Source;
}

export const OBSTACLE_RADIUS_M = 15;

export interface MissionState {
  phase: 'prep' | 'eva' | 'done';
  params: SimParams;
  clock: { t: number; speed: ClockSpeed }; // t : minutes depuis le départ
  leg: Leg | null;
  retourMin: number; // retour estimé depuis B (min) : itinéraire de moindre coût B → A
  observationExtra: number;
  incident: null | { id: IncidentId; choice?: string; resumeSpeed?: ClockSpeed };
  reached: Partial<Record<WaypointId, number>>; // heure de passage
  objectives: Record<ObjectiveKey, boolean>;
  trail: XY[]; // trajet réellement parcouru
  trailT: number[]; // heure de chaque point du trajet (curseur de temps, relecture)
  marginHistory: [number, number][]; // [t, marge] au fil de la sortie
  traveledM: number;
  minMargin: number;
  log: LogEntry[];
  lastMessageToHud?: string;
  plan: CustomPlan | null; // B choisi sur la carte (null = tracé de référence) ; partagé avec les trois modes
  obstacles: Obstacle[];
  returnPath: LonLat[] | null; // retour depuis B recalculé (contournement d'obstacle), sinon celui du plan
}

export type Action =
  | { type: 'SET_PARAMS'; params: SimParams }
  | { type: 'LAUNCH' }
  | { type: 'SET_CLOCK_SPEED'; speed: ClockSpeed }
  | { type: 'TICK'; dt: number }
  | { type: 'LOG'; source: Source; text: string; objective?: ObjectiveKey; kind?: string }
  | { type: 'EXTEND_OBSERVATION'; minutes: number; source: Source }
  | { type: 'TRIGGER_INCIDENT'; id: IncidentId }
  | { type: 'CHOOSE_OPTION'; optionId: string }
  | { type: 'RETURN_NOW'; source: Source }
  | { type: 'SEND_HUD_MESSAGE'; text: string }
  | { type: 'SET_PLAN'; plan: CustomPlan | null }
  /** Obstacle placé par l'habitat (lonlat) ou signalé par la tablette à la position actuelle (sans lonlat). */
  | { type: 'OBSTACLE'; source: Source; lonlat?: LonLat }
  /** Option calculée par l'habitat (A* sur la grille, domain/obstacle.ts) ; refusée si la marge passe sous la réserve. */
  | { type: 'CHOOSE_OBSTACLE_OPTION'; kind: 'continue' | 'back'; path: LonLat[]; allerRestant: number; retour: number; returnPath?: LonLat[] }
  | { type: 'RESET' };

/* ------------------------------------------------------------------ */
/* Coûts du plan                                                       */
/* ------------------------------------------------------------------ */

export function planCosts(data: MissionData): PlanCosts {
  return { allerCostM: data.analysis.aller.cost_m, retourCostM: data.analysis.return.cost_m };
}

/** Paramètres par défaut de la mission (route_analysis.json, réglés dans pipeline/config.py). */
export function defaultParams(data: MissionData): SimParams {
  const d = data.analysis.defaults;
  return { autonomy: d.autonomy_min, speedKmh: d.speed_kmh, observation: d.observation_min, reserve: d.reserve_min };
}

/** Coût cumulé (m de plat) le long du tracé aller jusqu'à la distance `d` (coût uniforme dans chaque segment). */
export function routeCostAt(data: MissionData, d: number): number {
  const byId = Object.fromEntries(data.waypoints.map((w) => [w.id, w]));
  let acc = 0;
  for (const sg of data.analysis.segments) {
    const d0 = byId[sg.from].d;
    const d1 = byId[sg.to].d;
    if (d >= d1) acc += sg.cost_m;
    else {
      if (d > d0) acc += (sg.cost_m * (d - d0)) / (d1 - d0 || 1);
      break;
    }
  }
  return acc;
}

export function initialState(params: SimParams = FALLBACK_PARAMS, data: MissionData | null = null): MissionState {
  return {
    phase: 'prep',
    params,
    clock: { t: 0, speed: 0 },
    leg: null,
    retourMin: data ? plannedDurations(planCosts(data), params.speedKmh).retour : 0,
    observationExtra: 0,
    incident: null,
    reached: {},
    objectives: { photo: false, observation: false, sample: false },
    trail: [],
    trailT: [],
    marginHistory: [],
    traveledM: 0,
    minMargin: data ? plannedMargin(params, planCosts(data)) : 0,
    log: [],
    plan: null,
    obstacles: [],
    returnPath: null,
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
  const leg = s.leg;
  if (!leg) return { p: data.route[0], heading: bearing(data.route[0], data.route[1]) };
  const k = legProgress(leg, s.clock.t);
  if (leg.cum && leg.cum.length === leg.path.length && leg.path.length > 1) {
    const target = leg.cum[leg.cum.length - 1] * k;
    let i = 0;
    while (i < leg.cum.length - 2 && leg.cum[i + 1] < target) i++;
    const span = leg.cum[i + 1] - leg.cum[i];
    const f = span > 0 ? clamp01((target - leg.cum[i]) / span) : 1;
    const [a, b] = [leg.path[i], leg.path[i + 1]];
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) };
  }
  return pointAt(leg.path, pathLength(leg.path) * k);
}

const observationPlanned = (s: MissionState) => s.params.observation + s.observationExtra;

/** Les termes de la formule d'autonomie à l'instant courant. */
export function budgetOf(s: MissionState, data: MissionData): Budget {
  const { params, leg } = s;
  const t = s.clock.t;
  if (s.phase === 'prep' || !leg) {
    const { aller, retour } = plannedDurations(planCosts(data), params.speedKmh);
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

export const marginNow = (s: MissionState, data: MissionData) => Math.round(margin(budgetOf(s, data)));

/**
 * Retour vers A à partir de la position courante :
 * - depuis B : itinéraire de moindre coût B → A (durée = retour du plan) ;
 * - en cours d'aller : tracé connu inversé, au coût du terrain déjà parcouru.
 */
export function returnPlan(s: MissionState, data: MissionData): { path: XY[]; duration: number } {
  const p = positionOf(s, data).p;
  if (s.leg?.kind === 'site') return { path: s.returnPath ? s.returnPath.map(data.projection.toLocal) : data.returnPath, duration: s.retourMin };
  const cost = routeCostAt(data, distanceAlong(data.route, p));
  return { path: [...s.trail, p].reverse(), duration: Math.max(0.5, minutesFor(cost, s.params.speedKmh)) };
}

export function returnMargin(s: MissionState, data: MissionData): number {
  return Math.round(s.params.autonomy - s.clock.t - returnPlan(s, data).duration);
}

/** Durées et tracé d'une option d'imprévu, calculés à partir des coûts (rien n'est écrit dans le scénario). */
export function optionPlan(s: MissionState, data: MissionData, opt: ScenarioOption) {
  const f = opt.speedFactor ?? 1;
  const b = budgetOf(s, data);
  const p = positionOf(s, data).p;
  if (opt.kind === 'back') {
    const r = returnPlan(s, data);
    return { allerRestant: 0, retour: r.duration / f, keepObservation: false, path: r.path };
  }
  const path = s.leg ? slicePath(s.leg.path, distanceAlong(s.leg.path, p), pathLength(s.leg.path)) : data.route;
  return { allerRestant: b.allerRestant / f, retour: s.retourMin / f, keepObservation: true, path };
}

/** Marge si l'on choisit cette option d'imprévu. */
export function optionMargin(s: MissionState, data: MissionData, opt: ScenarioOption): number {
  const b = budgetOf(s, data);
  const o = optionPlan(s, data, opt);
  return Math.round(margin({ autonomy: b.autonomy, allerRestant: o.allerRestant, observation: o.keepObservation ? b.observation : 0, retour: o.retour }));
}

/** Marge si l'on prolonge l'observation au point B. */
export function extensionMargin(s: MissionState, data: MissionData, minutes: number): number {
  const b = budgetOf(s, data);
  return Math.round(margin({ ...b, observation: b.observation + minutes }));
}

export const canExtend = (s: MissionState) => s.phase === 'eva' && (s.leg?.kind === 'out' || s.leg?.kind === 'site');

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
  const budget = budgetOf(s, data);
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
  const backLength = pathLength(data.returnPath);
  let left = data.routeLength + backLength;
  if (kind === 'out') left = data.routeLength - dAlong + backLength;
  else if (kind === 'site') left = backLength;
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

/** État de la sortie à l'instant `tau` (curseur de temps, relecture du bilan), reconstitué depuis l'historique. */
export interface Moment {
  t: number;
  position: XY;
  trail: XY[];
  margin: number | null;
  remaining: number; // autonomie restante (min)
  log: LogEntry[];
  obstacles: Obstacle[];
}

export function momentAt(s: MissionState, data: MissionData, tau: number): Moment {
  const t = Math.max(0, Math.min(tau, s.clock.t));
  const T = s.trailT;
  let k = 0;
  while (k < T.length - 1 && T[k + 1] <= t) k++;
  let position: XY = s.trail[k] ?? data.route[0];
  if (t >= s.clock.t) position = positionOf(s, data).p;
  else if (k < T.length - 1 && T[k + 1] > T[k]) {
    const f = (t - T[k]) / (T[k + 1] - T[k]);
    const [a, b] = [s.trail[k], s.trail[k + 1]];
    position = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  let m: number | null = null;
  for (const [ht, hm] of s.marginHistory) if (ht <= t) m = hm;
  return {
    t,
    position,
    trail: [...s.trail.slice(0, k + 1), position],
    margin: m,
    remaining: s.params.autonomy - t,
    log: s.log.filter((e) => e.t <= t),
    obstacles: s.obstacles.filter((o) => o.t <= t),
  };
}

/** Heure de passage prévue au plan pour un point : coût cumulé jusqu'au point ÷ vitesse. */
export function plannedTimeAt(s: MissionState, data: MissionData, w: Waypoint): number {
  return minutesFor(routeCostAt(data, w.d), s.params.speedKmh);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const lowerFirst = (txt: string) => txt.charAt(0).toLowerCase() + txt.slice(1);

const addLog = (s: MissionState, source: Source, text: string): MissionState => ({
  ...s,
  log: [...s.log, { t: s.clock.t, source, text }],
});

function startReturn(s: MissionState, data: MissionData, duration?: number, path?: XY[]): MissionState {
  const plan = returnPlan(s, data);
  return {
    ...s,
    leg: { kind: 'back', startT: s.clock.t, duration: duration ?? plan.duration, path: path ?? plan.path },
    trail: [...s.trail, positionOf(s, data).p],
    trailT: [...s.trailT, s.clock.t],
  };
}

/** Titre d'un imprévu (l'obstacle n'est plus un scénario prédéfini : il est placé sur la carte). */
export function incidentTitle(s: MissionState, data: MissionData): string | null {
  if (!s.incident) return null;
  return s.incident.id === 'obstacle' ? 'Obstacle sur l’itinéraire' : (data.scenarios[s.incident.id]?.title ?? 'Imprévu');
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
    const d0 = distanceAlong(leg.path, prev);
    const d1 = distanceAlong(leg.path, pos);
    for (const w of data.waypoints) {
      if (w.id === 'A' || w.id === 'B' || next.reached[w.id] !== undefined) continue;
      const dw = distanceAlong(leg.path, w.xy);
      if (dist(pointAt(leg.path, dw).p, w.xy) < 1 && dw > d0 && dw <= d1) {
        next = { ...next, reached: { ...next.reached, [w.id]: t } };
        next = addLog(next, 'CASQUE', `${w.id} atteint · marge ${marginNow(next, data)} min`);
      }
    }
  }

  const last = next.trail[next.trail.length - 1];
  next.traveledM += dist(prev, pos);
  if (!last || dist(last, pos) >= 10 || ends) {
    next.trail = [...next.trail, pos];
    next.trailT = [...next.trailT, t];
  }

  if (ends && leg.kind === 'out') {
    next = {
      ...next,
      leg: { kind: 'site', startT: t, duration: observationPlanned(next), path: [pos] },
      reached: { ...next.reached, B: t },
      clock: { t, speed: 1 }, // au point B l'horloge repasse en temps réel pour laisser le temps d'agir
    };
    next = addLog(next, 'CASQUE', `Arrivée au point B · marge ${marginNow(next, data)} min`);
  } else if (ends && leg.kind === 'back') {
    next = { ...next, phase: 'done', clock: { t, speed: 0 } };
    next = addLog(next, 'HABITAT', `Retour à l’habitat A · autonomie ${Math.round(s.params.autonomy - t)} min`);
  }

  const mNow = marginNow(next, data);
  next.minMargin = Math.min(next.minMargin, mNow);
  const lastM = next.marginHistory[next.marginHistory.length - 1];
  if (!lastM || lastM[1] !== mNow || t - lastM[0] >= 1) next.marginHistory = [...next.marginHistory, [t, mNow]];
  return next;
}

/**
 * Réducteur. `base` = données de référence ; le plan éventuel (B choisi sur la carte) est appliqué ici,
 * si bien que tous les appelants passent les mêmes données.
 */
export function reduce(s: MissionState, a: Action, base: MissionData): MissionState {
  const data = withPlan(base, s.plan);
  const reserve = s.params.reserve;
  const costs = planCosts(data);
  switch (a.type) {
    case 'SET_PARAMS': {
      if (s.phase !== 'prep') return s;
      const m = plannedMargin(a.params, costs);
      if (a.params.observation > s.params.observation && !isAllowed(m, a.params.reserve)) return s;
      return { ...s, params: a.params, retourMin: plannedDurations(costs, a.params.speedKmh).retour, minMargin: m };
    }

    case 'LAUNCH': {
      const m = plannedMargin(s.params, costs);
      if (s.phase !== 'prep' || !isAllowed(m, reserve)) return s;
      const { aller, retour } = plannedDurations(costs, s.params.speedKmh);
      const cum = data.route.map((v) => routeCostAt(data, distanceAlong(data.route, v)));
      const launched: MissionState = {
        ...initialState(s.params, data),
        phase: 'eva',
        clock: { t: 0, speed: 10 },
        leg: { kind: 'out', startT: 0, duration: aller, path: data.route, cum },
        retourMin: retour,
        reached: { A: 0 },
        trail: [data.route[0]],
        trailT: [0],
        marginHistory: [[0, m]],
        minMargin: m,
        plan: s.plan, // le B choisi reste celui de la sortie
      };
      return addLog(launched, 'HABITAT', `Départ de l’habitat A · marge ${m} min`);
    }

    case 'SET_CLOCK_SPEED':
      return s.phase === 'eva' ? { ...s, clock: { ...s.clock, speed: a.speed } } : s;

    case 'TICK':
      return tick(s, a.dt, data);

    case 'LOG': {
      if (s.phase !== 'eva') return s;
      // Les observations de la tablette sont géolocalisées à la position simulée
      const pos = a.source === 'TABLETTE' ? data.projection.toLonLat(positionOf(s, data).p) : undefined;
      const logged = { ...s, log: [...s.log, { t: s.clock.t, source: a.source, text: a.text, kind: a.kind, pos }] };
      return a.objective ? { ...logged, objectives: { ...logged.objectives, [a.objective]: true } } : logged;
    }

    case 'EXTEND_OBSERVATION': {
      const m = extensionMargin(s, data, a.minutes);
      if (!canExtend(s) || !isAllowed(m, reserve)) return s;
      const next = { ...s, observationExtra: s.observationExtra + a.minutes };
      return addLog(next, a.source, `Observation prolongée de ${a.minutes} min · marge ${m} min`);
    }

    case 'TRIGGER_INCIDENT': {
      if (s.phase !== 'eva' || s.leg?.kind !== 'out' || s.incident) return s;
      const scenario = data.scenarios[a.id];
      if (!scenario) return s;
      const next = { ...s, incident: { id: a.id } };
      return addLog(next, 'SYSTÈME', `Événement simulé : ${lowerFirst(scenario.title)}`);
    }

    case 'CHOOSE_OPTION': {
      if (!s.incident || s.incident.choice || s.leg?.kind !== 'out') return s;
      const opt = data.scenarios[s.incident.id]?.options.find((o) => o.id === a.optionId);
      if (!opt) return s;
      const m = optionMargin(s, data, opt);
      if (!isAllowed(m, reserve)) return s;
      const plan = optionPlan(s, data, opt);
      let next: MissionState = { ...s, incident: { ...s.incident, choice: opt.id } };
      if (plan.keepObservation) {
        next = { ...next, leg: { kind: 'out', startT: s.clock.t, duration: plan.allerRestant, path: plan.path }, retourMin: plan.retour };
      } else {
        next = startReturn(next, data, plan.retour);
      }
      return addLog(next, 'HABITAT', `Décision : ${lowerFirst(opt.label)} · marge ${m} min`);
    }

    case 'RETURN_NOW': {
      if (s.phase !== 'eva' || s.leg?.kind === 'back') return s;
      if (s.incident?.id === 'obstacle' && !s.incident.choice) return s; // décision de l'habitat attendue (options recalculées)
      const m = returnMargin(s, data);
      const text = s.leg?.kind === 'site' ? `Site terminé, retour vers A · marge ${m} min` : `Décision : retour à l’habitat · marge ${m} min`;
      return addLog(startReturn(s, data), a.source, text);
    }

    case 'SEND_HUD_MESSAGE':
      return addLog({ ...s, lastMessageToHud: a.text }, 'HABITAT', `Message au casque : « ${a.text} »`);

    case 'SET_PLAN': {
      if (s.phase !== 'prep') return s;
      const next = withPlan(base, a.plan);
      const m = plannedMargin(s.params, planCosts(next));
      if (!isAllowed(m, reserve)) return s; // refus : la marge passerait sous la réserve
      return { ...initialState(s.params, next), plan: a.plan };
    }

    case 'OBSTACLE': {
      if (s.phase !== 'eva' || s.leg?.kind !== 'out' || s.incident) return s;
      const lonlat = a.lonlat ?? data.projection.toLonLat(positionOf(s, data).p);
      const obstacle: Obstacle = { id: `obs-${s.obstacles.length + 1}`, lonlat, radiusM: OBSTACLE_RADIUS_M, t: s.clock.t, source: a.source };
      const next: MissionState = {
        ...s,
        obstacles: [...s.obstacles, obstacle],
        incident: { id: 'obstacle', resumeSpeed: s.clock.speed },
        clock: { ...s.clock, speed: 0 }, // pause : décision de l'habitat attendue
      };
      const who = a.source === 'TABLETTE' ? 'signalé par la tablette à la position actuelle' : 'placé par l’habitat';
      return { ...next, log: [...next.log, { t: s.clock.t, source: a.source, text: `Obstacle ${who} · rayon ${OBSTACLE_RADIUS_M} m bloqué`, kind: 'Obstacle', pos: lonlat }] };
    }

    case 'CHOOSE_OBSTACLE_OPTION': {
      if (s.incident?.id !== 'obstacle' || s.incident.choice || s.leg?.kind !== 'out') return s;
      const b = budgetOf(s, data);
      const keep = a.kind === 'continue';
      const m = Math.round(margin({ autonomy: b.autonomy, allerRestant: keep ? a.allerRestant : 0, observation: keep ? b.observation : 0, retour: a.retour }));
      if (!isAllowed(m, reserve)) return s;
      const path = a.path.map(data.projection.toLocal);
      let next: MissionState = { ...s, incident: { ...s.incident, choice: a.kind }, clock: { ...s.clock, speed: s.incident.resumeSpeed || 10 } };
      next = keep
        ? { ...next, leg: { kind: 'out', startT: s.clock.t, duration: a.allerRestant, path }, retourMin: a.retour, returnPath: a.returnPath ?? null }
        : startReturn(next, data, a.retour, path);
      return addLog(next, 'HABITAT', `Décision : ${keep ? 'contourner l’obstacle et poursuivre vers B' : 'rentrer à l’habitat en évitant l’obstacle'} · marge ${m} min`);
    }

    case 'RESET':
      return { ...initialState(s.params, data), plan: s.plan };
  }
}
