import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { DEFAULT_HOUSE_RULES, type SeatId } from "@kauda/rules";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MINT_ACCOUNT,
  commitmentFromSeed,
  facesFromSeed,
  seedForFaceCount,
  type RoundRecord,
} from "../src/index.js";
import { openChipStore } from "../src/db/open.js";
import { RoundDoesNotBalanceError, type DrizzleChipStore } from "../src/db/store.js";

/** The database on its own: a fresh in-memory PGlite for this file. */
let store: DrizzleChipStore;
beforeAll(async () => {
  store = await openChipStore({ dataDir: null });
});
afterAll(async () => {
  await store.close();
});

let n = 0;
/** A settled round with the given deltas; the seed and hash are real. */
function round(deltas: Record<string, number>, thrower: SeatId = "teeya"): RoundRecord {
  const seed = seedForFaceCount(3, n);
  const c = commitmentFromSeed(seed);
  const ids = Object.keys(deltas);
  const occupants: Partial<Record<SeatId, string>> = {};
  (["teeya", "chauka", "panja", "chakka"] as const).forEach((s, i) => {
    const id = ids[i];
    if (id !== undefined) occupants[s] = id;
  });
  return {
    roundId: `db-test:${++n}`,
    seed: c.seed,
    commitHash: c.commitHash,
    faces: facesFromSeed(seed),
    faceUp: 3,
    winningSeat: "teeya",
    hit: true,
    stake: 10,
    multiplier: 1,
    deltas,
    at: 1_000_000 + n,
    thrower,
    streak: 0,
    occupants,
    chyakhe: [],
    rules: DEFAULT_HOUSE_RULES,
  };
}

async function fund(id: string, chips: number, kind: "human" | "bot" = "human"): Promise<void> {
  await store.transfer({ accountId: id, displayName: id, kind, reason: kind === "bot" ? "botBuyin" : "buyin", chips, at: 1 });
}

async function count(table: "rounds" | "ledger_entries", roundId: string): Promise<number> {
  const column = table === "rounds" ? sql`id` : sql`round_id`;
  const res = (await store.db.execute(
    sql`SELECT COUNT(*) AS n FROM ${sql.identifier(table)} WHERE ${column} = ${roundId}`,
  )) as unknown as { rows: { n: string | number }[] };
  return Number(res.rows[0]?.n ?? 0);
}

async function refused(query: string): Promise<string> {
  try {
    await store.db.execute(sql.raw(query));
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  throw new Error(`expected this to be refused: ${query}`);
}

describe("chip store", () => {
  it("creates exactly one mint, in the first migration", async () => {
    expect(await store.balanceOf(MINT_ACCOUNT)).toBe(0);
    expect(await refused(`INSERT INTO accounts (id, display_name, kind) VALUES ('mint2', 'Mint 2', 'mint')`)).toMatch(
      /accounts_one_mint/,
    );
  });

  it("persists a round atomically: the round, its entries and every balance", async () => {
    await fund("a1", 500);
    await fund("a2", 500);
    await fund("a3", 500);
    const r = round({ a1: 30, a2: -10, a3: -20 });
    await store.settleRound("t1", r);
    expect(await count("rounds", r.roundId)).toBe(1);
    expect(await count("ledger_entries", r.roundId)).toBe(3);
    expect(await store.balanceOf("a1")).toBe(530);
    expect(await store.balanceOf("a2")).toBe(490);
    expect(await store.balanceOf("a3")).toBe(480);
    // A push moves no chips, and is still recorded.
    const push = round({ a1: 0, a2: 0 });
    await store.settleRound("t1", push);
    expect(await count("rounds", push.roundId)).toBe(1);
    expect(await count("ledger_entries", push.roundId)).toBe(0);
    expect((await store.verify()).ok).toBe(true);
  });

  it("leaves no partial rows when a round fails mid-transaction", async () => {
    await fund("b1", 500);
    await fund("b2", 500);
    // Deltas that do not sum to zero: the round row and entries are written,
    // then the check inside the transaction fails, and all of it rolls back.
    const unbalanced = round({ b1: 30, b2: -10 });
    await expect(store.settleRound("t1", unbalanced)).rejects.toThrow(RoundDoesNotBalanceError);
    expect(await count("rounds", unbalanced.roundId)).toBe(0);
    expect(await count("ledger_entries", unbalanced.roundId)).toBe(0);
    // A delta for an account that does not exist: the insert fails partway.
    const unknown = round({ b1: 10, nobody: -10 });
    await expect(store.settleRound("t1", unknown)).rejects.toThrow();
    expect(await count("rounds", unknown.roundId)).toBe(0);
    expect(await count("ledger_entries", unknown.roundId)).toBe(0);
    expect(await store.balanceOf("b1")).toBe(500);
    expect(await store.balanceOf("b2")).toBe(500);
    // The same round id cannot be settled twice.
    const ok = round({ b1: 10, b2: -10 });
    await store.settleRound("t1", ok);
    await expect(store.settleRound("t1", ok)).rejects.toThrow();
    expect(await store.balanceOf("b1")).toBe(510);
    expect((await store.verify()).ok).toBe(true);
  });

  it("refuses UPDATE and DELETE on ledger_entries and rounds", async () => {
    await fund("c1", 100);
    expect(await refused(`UPDATE ledger_entries SET chips = 1`)).toMatch(/append-only/);
    expect(await refused(`DELETE FROM ledger_entries`)).toMatch(/append-only/);
    expect(await refused(`TRUNCATE ledger_entries CASCADE`)).toMatch(/append-only/);
    expect(await refused(`UPDATE rounds SET stake = 1`)).toMatch(/append-only/);
    expect(await refused(`DELETE FROM rounds`)).toMatch(/append-only/);
    expect(await refused(`DELETE FROM accounts WHERE id = 'c1'`)).toMatch(/append-only/);
  });

  it("moves balances only through the ledger", async () => {
    expect(await refused(`UPDATE accounts SET balance = balance + 1 WHERE id = 'c1'`)).toMatch(/only through ledger_entries/);
    expect(await refused(`INSERT INTO accounts (id, display_name, kind, balance) VALUES ('rich', 'Rich', 'human', 1000)`)).toMatch(
      /starts at 0/,
    );
    // An entry that is not part of a balanced transaction fails at commit.
    expect(await refused(`INSERT INTO ledger_entries (account_id, chips, reason) VALUES ('c1', 5, 'topup')`)).toMatch(
      /books do not balance/,
    );
    expect(await store.balanceOf("c1")).toBe(100);
  });

  it("never lets a player go below zero, while the mint can", async () => {
    await fund("d1", 50);
    await fund("d2", 50);
    await expect(store.settleRound("t1", round({ d1: 60, d2: -60 }))).rejects.toThrow();
    expect(await store.balanceOf("d2")).toBe(50);
    await expect(
      store.transfer({ accountId: "d2", displayName: "d2", kind: "bot", reason: "botResidual", chips: -51, at: 1 }),
    ).rejects.toThrow();
    expect(await store.balanceOf("d2")).toBe(50);
    expect(await store.balanceOf(MINT_ACCOUNT)).toBeLessThan(0);
    const report = await store.verify();
    expect(report.ok).toBe(true);
    expect(report.chipsInExistence).toBe(-(await store.balanceOf(MINT_ACCOUNT))!);
  });

  it("refuses transfers that go the wrong way", async () => {
    await expect(store.transfer({ accountId: "e1", displayName: "e1", kind: "human", reason: "buyin", chips: -5, at: 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      store.transfer({ accountId: "e1", displayName: "e1", kind: "bot", reason: "botResidual", chips: 5, at: 1 }),
    ).rejects.toThrow(RangeError);
    await expect(store.transfer({ accountId: MINT_ACCOUNT, displayName: "m", kind: "human", reason: "buyin", chips: 5, at: 1 })).rejects.toThrow();
  });
});

describe("verify", () => {
  it("catches a deliberately corrupted balance", async () => {
    // Its own database: the corruption breaks the books for everything after.
    const own = await openChipStore({ dataDir: null });
    try {
      await own.transfer({ accountId: "v1", displayName: "v1", kind: "human", reason: "buyin", chips: 100, at: 1 });
      expect((await own.verify()).ok).toBe(true);
      // Corrupt it the way only someone with superuser rights could: with the
      // triggers switched off, as a careless manual fix would.
      await own.db.execute(sql`SET session_replication_role = replica`);
      await own.db.execute(sql`UPDATE accounts SET balance = 150 WHERE id = 'v1'`);
      await own.db.execute(sql`SET session_replication_role = DEFAULT`);
      const report = await own.verify();
      expect(report.ok).toBe(false);
      expect(report.problems).toContain("account v1: balance 150, but its ledger entries sum to 100");
      expect(report.problems).toContain("all accounts including the mint sum to 50, not 0");
    } finally {
      await own.close();
    }
  });
});

describe("node-postgres driver", () => {
  it("runs the same schema, triggers and checks through DATABASE_URL", async () => {
    // A real Postgres wire protocol endpoint over PGlite, so the production
    // driver path is exercised without Docker. One connection, used in turn.
    const raw = new PGlite();
    const server = new PGLiteSocketServer({ db: raw, port: 0, host: "127.0.0.1" });
    await server.start();
    const url = `postgres://postgres@${server.getServerConn()}/postgres?sslmode=disable`;
    const pgStore = await openChipStore({ databaseUrl: url });
    try {
      expect(pgStore.description).toMatch(/^Postgres at /);
      await pgStore.transfer({ accountId: "p1", displayName: "p1", kind: "human", reason: "buyin", chips: 300, at: 1 });
      await pgStore.transfer({ accountId: "p2", displayName: "p2", kind: "human", reason: "buyin", chips: 300, at: 1 });
      await pgStore.settleRound("pg", round({ p1: 40, p2: -40 }));
      await expect(pgStore.settleRound("pg", round({ p1: 40, p2: -30 }))).rejects.toThrow(RoundDoesNotBalanceError);
      expect(await pgStore.balanceOf("p1")).toBe(340);
      expect(await pgStore.balanceOf("p2")).toBe(260);
      expect(await pgStore.lastEntryAt("p1", "buyin")).toBe(1);
      const report = await pgStore.verify();
      expect(report).toMatchObject({ ok: true, rounds: 1, chipsInExistence: 600 });
    } finally {
      await pgStore.close();
      await server.stop();
      await raw.close();
    }
  });
});
