import { TURN_ORDER, type SeatId } from "@kauda/rules";
import type { RoundRecord } from "./protocol";

/**
 * THE MOMENT AFTER THE SHELLS LAND: the count, the result, the chips moving,
 * then the log. Pure: a schedule from the number of face-up shells, what is
 * showing at any moment of it, and who pays whom. The store plays it
 * (tableStore.ts); the table, the seats and the board draw it.
 *
 *   rest     the shells are still (the board says so)
 *   count    face-up shells light one by one, near to far, a running number
 *            beside the result area: COUNT.perShellMs each, faster when
 *            many are up, never more than COUNT.maxMs in all; with none up,
 *            a brief "0" beat
 *   result   straight after the count: the winning seat, the count, the
 *            hit or miss word, and the board's edge lit for it
 *   chips    resultBeatMs later, tokens travel between the panels
 *            (travelMs); as they arrive, "+30" or "-10" floats by each
 *            panel and its chips tick to the new value (tickMs)
 *   log      chipsMs after the chips began: the round-log entry and its
 *            fairness tick
 *
 * Nothing in it is ever computed for the game: the numbers shown are the
 * server's deltas, and chips only ever tick from the server's balance before
 * the round to the server's balance after it.
 */

export const COUNT = {
  perShellMs: 250,
  maxMs: 2000,
  zeroBeatMs: 450,
  resultBeatMs: 400,
  travelMs: 650,
  /** Travel and tick end 50 ms before the log appears, so the steps never overlap. */
  tickMs: 300,
  chipsMs: 1000,
} as const;

export interface Schedule {
  readonly start: number;
  readonly faceUp: number;
  /** Between one shell lighting and the next. */
  readonly interval: number;
  readonly resultAt: number;
  readonly chipsAt: number;
  /** The tokens arrive: the floats appear and the chips start to tick. */
  readonly arriveAt: number;
  readonly logAt: number;
}

/** The whole sequence, from the moment the shells rest. Under reduced motion it all happens at once. */
export function schedule(faceUp: number, start: number, reduced = false): Schedule {
  if (reduced) return { start, faceUp, interval: 0, resultAt: start, chipsAt: start, arriveAt: start, logAt: start };
  const interval = faceUp === 0 ? 0 : Math.min(COUNT.perShellMs, COUNT.maxMs / faceUp);
  const resultAt = start + (faceUp === 0 ? COUNT.zeroBeatMs : faceUp * interval);
  const chipsAt = resultAt + COUNT.resultBeatMs;
  return { start, faceUp, interval, resultAt, chipsAt, arriveAt: chipsAt + COUNT.travelMs, logAt: chipsAt + COUNT.chipsMs };
}

/** When the n-th face-up shell lights (n from 1). */
export const litAt = (s: Schedule, n: number): number => s.start + (n - 1) * s.interval;

export type Stage = "count" | "result" | "chips" | "arrived" | "done";

export interface Moment {
  /** Face-up shells lit, and the running number. */
  readonly counted: number;
  readonly stage: Stage;
}

/** What is showing at `now`. */
export function momentAt(s: Schedule, now: number): Moment {
  let counted = 0;
  if (s.faceUp > 0 && now >= s.start) counted = s.interval === 0 ? s.faceUp : Math.min(s.faceUp, Math.floor((now - s.start) / s.interval) + 1);
  const stage: Stage = now >= s.logAt ? "done" : now >= s.arriveAt ? "arrived" : now >= s.chipsAt ? "chips" : now >= s.resultAt ? "result" : "count";
  return { counted, stage };
}

const ORDER: readonly Stage[] = ["count", "result", "chips", "arrived", "done"];
/** Has the sequence reached `stage`? */
export const reached = (m: { readonly stage: Stage }, stage: Stage): boolean => ORDER.indexOf(m.stage) >= ORDER.indexOf(stage);

/**
 * A panel's chips at `now`: the server's balance before the round until the
 * tokens arrive, then ticking over tickMs to the server's balance after it.
 * Whole chips only.
 */
export function chipsAt(before: number, after: number, s: Schedule, now: number): number {
  if (now < s.arriveAt) return before;
  // Under reduced motion (everything at the start) the new value shows at once.
  const k = s.arriveAt === s.start ? 1 : Math.min(1, (now - s.arriveAt) / COUNT.tickMs);
  return k >= 1 ? after : Math.round(before + (after - before) * k);
}

// ------------------------------------------------------------ the result

export type Highlight = { readonly kind: "hit"; readonly seat: SeatId } | { readonly kind: "win"; readonly seat: SeatId } | { readonly kind: "push"; readonly seat: null };

/**
 * Where the eye should go. A hit: the thrower's side (they collect). A miss:
 * the winning seat's side (they are paid). A push (nobody sits on the
 * winning seat): nowhere.
 */
export function highlightOf(round: RoundRecord): Highlight {
  if (round.hit) return { kind: "hit", seat: round.thrower };
  if (round.occupants[round.winningSeat] === undefined) return { kind: "push", seat: null };
  return { kind: "win", seat: round.winningSeat };
}

// ------------------------------------------------------------- the chips

/** Where a token starts or ends: a seat's panel, or an outside bet's token at the board's edge. */
export type Spot = { readonly seat: SeatId } | { readonly bet: string; readonly seat: SeatId };

export interface Transfer {
  /** A stake, an outside bet, the ghanti, or a bet that simply goes back to its bettor. */
  readonly kind: "stake" | "bet" | "ghanti" | "return";
  readonly from: Spot;
  readonly to: Spot;
}

/**
 * Who pays whom in a settled round, for the tokens. The shape of the
 * settlement (packages/rules settlement.ts) read off the server's round
 * record; it carries no amounts, and the numbers shown are always the
 * server's deltas.
 *
 * Hit: every other seated player pays the thrower; every outside bet goes
 * to the thrower; on the first hit of a turn the thrower pays the ghanti to
 * the other seats. Miss: the thrower pays the winning seat, and pays out
 * the bets on it; the other bets go back. Push: nothing moves, the bets go
 * back.
 */
export function transfers(round: RoundRecord, ghantiChips: number): Transfer[] {
  const out: Transfer[] = [];
  const thrower: Spot = { seat: round.thrower };
  const others = TURN_ORDER.filter((s) => s !== round.thrower && round.occupants[s] !== undefined);
  const bet = (b: RoundRecord["chyakhe"][number]): Spot => ({ bet: b.playerId, seat: b.seat });
  if (round.hit) {
    for (const seat of others) out.push({ kind: "stake", from: { seat }, to: thrower });
    for (const b of round.chyakhe) out.push({ kind: "bet", from: bet(b), to: thrower });
    if (round.streak === 0 && ghantiChips > 0) for (const seat of others) out.push({ kind: "ghanti", from: thrower, to: { seat } });
    return out;
  }
  const paid = round.occupants[round.winningSeat] !== undefined;
  if (paid) out.push({ kind: "stake", from: thrower, to: { seat: round.winningSeat } });
  for (const b of round.chyakhe) {
    if (paid && b.seat === round.winningSeat) out.push({ kind: "bet", from: thrower, to: bet(b) });
    else out.push({ kind: "return", from: bet(b), to: bet(b) });
  }
  return out;
}
