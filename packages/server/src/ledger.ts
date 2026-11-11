/**
 * Append-only chip ledger (SECURITY.md rule 4).
 *
 * The entries are the record. A balance is the sum of an account's entries and
 * is never stored on its own; the in-memory map below is only a cache of that
 * sum, and verify() rebuilds it from the entries to prove it has not drifted.
 *
 * Double entry, with a mint. Every batch sums to zero, so chips are never
 * created or destroyed, only moved:
 *
 * - A round moves chips between players. The mint is never part of a round.
 * - A buy-in, bot buy-in or top-up moves chips from the mint to a player.
 * - A departing bot's residual chips move back to the mint ("botResidual").
 *
 * Player accounts may never go below zero. The mint may, and normally does:
 * its balance is exactly minus the chips in existence. So the master
 * invariant is that the sum of every account, the mint included, is 0, and
 * every chip anyone holds traces back to a mint entry.
 *
 * With a database (db/), this in-memory ledger is a cache for the players at
 * one table, and the database is the authority between sessions. Two
 * reasons exist only here and are never persisted: "opening" brings a
 * player's balance in from the database when they join, and "closing" clears
 * a stale cached balance before it is reloaded. Both are mint transfers, so
 * the in-memory invariant still holds. See db/schema.ts for the real tables.
 */

/** The one system account. Chips come from it and go back to it. */
export const MINT_ACCOUNT = "system:mint";

export const LEDGER_REASONS = ["buyin", "botBuyin", "topup", "botResidual", "round", "opening", "closing"] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

/** Reasons that move chips from the mint to a player. */
export const ISSUE_REASONS = ["buyin", "botBuyin", "topup", "opening"] as const;
export type IssueReason = (typeof ISSUE_REASONS)[number];

/** Reasons that move chips from a player back to the mint. */
export const RETIRE_REASONS = ["botResidual", "closing"] as const;
export type RetireReason = (typeof RETIRE_REASONS)[number];

/** Reasons that mirror the database rather than change it. Never persisted. */
export const IN_MEMORY_REASONS = ["opening", "closing"] as const;
export type PersistedReason = Exclude<LedgerReason, (typeof IN_MEMORY_REASONS)[number]>;
export const isPersistedReason = (r: LedgerReason): r is PersistedReason =>
  !(IN_MEMORY_REASONS as readonly string[]).includes(r);

const isIssue = (r: LedgerReason): r is IssueReason => (ISSUE_REASONS as readonly string[]).includes(r);
const isRetire = (r: LedgerReason): r is RetireReason => (RETIRE_REASONS as readonly string[]).includes(r);

export interface LedgerEntry {
  readonly seq: number;
  /** Entries written together share a batch number, and sum to zero. */
  readonly batch: number;
  /** Set for reason "round", null otherwise. */
  readonly roundId: string | null;
  readonly playerId: string;
  /** Signed whole chips, never zero. */
  readonly chips: number;
  readonly reason: LedgerReason;
  /** Epoch milliseconds. */
  readonly at: number;
}

export type NewLedgerEntry = Omit<LedgerEntry, "seq" | "batch">;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class Ledger {
  readonly #entries: LedgerEntry[] = [];
  /** Cache of the sum of each account's entries. Rebuilt and checked by verify(). */
  readonly #balances = new Map<string, number>();
  readonly #rounds = new Set<string>();
  #batches = 0;

  /**
   * Appends a batch atomically: either every entry is written or none is.
   * A batch is one round's settlement, or one transfer to or from the mint.
   * Every batch must sum to zero, and none may take a player below zero.
   */
  append(batch: readonly NewLedgerEntry[]): readonly LedgerEntry[] {
    const first = batch[0];
    if (first === undefined) return [];

    const seen = new Set<string>();
    for (const e of batch) {
      if (typeof e.playerId !== "string" || e.playerId.length === 0) {
        throw new LedgerError("an entry needs a playerId");
      }
      if (!Number.isSafeInteger(e.chips) || e.chips === 0) {
        throw new LedgerError(`chips must be a non-zero whole number, got ${e.chips}`);
      }
      if (!LEDGER_REASONS.includes(e.reason)) throw new LedgerError(`unknown reason ${String(e.reason)}`);
      if (!Number.isFinite(e.at)) throw new LedgerError("an entry needs a timestamp");
      if (e.reason !== first.reason || e.roundId !== first.roundId) {
        throw new LedgerError("every entry in a batch must share one reason and one round");
      }
      if (seen.has(e.playerId)) throw new LedgerError(`${e.playerId} appears twice in one batch`);
      seen.add(e.playerId);
    }
    const sum = batch.reduce((acc, e) => acc + e.chips, 0);

    if (first.reason === "round") {
      if (typeof first.roundId !== "string" || first.roundId.length === 0) {
        throw new LedgerError("a round entry needs a roundId");
      }
      if (this.#rounds.has(first.roundId)) {
        throw new LedgerError(`round ${first.roundId} is already in the ledger`);
      }
      if (seen.has(MINT_ACCOUNT)) throw new LedgerError("the mint never takes part in a round");
      if (sum !== 0) throw new LedgerError(`round ${first.roundId} does not balance: ${sum}`);
    } else {
      if (first.roundId !== null) throw new LedgerError(`a ${first.reason} has no round`);
      const mint = batch.find((e) => e.playerId === MINT_ACCOUNT);
      const player = batch.find((e) => e.playerId !== MINT_ACCOUNT);
      if (batch.length !== 2 || mint === undefined || player === undefined) {
        throw new LedgerError(`a ${first.reason} is one transfer between the mint and one player`);
      }
      if (sum !== 0) throw new LedgerError(`a ${first.reason} does not balance: ${sum}`);
      if (isIssue(first.reason) && player.chips < 0) throw new LedgerError(`a ${first.reason} must add chips`);
      if (isRetire(first.reason) && player.chips > 0) throw new LedgerError(`a ${first.reason} must remove chips`);
    }

    const projected = new Map<string, number>();
    for (const e of batch) {
      const next = this.balance(e.playerId) + e.chips;
      if (!Number.isSafeInteger(next)) throw new LedgerError(`balance for ${e.playerId} overflowed`);
      if (next < 0 && e.playerId !== MINT_ACCOUNT) {
        throw new LedgerError(`entry would take ${e.playerId} below zero (${next})`);
      }
      projected.set(e.playerId, next);
    }

    this.#batches += 1;
    const written: LedgerEntry[] = batch.map((e, i) =>
      Object.freeze({
        seq: this.#entries.length + i + 1,
        batch: this.#batches,
        roundId: e.roundId,
        playerId: e.playerId,
        chips: e.chips,
        reason: e.reason,
        at: e.at,
      }),
    );
    this.#entries.push(...written);
    for (const [id, bal] of projected) this.#balances.set(id, bal);
    if (first.reason === "round" && first.roundId !== null) this.#rounds.add(first.roundId);
    return written;
  }

  /** Moves `chips` from the mint to a player. */
  issue(playerId: string, chips: number, reason: IssueReason, at: number): void {
    if (playerId === MINT_ACCOUNT) throw new LedgerError("the mint cannot pay itself");
    this.append([
      { roundId: null, playerId: MINT_ACCOUNT, chips: -chips, reason, at },
      { roundId: null, playerId, chips, reason, at },
    ]);
  }

  /** Returns a player's whole balance to the mint. Returns the chips moved; 0 writes nothing. */
  retire(playerId: string, reason: RetireReason, at: number): number {
    if (playerId === MINT_ACCOUNT) throw new LedgerError("the mint cannot pay itself");
    const chips = this.balance(playerId);
    if (chips === 0) return 0;
    this.append([
      { roundId: null, playerId, chips: -chips, reason, at },
      { roundId: null, playerId: MINT_ACCOUNT, chips, reason, at },
    ]);
    return chips;
  }

  balance(playerId: string): number {
    return this.#balances.get(playerId) ?? 0;
  }

  /** True once any entry has been written for this account. */
  hasAccount(playerId: string): boolean {
    return this.#balances.has(playerId);
  }

  entries(): readonly LedgerEntry[] {
    return [...this.#entries];
  }

  /** Entries from index `start` on, for a reader that keeps its place. */
  entriesSince(start: number): readonly LedgerEntry[] {
    return this.#entries.slice(Math.max(0, start));
  }

  get entryCount(): number {
    return this.#entries.length;
  }

  /** When this account last had an entry with this reason, or null. */
  lastEntryAt(playerId: string, reason: LedgerReason): number | null {
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const e = this.#entries[i];
      if (e !== undefined && e.playerId === playerId && e.reason === reason) return e.at;
    }
    return null;
  }

  /** The mint's balance: minus the number of chips in existence. */
  mintBalance(): number {
    return this.balance(MINT_ACCOUNT);
  }

  /** Chips held by players, i.e. every account but the mint. Equals -mintBalance(). */
  totalInPlay(): number {
    let total = 0;
    for (const [id, v] of this.#balances) if (id !== MINT_ACCOUNT) total += v;
    return total;
  }

  /** The sum of every account, the mint included. Always 0. */
  sumOfAllAccounts(): number {
    let total = 0;
    for (const v of this.#balances.values()) total += v;
    return total;
  }

  /** Throws unless every account, the mint included, sums to exactly 0. */
  assertBalanced(): void {
    const sum = this.sumOfAllAccounts();
    if (sum !== 0) throw new LedgerError(`accounts sum to ${sum}, not 0`);
  }

  /**
   * Rebuilds every balance from the entries and throws if anything disagrees:
   * the cache, the sequence or batch numbers, a player below zero, a batch or
   * round that does not sum to zero, round entries that do not net to zero
   * across the whole ledger, or accounts that do not sum to zero.
   */
  verify(): void {
    const rebuilt = new Map<string, number>();
    const batchSums = new Map<number, number>();
    const roundSums = new Map<string, number>();
    let roundNet = 0;
    let lastBatch = 0;
    this.#entries.forEach((e, i) => {
      if (e.seq !== i + 1) throw new LedgerError(`sequence gap at entry ${i + 1}`);
      if (e.batch !== lastBatch && e.batch !== lastBatch + 1) throw new LedgerError(`batch gap at seq ${e.seq}`);
      lastBatch = e.batch;
      const next = (rebuilt.get(e.playerId) ?? 0) + e.chips;
      if (next < 0 && e.playerId !== MINT_ACCOUNT) {
        throw new LedgerError(`${e.playerId} went below zero at seq ${e.seq}`);
      }
      rebuilt.set(e.playerId, next);
      batchSums.set(e.batch, (batchSums.get(e.batch) ?? 0) + e.chips);
      if (e.reason === "round") {
        if (e.playerId === MINT_ACCOUNT) throw new LedgerError(`the mint is in round ${e.roundId} at seq ${e.seq}`);
        roundNet += e.chips;
        if (e.roundId !== null) roundSums.set(e.roundId, (roundSums.get(e.roundId) ?? 0) + e.chips);
      }
    });
    if (lastBatch !== this.#batches) throw new LedgerError("batch counter has drifted");
    for (const [batch, sum] of batchSums) {
      if (sum !== 0) throw new LedgerError(`batch ${batch} sums to ${sum}`);
    }
    for (const [roundId, sum] of roundSums) {
      if (sum !== 0) throw new LedgerError(`round ${roundId} sums to ${sum}`);
    }
    if (roundNet !== 0) throw new LedgerError(`round entries net to ${roundNet}, not 0`);
    if (rebuilt.size !== this.#balances.size) throw new LedgerError("balance cache has drifted");
    for (const [id, bal] of rebuilt) {
      if (this.#balances.get(id) !== bal) {
        throw new LedgerError(`balance for ${id} has drifted: cache ${this.#balances.get(id)}, entries ${bal}`);
      }
    }
    this.assertBalanced();
  }
}
