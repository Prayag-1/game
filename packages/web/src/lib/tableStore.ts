import type { SeatId } from "@kauda/rules";
import { create } from "zustand";
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
};

export const useTable = create<TableState>()(() => initialTableState);

let refusals = 0;

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
      useTable.setState({ view, names, published });
      if (view.lastRound !== null) addRound(view.lastRound);
      return;
    }
    case "round": {
      const round = parseRound(payload);
      if (round !== null) addRound(round);
      return;
    }
    case "error":
      refusals += 1;
      useTable.setState({ refusal: { reason: parseReason(payload), seq: refusals } });
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
