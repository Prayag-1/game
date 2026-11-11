import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TURN_ORDER } from "@kauda/rules";
import { MINT_ACCOUNT, Table, botSeatFilling, commitmentFromSeed, type TableOptions } from "../src/index.js";
import { openChipStore } from "../src/db/open.js";
import { TablePersistence } from "../src/db/persistence.js";
import type { ChipStore, DrizzleChipStore } from "../src/db/store.js";
import { TEST_RULES, lcg } from "./harness.js";

/**
 * A Table with its chips in a database: a fresh in-memory PGlite for this
 * file, a fake clock, and the same write-behind queue the room uses.
 */
let store: DrizzleChipStore;
beforeAll(async () => {
  store = await openChipStore({ dataDir: null });
});
afterAll(async () => {
  await store.close();
});

async function query<T>(q: SQL): Promise<T[]> {
  return ((await store.db.execute(q)) as unknown as { rows: T[] }).rows;
}

let tableNo = 0;

interface Session {
  readonly table: Table;
  readonly persistence: TablePersistence;
  readonly failures: unknown[];
  /** Moves the clock, ticks, queues what happened, and waits for it to be written. */
  step(ms?: number): Promise<void>;
  /** Admits a human from the database and seats them at the table. */
  join(id: string): Promise<void>;
}

function session(db: ChipStore, options: Partial<TableOptions> = {}, botBuyIn = 2_000): Session {
  let t = 1_000_000;
  let seeds = 0;
  const tableId = `p${++tableNo}`;
  const table = new Table(
    { tableId, rules: TEST_RULES, ...options },
    {
      now: () => t,
      commitments: () => commitmentFromSeed(Uint8Array.from(createHash("sha256").update(`${tableId}-${seeds++}`).digest())),
      botRandom: lcg(tableNo),
      seatFilling: botSeatFilling({ buyIn: botBuyIn, idPrefix: `bot:${tableId}:` }),
    },
  );
  const failures: unknown[] = [];
  const persistence = new TablePersistence(table, db, {
    onFailure: (e) => failures.push(e),
    displayName: (id) => id,
    now: () => t,
  });
  return {
    table,
    persistence,
    failures,
    async step(ms = 500) {
      t += ms;
      table.tick();
      persistence.pump();
      await persistence.idle();
    },
    async join(id) {
      const { created } = await persistence.admit(id, id);
      const r = table.join(id, { name: id, ...(created ? { buyIn: table.standardBuyIn } : {}) });
      if (!r.ok) throw new Error(`${id} could not join: ${r.reason}`);
      persistence.pump();
      await persistence.idle();
    },
  };
}

async function playRounds(s: Session, rounds: number, each?: () => void): Promise<void> {
  const target = s.table.roundCount + rounds;
  for (let i = 0; i < 100 * rounds && s.table.roundCount < target; i += 1) {
    each?.();
    await s.step();
  }
  expect(s.table.roundCount).toBe(target);
}

describe("a table backed by the database", () => {
  it("recovers every balance after a restart", async () => {
    const first = session(store);
    for (const id of ["r-asha", "r-bina"]) await first.join(id);
    first.table.handle("r-asha", { type: "sit", seat: "teeya" });
    await playRounds(first, 25);
    const before = { asha: first.table.balance("r-asha"), bina: first.table.balance("r-bina") };
    expect(before.asha).not.toBe(first.table.standardBuyIn); // A really played
    expect(await store.balanceOf("r-asha")).toBe(before.asha);

    // "Restart": the table and its in-memory ledger are gone; a new one starts empty.
    const second = session(store);
    expect(second.table.balance("r-asha")).toBe(0);
    for (const id of ["r-asha", "r-bina"]) await second.join(id);
    expect(second.table.balance("r-asha")).toBe(before.asha);
    expect(second.table.balance("r-bina")).toBe(before.bina);
    // Returning players get no second buy-in.
    const [buyins] = await query<{ n: string }>(
      sql`SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id = 'r-asha' AND reason = 'buyin'`,
    );
    expect(Number(buyins?.n)).toBe(1);
    expect((await store.verify()).ok).toBe(true);
  });

  it("keeps two tables settling at the same time for different players apart", async () => {
    const a = session(store);
    const b = session(store);
    await a.join("x-ama");
    await b.join("x-ben");
    a.table.handle("x-ama", { type: "sit", seat: "chauka" });
    b.table.handle("x-ben", { type: "sit", seat: "panja" });
    // Interleaved: both tables tick and write in the same turns of the event loop.
    for (let i = 0; i < 2_000 && (a.table.roundCount < 30 || b.table.roundCount < 30); i += 1) {
      await Promise.all([a.step(), b.step()]);
    }
    expect(a.table.roundCount).toBeGreaterThanOrEqual(30);
    expect(b.table.roundCount).toBeGreaterThanOrEqual(30);
    expect(a.failures).toEqual([]);
    expect(b.failures).toEqual([]);
    // Every player the database knows from either table matches its table.
    for (const s of [a, b]) {
      const ids = new Set(s.table.ledger.entries().map((e) => e.playerId).filter((id) => id !== MINT_ACCOUNT));
      for (const id of ids) expect(await store.balanceOf(id), id).toBe(s.table.balance(id));
    }
    expect((await store.verify()).ok).toBe(true);
  });

  it("holds the mint invariant in the database over 200 rounds of bot churn, top-ups and residuals", async () => {
    // Small bankrolls: bots go broke and are replaced, the human busts and tops up.
    const s = session(store, { minChipsToSit: 80, standardBuyIn: 200, topUpCooldownMs: 20_000 }, 200);
    await s.join("m-hari");
    let topUps = 0;
    await playRounds(s, 200, () => {
      if (s.table.topUpOffer("m-hari").ok && s.table.claimTopUp("m-hari").ok) topUps += 1;
      if (s.table.seatOf("m-hari") === null) s.table.handle("m-hari", { type: "sit", seat: "teeya" });
    });
    s.persistence.pump();
    await s.persistence.idle();
    expect(s.failures).toEqual([]);

    const report = await store.verify();
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    const mint = await store.balanceOf(MINT_ACCOUNT);
    expect(report.chipsInExistence).toBe(-(mint ?? 0));

    const reasons = await query<{ reason: string; n: string }>(
      sql`SELECT reason, COUNT(*) AS n FROM ledger_entries WHERE account_id <> 'system:mint' GROUP BY reason`,
    );
    const byReason = Object.fromEntries(reasons.map((r) => [r.reason, Number(r.n)]));
    expect(topUps).toBeGreaterThanOrEqual(1);
    expect(byReason.topup).toBeGreaterThanOrEqual(topUps);
    expect(byReason.botBuyin).toBeGreaterThan(3);
    expect(byReason.botResidual).toBeGreaterThan(0);
    // Every round, pushes included, is recorded.
    const [recorded] = await query<{ n: string }>(sql`SELECT COUNT(*) AS n FROM rounds WHERE table_id = ${s.table.tableId}`);
    expect(Number(recorded?.n)).toBe(s.table.roundCount);
    // The table's cache agrees with the database for everyone still at it.
    const v = s.table.view();
    for (const p of [...TURN_ORDER.map((seat) => v.seats[seat]), ...v.chyakhe]) {
      if (p !== null) expect(await store.balanceOf(p.playerId), p.playerId).toBe(p.chips);
    }
  });

  it("stops writing at the first failure, and reports it once", async () => {
    let failAfter = 3;
    const failing: ChipStore = {
      description: "failing",
      openAccount: (i) => store.openAccount(i),
      balanceOf: (id) => store.balanceOf(id),
      lastEntryAt: (id, r) => store.lastEntryAt(id, r),
      transfer: (t) => store.transfer(t),
      settleRound: async (tableId, r) => {
        if (failAfter-- <= 0) throw new Error("disk full");
        return store.settleRound(tableId, r);
      },
      verify: () => store.verify(),
      close: async () => {},
    };
    const s = session(failing);
    await s.join("f-gita");
    for (let i = 0; i < 400 && s.failures.length === 0; i += 1) await s.step();
    expect(s.failures).toHaveLength(1);
    expect(s.persistence.failed).toBe(true);
    const [settled] = await query<{ n: string }>(sql`SELECT COUNT(*) AS n FROM rounds WHERE table_id = ${s.table.tableId}`);
    expect(Number(settled?.n)).toBe(3);
    // More play queues nothing further.
    await s.step();
    await s.step();
    expect(s.persistence.pending).toBe(0);
    expect(s.failures).toHaveLength(1);
    await expect(s.persistence.admit("f-late", "f-late")).rejects.toThrow(/paused/);
    expect((await store.verify()).ok).toBe(true);
  });
});
