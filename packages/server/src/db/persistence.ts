import { MINT_ACCOUNT, isPersistedReason, type LedgerEntry } from "../ledger.js";
import type { RoundRecord, Table } from "../table.js";
import type { ChipStore, PlayerKind, TransferReason } from "./store.js";

/**
 * Keeps one Table's chips in the database, without making the Table async.
 *
 * The Table stays pure and synchronous, with its in-memory ledger as a cache
 * of the database for the players at that table. After anything happens at
 * the table, pump() reads what the in-memory ledger gained since last time
 * and queues it, in order, on one serial queue:
 * - a "round" batch with its RoundRecord becomes store.settleRound (one
 *   transaction); a round that moved no chips (a push) is still recorded;
 * - a buy-in, bot buy-in, top-up or bot residual becomes store.transfer;
 * - "opening" and "closing" only mirror the database, and are skipped.
 * The owner should not advance the table while anything is pending, so the
 * table never runs more than one step ahead of what is stored.
 *
 * The first failure stops everything: nothing after it is written, and
 * onFailure is told once. The owner must halt the table. Chips are then as
 * of the last write that succeeded; in-memory state after it is discarded.
 *
 * Single-writer rule: a player's chips change only through the room of the
 * table they are at, so this queue is the only writer for them meanwhile.
 */

export interface PersistenceHooks {
  /** Called once, on the first failed write. */
  onFailure(error: unknown): void;
  /** A display name for an account the database may not have yet. */
  displayName(accountId: string): string;
  /** The table's clock, for the in-memory opening entries. */
  now(): number;
}

export class TablePaused extends Error {
  constructor(cause: unknown) {
    super("the table is paused: a write to the database failed", { cause });
    this.name = "TablePaused";
  }
}

export class TablePersistence {
  readonly #table: Table;
  readonly #store: ChipStore;
  readonly #hooks: PersistenceHooks;
  #entries = 0;
  #records = 0;
  #queue: Promise<void> = Promise.resolve();
  #pending = 0;
  #failure: unknown = null;
  #failed = false;

  constructor(table: Table, store: ChipStore, hooks: PersistenceHooks) {
    this.#table = table;
    this.#store = store;
    this.#hooks = hooks;
  }

  /** Writes queued and not yet done. */
  get pending(): number {
    return this.#pending;
  }

  get failed(): boolean {
    return this.#failed;
  }

  get failure(): unknown {
    return this.#failure;
  }

  /** Queues everything the table has done that the database has not seen. Synchronous. */
  pump(): void {
    if (this.#failed) return;
    const entries = this.#table.ledger.entriesSince(this.#entries);
    const records = this.#table.recordsSince(this.#records);
    this.#entries += entries.length;
    this.#records += records.length;
    const unwritten = new Map<string, RoundRecord>(records.map((r) => [r.roundId, r]));

    for (const batch of batches(entries)) {
      const first = batch[0];
      if (first === undefined || !isPersistedReason(first.reason)) continue;
      if (first.reason === "round") {
        const record = first.roundId === null ? undefined : unwritten.get(first.roundId);
        if (record === undefined) throw new Error(`round entries for ${first.roundId} have no settled record`);
        unwritten.delete(record.roundId);
        this.#enqueue(() => this.#store.settleRound(this.#table.tableId, record));
        continue;
      }
      const player = batch.find((e) => e.playerId !== MINT_ACCOUNT);
      if (player === undefined) throw new Error(`a ${first.reason} batch with no player`);
      const reason = first.reason as TransferReason;
      const kind: PlayerKind = reason === "botBuyin" || reason === "botResidual" ? "bot" : "human";
      const accountId = player.playerId;
      // Named now: a bot can be gone from the table by the time this runs.
      const displayName = this.#hooks.displayName(accountId);
      this.#enqueue(() =>
        this.#store.transfer({
          accountId,
          displayName,
          kind,
          reason,
          chips: player.chips,
          at: player.at,
        }),
      );
    }
    // Rounds that moved no chips have no ledger batch. They change no balance,
    // so where they fall in the queue does not matter; they are still recorded.
    for (const record of unwritten.values()) {
      this.#enqueue(() => this.#store.settleRound(this.#table.tableId, record));
    }
  }

  /** Resolves when everything queued so far has been written, or the first write failed. */
  idle(): Promise<void> {
    return this.#queue;
  }

  /**
   * Brings a player's balance in from the database before they join the
   * table, creating the account if it is new. A player already at the table
   * is left alone: while they are here, the table is the only writer for
   * them, so its cache is current. Returns whether the account was created.
   */
  async admit(playerId: string, displayName: string): Promise<{ created: boolean }> {
    await this.idle();
    if (this.#failed) throw new TablePaused(this.#failure);
    const { balance, created } = await this.#store.openAccount({ id: playerId, displayName, kind: "human" });
    if (this.#failed) throw new TablePaused(this.#failure);
    if (this.#table.hasPlayer(playerId)) return { created };
    // Replace whatever this table cached from an earlier visit; the database
    // may have moved on since (another table, another session).
    const ledger = this.#table.ledger;
    const at = this.#hooks.now();
    ledger.retire(playerId, "closing", at);
    if (balance > 0) ledger.issue(playerId, balance, "opening", at);
    this.pump(); // advances past the opening and closing, which write nothing
    return { created };
  }

  #enqueue(write: () => Promise<void>): void {
    this.#pending += 1;
    this.#queue = this.#queue.then(async () => {
      try {
        if (!this.#failed) await write();
      } catch (e) {
        this.#failed = true;
        this.#failure = e;
        this.#hooks.onFailure(e);
      } finally {
        this.#pending -= 1;
      }
    });
  }
}

/** Splits entries into their batches, in order. */
function batches(entries: readonly LedgerEntry[]): LedgerEntry[][] {
  const out: LedgerEntry[][] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (last !== undefined && last[0]?.batch === e.batch) last.push(e);
    else out.push([e]);
  }
  return out;
}
