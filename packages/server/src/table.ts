import { randomInt } from "node:crypto";
import {
  DEFAULT_HOUSE_RULES,
  TURN_ORDER,
  facesForCount,
  isChipAmount,
  nextSeat,
  settleRound,
  stakeMultiplier,
  validateHouseRules,
  type ChyakheBet,
  type HouseRules,
  type SeatId,
  type ShellFace,
} from "@kauda/rules";
import { chooseChyakheBet } from "./bots.js";
import { isValidPlayerId, parseCommand, type Command } from "./commands.js";
import {
  cryptoCommitment,
  facesFromSeed,
  parseSeed,
  sha256Hex,
  type Commitment,
  type CommitmentFactory,
} from "./fairness.js";
import { Ledger, MINT_ACCOUNT, type IssueReason, type NewLedgerEntry } from "./ledger.js";
import { botSeatFilling, type SeatFillPolicy } from "./seating.js";
import {
  DEFAULT_TOP_UP_COOLDOWN_MS,
  claimTopUp,
  topUpOffer,
  type TopUpOffer,
  type TopUpPolicy,
} from "./topup.js";

/**
 * One Kauda table as a pure state machine.
 *
 * No sockets, timers or database. Time comes in through the injected now()
 * and the tick() method, randomness through the injected commitment factory
 * and bot random source, so a whole session replays exactly from its inputs.
 * The Colyseus room wraps this: it forwards commands, calls tick() on a timer
 * and broadcasts view().
 *
 *   waiting -> betting -> throwing -> revealing -> betting -> ...
 *
 * Every phase change happens inside tick(). Commands never advance the phase
 * on their own, except a throw, which settles the round at once.
 */

export type Phase = "waiting" | "betting" | "throwing" | "revealing";

export interface Timings {
  readonly bettingMs: number;
  readonly throwingMs: number;
  readonly revealMs: number;
  /** How long a seated bot waits before throwing. */
  readonly botThrowDelayMs: number;
  /** How long into betting a chyakhe bot waits before deciding. */
  readonly botBetDelayMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  bettingMs: 8_000,
  throwingMs: 10_000,
  revealMs: 4_500,
  botThrowDelayMs: 1_200,
  botBetDelayMs: 1_500,
};

/** Four inside seats plus up to eight outside bettors. */
export const MAX_PLAYERS = 12;

/**
 * At most this many players are ever unseated. Seats are capacity held back
 * for whoever sits, so a bot can always be found room to fill an empty seat:
 * with 9 unseated and one seat empty, a full table of 12 could not seat a bot.
 */
export const MAX_UNSEATED = MAX_PLAYERS - TURN_ORDER.length;

export interface TableOptions {
  readonly tableId: string;
  readonly rules?: HouseRules;
  /** Balance needed to take a seat. Defaults to a full-cap stake. */
  readonly minChipsToSit?: number;
  /**
   * The standard buy-in: what a fresh bot brings and what a human top-up
   * restores. Defaults to defaultBotBuyIn(rules). At least minChipsToSit.
   */
  readonly standardBuyIn?: number;
  /** Time between top-up claims on one account. See topup.ts. */
  readonly topUpCooldownMs?: number;
  /**
   * A reservation still unhonoured after this many rounds have opened
   * without it is dropped, and a bot may then take the seat.
   */
  readonly reservationMaxRounds?: number;
  /** Likewise, once it is this old. Whichever limit comes first wins. */
  readonly reservationMaxMs?: number;
  readonly timings?: Partial<Timings>;
}

export const DEFAULT_RESERVATION_MAX_ROUNDS = 2;
export const DEFAULT_RESERVATION_MAX_MS = 60_000;

export interface TableDeps {
  readonly now: () => number;
  readonly commitments?: CommitmentFactory;
  /** Bot decisions only. Returns [0, 1). Defaults to a crypto source. */
  readonly botRandom?: () => number;
  readonly ledger?: Ledger;
  /**
   * Keeps the four seats filled with bots (see seating.ts). Omit for the
   * standard policy; pass null to turn seat filling off.
   */
  readonly seatFilling?: SeatFillPolicy | null;
}

/** Default buy-in for a fresh bot: 25 full-cap stakes. */
export function defaultBotBuyIn(rules: HouseRules): number {
  return 25 * rules.thini * rules.maxStakeMultiplier;
}

export type RejectReason =
  | "malformed"
  | "not-at-table"
  | "table-full"
  | "wrong-phase"
  | "already-seated"
  | "seat-taken"
  | "insufficient-chips"
  | "not-seated"
  | "seated-cannot-bet"
  | "chyakhe-disabled"
  | "thrower-seat"
  | "empty-seat"
  | "too-many-chyakhe"
  | "thrower-cannot-cover"
  | "no-bet"
  | "not-thrower";

export type CommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RejectReason };

/** A top-up offer or claim at this table. */
export type TableTopUpResult =
  | TopUpOffer
  | { readonly ok: false; readonly reason: "not-at-table" | "not-human"; readonly availableAt: null };

/** Everything needed to check and replay one settled round. */
export interface RoundRecord {
  readonly roundId: string;
  readonly seed: string;
  readonly commitHash: string;
  readonly faces: readonly ShellFace[];
  readonly faceUp: number;
  readonly winningSeat: SeatId;
  readonly hit: boolean;
  readonly stake: number;
  readonly multiplier: number;
  readonly deltas: Readonly<Record<string, number>>;
  readonly at: number;
  // Inputs to settlement, so replay() needs nothing else.
  readonly thrower: SeatId;
  readonly streak: number;
  readonly occupants: Readonly<Partial<Record<SeatId, string>>>;
  readonly chyakhe: readonly ChyakheBet[];
  readonly rules: HouseRules;
}

export interface ReplayResult {
  readonly commitmentMatches: boolean;
  readonly faces: readonly ShellFace[];
  readonly faceUp: number;
  readonly winningSeat: SeatId;
  readonly hit: boolean;
  readonly stake: number;
  readonly multiplier: number;
  readonly deltas: Readonly<Record<string, number>>;
}

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

/** What clients see. Built field by field, so the pending seed cannot leak in. */
export interface TableView {
  readonly tableId: string;
  readonly phase: Phase;
  readonly roundId: string | null;
  readonly thrower: SeatId | null;
  readonly streak: number;
  readonly stake: number;
  /** sha256 of the pending seed. Null outside betting and throwing. */
  readonly commitHash: string | null;
  readonly seats: Readonly<Record<SeatId, PlayerView | null>>;
  readonly chyakhe: readonly PlayerView[];
  readonly bets: readonly BetView[];
  readonly phaseEndsAt: number | null;
  /** Seats humans have asked for mid-round. A bot is never given one of these. */
  readonly reservations: readonly { readonly seat: SeatId; readonly playerId: string }[];
  /** The last settled round, seed included. */
  readonly lastRound: RoundRecord | null;
  readonly rules: HouseRules;
}

interface PlayerState {
  readonly id: string;
  readonly name: string;
  readonly isBot: boolean;
  connected: boolean;
  /** Asked to leave mid-round. Removed once the round settles. */
  leaving: boolean;
}

interface Reservation {
  readonly playerId: string;
  /** #roundNo when it was made. */
  readonly roundNo: number;
  readonly at: number;
}

interface Bet {
  readonly seat: SeatId;
  readonly chips: number;
}

interface OpenRound {
  readonly id: string;
  readonly commitment: Commitment;
}

const OK: CommandResult = { ok: true };
const reject = (reason: RejectReason): CommandResult => ({ ok: false, reason });

const cryptoUnit = (): number => randomInt(0, 2 ** 32) / 2 ** 32;

/** One face layout per winning seat: 0 chauka, 1 panja, 2 chakka, 3 teeya. */
const ONE_THROW_PER_SEAT: readonly (readonly ShellFace[])[] = [0, 1, 2, 3].map((k) => facesForCount(k));

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export class Table {
  readonly tableId: string;
  readonly rules: HouseRules;
  readonly minChipsToSit: number;
  readonly standardBuyIn: number;
  readonly topUpCooldownMs: number;
  readonly reservationMaxRounds: number;
  readonly reservationMaxMs: number;
  readonly timings: Timings;
  readonly ledger: Ledger;

  readonly #now: () => number;
  readonly #commitments: CommitmentFactory;
  readonly #botRandom: () => number;
  readonly #seatFilling: SeatFillPolicy | null;

  #phase: Phase = "waiting";
  #phaseStartedAt = 0;
  #phaseEndsAt: number | null = null;
  #roundNo = 0;
  #round: OpenRound | null = null;

  #thrower: SeatId | null = null;
  #throwerPlayer: string | null = null;
  #streak = 0;

  readonly #seats: Partial<Record<SeatId, string>> = {};
  readonly #players = new Map<string, PlayerState>();
  /** One bet per chyakhe, in the order placed. */
  readonly #bets = new Map<string, Bet>();
  readonly #botsDecided = new Set<string>();
  readonly #records: RoundRecord[] = [];
  /** Seat -> human waiting to take it at the next round. At most one per human. */
  readonly #reservations: Partial<Record<SeatId, Reservation>> = {};

  constructor(options: TableOptions, deps: TableDeps) {
    if (!isValidPlayerId(options.tableId)) throw new RangeError("tableId must be a short non-empty string");
    const rules = options.rules ?? DEFAULT_HOUSE_RULES;
    validateHouseRules(rules);
    const minChipsToSit = options.minChipsToSit ?? rules.thini * rules.maxStakeMultiplier;
    if (!isChipAmount(minChipsToSit, 0)) throw new RangeError("minChipsToSit must be a whole number of chips");
    const standardBuyIn = options.standardBuyIn ?? defaultBotBuyIn(rules);
    if (!isChipAmount(standardBuyIn, 1) || standardBuyIn < minChipsToSit) {
      throw new RangeError("standardBuyIn must be a whole number of chips, at least minChipsToSit");
    }
    const topUpCooldownMs = options.topUpCooldownMs ?? DEFAULT_TOP_UP_COOLDOWN_MS;
    const reservationMaxRounds = options.reservationMaxRounds ?? DEFAULT_RESERVATION_MAX_ROUNDS;
    const reservationMaxMs = options.reservationMaxMs ?? DEFAULT_RESERVATION_MAX_MS;
    if (!Number.isSafeInteger(topUpCooldownMs) || topUpCooldownMs < 0) {
      throw new RangeError("topUpCooldownMs must be a non-negative integer");
    }
    if (!Number.isSafeInteger(reservationMaxRounds) || reservationMaxRounds < 1) {
      throw new RangeError("reservationMaxRounds must be a positive integer");
    }
    if (!Number.isSafeInteger(reservationMaxMs) || reservationMaxMs < 1) {
      throw new RangeError("reservationMaxMs must be a positive integer");
    }
    const timings = { ...DEFAULT_TIMINGS, ...options.timings };
    for (const [k, v] of Object.entries(timings)) {
      if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${k} must be a non-negative integer`);
    }

    this.tableId = options.tableId;
    this.rules = deepFreeze({ ...rules });
    this.minChipsToSit = minChipsToSit;
    this.standardBuyIn = standardBuyIn;
    this.topUpCooldownMs = topUpCooldownMs;
    this.reservationMaxRounds = reservationMaxRounds;
    this.reservationMaxMs = reservationMaxMs;
    this.timings = Object.freeze(timings);
    this.ledger = deps.ledger ?? new Ledger();
    this.#now = deps.now;
    this.#commitments = deps.commitments ?? cryptoCommitment;
    this.#botRandom = deps.botRandom ?? cryptoUnit;
    this.#seatFilling =
      deps.seatFilling === undefined
        ? botSeatFilling({ buyIn: standardBuyIn, idPrefix: `bot:${options.tableId}:` })
        : deps.seatFilling;
    this.#phaseStartedAt = this.#now();
  }

  // ---------------------------------------------------------------- reading

  get phase(): Phase {
    return this.#phase;
  }

  balance(playerId: string): number {
    return this.ledger.balance(playerId);
  }

  records(): readonly RoundRecord[] {
    return [...this.#records];
  }

  /** Settled rounds from index `start` on, for a reader that drains them in order. */
  recordsSince(start: number): readonly RoundRecord[] {
    return this.#records.slice(Math.max(0, start));
  }

  get roundCount(): number {
    return this.#records.length;
  }

  seatOf(playerId: string): SeatId | null {
    return TURN_ORDER.find((s) => this.#seats[s] === playerId) ?? null;
  }

  /** Whether this player is at the table at all, including one leaving after the round. */
  hasPlayer(playerId: string): boolean {
    return this.#players.has(playerId);
  }

  /**
   * How many more humans could join right now. A newcomer is unseated, and
   * there are at most MAX_UNSEATED unseated players, though a joining human
   * may displace an idle chyakhe bot (one with no bet down). The same rule
   * join() applies, read without changing anything.
   */
  humanCapacity(): number {
    let seated = 0;
    for (const s of TURN_ORDER) if (this.#seats[s] !== undefined) seated += 1;
    let idleBots = 0;
    for (const p of this.#players.values()) {
      if (p.isBot && !p.leaving && this.seatOf(p.id) === null && !this.#bets.has(p.id)) idleBots += 1;
    }
    return Math.max(0, MAX_UNSEATED - (this.#players.size - seated)) + idleBots;
  }

  view(): TableView {
    const playerView = (id: string): PlayerView | null => {
      const p = this.#players.get(id);
      if (p === undefined) return null;
      return { playerId: p.id, name: p.name, isBot: p.isBot, connected: p.connected, chips: this.balance(p.id) };
    };
    const seats = {} as Record<SeatId, PlayerView | null>;
    for (const seat of TURN_ORDER) {
      const id = this.#seats[seat];
      seats[seat] = id === undefined ? null : playerView(id);
    }
    const chyakhe: PlayerView[] = [];
    for (const p of this.#players.values()) {
      if (this.seatOf(p.id) === null && !p.leaving) {
        const v = playerView(p.id);
        if (v !== null) chyakhe.push(v);
      }
    }
    const last = this.#records.at(-1) ?? null;
    return {
      tableId: this.tableId,
      phase: this.#phase,
      roundId: this.#round?.id ?? last?.roundId ?? null,
      thrower: this.#thrower,
      streak: this.#streak,
      stake: this.#currentStake(),
      commitHash: this.#round?.commitment.commitHash ?? null,
      seats,
      chyakhe,
      bets: [...this.#bets].map(([playerId, b]) => ({ playerId, seat: b.seat, chips: b.chips })),
      phaseEndsAt: this.#phaseEndsAt,
      reservations: TURN_ORDER.flatMap((seat) => {
        const r = this.#reservations[seat];
        return r === undefined ? [] : [{ seat, playerId: r.playerId }];
      }),
      lastRound: last,
      rules: this.rules,
    };
  }

  // ------------------------------------------------- server-side membership

  /**
   * Adds a player, or reconnects one already here. Called by the server after
   * authentication, never from a client message. An optional buy-in is
   * written to the ledger as a transfer from the mint: "buyin" for a human,
   * "botBuyin" for a bot.
   */
  join(playerId: string, opts: { readonly name: string; readonly isBot?: boolean; readonly buyIn?: number }): CommandResult {
    if (!isValidPlayerId(playerId) || playerId === MINT_ACCOUNT) return reject("malformed");
    if (opts.buyIn !== undefined && !isChipAmount(opts.buyIn, 1)) return reject("malformed");
    const existing = this.#players.get(playerId);
    // A newcomer is unseated. A human may displace an idle chyakhe bot to get
    // in; a bot never displaces anyone.
    if (existing === undefined && !this.#roomForOneMoreUnseated(!(opts.isBot ?? false))) return reject("table-full");

    if (existing === undefined) {
      this.#players.set(playerId, {
        id: playerId,
        name: opts.name,
        isBot: opts.isBot ?? false,
        connected: true,
        leaving: false,
      });
    } else {
      existing.connected = true;
      existing.leaving = false;
    }
    if (opts.buyIn !== undefined) {
      const isBot = this.#players.get(playerId)?.isBot ?? false;
      this.#issue(playerId, opts.buyIn, isBot ? "botBuyin" : "buyin");
    }
    return OK;
  }

  /**
   * Whether this human could claim a free top-up now, and for how much. For
   * the lobby to show as a choice; writes nothing. See topup.ts.
   */
  topUpOffer(playerId: string): TableTopUpResult {
    return this.#topUpRefusal(playerId) ?? topUpOffer(this.ledger, playerId, this.#topUpPolicy(), this.#now());
  }

  /**
   * Claims a free top-up back to the standard buy-in, if this human is below
   * the minimum to sit and off cooldown. Only ever on an explicit claim; the
   * table never tops anyone up by itself. Safe in any phase, since it only
   * adds chips.
   */
  claimTopUp(playerId: string): TableTopUpResult {
    return this.#topUpRefusal(playerId) ?? claimTopUp(this.ledger, playerId, this.#topUpPolicy(), this.#now());
  }

  #topUpRefusal(playerId: string): TableTopUpResult | null {
    const p = this.#players.get(playerId);
    if (p === undefined || p.leaving) return { ok: false, reason: "not-at-table", availableAt: null };
    if (p.isBot) return { ok: false, reason: "not-human", availableAt: null };
    return null;
  }

  #topUpPolicy(): TopUpPolicy {
    return { standardBuyIn: this.standardBuyIn, minChipsToSit: this.minChipsToSit, cooldownMs: this.topUpCooldownMs };
  }

  setConnected(playerId: string, connected: boolean): void {
    const p = this.#players.get(playerId);
    if (p !== undefined) p.connected = connected;
  }

  // --------------------------------------------------------------- commands

  /**
   * Handles one command. `playerId` comes from the authenticated session;
   * `raw` is untrusted. Parsed against the schema first, then checked
   * against the table's phase and the player's real balance.
   */
  handle(playerId: unknown, raw: unknown): CommandResult {
    if (!isValidPlayerId(playerId)) return reject("malformed");
    const cmd = parseCommand(raw);
    if (cmd === null) return reject("malformed");
    const player = this.#players.get(playerId);
    if (player === undefined || player.leaving) return reject("not-at-table");
    return this.#apply(player, cmd);
  }

  #apply(player: PlayerState, cmd: Command): CommandResult {
    const between = this.#phase === "waiting" || this.#phase === "revealing";
    const seat = this.seatOf(player.id);

    switch (cmd.type) {
      case "sit": {
        if (seat !== null) return reject("already-seated");
        if (this.balance(player.id) < this.minChipsToSit) return reject("insufficient-chips");
        const holderId = this.#seats[cmd.seat];
        const holder = holderId === undefined ? undefined : this.#players.get(holderId);
        // A human is never displaced.
        if (holder !== undefined && !holder.isBot && !holder.leaving) return reject("seat-taken");
        this.#expireReservations(this.#now());
        const reservedBy = this.#reservations[cmd.seat]?.playerId;
        if (reservedBy !== undefined && reservedBy !== player.id) return reject("seat-taken");
        // The minimum is not enough on its own: the player must also cover
        // the stake as it stands, or they would just be stood up again.
        if (!this.#couldCover(player.id, cmd.seat)) return reject("insufficient-chips");

        if (!between) {
          // Mid-round, a human may reserve the seat for the next round. Bots
          // only ever sit between rounds.
          if (player.isBot) return reject("wrong-phase");
          // One reservation per player: asking for another seat moves it. It
          // keeps its age, so asking again cannot hold off its expiry.
          const previous = this.#takeReservation(player.id);
          this.#reservations[cmd.seat] = {
            playerId: player.id,
            roundNo: previous?.roundNo ?? this.#roundNo,
            at: previous?.at ?? this.#now(),
          };
          return OK;
        }
        if (holder !== undefined) {
          // Between rounds a human may take a bot's seat; the bot leaves.
          if (player.isBot) return reject("seat-taken");
          this.#removePlayer(holder.id);
        }
        this.#clearReservation(player.id);
        this.#seats[cmd.seat] = player.id;
        return OK;
      }

      case "stand": {
        if (seat === null) {
          // Standing with no seat cancels a reservation, if there is one.
          return this.#clearReservation(player.id) ? OK : reject("not-seated");
        }
        if (!between) return reject("wrong-phase");
        // Standing makes one more unseated player. With no chyakhe place and
        // no idle chyakhe bot to give one up, the player can leave instead.
        if (!this.#roomForOneMoreUnseated(true)) return reject("table-full");
        delete this.#seats[seat];
        return OK;
      }

      case "placeBet": {
        if (this.#phase !== "betting" || this.#thrower === null) return reject("wrong-phase");
        if (seat !== null) return reject("seated-cannot-bet");
        if (!this.rules.chyakheEnabled) return reject("chyakhe-disabled");
        if (cmd.seat === this.#thrower) return reject("thrower-seat");
        if (this.#seats[cmd.seat] === undefined) return reject("empty-seat");
        if (cmd.chips > this.balance(player.id)) return reject("insufficient-chips");
        if (!this.#bets.has(player.id) && this.#bets.size >= this.rules.maxChyakhe) {
          return reject("too-many-chyakhe");
        }
        // Thrower solvency: the thrower must be able to pay the worst case
        // this bet creates, or settlement would one day overdraw them.
        const proposed = new Map(this.#bets).set(player.id, { seat: cmd.seat, chips: cmd.chips });
        const throwerId = this.#seats[this.#thrower];
        if (throwerId === undefined) return reject("wrong-phase");
        if (this.#worstLoss(throwerId, proposed) > this.balance(throwerId)) {
          return reject("thrower-cannot-cover");
        }
        this.#bets.set(player.id, { seat: cmd.seat, chips: cmd.chips });
        return OK;
      }

      case "clearBet": {
        if (this.#phase !== "betting") return reject("wrong-phase");
        if (!this.#bets.delete(player.id)) return reject("no-bet");
        return OK;
      }

      case "throw": {
        if (this.#phase !== "throwing") return reject("wrong-phase");
        if (seat === null || seat !== this.#thrower) return reject("not-thrower");
        this.#throw(this.#now());
        return OK;
      }

      case "leave": {
        this.#clearReservation(player.id);
        const atRisk = !between && (seat !== null || (this.#phase === "throwing" && this.#bets.has(player.id)));
        if (atRisk) {
          // Chips are committed to this round. Leave once it settles.
          player.leaving = true;
          player.connected = false;
          return OK;
        }
        this.#removePlayer(player.id);
        return OK;
      }
    }
  }

  // ------------------------------------------------------------------- time

  /** Advances the table to now(), running every phase change that is due. */
  tick(): void {
    const t = this.#now();
    // Bounded so a bug can never hang the server.
    for (let guard = 0; guard < 1_000; guard += 1) {
      if (this.#phase === "waiting") {
        this.#openRound(t);
        if (this.#phase === "waiting") return;
        continue;
      }
      this.#runBots(t);
      if (this.#phaseEndsAt !== null && t >= this.#phaseEndsAt) {
        this.#advance(this.#phaseEndsAt);
        continue;
      }
      return;
    }
    throw new Error("tick did not settle");
  }

  #advance(at: number): void {
    switch (this.#phase) {
      case "betting":
        this.#enter("throwing", at, this.timings.throwingMs);
        return;
      case "throwing":
        this.#throw(at); // auto-throw on timeout
        return;
      case "revealing":
        this.#openRound(at);
        return;
      case "waiting":
        return;
    }
  }

  #enter(phase: Phase, at: number, durationMs: number | null): void {
    this.#phase = phase;
    this.#phaseStartedAt = at;
    this.#phaseEndsAt = durationMs === null ? null : at + durationMs;
  }

  #runBots(t: number): void {
    if (this.#phase === "betting" && t >= this.#phaseStartedAt + this.timings.botBetDelayMs && this.#thrower !== null) {
      for (const p of [...this.#players.values()]) {
        if (!p.isBot || p.leaving || this.#botsDecided.has(p.id) || this.seatOf(p.id) !== null) continue;
        this.#botsDecided.add(p.id);
        const bet = chooseChyakheBet(
          { thrower: this.#thrower, seats: this.#seats, balance: this.balance(p.id), thini: this.rules.thini },
          this.#botRandom,
        );
        // Through the same validation as a human; a refused bot bet is just dropped.
        if (bet !== null) this.handle(p.id, { type: "placeBet", seat: bet.seat, chips: bet.chips });
      }
    }
    const botThrowAt = this.#phaseStartedAt + this.timings.botThrowDelayMs;
    if (this.#phase === "throwing" && this.#thrower !== null && t >= botThrowAt) {
      const id = this.#seats[this.#thrower];
      const p = id === undefined ? undefined : this.#players.get(id);
      // At the scheduled moment rather than now(), so a late tick replays the
      // same timeline as a punctual one.
      if (p !== undefined && p.isBot) this.#throw(botThrowAt);
    }
  }

  // ----------------------------------------------------------------- rounds

  #openRound(at: number): void {
    this.#removeLeavers();
    this.#bets.clear();
    this.#botsDecided.clear();
    this.#round = null;

    const live = this.#isLive();
    if (live) this.#honourReservations();
    // What could not be honoured is about to miss a round; stale ones go.
    this.#expireReservations(at, 1);

    // Stand anyone who can no longer cover their worst case at the current
    // stake, so every seated player in a round is solvent, then fill empty
    // seats. Either can change the thrower, the stake or the ghanti split, so
    // repeat until nothing changes. Each pass removes or seats someone, and
    // fresh bots are checked to be solvent before they sit, so this ends.
    for (let pass = 0; ; pass += 1) {
      if (pass > 64) throw new Error("seating did not settle");
      this.#normaliseThrower();
      const broke = TURN_ORDER.find((s) => {
        const id = this.#seats[s];
        return id !== undefined && this.#worstLoss(id, new Map()) > this.balance(id);
      });
      if (broke !== undefined) {
        const id = this.#seats[broke];
        const p = id === undefined ? undefined : this.#players.get(id);
        // With seat filling, a broke bot leaves and a fresh one replaces it.
        // A broke human is only stood up, and keeps their real balance. If
        // there is no chyakhe place for them and no idle bot to give one up,
        // they leave the table instead; their balance is still untouched.
        if (p !== undefined && ((this.#seatFilling !== null && p.isBot) || !this.#roomForOneMoreUnseated(true))) {
          this.#removePlayer(p.id);
        } else {
          delete this.#seats[broke];
        }
        continue;
      }
      if (live && this.#fillEmptySeats()) continue;
      break;
    }
    // Bot buy-ins and cash-outs above all go through the mint.
    this.ledger.assertBalanced();

    if (!this.#canStart()) {
      this.#enter("waiting", at, null);
      return;
    }

    const commitment = this.#commitments();
    const seed = parseSeed(commitment.seed);
    if (seed === null || sha256Hex(seed) !== commitment.commitHash) {
      throw new Error("commitment factory returned a seed that does not match its hash");
    }
    this.#roundNo += 1;
    this.#round = { id: `${this.tableId}:${this.#roundNo}`, commitment };
    this.#enter("betting", at, this.timings.bettingMs);
  }

  #throw(at: number): void {
    const round = this.#round;
    const thrower = this.#thrower;
    if (round === null || thrower === null) throw new Error("no round to throw");

    const faces = facesFromSeed(round.commitment.seed);
    const occupants = { ...this.#seats };
    const chyakhe = this.#chyakheBets(this.#bets);
    const outcome = settleRound({ thrower, occupants, chyakhe, streak: this.#streak, rules: this.rules, faces });

    const entries: NewLedgerEntry[] = Object.entries(outcome.deltas)
      .filter(([, chips]) => chips !== 0)
      .map(([playerId, chips]) => ({ roundId: round.id, playerId, chips, reason: "round", at }));
    // Cannot go negative: solvency was checked at the open and on every bet.
    this.ledger.append(entries);
    // Master invariant: every account, the mint included, sums to zero.
    this.ledger.assertBalanced();

    this.#records.push(
      deepFreeze<RoundRecord>({
        roundId: round.id,
        seed: round.commitment.seed,
        commitHash: round.commitment.commitHash,
        faces,
        faceUp: outcome.faceUp,
        winningSeat: outcome.winningSeat,
        hit: outcome.hit,
        stake: outcome.stake,
        multiplier: outcome.stakeMultiplier,
        deltas: { ...outcome.deltas },
        at,
        thrower,
        streak: this.#streak,
        occupants,
        chyakhe,
        rules: this.rules,
      }),
    );

    this.#thrower = outcome.nextThrower;
    this.#throwerPlayer = this.#seats[outcome.nextThrower] ?? null;
    this.#streak = outcome.nextStreak;
    this.#bets.clear();
    this.#round = null;
    this.#removeLeavers();
    this.#enter("revealing", at, this.timings.revealMs);
  }

  /** Re-derives a recorded round from its seed and inputs alone. */
  static replay(record: RoundRecord): ReplayResult {
    const seed = parseSeed(record.seed);
    const faces = facesFromSeed(record.seed);
    const outcome = settleRound({
      thrower: record.thrower,
      occupants: record.occupants,
      chyakhe: record.chyakhe,
      streak: record.streak,
      rules: record.rules,
      faces,
    });
    return {
      commitmentMatches: seed !== null && sha256Hex(seed) === record.commitHash,
      faces,
      faceUp: outcome.faceUp,
      winningSeat: outcome.winningSeat,
      hit: outcome.hit,
      stake: outcome.stake,
      multiplier: outcome.stakeMultiplier,
      deltas: outcome.deltas,
    };
  }

  // ---------------------------------------------------------------- helpers

  #canStart(): boolean {
    const seated = TURN_ORDER.filter((s) => this.#seats[s] !== undefined).length;
    return seated >= 2 && this.#isLive();
  }

  /** A table is live while at least one connected human is at it. */
  #isLive(): boolean {
    for (const p of this.#players.values()) if (!p.isBot && p.connected && !p.leaving) return true;
    return false;
  }

  /** Seats each human who reserved a seat, if it is free or held by a bot. */
  #honourReservations(): void {
    for (const seat of TURN_ORDER) {
      const id = this.#reservations[seat]?.playerId;
      if (id === undefined) continue;
      const p = this.#players.get(id);
      if (p === undefined || p.leaving || this.seatOf(id) !== null || this.balance(id) < this.minChipsToSit) {
        delete this.#reservations[seat];
        continue;
      }
      const holderId = this.#seats[seat];
      const holder = holderId === undefined ? undefined : this.#players.get(holderId);
      if (holder !== undefined && !holder.isBot) continue; // a human still has it; keep waiting
      if (holder !== undefined) this.#removePlayer(holder.id);
      this.#seats[seat] = id;
      delete this.#reservations[seat];
    }
  }

  /**
   * Drops reservations that are too old, so a seat cannot be held for a
   * human who never takes it. `pending` counts a round about to open without
   * them. Reservations are only used when a round opens or someone sits, so
   * checking at those two points is enough.
   */
  #expireReservations(at: number, pending = 0): void {
    for (const seat of TURN_ORDER) {
      const r = this.#reservations[seat];
      if (r === undefined) continue;
      const roundsMissed = this.#roundNo + pending - r.roundNo;
      if (roundsMissed > this.reservationMaxRounds || at - r.at >= this.reservationMaxMs) {
        delete this.#reservations[seat];
      }
    }
  }

  /**
   * Seats a fresh bot in every empty seat that no human has reserved.
   * Returns true if anyone was seated.
   */
  #fillEmptySeats(): boolean {
    const policy = this.#seatFilling;
    if (policy === null) return false;
    let seated = false;
    for (const seat of TURN_ORDER) {
      if (this.#seats[seat] !== undefined || this.#reservations[seat] !== undefined) continue;
      if (this.#players.size >= MAX_PLAYERS) break;
      const bot = policy.nextBot(seat);
      if (bot === null) continue;
      if (
        !isValidPlayerId(bot.id) ||
        bot.id === MINT_ACCOUNT ||
        this.#players.has(bot.id) ||
        this.ledger.hasAccount(bot.id)
      ) {
        throw new Error(`seat filling produced an unusable bot id ${JSON.stringify(bot.id)}`);
      }
      // Check the bot could cover this seat before minting any chips for it.
      this.#seats[seat] = bot.id;
      this.#normaliseThrower();
      const needed = Math.max(this.minChipsToSit, this.#worstLoss(bot.id, new Map()));
      if (!isChipAmount(bot.buyIn, 1) || bot.buyIn < needed) {
        delete this.#seats[seat];
        this.#normaliseThrower();
        continue;
      }
      this.#players.set(bot.id, { id: bot.id, name: bot.name, isBot: true, connected: true, leaving: false });
      this.#issue(bot.id, bot.buyIn, "botBuyin");
      seated = true;
    }
    return seated;
  }

  /**
   * Whether one more player can be unseated without passing MAX_UNSEATED.
   * If not, and `evictBot` is set, removes an unseated bot with no bet down
   * (so with nothing at risk) to make room.
   */
  #roomForOneMoreUnseated(evictBot: boolean): boolean {
    const seated = TURN_ORDER.filter((s) => this.#seats[s] !== undefined).length;
    if (this.#players.size - seated < MAX_UNSEATED) return true;
    if (!evictBot) return false;
    for (const p of this.#players.values()) {
      if (p.isBot && !p.leaving && this.seatOf(p.id) === null && !this.#bets.has(p.id)) {
        this.#removePlayer(p.id);
        return true;
      }
    }
    return false;
  }

  /** Whether `playerId` could cover the worst case of sitting in `seat` now. */
  #couldCover(playerId: string, seat: SeatId): boolean {
    const previous = this.#seats[seat];
    this.#seats[seat] = playerId;
    try {
      return this.#worstLoss(playerId, new Map()) <= this.balance(playerId);
    } finally {
      if (previous === undefined) delete this.#seats[seat];
      else this.#seats[seat] = previous;
    }
  }

  /**
   * Takes a player off the table. A human keeps their balance. A bot exists
   * only for this table, so its residual chips go back to the mint rather
   * than sit orphaned on a dead account. Only called between rounds or with
   * nothing at risk, so the whole balance is free to move.
   */
  #removePlayer(playerId: string): void {
    if (this.#players.get(playerId)?.isBot) this.ledger.retire(playerId, "botResidual", this.#now());
    const seat = this.seatOf(playerId);
    if (seat !== null) delete this.#seats[seat];
    this.#bets.delete(playerId);
    this.#botsDecided.delete(playerId);
    this.#clearReservation(playerId);
    this.#players.delete(playerId);
  }

  #clearReservation(playerId: string): boolean {
    return this.#takeReservation(playerId) !== null;
  }

  /** Removes this player's reservation, if any, and returns it. */
  #takeReservation(playerId: string): Reservation | null {
    for (const seat of TURN_ORDER) {
      const r = this.#reservations[seat];
      if (r?.playerId === playerId) {
        delete this.#reservations[seat];
        return r;
      }
    }
    return null;
  }

  /** Puts the throw on an occupied seat. A new person on the throw starts a fresh turn. */
  #normaliseThrower(): void {
    const occupied = (s: SeatId): boolean => this.#seats[s] !== undefined;
    if (!TURN_ORDER.some(occupied)) {
      this.#thrower = null;
      this.#throwerPlayer = null;
      this.#streak = 0;
      return;
    }
    if (this.#thrower === null) this.#thrower = TURN_ORDER.find(occupied) ?? null;
    else if (!occupied(this.#thrower)) this.#thrower = nextSeat(this.#thrower, occupied);
    const occupant = this.#thrower === null ? null : (this.#seats[this.#thrower] ?? null);
    if (occupant !== this.#throwerPlayer) {
      this.#throwerPlayer = occupant;
      this.#streak = 0;
    }
  }

  #currentStake(): number {
    return this.rules.thini * stakeMultiplier(this.#streak, this.rules);
  }

  #chyakheBets(bets: ReadonlyMap<string, Bet>): ChyakheBet[] {
    return [...bets].map(([playerId, b]) => ({ playerId, seat: b.seat, chips: b.chips }));
  }

  /**
   * The most `playerId` could lose on the next throw, given these bets. Works
   * by settling one throw for each possible winning seat, so it accounts for
   * the stake, the chyakhe bets and ghanti exactly, whatever the house rules.
   */
  #worstLoss(playerId: string, bets: ReadonlyMap<string, Bet>): number {
    if (this.#thrower === null || this.#seats[this.#thrower] === undefined) return 0;
    const chyakhe = this.#chyakheBets(bets);
    let worst = 0;
    for (const faces of ONE_THROW_PER_SEAT) {
      const o = settleRound({
        thrower: this.#thrower,
        occupants: this.#seats,
        chyakhe,
        streak: this.#streak,
        rules: this.rules,
        faces,
      });
      worst = Math.min(worst, o.deltas[playerId] ?? 0);
    }
    return -worst;
  }

  #removeLeavers(): void {
    for (const p of [...this.#players.values()]) if (p.leaving) this.#removePlayer(p.id);
  }

  /** Moves chips from the mint to a player. */
  #issue(playerId: string, chips: number, reason: IssueReason): void {
    this.ledger.issue(playerId, chips, reason, this.#now());
  }
}
