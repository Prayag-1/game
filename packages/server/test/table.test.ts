import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Table, parseCommand, verifyThrow, type RoundRecord } from "../src/index.js";
import { TEST_RULES, harness, seatFour } from "./harness.js";

function lastRecord(table: Table): RoundRecord {
  const r = table.records().at(-1);
  if (r === undefined) throw new Error("no round has settled");
  return r;
}

describe("a round", () => {
  it("plays out and settles; a hit pays the thrower 3x the stake", () => {
    const h = harness();
    seatFour(h);
    h.queue(3); // teeya
    h.advance(0);
    expect(h.table.phase).toBe("betting");
    expect(h.table.view().thrower).toBe("teeya");
    expect(h.table.view().stake).toBe(10);

    h.advance(8_000);
    expect(h.table.phase).toBe("throwing");
    h.ok(h.table.handle("A", { type: "throw" }));
    expect(h.table.phase).toBe("revealing");

    const r = lastRecord(h.table);
    expect(r.hit).toBe(true);
    expect(r.deltas).toEqual({ A: 30, B: -10, C: -10, D: -10 });
    expect(h.table.balance("A")).toBe(1030);
    expect(h.table.balance("B")).toBe(990);
    h.table.ledger.verify();

    h.advance(4_500);
    expect(h.table.phase).toBe("betting");
    expect(h.table.view().thrower).toBe("teeya");
  });

  it("passes the throw on a miss and pays the winning seat", () => {
    const h = harness();
    seatFour(h);
    h.queue(5); // panja
    h.advance(0);
    h.playRound("A");
    const r = lastRecord(h.table);
    expect(r.hit).toBe(false);
    expect(r.winningSeat).toBe("panja");
    expect(r.deltas).toEqual({ A: -10, B: 0, C: 10, D: 0 });
    expect(h.table.view().thrower).toBe("chauka");
    expect(h.table.view().streak).toBe(0);
  });

  it("keeps the throw on a streak and escalates the stake 1x, 2x, 4x", () => {
    const h = harness();
    seatFour(h);
    h.queue(3, 3, 3);
    h.advance(0);
    for (let i = 0; i < 3; i += 1) h.playRound("A");
    const rs = h.table.records();
    expect(rs.map((r) => r.multiplier)).toEqual([1, 2, 4]);
    expect(rs.map((r) => r.stake)).toEqual([10, 20, 40]);
    expect(rs.every((r) => r.thrower === "teeya")).toBe(true);
    expect(h.table.balance("A")).toBe(1000 + 3 * (10 + 20 + 40));
    expect(h.table.view().stake).toBe(80);
  });

  it("auto-throws when the thrower does nothing", () => {
    const h = harness();
    seatFour(h);
    h.queue(5);
    h.advance(0);
    h.advance(8_000);
    h.advance(9_999);
    expect(h.table.phase).toBe("throwing");
    h.advance(1);
    expect(h.table.phase).toBe("revealing");
    expect(h.table.records()).toHaveLength(1);
  });

  it("refuses a throw from anyone but the thrower, or outside the throwing phase", () => {
    const h = harness();
    seatFour(h);
    h.advance(0);
    expect(h.table.handle("A", { type: "throw" })).toEqual({ ok: false, reason: "wrong-phase" });
    h.advance(8_000);
    expect(h.table.handle("B", { type: "throw" })).toEqual({ ok: false, reason: "not-thrower" });
  });

  it("has a seated bot throw promptly", () => {
    const h = harness();
    h.ok(h.table.join("A", { name: "A", buyIn: 1000 }));
    h.ok(h.table.join("bot", { name: "bot", isBot: true, buyIn: 1000 }));
    h.ok(h.table.handle("bot", { type: "sit", seat: "teeya" }));
    h.ok(h.table.handle("A", { type: "sit", seat: "chauka" }));
    h.advance(0);
    h.advance(8_000);
    h.advance(1_199);
    expect(h.table.records()).toHaveLength(0);
    h.advance(1);
    expect(h.table.records()).toHaveLength(1);
  });
});

describe("conservation", () => {
  it("keeps every chip over 60 rounds, and the ledger verifies", () => {
    const h = harness({ minChipsToSit: 100 }, 12345);
    const players = [
      { id: "A", isBot: false, buyIn: 5_000 },
      { id: "B", isBot: false, buyIn: 5_000 },
      { id: "H", isBot: false, buyIn: 2_000 }, // a human chyakhe
      { id: "X", isBot: true, buyIn: 5_000 },
      { id: "Y", isBot: true, buyIn: 5_000 },
      { id: "Z1", isBot: true, buyIn: 3_000 }, // chyakhe bots
      { id: "Z2", isBot: true, buyIn: 3_000 },
    ];
    for (const p of players) h.ok(h.table.join(p.id, { name: p.id, isBot: p.isBot, buyIn: p.buyIn }));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
    h.ok(h.table.handle("X", { type: "sit", seat: "chauka" }));
    h.ok(h.table.handle("B", { type: "sit", seat: "panja" }));
    h.ok(h.table.handle("Y", { type: "sit", seat: "chakka" }));
    const issued = players.reduce((a, p) => a + p.buyIn, 0);

    for (let step = 0; step < 10_000 && h.table.records().length < 60; step += 1) h.advance(500);

    const records = h.table.records();
    expect(records.length).toBeGreaterThanOrEqual(60);
    expect(h.table.ledger.totalInPlay()).toBe(issued);
    h.table.ledger.verify();
    for (const r of records) expect(Object.values(r.deltas).reduce((a, b) => a + b, 0)).toBe(0);
    for (const p of players) expect(h.table.balance(p.id)).toBeGreaterThanOrEqual(0);
    // The chyakhe bots really did bet.
    expect(records.some((r) => r.chyakhe.length > 0)).toBe(true);
    // And every round replays from its seed.
    for (const r of records) expect(Table.replay(r).deltas).toEqual(r.deltas);
  });
});

describe("commit-reveal", () => {
  it("publishes the hash before betting, and the revealed seed matches it", () => {
    const h = harness();
    seatFour(h);
    h.queue(3);
    h.advance(0);
    const published = h.table.view().commitHash;
    expect(published).toMatch(/^[0-9a-f]{64}$/);

    h.playRound("A");
    const r = lastRecord(h.table);
    expect(r.commitHash).toBe(published);
    expect(createHash("sha256").update(Buffer.from(r.seed, "hex")).digest("hex")).toBe(published);
    expect(verifyThrow(r.seed, r.commitHash, r.faces)).toBe(true);
  });

  it("fails verification for a tampered seed or tampered faces", () => {
    const h = harness();
    seatFour(h);
    h.queue(3);
    h.advance(0);
    h.playRound("A");
    const r = lastRecord(h.table);

    const last = r.seed.at(-1) === "0" ? "1" : "0";
    expect(verifyThrow(r.seed.slice(0, -1) + last, r.commitHash, r.faces)).toBe(false);
    expect(verifyThrow("not a seed", r.commitHash, r.faces)).toBe(false);

    const faces = [...r.faces];
    faces[0] = !faces[0];
    expect(verifyThrow(r.seed, r.commitHash, faces)).toBe(false);
    expect(verifyThrow(r.seed, r.commitHash, r.faces.slice(1))).toBe(false);
  });

  it("replays a record to the same result", () => {
    const h = harness();
    seatFour(h);
    h.queue(5, 3);
    h.advance(0);
    h.playRound("A");
    h.playRound("B");
    for (const r of h.table.records()) {
      const replay = Table.replay(r);
      expect(replay.commitmentMatches).toBe(true);
      expect(replay).toMatchObject({
        faces: r.faces,
        faceUp: r.faceUp,
        winningSeat: r.winningSeat,
        hit: r.hit,
        stake: r.stake,
        multiplier: r.multiplier,
        deltas: r.deltas,
      });
    }
  });

  it("never puts the pending seed in the view before settlement, and does after", () => {
    const h = harness();
    seatFour(h);
    h.queue(3, 5);
    h.advance(0);
    h.advance(4_000);
    const betting = JSON.stringify(h.table.view());
    h.advance(4_000);
    const throwing = JSON.stringify(h.table.view());
    h.ok(h.table.handle("A", { type: "throw" }));
    const revealed = JSON.stringify(h.table.view());

    const seed = lastRecord(h.table).seed;
    expect(betting).not.toContain(seed);
    expect(throwing).not.toContain(seed);
    expect(revealed).toContain(seed);

    // The next round's seed is not visible either, once its betting opens.
    h.advance(4_500);
    const next = JSON.stringify(h.table.view());
    h.playRound("A");
    expect(next).not.toContain(lastRecord(h.table).seed);
  });
});

describe("outside bets", () => {
  function withChyakhe(throwerChips = 1000) {
    const h = harness({ minChipsToSit: 100 });
    seatFour(h, [throwerChips, 1000, 1000, 1000]);
    h.ok(h.table.join("E", { name: "E", buyIn: 100 }));
    h.ok(h.table.join("F", { name: "F", buyIn: 1000 }));
    return h;
  }

  it("accepts a bet on a valid seat", () => {
    const h = withChyakhe();
    h.advance(0);
    h.ok(h.table.handle("E", { type: "placeBet", seat: "panja", chips: 50 }));
    expect(h.table.view().bets).toEqual([{ playerId: "E", seat: "panja", chips: 50 }]);
    h.ok(h.table.handle("E", { type: "placeBet", seat: "chauka", chips: 20 }));
    expect(h.table.view().bets).toEqual([{ playerId: "E", seat: "chauka", chips: 20 }]);
    h.ok(h.table.handle("E", { type: "clearBet" }));
    expect(h.table.view().bets).toEqual([]);
  });

  it("refuses a bet on the thrower's seat", () => {
    const h = withChyakhe();
    h.advance(0);
    expect(h.table.handle("E", { type: "placeBet", seat: "teeya", chips: 10 })).toEqual({
      ok: false,
      reason: "thrower-seat",
    });
  });

  it("refuses a bet on an empty seat", () => {
    const h = harness();
    h.ok(h.table.join("A", { name: "A", buyIn: 1000 }));
    h.ok(h.table.join("B", { name: "B", buyIn: 1000 }));
    h.ok(h.table.join("E", { name: "E", buyIn: 1000 }));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
    h.ok(h.table.handle("B", { type: "sit", seat: "chauka" }));
    h.advance(0);
    expect(h.table.handle("E", { type: "placeBet", seat: "panja", chips: 10 })).toEqual({
      ok: false,
      reason: "empty-seat",
    });
  });

  it("refuses a bet above the bettor's balance", () => {
    const h = withChyakhe();
    h.advance(0);
    expect(h.table.handle("E", { type: "placeBet", seat: "panja", chips: 101 })).toEqual({
      ok: false,
      reason: "insufficient-chips",
    });
  });

  it("refuses a bet the thrower cannot cover: stake plus the largest total on one seat", () => {
    const h = withChyakhe(100); // A, the thrower, holds 100 and the stake is 10
    h.ok(h.table.join("G", { name: "G", buyIn: 1000 }));
    h.advance(0);
    expect(h.table.handle("F", { type: "placeBet", seat: "panja", chips: 91 })).toEqual({
      ok: false,
      reason: "thrower-cannot-cover",
    });
    h.ok(h.table.handle("F", { type: "placeBet", seat: "panja", chips: 50 }));
    // Another 41 on panja would make the worst case 10 + 91.
    expect(h.table.handle("G", { type: "placeBet", seat: "panja", chips: 41 })).toEqual({
      ok: false,
      reason: "thrower-cannot-cover",
    });
    // But 40 on panja is exactly coverable, and so is a separate seat.
    h.ok(h.table.handle("G", { type: "placeBet", seat: "panja", chips: 40 }));
    h.ok(h.table.handle("E", { type: "placeBet", seat: "chauka", chips: 90 }));
  });

  it("settles a fully covered worst case without going negative", () => {
    const h = withChyakhe(100);
    h.queue(5); // panja wins
    h.advance(0);
    h.ok(h.table.handle("F", { type: "placeBet", seat: "panja", chips: 90 }));
    h.playRound("A");
    expect(h.table.balance("A")).toBe(0);
    expect(h.table.balance("F")).toBe(1090);
    h.table.ledger.verify();
    // A can no longer cover a stake, so A is stood up and the throw passes on.
    expect(h.table.view().seats.teeya).toBeNull();
  });

  it("refuses a bet once betting closes", () => {
    const h = withChyakhe();
    h.advance(0);
    h.advance(8_000);
    expect(h.table.handle("E", { type: "placeBet", seat: "panja", chips: 10 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(h.table.handle("E", { type: "clearBet" })).toEqual({ ok: false, reason: "wrong-phase" });
  });

  it("refuses a bet from a seated player", () => {
    const h = withChyakhe();
    h.advance(0);
    expect(h.table.handle("B", { type: "placeBet", seat: "panja", chips: 10 })).toEqual({
      ok: false,
      reason: "seated-cannot-bet",
    });
  });

  it("respects maxChyakhe", () => {
    const h = harness({ rules: { ...TEST_RULES, maxChyakhe: 1 } });
    seatFour(h);
    h.ok(h.table.join("E", { name: "E", buyIn: 1000 }));
    h.ok(h.table.join("F", { name: "F", buyIn: 1000 }));
    h.advance(0);
    h.ok(h.table.handle("E", { type: "placeBet", seat: "panja", chips: 10 }));
    expect(h.table.handle("F", { type: "placeBet", seat: "panja", chips: 10 })).toEqual({
      ok: false,
      reason: "too-many-chyakhe",
    });
    // Replacing your own bet does not count as another chyakhe.
    h.ok(h.table.handle("E", { type: "placeBet", seat: "chauka", chips: 10 }));
  });

  it("pays a winning bet 1:1 from the thrower, and returns the others", () => {
    const h = withChyakhe();
    h.queue(5); // panja
    h.advance(0);
    h.ok(h.table.handle("E", { type: "placeBet", seat: "panja", chips: 50 }));
    h.ok(h.table.handle("F", { type: "placeBet", seat: "chakka", chips: 70 }));
    h.playRound("A");
    expect(lastRecord(h.table).deltas).toEqual({ A: -60, B: 0, C: 10, D: 0, E: 50, F: 0 });
    expect(h.table.balance("E")).toBe(150);
    expect(h.table.balance("F")).toBe(1000);
  });

  it("gives every bet to the thrower on a hit", () => {
    const h = withChyakhe();
    h.queue(3); // teeya
    h.advance(0);
    h.ok(h.table.handle("E", { type: "placeBet", seat: "panja", chips: 50 }));
    h.playRound("A");
    expect(h.table.balance("E")).toBe(50);
    expect(h.table.balance("A")).toBe(1000 + 30 + 50);
  });
});

describe("seating", () => {
  it("enforces the minimum to sit", () => {
    const h = harness({ minChipsToSit: 100 });
    h.ok(h.table.join("A", { name: "A", buyIn: 99 }));
    expect(h.table.handle("A", { type: "sit", seat: "teeya" })).toEqual({ ok: false, reason: "insufficient-chips" });
    h.ok(h.table.topUp("A", 1));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
  });

  it("allows only one player per seat, and one seat per player", () => {
    const h = harness();
    h.ok(h.table.join("A", { name: "A", buyIn: 1000 }));
    h.ok(h.table.join("B", { name: "B", buyIn: 1000 }));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
    expect(h.table.handle("B", { type: "sit", seat: "teeya" })).toEqual({ ok: false, reason: "seat-taken" });
    expect(h.table.handle("A", { type: "sit", seat: "panja" })).toEqual({ ok: false, reason: "already-seated" });
  });

  it("does not let anyone sit or stand mid-round", () => {
    const h = harness();
    seatFour(h);
    h.ok(h.table.join("E", { name: "E", buyIn: 1000 }));
    h.advance(0);
    expect(h.table.handle("B", { type: "stand" })).toEqual({ ok: false, reason: "wrong-phase" });
    h.advance(8_000);
    expect(h.table.handle("B", { type: "stand" })).toEqual({ ok: false, reason: "wrong-phase" });
    h.ok(h.table.handle("A", { type: "throw" }));
    // Revealing is between rounds.
    h.ok(h.table.handle("B", { type: "stand" }));
    h.ok(h.table.handle("E", { type: "sit", seat: "chauka" }));
  });

  it("stops play below two seated players", () => {
    const h = harness();
    h.ok(h.table.join("A", { name: "A", buyIn: 1000 }));
    h.ok(h.table.join("B", { name: "B", buyIn: 1000 }));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
    h.advance(0);
    expect(h.table.phase).toBe("waiting");
    h.ok(h.table.handle("B", { type: "sit", seat: "chauka" }));
    h.advance(0);
    expect(h.table.phase).toBe("betting");
    h.advance(8_000);
    h.ok(h.table.handle("A", { type: "throw" }));
    h.ok(h.table.handle("B", { type: "stand" }));
    h.advance(4_500);
    expect(h.table.phase).toBe("waiting");
    h.advance(60_000);
    expect(h.table.records()).toHaveLength(1);
  });

  it("needs a connected human to start", () => {
    const h = harness();
    for (const id of ["X", "Y"]) h.ok(h.table.join(id, { name: id, isBot: true, buyIn: 1000 }));
    h.ok(h.table.handle("X", { type: "sit", seat: "teeya" }));
    h.ok(h.table.handle("Y", { type: "sit", seat: "chauka" }));
    h.advance(0);
    expect(h.table.phase).toBe("waiting");
    h.ok(h.table.join("H", { name: "H", buyIn: 10 }));
    h.advance(0);
    expect(h.table.phase).toBe("betting");
    h.table.setConnected("H", false);
    h.advance(8_000 + 1_200 + 4_500);
    expect(h.table.phase).toBe("waiting");
  });

  it("stands a seated player who cannot cover the stake before the round opens", () => {
    // B has 25. A hits, B pays 10 and has 15, which cannot cover the next
    // stake of 20, so B is stood up before that round opens.
    const h = harness({ minChipsToSit: 10 });
    seatFour(h, [1000, 25, 1000, 1000]);
    h.queue(3);
    h.advance(0);
    h.playRound("A");
    expect(h.table.balance("B")).toBe(15);
    expect(h.table.view().stake).toBe(20);
    expect(h.table.view().seats.chauka).toBeNull();
    expect(h.table.view().chyakhe.map((p) => p.playerId)).toContain("B");
  });

  it("passes the throw when the thrower is the one stood up", () => {
    // With a ghanti of 10 split two ways, a non-thrower risks at most 10 - 5,
    // so B can sit with 8. As thrower B would risk the full stake of 10.
    const h = harness({ minChipsToSit: 5, rules: { ...TEST_RULES, ghantiChips: 10 } });
    h.ok(h.table.join("A", { name: "A", buyIn: 1000 }));
    h.ok(h.table.join("B", { name: "B", buyIn: 8 }));
    h.ok(h.table.join("C", { name: "C", buyIn: 1000 }));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
    h.ok(h.table.handle("B", { type: "sit", seat: "chauka" }));
    h.ok(h.table.handle("C", { type: "sit", seat: "panja" }));
    h.queue(5); // panja wins, so the throw passes to chauka
    h.advance(0);
    h.playRound("A");
    // B could not cover a miss as thrower, so B is stood and the throw passes on.
    expect(h.table.view().seats.chauka).toBeNull();
    expect(h.table.balance("B")).toBe(8);
    expect(h.table.view().thrower).toBe("panja");
    expect(h.table.phase).toBe("betting");
  });

  it("refuses a seat to someone who could not cover its stake", () => {
    const h = harness({ minChipsToSit: 5 });
    seatFour(h);
    h.ok(h.table.join("D2", { name: "D2", buyIn: 8 }));
    h.queue(5);
    h.advance(0);
    h.playRound("A");
    h.advance(8_000);
    h.advance(10_000);
    // A seat is free, but 8 chips cannot cover a 10-chip stake.
    h.ok(h.table.handle("D", { type: "stand" }));
    expect(h.table.handle("D2", { type: "sit", seat: "chakka" })).toEqual({ ok: false, reason: "insufficient-chips" });
  });

  it("keeps a leaver's chips in the round, then removes them", () => {
    const h = harness();
    seatFour(h);
    h.queue(5);
    h.advance(0);
    h.ok(h.table.handle("C", { type: "leave" }));
    expect(h.table.handle("C", { type: "stand" })).toEqual({ ok: false, reason: "not-at-table" });
    h.playRound("A");
    expect(lastRecord(h.table).deltas.C).toBe(10);
    expect(h.table.view().seats.panja).toBeNull();
  });
});

describe("malformed commands", () => {
  const bad: unknown[] = [
    null,
    undefined,
    42,
    "sit",
    [],
    {},
    { type: "dance" },
    { type: "sit" },
    { type: "sit", seat: "seven" },
    { type: "sit", seat: 3 },
    { type: "placeBet", seat: "panja" },
    { type: "placeBet", seat: "panja", chips: -5 },
    { type: "placeBet", seat: "panja", chips: 0 },
    { type: "placeBet", seat: "panja", chips: 2.5 },
    { type: "placeBet", seat: "panja", chips: "10" },
    { type: "placeBet", seat: "panja", chips: Number.NaN },
    { type: "placeBet", seat: "panja", chips: 2 ** 60 },
    // Strict objects: no smuggled fields.
    { type: "throw", faces: [true] },
    { type: "stand", winner: "teeya" },
    { type: "placeBet", seat: "panja", chips: 10, playerId: "B" },
  ];

  it("returns null from parseCommand rather than throwing", () => {
    for (const raw of bad) expect(parseCommand(raw), JSON.stringify(raw)).toBeNull();
    expect(parseCommand({ type: "placeBet", seat: "panja", chips: 10 })).toEqual({
      type: "placeBet",
      seat: "panja",
      chips: 10,
    });
  });

  it("is rejected by the table, which stays unchanged", () => {
    const h = harness();
    seatFour(h);
    h.ok(h.table.join("E", { name: "E", buyIn: 1000 }));
    h.advance(0);
    const before = JSON.stringify(h.table.view());
    for (const raw of bad) expect(h.table.handle("E", raw)).toEqual({ ok: false, reason: "malformed" });
    expect(JSON.stringify(h.table.view())).toBe(before);
  });

  it("rejects an empty or missing playerId, and anyone not at the table", () => {
    const h = harness();
    seatFour(h);
    for (const id of ["", null, undefined, 7, "x".repeat(65)]) {
      expect(h.table.handle(id, { type: "stand" })).toEqual({ ok: false, reason: "malformed" });
    }
    expect(h.table.handle("stranger", { type: "stand" })).toEqual({ ok: false, reason: "not-at-table" });
  });
});
