import type { SeatId } from "@kauda/rules";
import { create } from "zustand";
import { litAt, momentAt, reached, schedule, type Schedule, type Stage } from "./ceremony";
import { checkRound, type FairnessResult } from "./fairness";
import {
  parseReason,
  parseRound,
  parseTopUp,
  parseView,
  parseWelcome,
  type PlayerView,
  type RoundRecord,
  type TableView,
  type TopUpResult,
  type Welcome,
} from "./protocol";

/**
 * All room state, in one store. Only the socket adapter (table.ts) writes to
 * it, through `ingest`, with the raw messages it receives; components only
 * read. Every message is parsed on the way in (protocol.ts).
 *
 * NOT SPOILING THE THROW. The server sends a round's result the moment it
 * settles, but the 3D board then still has to play the throw. So when a
 * view reveals the round this page was waiting on, and a board that can
 * play it is on screen (setThrowAnimator), that view is HELD: `view` and
 * `rounds` keep showing the round before it (no result word, no count, no
 * chip changes, no log entry), and `held` carries the result for the board
 * to play. The board calls releaseThrow when the shells are at rest, and
 * everything held appears at once. A hold also ends if the server moves on
 * to the next round first, if the board goes away, or after MAX_HOLD_MS
 * whatever happens. Nothing is ever dropped: views that arrive meanwhile
 * replace the held one, and are shown on release.
 *
 * THE MOMENT AFTER (ceremony.ts). Once the shells rest, the result is shown
 * in steps: the count, the result, the chips, then the log. `view` is the
 * server's view from the moment the shells rest; `ceremony` says how far
 * the steps have got, and the table draws from it (the panels keep the
 * chips they had before the round until the tokens arrive). The round's
 * log entry (and so its fairness tick) is added only at the last step. A
 * page that was not watching (it joined, came back, or its tab is hidden)
 * gets the final state at once.
 */

export type Connection = "idle" | "connecting" | "connected" | "reconnecting" | "replaced" | "paused";

export const LOG_LIMIT = 50;

export interface Refusal {
  readonly reason: string;
  /** Increments per refusal, so the same reason twice still shows afresh. */
  readonly seq: number;
}

export interface TableState {
  readonly conn: Connection;
  readonly attempt: number;
  readonly tableId: string | null;
  readonly code: string | null;
  readonly shareUrl: string | null;
  readonly welcome: Welcome | null;
  readonly view: TableView | null;
  /** Settled rounds, newest first. */
  readonly rounds: readonly RoundRecord[];
  /** playerId -> name, from every view seen, so the log can name people who have left. */
  readonly names: Readonly<Record<string, string>>;
  /** roundId -> the commitHash this page saw before the reveal. */
  readonly published: Readonly<Record<string, string>>;
  /** roundId -> the browser's check of that round. Missing while it runs. */
  readonly fairness: Readonly<Record<string, FairnessResult>>;
  readonly refusal: Refusal | null;
  readonly topUp: TopUpResult | null;
  readonly pausedReason: string | null;
  /** A revealed round held back while the board plays its throw (see above). */
  readonly held: Held | null;
  /** The round I pressed Throw in, until it settles or the server refuses. */
  readonly pressed: string | null;
  /** The steps after the shells rest, while they play. */
  readonly ceremony: Ceremony | null;
  /** The chips that just changed: floats by the panels (or, under reduced motion, a brief highlight). */
  readonly changed: Changed | null;
}

export interface Ceremony {
  readonly round: RoundRecord;
  readonly sched: Schedule;
  /** Each player's chips (the server's) before the round: the panels show these until the tokens arrive. */
  readonly before: Readonly<Record<string, number>>;
  /** The table's ghanti, for the tokens. */
  readonly ghantiChips: number;
  readonly reduced: boolean;
  readonly counted: number;
  readonly stage: Stage;
  /** Round records for the log, added at the last step. */
  readonly queued: readonly RoundRecord[];
}

export interface Changed {
  readonly roundId: string;
  /** The server's deltas for the round. */
  readonly deltas: Readonly<Record<string, number>>;
  readonly reduced: boolean;
}

export type CeremonyEvent =
  | { readonly type: "count"; readonly roundId: string; readonly n: number }
  | { readonly type: "result" | "chips" | "arrive" | "done"; readonly roundId: string };

export interface Held {
  readonly roundId: string;
  /** The latest view, shown on release. */
  readonly view: TableView;
  /** Round records for the log, shown on release. */
  readonly rounds: readonly RoundRecord[];
}

export const initialTableState: TableState = {
  conn: "idle",
  attempt: 0,
  tableId: null,
  code: null,
  shareUrl: null,
  welcome: null,
  view: null,
  rounds: [],
  names: {},
  published: {},
  fairness: {},
  refusal: null,
  topUp: null,
  pausedReason: null,
  held: null,
  pressed: null,
  ceremony: null,
  changed: null,
};

export const useTable = create<TableState>()(() => initialTableState);

let refusals = 0;

/** The longest a result is ever held: the physics' wait, a gather, the longest throw, and a margin. */
export const MAX_HOLD_MS = 8_000;
let animator = false;
let holdTimer: ReturnType<typeof setTimeout> | null = null;

/** The 3D board, able to play a throw, is on screen (true) or gone (false). Gone ends any hold. */
export function setThrowAnimator(on: boolean): void {
  animator = on;
  if (!on) releaseHeld();
}

/** The board's shells for this round are at rest: the steps after begin. */
export function releaseThrow(roundId: string): void {
  if (useTable.getState().held?.roundId === roundId) releaseHeld(true);
}

/** I pressed Throw in this round: the board gathers the shells at once. */
export function pressThrow(roundId: string): void {
  useTable.setState({ pressed: roundId });
}

/**
 * Ends a hold. Released by the board (the shells are at rest), the steps
 * after begin; ended any other way (the server moved on, the board went,
 * the hold ran out), the page goes straight to the final state.
 */
function releaseHeld(atRest = false): void {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
  const s = useTable.getState();
  const held = s.held;
  if (held === null) return;
  useTable.setState({ held: null, pressed: null });
  const queued = held.view.lastRound === null ? held.rounds : [...held.rounds, held.view.lastRound];
  if (atRest) startCeremony(held.view, s.view, queued);
  else present(held.view, queued);
}

/** The final state at once: the view, and the rounds into the log. */
function present(view: TableView, rounds: readonly RoundRecord[]): void {
  useTable.setState({ view });
  for (const r of rounds) addRound(r);
}

// ---------------------------------------------------------- the moment after

let ceremonyTimers: ReturnType<typeof setTimeout>[] = [];
let changedTimer: ReturnType<typeof setTimeout> | null = null;
const ceremonyListeners = new Set<(e: CeremonyEvent) => void>();
/** How long the floats (or the reduced-motion highlight) stay after the chips change. */
export const CHANGED_MS = 1_600;

/** Hooks for sound (no audio yet): one event per counted shell, and one per step. */
export function subscribeCeremony(listener: (e: CeremonyEvent) => void): () => void {
  ceremonyListeners.add(listener);
  return () => void ceremonyListeners.delete(listener);
}
const emit = (e: CeremonyEvent) => ceremonyListeners.forEach((l) => l(e));

function clearCeremonyTimers(): void {
  for (const t of ceremonyTimers) clearTimeout(t);
  ceremonyTimers = [];
}

const prefersReducedMotion = (): boolean =>
  typeof window === "undefined" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true);

function chipsOf(view: TableView | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (view === null) return out;
  for (const p of [...Object.values(view.seats), ...view.chyakhe]) if (p !== null) out[p.playerId] = p.chips;
  return out;
}

/** The shells are at rest: count, result, chips, log, in that order. */
function startCeremony(view: TableView, before: TableView | null, queued: readonly RoundRecord[]): void {
  finishCeremony();
  const round = view.lastRound;
  if (round === null || documentHidden()) {
    present(view, queued);
    return;
  }
  const reduced = prefersReducedMotion();
  const sched = schedule(round.faceUp, Date.now(), reduced);
  const ceremony: Ceremony = {
    round,
    sched,
    before: chipsOf(before),
    ghantiChips: view.rules.ghantiChips,
    reduced,
    queued,
    // From the very beginning, so every step is crossed (and announced) even when they all come at once.
    counted: 0,
    stage: "count",
  };
  useTable.setState({ view, ceremony });
  const at = (when: number, run: () => void) => ceremonyTimers.push(setTimeout(run, Math.max(0, when - Date.now())));
  for (let n = 2; n <= round.faceUp && !reduced; n += 1) at(litAt(sched, n), advanceCeremony);
  for (const when of new Set([sched.resultAt, sched.chipsAt, sched.arriveAt, sched.logAt])) at(when, advanceCeremony);
  advanceCeremony();
}

/** Moves the steps on to where the clock says they are. */
function advanceCeremony(): void {
  const c = useTable.getState().ceremony;
  if (c === null) return;
  const m = momentAt(c.sched, Date.now());
  const roundId = c.round.roundId;
  for (let n = c.counted + 1; n <= m.counted; n += 1) emit({ type: "count", roundId, n });
  if (m.stage !== c.stage) {
    if (reached(m, "result") && !reached(c, "result")) emit({ type: "result", roundId });
    if (reached(m, "chips") && !reached(c, "chips")) emit({ type: "chips", roundId });
    if (reached(m, "arrived") && !reached(c, "arrived")) {
      emit({ type: "arrive", roundId });
      showChanged(roundId, c.round.deltas, c.reduced);
    }
  }
  if (m.stage === "done") {
    finishCeremony();
    emit({ type: "done", roundId });
    return;
  }
  if (m.counted !== c.counted || m.stage !== c.stage) useTable.setState({ ceremony: { ...c, ...m } });
}

function showChanged(roundId: string, deltas: Readonly<Record<string, number>>, reduced: boolean): void {
  if (changedTimer !== null) clearTimeout(changedTimer);
  useTable.setState({ changed: { roundId, deltas, reduced } });
  changedTimer = setTimeout(() => useTable.setState({ changed: null }), CHANGED_MS);
}

/** Straight to the final state: the steps that remain, at once. */
export function finishCeremony(): void {
  clearCeremonyTimers();
  const c = useTable.getState().ceremony;
  if (c === null) return;
  useTable.setState({ ceremony: null });
  for (const r of c.queued) addRound(r);
}

/**
 * For the visual baselines only: shows the steps as they are `elapsedMs`
 * after the shells rest, and holds them there.
 */
export function freezeCeremony(elapsedMs: number): void {
  clearCeremonyTimers();
  const c = useTable.getState().ceremony;
  if (c === null) return;
  useTable.setState({ ceremony: { ...c, ...momentAt(c.sched, c.sched.start + elapsedMs) } });
}

if (typeof document !== "undefined") {
  // A hidden tab skips to the final state.
  document.addEventListener("visibilitychange", () => {
    if (documentHidden()) finishCeremony();
  });
}

/**
 * Does this view reveal the round the page was waiting on? Only then is
 * there a throw to play: a page that arrives after the throw shows the
 * result at once.
 */
function revealsAwaited(shown: TableView | null, next: TableView): boolean {
  const r = next.lastRound;
  if (r === null || shown === null || next.phase !== "revealing") return false;
  if (shown.lastRound?.roundId === r.roundId) return false;
  return shown.roundId === r.roundId && (shown.phase === "throwing" || shown.phase === "betting");
}

function addRound(round: RoundRecord): void {
  const s = useTable.getState();
  if (s.rounds.some((r) => r.roundId === round.roundId)) return;
  useTable.setState({ rounds: [round, ...s.rounds].slice(0, LOG_LIMIT) });
  const published = s.published[round.roundId];
  void checkRound(round, published).then((result) => {
    useTable.setState((now) => ({ fairness: { ...now.fairness, [round.roundId]: result } }));
  });
}

/** The adapter's only way in: one raw message from the room. */
export function ingest(type: string, payload: unknown): void {
  switch (type) {
    case "welcome": {
      const welcome = parseWelcome(payload);
      if (welcome !== null) useTable.setState({ welcome });
      return;
    }
    case "view": {
      const view = parseView(payload);
      if (view === null) return;
      const s = useTable.getState();
      const names = { ...s.names };
      for (const p of [...Object.values(view.seats), ...view.chyakhe]) if (p !== null) names[p.playerId] = p.name;
      const published =
        view.roundId !== null && view.commitHash !== null && s.published[view.roundId] === undefined
          ? { ...s.published, [view.roundId]: view.commitHash }
          : s.published;
      useTable.setState({ names, published });
      // The server has moved on from a round whose steps are still playing: the final state, at once.
      if (s.ceremony !== null && (view.phase !== "revealing" || view.lastRound?.roundId !== s.ceremony.round.roundId)) finishCeremony();
      const held = s.held;
      if (held !== null) {
        // Still the same reveal: keep holding the newest view. The server has
        // moved on to the next round: stop holding, the board skips to rest.
        useTable.setState({ held: { ...held, view } });
        if (view.phase !== "revealing" || view.lastRound?.roundId !== held.roundId) releaseHeld();
        return;
      }
      const pressed = s.pressed !== null && s.pressed !== view.roundId ? null : s.pressed;
      if (animator && !documentHidden() && revealsAwaited(s.view, view) && view.lastRound !== null) {
        // A second result while the first's steps play: finish those at once.
        finishCeremony();
        useTable.setState({ held: { roundId: view.lastRound.roundId, view, rounds: [] }, pressed });
        holdTimer = setTimeout(() => releaseHeld(), MAX_HOLD_MS);
        return;
      }
      useTable.setState({ pressed: view.phase === "revealing" ? null : pressed });
      // No board playing the throw (the 2D board), but this page saw the round played: the steps begin now.
      if (!documentHidden() && revealsAwaited(s.view, view) && view.lastRound !== null && s.ceremony === null) {
        startCeremony(view, s.view, [view.lastRound]);
        return;
      }
      const c = useTable.getState().ceremony;
      if (c !== null && view.lastRound?.roundId === c.round.roundId) {
        // The same round's view again while its steps play: keep it, the log entry waits.
        useTable.setState({ view });
        return;
      }
      present(view, view.lastRound === null ? [] : [view.lastRound]);
      return;
    }
    case "round": {
      const round = parseRound(payload);
      if (round === null) return;
      const { held, ceremony } = useTable.getState();
      if (held !== null && held.roundId === round.roundId) useTable.setState({ held: { ...held, rounds: [...held.rounds, round] } });
      else if (ceremony !== null && ceremony.round.roundId === round.roundId) useTable.setState({ ceremony: { ...ceremony, queued: [...ceremony.queued, round] } });
      else addRound(round);
      return;
    }
    case "error":
      refusals += 1;
      // Refused: a press that started the gather is undone.
      useTable.setState({ refusal: { reason: parseReason(payload), seq: refusals }, pressed: null });
      return;
    case "topUp": {
      const topUp = parseTopUp(payload);
      if (topUp !== null) useTable.setState({ topUp });
      return;
    }
    case "paused": {
      const reason = typeof payload === "object" && payload !== null ? (payload as { reason?: unknown }).reason : undefined;
      useTable.setState({ conn: "paused", pausedReason: parseReason(reason) });
      return;
    }
  }
}

const documentHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

/** For tests: forget the board, any hold, and any steps in play. */
export function resetThrowHold(): void {
  animator = false;
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
  clearCeremonyTimers();
  if (changedTimer !== null) clearTimeout(changedTimer);
  changedTimer = null;
  ceremonyListeners.clear();
}

export function clearRefusal(): void {
  useTable.setState({ refusal: null });
}

// ------------------------------------------------------------- selectors

/** My seat, if I am seated. */
export function mySeatIn(view: TableView | null, me: string | null): SeatId | null {
  if (view === null || me === null) return null;
  for (const [seat, p] of Object.entries(view.seats) as [SeatId, PlayerView | null][]) if (p?.playerId === me) return seat;
  return null;
}

export function myPlayerIn(view: TableView | null, me: string | null): PlayerView | null {
  if (view === null || me === null) return null;
  for (const p of Object.values(view.seats)) if (p?.playerId === me) return p;
  return view.chyakhe.find((p) => p.playerId === me) ?? null;
}

export function myReservationIn(view: TableView | null, me: string | null): SeatId | null {
  return view?.reservations.find((r) => r.playerId === me)?.seat ?? null;
}

export function myBetIn(view: TableView | null, me: string | null) {
  return view?.bets.find((b) => b.playerId === me) ?? null;
}
