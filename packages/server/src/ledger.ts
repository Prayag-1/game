/**
 * Append-only chip ledger (SECURITY.md rule 4).
 *
 * The entries are the record. A balance is the sum of a player's entries and
 * is never stored on its own; the in-memory map below is only a cache of that
 * sum, and verify() rebuilds it from the entries to prove it has not drifted.
 *
 * Shape of the Postgres table this mirrors:
 *
 *   CREATE TYPE ledger_reason AS ENUM ('buyin', 'round', 'topup');
 *   CREATE TABLE ledger_entries (
 *     seq       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 *     round_id  text,
 *     player_id text          NOT NULL,
 *     chips     bigint        NOT NULL CHECK (chips <> 0),
 *     reason    ledger_reason NOT NULL,
 *     at        timestamptz   NOT NULL,
 *     CHECK ((reason = 'round') = (round_id IS NOT NULL)),
 *     CHECK (reason = 'round' OR chips > 0),
 *     UNIQUE (round_id, player_id)
 *   );
 *   -- The application role gets INSERT and SELECT only. No UPDATE, no DELETE.
 */

export const LEDGER_REASONS = ["buyin", "round", "topup"] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export interface LedgerEntry {
  readonly seq: number;
  /** Set for reason "round", null otherwise. */
  readonly roundId: string | null;
  readonly playerId: string;
  /** Signed whole chips, never zero. */
  readonly chips: number;
  readonly reason: LedgerReason;
  /** Epoch milliseconds. */
  readonly at: number;
}

export type NewLedgerEntry = Omit<LedgerEntry, "seq">;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class Ledger {
  readonly #entries: LedgerEntry[] = [];
  /** Cache of the sum of each player's entries. Rebuilt and checked by verify(). */
  readonly #balances = new Map<string, number>();
  readonly #rounds = new Set<string>();

  /**
   * Appends a batch atomically: either every entry is written or none is.
   * A batch is one round's settlement, or a single buy-in or top-up.
   * Refuses anything that would take a player below zero.
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

    if (first.reason === "round") {
      if (typeof first.roundId !== "string" || first.roundId.length === 0) {
        throw new LedgerError("a round entry needs a roundId");
      }
      if (this.#rounds.has(first.roundId)) {
        throw new LedgerError(`round ${first.roundId} is already in the ledger`);
      }
      const sum = batch.reduce((acc, e) => acc + e.chips, 0);
      if (sum !== 0) throw new LedgerError(`round ${first.roundId} does not balance: ${sum}`);
    } else {
      if (first.roundId !== null) throw new LedgerError(`a ${first.reason} has no round`);
      if (batch.length !== 1) throw new LedgerError(`a ${first.reason} is one entry`);
      if (first.chips < 0) throw new LedgerError(`a ${first.reason} must add chips`);
    }

    const projected = new Map<string, number>();
    for (const e of batch) {
      const next = this.balance(e.playerId) + e.chips;
      if (!Number.isSafeInteger(next)) throw new LedgerError(`balance for ${e.playerId} overflowed`);
      if (next < 0) {
        throw new LedgerError(`entry would take ${e.playerId} below zero (${next})`);
      }
      projected.set(e.playerId, next);
    }

    const written: LedgerEntry[] = batch.map((e, i) =>
      Object.freeze({
        seq: this.#entries.length + i + 1,
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

  balance(playerId: string): number {
    return this.#balances.get(playerId) ?? 0;
  }

  entries(): readonly LedgerEntry[] {
    return [...this.#entries];
  }

  /** Chips held by everyone. Equals the sum of all buy-ins and top-ups. */
  totalInPlay(): number {
    let total = 0;
    for (const v of this.#balances.values()) total += v;
    return total;
  }

  /**
   * Rebuilds every balance from the entries and throws if anything disagrees:
   * the cache, the sequence numbers, a negative running balance, a round that
   * does not sum to zero, or chips in play that no buy-in or top-up created.
   */
  verify(): void {
    const rebuilt = new Map<string, number>();
    const roundSums = new Map<string, number>();
    let minted = 0;
    this.#entries.forEach((e, i) => {
      if (e.seq !== i + 1) throw new LedgerError(`sequence gap at entry ${i + 1}`);
      const next = (rebuilt.get(e.playerId) ?? 0) + e.chips;
      if (next < 0) throw new LedgerError(`${e.playerId} went below zero at seq ${e.seq}`);
      rebuilt.set(e.playerId, next);
      if (e.reason === "round" && e.roundId !== null) {
        roundSums.set(e.roundId, (roundSums.get(e.roundId) ?? 0) + e.chips);
      } else {
        minted += e.chips;
      }
    });
    for (const [roundId, sum] of roundSums) {
      if (sum !== 0) throw new LedgerError(`round ${roundId} sums to ${sum}`);
    }
    if (rebuilt.size !== this.#balances.size) throw new LedgerError("balance cache has drifted");
    for (const [id, bal] of rebuilt) {
      if (this.#balances.get(id) !== bal) {
        throw new LedgerError(`balance for ${id} has drifted: cache ${this.#balances.get(id)}, entries ${bal}`);
      }
    }
    if (this.totalInPlay() !== minted) {
      throw new LedgerError(`chips in play ${this.totalInPlay()} do not match chips issued ${minted}`);
    }
  }
}
