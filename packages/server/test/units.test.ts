import { describe, expect, it } from "vitest";
import { seatForFaceCount } from "@kauda/rules";
import {
  Ledger,
  LedgerError,
  chooseChyakheBet,
  commitmentFromSeed,
  cryptoCommitment,
  facesFromSeed,
  seedForFaceCount,
  verifyThrow,
} from "../src/index.js";
import { lcg } from "./harness.js";

describe("fairness helpers", () => {
  it("derives one face per byte from the low bit", () => {
    const seed = new Uint8Array(32);
    seed[0] = 1;
    seed[1] = 0xfe;
    seed[2] = 0xff;
    const faces = facesFromSeed(seed);
    expect(faces).toHaveLength(16);
    expect(faces.slice(0, 3)).toEqual([true, false, true]);
    expect(faces.filter(Boolean)).toHaveLength(2);
  });

  it("builds a seed for any chosen face count, distinct per variant", () => {
    for (let k = 0; k <= 16; k += 1) {
      expect(facesFromSeed(seedForFaceCount(k)).filter(Boolean)).toHaveLength(k);
    }
    expect(seatForFaceCount(facesFromSeed(seedForFaceCount(5)).filter(Boolean).length)).toBe("panja");
    const a = commitmentFromSeed(seedForFaceCount(3, 0));
    const b = commitmentFromSeed(seedForFaceCount(3, 1));
    expect(a.commitHash).not.toBe(b.commitHash);
  });

  it("produces fresh, self-consistent commitments from the crypto source", () => {
    const a = cryptoCommitment();
    const b = cryptoCommitment();
    expect(a.seed).not.toBe(b.seed);
    expect(verifyThrow(a.seed, a.commitHash, facesFromSeed(a.seed))).toBe(true);
    expect(verifyThrow(a.seed, b.commitHash, facesFromSeed(a.seed))).toBe(false);
  });

  it("refuses seeds of the wrong size", () => {
    expect(() => facesFromSeed(new Uint8Array(31))).toThrow(RangeError);
    expect(() => facesFromSeed("abcd")).toThrow(RangeError);
  });
});

describe("ledger", () => {
  it("derives balances from entries and refuses to go below zero", () => {
    const l = new Ledger();
    l.append([{ roundId: null, playerId: "a", chips: 100, reason: "buyin", at: 1 }]);
    l.append([{ roundId: null, playerId: "b", chips: 50, reason: "buyin", at: 1 }]);
    l.append([
      { roundId: "r1", playerId: "a", chips: -30, reason: "round", at: 2 },
      { roundId: "r1", playerId: "b", chips: 30, reason: "round", at: 2 },
    ]);
    expect(l.balance("a")).toBe(70);
    expect(l.balance("b")).toBe(80);
    expect(l.totalInPlay()).toBe(150);

    expect(() =>
      l.append([
        { roundId: "r2", playerId: "a", chips: -71, reason: "round", at: 3 },
        { roundId: "r2", playerId: "b", chips: 71, reason: "round", at: 3 },
      ]),
    ).toThrow(/below zero/);
    // A refused batch writes nothing at all.
    expect(l.balance("b")).toBe(80);
    expect(l.entries()).toHaveLength(4);
    l.verify();
  });

  it("refuses unbalanced, repeated, fractional or malformed entries", () => {
    const l = new Ledger();
    l.append([{ roundId: null, playerId: "a", chips: 100, reason: "buyin", at: 1 }]);
    const bad = [
      [{ roundId: "r", playerId: "a", chips: -5, reason: "round", at: 1 }],
      [{ roundId: null, playerId: "a", chips: 1.5, reason: "topup", at: 1 }],
      [{ roundId: null, playerId: "a", chips: -5, reason: "topup", at: 1 }],
      [{ roundId: "r", playerId: "a", chips: 5, reason: "buyin", at: 1 }],
      [{ roundId: null, playerId: "", chips: 5, reason: "buyin", at: 1 }],
      [{ roundId: null, playerId: "a", chips: 0, reason: "buyin", at: 1 }],
      [
        { roundId: "r", playerId: "a", chips: -5, reason: "round", at: 1 },
        { roundId: "r", playerId: "a", chips: 5, reason: "round", at: 1 },
      ],
    ] as const;
    for (const batch of bad) expect(() => l.append(batch), JSON.stringify(batch)).toThrow(LedgerError);

    l.append([{ roundId: null, playerId: "b", chips: 10, reason: "buyin", at: 1 }]);
    const round = [
      { roundId: "r", playerId: "a", chips: -5, reason: "round", at: 1 },
      { roundId: "r", playerId: "b", chips: 5, reason: "round", at: 1 },
    ] as const;
    l.append(round);
    expect(() => l.append(round)).toThrow(/already/);
    l.verify();
  });

  it("hands out frozen copies, so entries cannot be edited from outside", () => {
    const l = new Ledger();
    l.append([{ roundId: null, playerId: "a", chips: 100, reason: "buyin", at: 1 }]);
    const [entry] = l.entries();
    expect(Object.isFrozen(entry)).toBe(true);
    (l.entries() as unknown[]).length = 0;
    expect(l.entries()).toHaveLength(1);
  });
});

describe("chyakhe bot policy", () => {
  it("only bets on occupied seats other than the thrower's, within a quarter of its balance", () => {
    const random = lcg(99);
    let bets = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const bet = chooseChyakheBet(
        { thrower: "teeya", seats: { teeya: "a", panja: "b", chakka: "c" }, balance: 200, thini: 10 },
        random,
      );
      if (bet === null) continue;
      bets += 1;
      expect(["panja", "chakka"]).toContain(bet.seat);
      expect(bet.chips).toBeGreaterThanOrEqual(1);
      expect(bet.chips).toBeLessThanOrEqual(50);
      expect(Number.isInteger(bet.chips)).toBe(true);
    }
    expect(bets).toBeGreaterThan(500);
  });

  it("does not bet when it cannot", () => {
    const always = () => 0;
    expect(chooseChyakheBet({ thrower: "teeya", seats: { teeya: "a" }, balance: 200, thini: 10 }, always)).toBeNull();
    expect(
      chooseChyakheBet({ thrower: "teeya", seats: { teeya: "a", panja: "b" }, balance: 3, thini: 10 }, always),
    ).toBeNull();
  });
});
