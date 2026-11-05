import { describe, expect, it } from "vitest";
import { TURN_ORDER } from "@kauda/rules";
import { botSeatFilling, type RoundRecord, type SeatFillPolicy } from "../src/index.js";
import { TEST_RULES, harness, type Harness } from "./harness.js";

const BOT_BUY_IN = 2_000;
const filling = (): SeatFillPolicy => botSeatFilling({ buyIn: BOT_BUY_IN, idPrefix: "fresh-" });

function occupiedSeats(h: Harness): number {
  const seats = h.table.view().seats;
  return TURN_ORDER.filter((s) => seats[s] !== null).length;
}

/** Advances until the table is between rounds, however the throw happens. */
function untilRevealing(h: Harness): void {
  for (let i = 0; i < 200 && h.table.phase !== "revealing"; i += 1) h.advance(250);
  expect(h.table.phase).toBe("revealing");
}

const isPush =(r: RoundRecord): boolean => !r.hit && Object.values(r.deltas).every((c) => c === 0);

/** Human A on teeya, bots on the other three, with the given bot buy-ins. */
function humanAndBots(h: Harness, botChips: readonly [number, number, number], humanChips = 1_000): void {
  h.ok(h.table.join("A", { name: "A", buyIn: humanChips }));
  h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
  (["chauka", "panja", "chakka"] as const).forEach((seat, i) => {
    const id = `bot-${seat}`;
    h.ok(h.table.join(id, { name: id, isBot: true, buyIn: botChips[i] ?? 1_000 }));
    h.ok(h.table.handle(id, { type: "sit", seat }));
  });
}

describe("seat filling", () => {
  it("replaces a bot that drops below the stake, rather than just standing it up", () => {
    const h = harness({ minChipsToSit: 10 }, 7, filling());
    humanAndBots(h, [25, 1_000, 1_000]);
    h.queue(3); // A hits: bot-chauka pays 10 and is left with 15
    h.advance(0);
    h.playRound("A");

    // The next stake is 20, which bot-chauka cannot cover.
    const v = h.table.view();
    expect(v.stake).toBe(20);
    const chauka = v.seats.chauka;
    expect(chauka?.playerId).toBe("fresh-1");
    expect(chauka?.isBot).toBe(true);
    expect(chauka?.chips).toBe(BOT_BUY_IN);
    expect(occupiedSeats(h)).toBe(4);
    // The broke bot has left the table, not joined the chyakhe.
    expect(v.chyakhe.map((p) => p.playerId)).not.toContain("bot-chauka");
    // Its 15 chips are still in the ledger; nothing is erased.
    expect(h.table.balance("bot-chauka")).toBe(15);
    h.table.ledger.verify();
    // A keeps the throw and the streak.
    expect(v.thrower).toBe("teeya");
    expect(v.streak).toBe(1);
  });

  it("fills empty seats when a live table opens", () => {
    const h = harness({}, 7, filling());
    h.ok(h.table.join("A", { name: "A", buyIn: 1_000 }));
    h.ok(h.table.handle("A", { type: "sit", seat: "panja" }));
    h.advance(0);
    expect(h.table.phase).toBe("betting");
    expect(occupiedSeats(h)).toBe(4);
    expect(h.table.view().seats.panja?.playerId).toBe("A");
  });

  it("does not fill seats at a table with no connected human", () => {
    const h = harness({}, 7, filling());
    h.ok(h.table.join("A", { name: "A", buyIn: 1_000 }));
    h.table.setConnected("A", false);
    h.advance(0);
    expect(occupiedSeats(h)).toBe(0);
    expect(h.table.ledger.entries()).toHaveLength(1);
  });

  it("seats a bot when a human leaves", () => {
    const h = harness({}, 7, filling());
    humanAndBots(h, [1_000, 1_000, 1_000]);
    h.ok(h.table.join("H", { name: "H", buyIn: 1_000 })); // keeps the table live
    h.advance(0);
    h.ok(h.table.handle("A", { type: "leave" })); // mid-round: leaves after settling
    h.playRound();
    expect(h.table.view().seats.teeya?.playerId).toBe("fresh-1");
    expect(occupiedSeats(h)).toBe(4);
  });

  it("never displaces a human, and lets a human take a bot's seat between rounds", () => {
    const h = harness({}, 7, filling());
    humanAndBots(h, [1_000, 1_000, 1_000]);
    h.ok(h.table.join("H", { name: "H", buyIn: 1_000 }));
    h.advance(0);
    expect(h.table.handle("H", { type: "sit", seat: "teeya" })).toEqual({ ok: false, reason: "seat-taken" });
    untilRevealing(h);
    expect(h.table.handle("H", { type: "sit", seat: "teeya" })).toEqual({ ok: false, reason: "seat-taken" });
    h.ok(h.table.handle("H", { type: "sit", seat: "panja" }));
    expect(h.table.view().seats.panja?.playerId).toBe("H");
    expect(h.table.view().chyakhe.map((p) => p.playerId)).not.toContain("bot-panja");
  });

  it("never gives a bot a seat a human is waiting to take", () => {
    const h = harness({}, 7, filling());
    humanAndBots(h, [1_000, 1_000, 1_000]);
    h.ok(h.table.join("H", { name: "H", buyIn: 1_000 }));
    h.advance(0);
    // Mid-round: A will leave once the round settles, and H reserves teeya.
    h.ok(h.table.handle("A", { type: "leave" }));
    h.ok(h.table.handle("H", { type: "sit", seat: "teeya" }));
    expect(h.table.view().reservations).toEqual([{ seat: "teeya", playerId: "H" }]);
    // A second human cannot jump the queue.
    h.ok(h.table.join("J", { name: "J", buyIn: 1_000 }));
    expect(h.table.handle("J", { type: "sit", seat: "teeya" })).toEqual({ ok: false, reason: "seat-taken" });

    h.playRound();
    expect(h.table.view().seats.teeya?.playerId).toBe("H");
    expect(h.table.view().reservations).toEqual([]);
    expect(occupiedSeats(h)).toBe(4);
  });

  it("can reserve a bot's seat mid-round, and cancel a reservation by standing", () => {
    const h = harness({}, 7, filling());
    humanAndBots(h, [1_000, 1_000, 1_000]);
    h.ok(h.table.join("H", { name: "H", buyIn: 1_000 }));
    h.advance(0);
    h.ok(h.table.handle("H", { type: "sit", seat: "chakka" }));
    h.ok(h.table.handle("H", { type: "stand" }));
    expect(h.table.view().reservations).toEqual([]);
    h.ok(h.table.handle("H", { type: "sit", seat: "chakka" }));
    h.playRound();
    expect(h.table.view().seats.chakka?.playerId).toBe("H");
    expect(h.table.view().chyakhe.map((p) => p.playerId)).not.toContain("bot-chakka");
  });

  it("keeps pushes rare over 5000 rounds, and still conserves chips", () => {
    // Small bot buy-ins, so bots go broke and are replaced again and again.
    const policy = botSeatFilling({ buyIn: 300, idPrefix: "fresh-" });
    const h = harness({ minChipsToSit: 100 }, 2024, policy);
    humanAndBots(h, [300, 300, 300], 1_000_000);
    for (const id of ["Z1", "Z2"]) h.ok(h.table.join(id, { name: id, isBot: true, buyIn: 300 }));

    let seatChecks = 0;
    for (let step = 0; h.table.records().length < 5_000 && step < 1_000_000; step += 1) {
      h.advance(500);
      if (h.table.phase === "betting") {
        seatChecks += 1;
        expect(occupiedSeats(h)).toBe(4);
      }
    }

    const records = h.table.records();
    expect(records).toHaveLength(5_000);
    const pushes = records.filter(isPush).length;
    expect(pushes / records.length).toBeLessThan(0.01);
    expect(seatChecks).toBeGreaterThan(5_000);

    // Conservation: every round sums to zero, and every chip in play was
    // issued by a buy-in, including the fresh bots' buy-ins.
    for (const r of records) expect(Object.values(r.deltas).reduce((a, b) => a + b, 0)).toBe(0);
    h.table.ledger.verify();
    const issued = h.table.ledger
      .entries()
      .filter((e) => e.reason !== "round")
      .reduce((a, e) => a + e.chips, 0);
    expect(h.table.ledger.totalInPlay()).toBe(issued);
    const freshBots = new Set(h.table.ledger.entries().filter((e) => e.playerId.startsWith("fresh-")).map((e) => e.playerId));
    expect(freshBots.size).toBeGreaterThan(10);
  });

  it("with the policy off, an empty winning seat is still a push", () => {
    const h = harness({}, 7, null);
    h.ok(h.table.join("A", { name: "A", buyIn: 1_000 }));
    h.ok(h.table.join("B", { name: "B", buyIn: 1_000 }));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
    h.ok(h.table.handle("B", { type: "sit", seat: "panja" }));
    h.queue(4); // chauka, which is empty
    h.advance(0);
    expect(occupiedSeats(h)).toBe(2);
    h.playRound("A");
    const r = h.table.records().at(-1);
    expect(r && isPush(r)).toBe(true);
    expect(r?.winningSeat).toBe("chauka");
    expect(h.table.balance("A")).toBe(1_000);
    expect(h.table.balance("B")).toBe(1_000);
    expect(h.table.view().thrower).toBe("panja");
    expect(occupiedSeats(h)).toBe(2);
  });

  it("with the policy off, a broke bot is stood up and stays at the table", () => {
    const h = harness({ minChipsToSit: 10 }, 7, null);
    humanAndBots(h, [25, 1_000, 1_000]);
    h.queue(3);
    h.advance(0);
    h.playRound("A");
    expect(h.table.view().seats.chauka).toBeNull();
    expect(h.table.view().chyakhe.map((p) => p.playerId)).toContain("bot-chauka");
  });

  it("stands a broke human up and does not top them up", () => {
    const h = harness({ minChipsToSit: 10, rules: TEST_RULES }, 7, filling());
    h.ok(h.table.join("A", { name: "A", buyIn: 1_000 }));
    h.ok(h.table.join("B", { name: "B", buyIn: 25 }));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
    h.ok(h.table.handle("B", { type: "sit", seat: "chauka" }));
    h.queue(3); // A hits: B pays 10, has 15, and cannot cover the next stake of 20
    h.advance(0);
    h.playRound("A");

    const v = h.table.view();
    expect(v.seats.chauka?.playerId).not.toBe("B");
    expect(v.seats.chauka?.isBot).toBe(true);
    // B is still at the table, unseated, with their real balance.
    const b = v.chyakhe.find((p) => p.playerId === "B");
    expect(b?.chips).toBe(15);
    expect(h.table.balance("B")).toBe(15);
    // And nothing but B's own buy-in ever credited B.
    const credits = h.table.ledger.entries().filter((e) => e.playerId === "B" && e.reason !== "round");
    expect(credits).toEqual([expect.objectContaining({ reason: "buyin", chips: 25 })]);
    // B clears the 10-chip minimum but not the 20-chip stake, so B cannot
    // take a seat again only to be stood up at the next open.
    expect(v.stake).toBe(20);
    expect(h.table.handle("B", { type: "sit", seat: "panja" })).toEqual({ ok: false, reason: "insufficient-chips" });
    expect(h.table.view().reservations).toEqual([]);
    untilRevealing(h);
    expect(h.table.balance("B")).toBe(15);
  });
});
