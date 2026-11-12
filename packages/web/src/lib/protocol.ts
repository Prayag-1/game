import { TURN_ORDER, type SeatId } from "@kauda/rules";

/**
 * What the room sends (packages/server/src/room.ts), as the client sees it.
 * Every message is untrusted: each is parsed here, and anything that does
 * not fit is dropped rather than half-used. Strings are only ever rendered
 * as text.
 */

export type Phase = "waiting" | "betting" | "throwing" | "revealing";

export interface PlayerView {
  readonly playerId: string;
  readonly name: string;
  readonly isBot: boolean;
  readonly connected: boolean;
  readonly chips: number;
}

export interface BetView {
  readonly playerId: string;
  readonly seat: SeatId;
  readonly chips: number;
}

export interface Rules {
  readonly thini: number;
  readonly doubling: boolean;
  readonly maxStakeMultiplier: number;
  readonly ghantiChips: number;
  readonly chyakheEnabled: boolean;
  readonly maxChyakhe: number;
}

export interface RoundRecord {
  readonly roundId: string;
  readonly seed: string;
  readonly commitHash: string;
  readonly faces: readonly boolean[];
  readonly faceUp: number;
  readonly winningSeat: SeatId;
  readonly hit: boolean;
  readonly stake: number;
  readonly multiplier: number;
  readonly deltas: Readonly<Record<string, number>>;
  readonly at: number;
  readonly thrower: SeatId;
  readonly streak: number;
  readonly occupants: Readonly<Partial<Record<SeatId, string>>>;
  /** The outside bets that settled in this round. */
  readonly chyakhe: readonly BetView[];
}

export interface TableView {
  readonly tableId: string;
  readonly phase: Phase;
  readonly roundId: string | null;
  readonly thrower: SeatId | null;
  readonly streak: number;
  readonly stake: number;
  readonly commitHash: string | null;
  readonly seats: Readonly<Record<SeatId, PlayerView | null>>;
  readonly chyakhe: readonly PlayerView[];
  readonly bets: readonly BetView[];
  readonly phaseEndsAt: number | null;
  readonly reservations: readonly { readonly seat: SeatId; readonly playerId: string }[];
  readonly lastRound: RoundRecord | null;
  readonly rules: Rules;
}

export interface Welcome {
  readonly playerId: string;
  readonly name: string;
  readonly minChipsToSit: number;
  readonly standardBuyIn: number;
}

export type TopUpResult =
  | { readonly ok: true; readonly chips: number }
  | { readonly ok: false; readonly reason: string; readonly availableAt: number | null };

/** The commands a client may send (packages/server/src/commands.ts). */
export type Command =
  | { readonly type: "sit"; readonly seat: SeatId }
  | { readonly type: "stand" }
  | { readonly type: "placeBet"; readonly seat: SeatId; readonly chips: number }
  | { readonly type: "clearBet" }
  | { readonly type: "throw" }
  | { readonly type: "leave" };

// ------------------------------------------------------------------ parsing

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
export const isSeat = (v: unknown): v is SeatId => typeof v === "string" && (TURN_ORDER as readonly string[]).includes(v);
const PHASES: readonly string[] = ["waiting", "betting", "throwing", "revealing"];
const HEX64 = /^[0-9a-f]{64}$/;

function list<T>(v: unknown, parse: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const p = parse(x);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

function parsePlayer(v: unknown): PlayerView | null {
  if (!isObj(v) || !isStr(v.playerId) || !isStr(v.name) || !isBool(v.isBot) || !isBool(v.connected) || !isInt(v.chips)) return null;
  return { playerId: v.playerId, name: v.name, isBot: v.isBot, connected: v.connected, chips: v.chips };
}

function parseBet(v: unknown): BetView | null {
  if (!isObj(v) || !isStr(v.playerId) || !isSeat(v.seat) || !isInt(v.chips)) return null;
  return { playerId: v.playerId, seat: v.seat, chips: v.chips };
}

function parseRules(v: unknown): Rules | null {
  if (!isObj(v)) return null;
  const { thini, doubling, maxStakeMultiplier, ghantiChips, chyakheEnabled, maxChyakhe } = v;
  if (!isInt(thini) || thini < 1 || !isBool(doubling) || !isInt(maxStakeMultiplier) || !isInt(ghantiChips)) return null;
  if (!isBool(chyakheEnabled) || !isInt(maxChyakhe)) return null;
  return { thini, doubling, maxStakeMultiplier, ghantiChips, chyakheEnabled, maxChyakhe };
}

export function parseRound(v: unknown): RoundRecord | null {
  if (!isObj(v)) return null;
  const { roundId, seed, commitHash, faces, faceUp, winningSeat, hit, stake, multiplier, deltas, at, thrower, streak, occupants } = v;
  if (!isStr(roundId) || !isStr(seed) || !isStr(commitHash) || !HEX64.test(commitHash)) return null;
  const shells = list(faces, (f) => (isBool(f) ? f : null));
  if (shells === null || shells.length !== 16) return null;
  if (!isInt(faceUp) || !isSeat(winningSeat) || !isBool(hit) || !isInt(stake) || !isInt(multiplier) || !isInt(at) || !isSeat(thrower) || !isInt(streak)) return null;
  const bets = list(v.chyakhe, parseBet);
  if (bets === null) return null;
  if (!isObj(deltas) || !Object.values(deltas).every(isInt)) return null;
  if (!isObj(occupants)) return null;
  const seats: Partial<Record<SeatId, string>> = {};
  for (const [seat, id] of Object.entries(occupants)) {
    if (!isSeat(seat) || !isStr(id)) return null;
    seats[seat] = id;
  }
  return {
    roundId,
    seed,
    commitHash,
    faces: shells,
    faceUp,
    winningSeat,
    hit,
    stake,
    multiplier,
    deltas: deltas as Record<string, number>,
    at,
    thrower,
    streak,
    occupants: seats,
    chyakhe: bets,
  };
}

export function parseView(v: unknown): TableView | null {
  if (!isObj(v) || !isStr(v.tableId) || !isStr(v.phase) || !PHASES.includes(v.phase)) return null;
  const { roundId, thrower, streak, stake, commitHash, phaseEndsAt } = v;
  if (!(roundId === null || isStr(roundId)) || !(thrower === null || isSeat(thrower))) return null;
  if (!isInt(streak) || !isInt(stake) || !(commitHash === null || (isStr(commitHash) && HEX64.test(commitHash)))) return null;
  if (!(phaseEndsAt === null || isInt(phaseEndsAt))) return null;
  if (!isObj(v.seats)) return null;
  const seats = {} as Record<SeatId, PlayerView | null>;
  for (const seat of TURN_ORDER) {
    const p = v.seats[seat];
    if (p === null || p === undefined) seats[seat] = null;
    else {
      const parsed = parsePlayer(p);
      if (parsed === null) return null;
      seats[seat] = parsed;
    }
  }
  const chyakhe = list(v.chyakhe, parsePlayer);
  const bets = list(v.bets, parseBet);
  const reservations = list(v.reservations, (r) => (isObj(r) && isSeat(r.seat) && isStr(r.playerId) ? { seat: r.seat, playerId: r.playerId } : null));
  const rules = parseRules(v.rules);
  const lastRound = v.lastRound === null ? null : parseRound(v.lastRound);
  if (chyakhe === null || bets === null || reservations === null || rules === null) return null;
  if (v.lastRound !== null && lastRound === null) return null;
  return {
    tableId: v.tableId,
    phase: v.phase as Phase,
    roundId,
    thrower,
    streak,
    stake,
    commitHash,
    seats,
    chyakhe,
    bets,
    phaseEndsAt,
    reservations,
    lastRound,
    rules,
  };
}

export function parseWelcome(v: unknown): Welcome | null {
  if (!isObj(v) || !isStr(v.playerId) || !isStr(v.name) || !isInt(v.minChipsToSit) || !isInt(v.standardBuyIn)) return null;
  return { playerId: v.playerId, name: v.name, minChipsToSit: v.minChipsToSit, standardBuyIn: v.standardBuyIn };
}

export function parseTopUp(v: unknown): TopUpResult | null {
  if (!isObj(v) || !isBool(v.ok)) return null;
  if (v.ok) return isInt(v.chips) ? { ok: true, chips: v.chips } : null;
  if (!isStr(v.reason) || !(v.availableAt === null || v.availableAt === undefined || isInt(v.availableAt))) return null;
  return { ok: false, reason: v.reason, availableAt: isInt(v.availableAt) ? v.availableAt : null };
}

/** A refusal reason from the server: a short code, or nothing. */
export function parseReason(v: unknown): string {
  return isStr(v) && /^[a-z0-9-]{1,40}$/.test(v) ? v : "unknown";
}
