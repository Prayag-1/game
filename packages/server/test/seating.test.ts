import { describe, expect, it } from "vitest";
import { TURN_ORDER } from "@kauda/rules";
import { MINT_ACCOUNT, botSeatFilling, type RoundRecord, type SeatFillPolicy } from "../src/index.js";
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
    // Its 15 chips went back to the mint rather than being orphaned, and the
    // fresh bot was funded from the mint.
    expect(h.table.balance("bot-chauka")).toBe(0);
    const ledger = h.table.ledger.entries();
    expect(ledger.filter((e) => e.reason === "botCashout")).toEqual([
      expect.objectContaining({ playerId: "bot-chauka", chips: -15 }),
      expect.objectContaining({ playerId: MINT_ACCOUNT, chips: 15 }),
    ]);
    expect(ledger.filter((e) => e.reason === "botBuyin" && e.playerId === "fresh-1")).toEqual([
      expect.objectContaining({ chips: BOT_BUY_IN }),
    ]);
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
    expect(h.table.ledger.entries()).toHaveLength(2); // A's buy-in: mint debit and A credit
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

  it("holds at most one reservation per player: asking again moves it", () => {
    const h = harness({}, 7, filling());
    humanAndBots(h, [1_000, 1_000, 1_000]);
    h.ok(h.table.join("H", { name: "H", buyIn: 1_000 }));
    h.ok(h.table.join("J", { name: "J", buyIn: 1_000 }));
    h.advance(0);
    h.ok(h.table.handle("H", { type: "sit", seat: "chakka" }));
    h.ok(h.table.handle("H", { type: "sit", seat: "panja" }));
    h.ok(h.table.handle("H", { type: "sit", seat: "chauka" }));
    expect(h.table.view().reservations).toEqual([{ seat: "chauka", playerId: "H" }]);
    // The seats H let go of are free again, for J or for a bot.
    h.ok(h.table.handle("J", { type: "sit", seat: "chakka" }));
    h.playRound();
    const seats = h.table.view().seats;
    expect(seats.chauka?.playerId).toBe("H");
    expect(seats.chakka?.playerId).toBe("J");
    expect(seats.panja?.playerId).toBe("bot-panja");
  });

  /**
   * A reservation is normally honoured at the very next round open. One that
   * cannot be is queued behind a human: here A says leave mid-round, H
   * reserves A's seat, and A reconnects before the round settles, so A keeps
   * the seat and H's reservation waits.
   */
  function queuedBehindHuman(options: { reservationMaxRounds?: number; reservationMaxMs?: number }): Harness {
    const h = harness(options, 7, filling());
    humanAndBots(h, [1_000, 1_000, 1_000]);
    h.ok(h.table.join("H", { name: "H", buyIn: 1_000 }));
    h.advance(0);
    h.ok(h.table.handle("A", { type: "leave" }));
    h.ok(h.table.handle("H", { type: "sit", seat: "teeya" }));
    h.ok(h.table.join("A", { name: "A" })); // reconnects: no longer leaving
    expect(h.table.view().reservations).toEqual([{ seat: "teeya", playerId: "H" }]);
    return h;
  }

  /** Plays on until the next round opens. */
  function nextOpen(h: Harness): void {
    untilRevealing(h);
    for (let i = 0; i < 200 && h.table.phase !== "betting"; i += 1) h.advance(250);
    expect(h.table.phase).toBe("betting");
  }

  /** A gives up teeya between rounds; who gets it at the next open? */
  function aStandsAndRoundOpens(h: Harness): string | undefined {
    untilRevealing(h);
    h.ok(h.table.handle("A", { type: "stand" }));
    nextOpen(h);
    return h.table.view().seats.teeya?.playerId;
  }

  it("before it expires, a queued reservation still gets the seat", () => {
    const h = queuedBehindHuman({ reservationMaxRounds: 2, reservationMaxMs: 10 * 60_000 });
    nextOpen(h);
    expect(h.table.view().reservations).toHaveLength(1);
    expect(aStandsAndRoundOpens(h)).toBe("H");
  });

  it("expires a reservation after the configured number of rounds, and a bot may then take the seat", () => {
    const h = queuedBehindHuman({ reservationMaxRounds: 2, reservationMaxMs: 10 * 60_000 });
    nextOpen(h); // round 2 opens without H: one missed
    nextOpen(h); // round 3: two missed
    expect(h.table.view().reservations).toHaveLength(1);
    nextOpen(h); // round 4 would be the third: expired
    expect(h.table.view().reservations).toEqual([]);
    expect(aStandsAndRoundOpens(h)).not.toBe("H");
    expect(h.table.view().seats.teeya?.isBot).toBe(true);
  });

  it("expires a reservation after the configured time, and a bot may then take the seat", () => {
    // A round is longer than 5 s, so by the next open it is stale.
    const h = queuedBehindHuman({ reservationMaxRounds: 100, reservationMaxMs: 5_000 });
    nextOpen(h);
    expect(h.table.view().reservations).toEqual([]);
    expect(aStandsAndRoundOpens(h)).not.toBe("H");
    expect(h.table.view().seats.teeya?.isBot).toBe(true);
  });

  it("keeps pushes rare over 5000 rounds, and still conserves chips", () => {
    // Small bot buy-ins, so bots go broke and are replaced again and again.
    const policy = botSeatFilling({ buyIn: 300, idPrefix: "fresh-" });
    const h = harness({ minChipsToSit: 100 }, 2024, policy);
    humanAndBots(h, [300, 300, 300], 1_000_000);
    for (const id of ["Z1", "Z2"]) h.ok(h.table.join(id, { name: id, isBot: true, buyIn: 300 }));

    let seatChecks = 0;
    let checkedRounds = 0;
    for (let step = 0; h.table.records().length < 5_000 && step < 1_000_000; step += 1) {
      h.advance(500);
      if (h.table.phase === "betting") {
        seatChecks += 1;
        expect(occupiedSeats(h)).toBe(4);
      }
      // After every round: every account, the mint included, sums to zero,
      // recomputed from the entries rather than trusted from the cache.
      if (h.table.records().length > checkedRounds) {
        checkedRounds = h.table.records().length;
        expect(h.table.ledger.entries().reduce((a, e) => a + e.chips, 0)).toBe(0);
      }
    }

    const records = h.table.records();
    expect(records).toHaveLength(5_000);
    const pushes = records.filter(isPush).length;
    expect(pushes / records.length).toBeLessThan(0.01);
    expect(seatChecks).toBeGreaterThan(5_000);

    // Conservation, strongest first. Settlement alone: every "round" entry
    // over the whole session nets to exactly zero, so a settlement bug cannot
    // hide behind a buy-in.
    const entries = h.table.ledger.entries();
    expect(entries.filter((e) => e.reason === "round").reduce((a, e) => a + e.chips, 0)).toBe(0);
    for (const r of records) expect(Object.values(r.deltas).reduce((a, b) => a + b, 0)).toBe(0);
    // Funding: every chip in play came from the mint, net of what departing
    // bots handed back.
    const playerSide = entries.filter((e) => e.playerId !== MINT_ACCOUNT);
    const net = (reason: string) => playerSide.filter((e) => e.reason === reason).reduce((a, e) => a + e.chips, 0);
    expect(h.table.ledger.totalInPlay()).toBe(net("buyin") + net("botBuyin") + net("topup") + net("botCashout"));
    expect(h.table.ledger.totalInPlay()).toBe(-h.table.ledger.mintBalance());
    expect(net("botCashout")).toBeLessThan(0);
    h.table.ledger.verify();
    // No chips are left orphaned on a bot that has left.
    const present = new Set(
      [...Object.values(h.table.view().seats), ...h.table.view().chyakhe].flatMap((p) => (p === null ? [] : [p.playerId])),
    );
    const departed = new Set(playerSide.map((e) => e.playerId).filter((id) => id !== "A" && !present.has(id)));
    expect(departed.size).toBeGreaterThan(10);
    for (const id of departed) expect(h.table.balance(id)).toBe(0);
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
    // And nothing but B's own buy-in ever credited B: no silent top-up.
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
