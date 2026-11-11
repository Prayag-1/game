import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TURN_ORDER, type SeatId } from "@kauda/rules";
import {
  MINT_ACCOUNT,
  Table,
  botSeatFilling,
  commitmentFromSeed,
  verifyThrow,
  type Commitment,
  type TableView,
} from "../src/index.js";
import { TEST_RULES, lcg } from "./harness.js";

/**
 * Model-based fuzz test: long random sequences of commands, joins, bot churn,
 * connection changes and clock advances, with seat filling on. Every
 * invariant is checked after every single step.
 */

const HUMANS = ["H0", "H1", "H2", "H3", "H4", "H5"] as const;
const BOTS = ["Z0", "Z1", "Z2", "Z3"] as const;
const SEATS = TURN_ORDER;

type Action =
  | { readonly k: "join"; readonly who: number; readonly buyIn: number | null }
  | { readonly k: "joinBot"; readonly who: number; readonly buyIn: number }
  | { readonly k: "sit"; readonly who: number; readonly seat: SeatId }
  | { readonly k: "stand"; readonly who: number }
  | { readonly k: "bet"; readonly who: number; readonly seat: SeatId; readonly chips: number }
  | { readonly k: "clearBet"; readonly who: number }
  | { readonly k: "throw"; readonly who: number | "thrower" }
  | { readonly k: "leave"; readonly who: number }
  | { readonly k: "topUp"; readonly who: number }
  | { readonly k: "connect"; readonly who: number; readonly on: boolean }
  | { readonly k: "junk"; readonly who: number; readonly raw: unknown }
  | { readonly k: "advance"; readonly ms: number }
  | { readonly k: "toPhaseEnd" };

const who = fc.nat({ max: 63 });
const seat = fc.constantFrom(...SEATS);
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("join" as const), who, buyIn: fc.option(fc.integer({ min: 1, max: 400 })) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("joinBot" as const), who, buyIn: fc.integer({ min: 1, max: 400 }) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("sit" as const), who, seat }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("stand" as const), who }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("bet" as const), who, seat, chips: fc.integer({ min: 1, max: 300 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("clearBet" as const), who }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("throw" as const), who: fc.oneof(fc.constant("thrower" as const), who) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("leave" as const), who }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("topUp" as const), who }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("connect" as const), who, on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("junk" as const), who, raw: fc.anything() }) },
  { weight: 8, arbitrary: fc.record({ k: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 3_000 }) }) },
  { weight: 3, arbitrary: fc.constant({ k: "toPhaseEnd" as const }) },
);

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function runSequence(seed: number, actions: readonly Action[]): void {
  let t = 1_000_000;
  const pendingSeeds = new Set<string>();
  // Seed -> the commit hash the factory handed out with it.
  const issuedHash = new Map<string, string>();
  let issued = 0;
  const commitments = (): Commitment => {
    const bytes = Uint8Array.from(createHash("sha256").update(`fuzz-${seed}-${issued++}`).digest());
    const c = commitmentFromSeed(bytes);
    pendingSeeds.add(hex(bytes));
    issuedHash.set(hex(bytes), c.commitHash);
    return c;
  };
  const table = new Table(
    {
      tableId: "fz",
      rules: { ...TEST_RULES, ghantiChips: 5 },
      minChipsToSit: 80,
      // Small bankrolls, so bots go broke and are replaced again and again.
      standardBuyIn: 200,
      topUpCooldownMs: 5_000,
      reservationMaxRounds: 2,
      reservationMaxMs: 8_000,
      timings: { bettingMs: 2_000, throwingMs: 3_000, revealMs: 1_000, botThrowDelayMs: 300, botBetDelayMs: 400 },
    },
    {
      now: () => t,
      commitments,
      botRandom: lcg(seed),
      seatFilling: botSeatFilling({ buyIn: 200, idPrefix: "fill-" }),
    },
  );

  // Incremental view of the append-only ledger.
  let seen = 0;
  let allSum = 0;
  let roundSum = 0;
  const balances = new Map<string, number>();
  // Round id -> the commit hash shown while its betting was open.
  const published = new Map<string, string>();
  let checkedRecords = 0;

  const resolve = (n: number, view: TableView): string => {
    const present = [...Object.values(view.seats), ...view.chyakhe].flatMap((p) => (p === null ? [] : [p.playerId]));
    const pool = [...HUMANS, ...BOTS, ...present, "ghost"];
    return pool[n % pool.length] ?? "ghost";
  };

  const step = (a: Action): void => {
    const view = table.view();
    switch (a.k) {
      case "join": {
        const id = resolve(a.who, view);
        table.join(id, { name: id, ...(a.buyIn === null ? {} : { buyIn: a.buyIn }) });
        return;
      }
      case "joinBot": {
        const id = BOTS[a.who % BOTS.length] ?? "Z0";
        table.join(id, { name: id, isBot: true, buyIn: a.buyIn });
        return;
      }
      case "sit":
        table.handle(resolve(a.who, view), { type: "sit", seat: a.seat });
        return;
      case "stand":
        table.handle(resolve(a.who, view), { type: "stand" });
        return;
      case "bet":
        table.handle(resolve(a.who, view), { type: "placeBet", seat: a.seat, chips: a.chips });
        return;
      case "clearBet":
        table.handle(resolve(a.who, view), { type: "clearBet" });
        return;
      case "throw": {
        const thrower = view.thrower === null ? undefined : view.seats[view.thrower]?.playerId;
        const id = a.who === "thrower" ? (thrower ?? "ghost") : resolve(a.who, view);
        table.handle(id, { type: "throw" });
        return;
      }
      case "leave":
        table.handle(resolve(a.who, view), { type: "leave" });
        return;
      case "topUp":
        table.claimTopUp(resolve(a.who, view));
        return;
      case "connect":
        table.setConnected(resolve(a.who, view), a.on);
        return;
      case "junk":
        table.handle(resolve(a.who, view), a.raw);
        return;
      case "advance":
        t += a.ms;
        table.tick();
        return;
      case "toPhaseEnd":
        if (view.phaseEndsAt !== null) t = Math.max(t, view.phaseEndsAt);
        table.tick();
        return;
    }
  };

  // Plain comparisons on the hot path: this runs after every one of ~70,000
  // steps, and a vitest expect() per invariant made it several times slower.
  const fail = (message: string): never => expect.fail(message);

  const check = (): void => {
    const view = table.view();
    const json = JSON.stringify(view);

    // Ledger: every account including the mint sums to 0, no player is
    // negative, and round entries net to 0. Counted from the entries.
    if (table.ledger.entryCount < seen) fail("the ledger lost entries");
    const touched = new Set<string>();
    const fresh = table.ledger.entriesSince(seen);
    for (const e of fresh) {
      allSum += e.chips;
      if (e.reason === "round") roundSum += e.chips;
      balances.set(e.playerId, (balances.get(e.playerId) ?? 0) + e.chips);
      touched.add(e.playerId);
    }
    seen += fresh.length;
    if (allSum !== 0) fail(`all accounts sum to ${allSum}`);
    if (table.ledger.sumOfAllAccounts() !== 0) fail(`the ledger cache sums to ${table.ledger.sumOfAllAccounts()}`);
    if (roundSum !== 0) fail(`round entries net to ${roundSum}`);
    // Balances only change on accounts with new entries, so those are the
    // only ones to check.
    for (const id of touched) {
      const bal = balances.get(id) ?? 0;
      if (id !== MINT_ACCOUNT && bal < 0) fail(`${id} is negative: ${bal}`);
      if (table.balance(id) !== bal) fail(`${id}: table says ${table.balance(id)}, entries say ${bal}`);
    }

    // Seats: full while a round is live, one seat per player.
    const seated = SEATS.flatMap((s) => {
      const p = view.seats[s];
      return p === null ? [] : [p.playerId];
    });
    if ((view.phase === "betting" || view.phase === "throwing") && seated.length !== 4) {
      fail(`only ${seated.length} seats occupied during ${view.phase}: ${JSON.stringify(seated)}`);
    }
    if (new Set(seated).size !== seated.length) fail(`a player holds two seats: ${JSON.stringify(seated)}`);
    const unseated = view.chyakhe.map((p) => p.playerId);
    if (unseated.some((id) => seated.includes(id))) fail("a seated player is also listed as chyakhe");
    if (new Set(unseated).size !== unseated.length) fail("a chyakhe is listed twice");
    if (seated.length + unseated.length > 12) fail(`${seated.length + unseated.length} players at the table`);

    // Every settled round verifies against the hash committed for it.
    const settled = table.recordsSince(checkedRecords);
    for (const r of settled) {
      pendingSeeds.delete(r.seed);
      if (issuedHash.get(r.seed) !== r.commitHash) fail(`${r.roundId} settled on a seed nobody committed to`);
      // A big clock jump can open and settle a round inside one tick, so the
      // betting view is not always observed; when it was, it must match.
      const shown = published.get(r.roundId);
      if (shown !== undefined && shown !== r.commitHash) fail(`${r.roundId} showed hash ${shown}, settled ${r.commitHash}`);
      if (!verifyThrow(r.seed, r.commitHash, r.faces)) fail(`${r.roundId} does not verify`);
      expect(Table.replay(r).deltas).toEqual(r.deltas);
      if (Object.values(r.deltas).reduce((x, y) => x + y, 0) !== 0) fail(`${r.roundId} does not sum to zero`);
    }
    checkedRecords += settled.length;

    // Commit-reveal: the pending seed never shows; record what was published.
    for (const s of pendingSeeds) if (json.includes(s)) fail("pending seed leaked into the view");
    if (view.phase === "betting" && view.roundId !== null && view.commitHash !== null) {
      const before = published.get(view.roundId);
      if (before !== undefined && before !== view.commitHash) fail(`${view.roundId} changed its commit hash`);
      published.set(view.roundId, view.commitHash);
    }
  };

  check();
  actions.forEach((a, i) => {
    try {
      step(a);
      check();
    } catch (e) {
      const v = table.view();
      const state = {
        phase: v.phase,
        thrower: v.thrower,
        seats: Object.fromEntries(SEATS.map((s) => [s, v.seats[s]?.playerId ?? null])),
        chyakhe: v.chyakhe.map((p) => `${p.playerId}${p.connected ? "" : "(off)"}:${p.chips}`),
        reservations: v.reservations,
        recent: actions.slice(Math.max(0, i - 8), i + 1),
      };
      throw new Error(`step ${i} ${JSON.stringify(a)}: ${(e as Error).message}
state ${JSON.stringify(state)}`, {
        cause: e,
      });
    }
  });
  table.ledger.verify();
}

describe("model-based fuzz", () => {
  it("holds every invariant after every step of 200 random sequences of 300+ steps", () => {
    let rounds = 0;
    fc.assert(
      fc.property(fc.integer(), fc.array(action, { minLength: 300, maxLength: 400 }), (seed, actions) => {
        runSequence(seed, actions);
        rounds += 1;
      }),
      // FUZZ_SHRINK=0 reports the first failure as found, without shrinking
      // (shrinking 300-step sequences is slow); FUZZ_SEED replays a run.
      {
        numRuns: 200,
        endOnFailure: process.env.FUZZ_SHRINK === "0",
        ...(process.env.FUZZ_SEED === undefined ? {} : { seed: Number(process.env.FUZZ_SEED) }),
      },
    );
    expect(rounds).toBeGreaterThanOrEqual(200);
  }, 120_000);
});
