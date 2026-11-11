import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { RoundRecord } from "../table.js";
import * as schema from "./schema.js";
import { MINT_ID, accounts, ledgerEntries, rounds } from "./schema.js";

/**
 * The database side of the chip economy. Every write is one transaction, and
 * the database itself enforces the rules (see the hand-written part of
 * drizzle/0000_init.sql): ledger_entries and rounds are append-only, every
 * entry moves its account's balance in the same transaction, no player
 * balance goes below zero, and at commit every round nets to zero and all
 * accounts sum to zero.
 *
 * Single-writer rule (SECURITY.md): while a player is at a table, every
 * change to their chips goes through that table's room, and nothing else
 * writes to their balance. The room's in-memory ledger is a cache of this
 * database for the players at its table.
 */

export type KaudaDb = PgDatabase<PgQueryResultHKT, typeof schema>;
export type PlayerKind = "human" | "bot";
export type TransferReason = "buyin" | "botBuyin" | "topup" | "botResidual";

export interface TransferInput {
  readonly accountId: string;
  /** Used only if the account does not exist yet. */
  readonly displayName: string;
  readonly kind: PlayerKind;
  readonly reason: TransferReason;
  /** The player's side: positive from the mint, negative back to it. */
  readonly chips: number;
  /** Epoch ms of the event, from the table's clock. */
  readonly at: number;
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly accounts: number;
  readonly entries: number;
  readonly rounds: number;
  /** Chips held by players: minus the mint's balance when the books balance. */
  readonly chipsInExistence: number;
}

export interface ChipStore {
  /** Creates the account if it is new. Returns its balance, and whether it was created. */
  openAccount(input: { id: string; displayName: string; kind: PlayerKind }): Promise<{ balance: number; created: boolean }>;
  balanceOf(accountId: string): Promise<number | null>;
  /** When this account last had an entry with this reason (epoch ms), or null. */
  lastEntryAt(accountId: string, reason: TransferReason | "round"): Promise<number | null>;
  /** One transfer between the mint and a player, in one transaction. */
  transfer(input: TransferInput): Promise<void>;
  /** Inserts the round, an entry per non-zero delta and so every balance, in one transaction. */
  settleRound(tableId: string, record: RoundRecord): Promise<void>;
  /** Recomputes every balance from the ledger and checks the books. Read-only. */
  verify(): Promise<VerifyReport>;
  /** Where the data lives, for logs. Never includes a password. */
  readonly description: string;
  close(): Promise<void>;
}

export class RoundDoesNotBalanceError extends Error {
  constructor(roundId: string, sum: number) {
    super(`round ${roundId} does not balance: its deltas sum to ${sum}; rolled back`);
    this.name = "RoundDoesNotBalanceError";
  }
}

interface Executor {
  execute(query: SQL): Promise<unknown>;
}

/** Rows of a raw query; both drivers return them under `rows`. */
async function rows<T>(db: Executor, query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as { rows: T[] }).rows;
}

const ISSUE: ReadonlySet<TransferReason> = new Set(["buyin", "botBuyin", "topup"]);

export class DrizzleChipStore implements ChipStore {
  readonly db: KaudaDb;
  readonly description: string;
  readonly #close: () => Promise<void>;

  constructor(db: KaudaDb, description: string, close: () => Promise<void>) {
    this.db = db;
    this.description = description;
    this.#close = close;
  }

  async openAccount(input: { id: string; displayName: string; kind: PlayerKind }): Promise<{ balance: number; created: boolean }> {
    const inserted = await this.db
      .insert(accounts)
      .values({ id: input.id, displayName: input.displayName, kind: input.kind })
      .onConflictDoNothing()
      .returning({ id: accounts.id });
    const [row] = await this.db
      .select({ balance: accounts.balance, kind: accounts.kind })
      .from(accounts)
      .where(eq(accounts.id, input.id));
    if (row === undefined) throw new Error(`account ${input.id} vanished`);
    if (row.kind !== input.kind) throw new Error(`account ${input.id} is a ${row.kind}, not a ${input.kind}`);
    return { balance: row.balance, created: inserted.length === 1 };
  }

  async balanceOf(accountId: string): Promise<number | null> {
    const [row] = await this.db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, accountId));
    return row?.balance ?? null;
  }

  async lastEntryAt(accountId: string, reason: TransferReason | "round"): Promise<number | null> {
    const [row] = await this.db
      .select({ at: ledgerEntries.createdAt })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.accountId, accountId), eq(ledgerEntries.reason, reason)))
      .orderBy(desc(ledgerEntries.seq))
      .limit(1);
    return row === undefined ? null : row.at.getTime();
  }

  async transfer(t: TransferInput): Promise<void> {
    if (!Number.isSafeInteger(t.chips) || t.chips === 0) throw new RangeError(`chips must be a non-zero whole number, got ${t.chips}`);
    if (ISSUE.has(t.reason) !== t.chips > 0) throw new RangeError(`a ${t.reason} cannot move ${t.chips} chips`);
    if (t.accountId === MINT_ID) throw new RangeError("the mint cannot pay itself");
    const at = new Date(t.at);
    await this.db.transaction(async (tx) => {
      await tx.insert(accounts).values({ id: t.accountId, displayName: t.displayName, kind: t.kind }).onConflictDoNothing();
      await tx.insert(ledgerEntries).values([
        { accountId: t.accountId, chips: t.chips, reason: t.reason, createdAt: at },
        { accountId: MINT_ID, chips: -t.chips, reason: t.reason, createdAt: at },
      ]);
    });
  }

  async settleRound(tableId: string, r: RoundRecord): Promise<void> {
    const throwerAccountId = r.occupants[r.thrower];
    if (throwerAccountId === undefined) throw new Error(`round ${r.roundId} has nobody on the throwing seat`);
    const at = new Date(r.at);
    await this.db.transaction(async (tx) => {
      await tx.insert(rounds).values({
        id: r.roundId,
        tableId,
        throwerSeat: r.thrower,
        throwerAccountId,
        commitHash: r.commitHash,
        seed: r.seed,
        faceUp: r.faceUp,
        winningSeat: r.winningSeat,
        hit: r.hit,
        stake: r.stake,
        stakeMultiplier: r.multiplier,
        deltas: { ...r.deltas },
        replay: {
          thrower: r.thrower,
          streak: r.streak,
          occupants: { ...r.occupants },
          chyakhe: r.chyakhe.map((b) => ({ ...b })),
          faces: [...r.faces],
          rules: { ...r.rules },
        },
        createdAt: at,
      });
      const moved = Object.entries(r.deltas).filter(([, chips]) => chips !== 0);
      if (moved.length > 0) {
        await tx.insert(ledgerEntries).values(
          moved.map(([accountId, chips]) => ({ accountId, roundId: r.roundId, chips, reason: "round" as const, createdAt: at })),
        );
      }
      // Asserted here, inside the transaction, as well as by the deferred
      // trigger at commit: a round whose deltas do not sum to zero rolls back.
      const [sum] = await rows<{ total: string | number }>(
        tx,
        sql`SELECT COALESCE(SUM(${ledgerEntries.chips}), 0) AS total FROM ${ledgerEntries} WHERE ${ledgerEntries.roundId} = ${r.roundId}`,
      );
      const total = Number(sum?.total ?? 0);
      if (total !== 0) throw new RoundDoesNotBalanceError(r.roundId, total);
    });
  }

  async verify(): Promise<VerifyReport> {
    const problems: string[] = [];
    const num = (v: unknown): number => Number(v ?? 0);

    const drift = await rows<{ id: string; balance: string | number; computed: string | number }>(
      this.db,
      sql`SELECT a.id, a.balance, COALESCE(SUM(l.chips), 0) AS computed
            FROM accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
           GROUP BY a.id, a.balance
          HAVING a.balance <> COALESCE(SUM(l.chips), 0)`,
    );
    for (const d of drift) {
      problems.push(`account ${d.id}: balance ${num(d.balance)}, but its ledger entries sum to ${num(d.computed)}`);
    }

    const [totals] = await rows<{
      accounts: string | number;
      balances: string | number;
      mints: string | number;
      negative: string | number;
      in_play: string | number;
    }>(
      this.db,
      sql`SELECT COUNT(*) AS accounts,
                 COALESCE(SUM(balance), 0) AS balances,
                 COUNT(*) FILTER (WHERE kind = 'mint') AS mints,
                 COUNT(*) FILTER (WHERE kind <> 'mint' AND balance < 0) AS negative,
                 COALESCE(SUM(balance) FILTER (WHERE kind <> 'mint'), 0) AS in_play
            FROM accounts`,
    );
    if (num(totals?.balances) !== 0) problems.push(`all accounts including the mint sum to ${num(totals?.balances)}, not 0`);
    if (num(totals?.mints) !== 1) problems.push(`there are ${num(totals?.mints)} mint accounts, not 1`);
    if (num(totals?.negative) !== 0) problems.push(`${num(totals?.negative)} player accounts are below zero`);

    const [ledger] = await rows<{ entries: string | number; total: string | number; round_total: string | number }>(
      this.db,
      sql`SELECT COUNT(*) AS entries, COALESCE(SUM(chips), 0) AS total,
                 COALESCE(SUM(chips) FILTER (WHERE reason = 'round'), 0) AS round_total
            FROM ledger_entries`,
    );
    if (num(ledger?.total) !== 0) problems.push(`ledger entries sum to ${num(ledger?.total)}, not 0`);
    if (num(ledger?.round_total) !== 0) problems.push(`"round" entries sum to ${num(ledger?.round_total)}, not 0`);

    // Each round's entries must be exactly its non-zero deltas.
    const settled = await rows<{ id: string; deltas: Record<string, number> | string }>(this.db, sql`SELECT id, deltas FROM rounds`);
    const entries = await rows<{ round_id: string; account_id: string; chips: string | number }>(
      this.db,
      sql`SELECT round_id, account_id, chips FROM ledger_entries WHERE round_id IS NOT NULL`,
    );
    const byRound = new Map<string, Map<string, number>>();
    for (const e of entries) {
      const m = byRound.get(e.round_id) ?? new Map<string, number>();
      m.set(e.account_id, num(e.chips));
      byRound.set(e.round_id, m);
    }
    for (const r of settled) {
      const deltas = typeof r.deltas === "string" ? (JSON.parse(r.deltas) as Record<string, number>) : r.deltas;
      const want = Object.entries(deltas).filter(([, c]) => c !== 0);
      const got = byRound.get(r.id) ?? new Map<string, number>();
      const same = want.length === got.size && want.every(([id, c]) => got.get(id) === c);
      if (!same) problems.push(`round ${r.id}: ledger entries do not match its recorded deltas`);
      byRound.delete(r.id);
    }
    for (const id of byRound.keys()) problems.push(`ledger entries name round ${id}, which is not in rounds`);

    return {
      ok: problems.length === 0,
      problems,
      accounts: num(totals?.accounts),
      entries: num(ledger?.entries),
      rounds: settled.length,
      chipsInExistence: num(totals?.in_play),
    };
  }

  close(): Promise<void> {
    return this.#close();
  }
}
