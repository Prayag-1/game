import { describe, expect, it } from "vitest";
import { seatForFaceCount } from "@kauda/rules";
import {
  Ledger,
  LedgerError,
  MINT_ACCOUNT,
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
    l.issue("a", 100, "buyin", 1);
    l.issue("b", 50, "buyin", 1);
    l.append([
      { roundId: "r1", playerId: "a", chips: -30, reason: "round", at: 2 },
      { roundId: "r1", playerId: "b", chips: 30, reason: "round", at: 2 },
    ]);
    expect(l.balance("a")).toBe(70);
    expect(l.balance("b")).toBe(80);
    expect(l.totalInPlay()).toBe(150);
    expect(l.mintBalance()).toBe(-150);
    expect(l.sumOfAllAccounts()).toBe(0);

    expect(() =>
      l.append([
        { roundId: "r2", playerId: "a", chips: -71, reason: "round", at: 3 },
        { roundId: "r2", playerId: "b", chips: 71, reason: "round", at: 3 },
      ]),
    ).toThrow(/below zero/);
    // A refused batch writes nothing at all.
    expect(l.balance("b")).toBe(80);
    expect(l.entries()).toHaveLength(6);
    l.verify();
  });

  it("refuses unbalanced, repeated, fractional or malformed entries", () => {
    const l = new Ledger();
    l.issue("a", 100, "buyin", 1);
    const M = MINT_ACCOUNT;
    const pair = (reason: "buyin" | "botBuyin" | "topup" | "botCashout", chips: number, id = "a") =>
      [
        { roundId: null, playerId: M, chips: -chips, reason, at: 1 },
        { roundId: null, playerId: id, chips, reason, at: 1 },
      ] as const;
    const bad = [
      [{ roundId: "r", playerId: "a", chips: -5, reason: "round", at: 1 }],
      pair("topup", 1.5),
      pair("topup", -5), // an issue that takes chips away
      pair("botCashout", 5), // a cash-out that adds chips
      pair("buyin", 5, ""),
      pair("buyin", 0),
      // A lone credit with no mint debit: chips from nowhere.
      [{ roundId: null, playerId: "a", chips: 5, reason: "buyin", at: 1 }],
      // A funding transfer that does not balance.
      [
        { roundId: null, playerId: M, chips: -4, reason: "buyin", at: 1 },
        { roundId: null, playerId: "a", chips: 5, reason: "buyin", at: 1 },
      ],
      // A funding transfer with no mint in it: a player-to-player gift.
      [
        { roundId: null, playerId: "a", chips: -5, reason: "buyin", at: 1 },
        { roundId: null, playerId: "b", chips: 5, reason: "buyin", at: 1 },
      ],
      [
        { roundId: "r", playerId: M, chips: -5, reason: "buyin", at: 1 },
        { roundId: "r", playerId: "a", chips: 5, reason: "buyin", at: 1 },
      ],
      // The mint may not take part in a round.
      [
        { roundId: "r", playerId: M, chips: -5, reason: "round", at: 1 },
        { roundId: "r", playerId: "a", chips: 5, reason: "round", at: 1 },
      ],
      [
        { roundId: "r", playerId: "a", chips: -5, reason: "round", at: 1 },
        { roundId: "r", playerId: "a", chips: 5, reason: "round", at: 1 },
      ],
    ] as const;
    for (const batch of bad) expect(() => l.append(batch), JSON.stringify(batch)).toThrow(LedgerError);
    expect(() => l.issue(M, 5, "buyin", 1)).toThrow(LedgerError);
    expect(() => l.retire(M, "botCashout", 1)).toThrow(LedgerError);

    l.issue("b", 10, "buyin", 1);
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
    l.issue("a", 100, "buyin", 1);
    const [entry] = l.entries();
    expect(Object.isFrozen(entry)).toBe(true);
    (l.entries() as unknown[]).length = 0;
    expect(l.entries()).toHaveLength(2);
  });

  it("funds every chip from the mint, lets only the mint go negative, and sums to zero", () => {
    const l = new Ledger();
    l.issue("human", 2_000, "buyin", 1);
    l.issue("bot", 2_000, "botBuyin", 1);
    l.issue("human", 500, "topup", 2);
    expect(l.mintBalance()).toBe(-4_500);
    expect(l.totalInPlay()).toBe(4_500);
    l.append([
      { roundId: "r1", playerId: "human", chips: -300, reason: "round", at: 3 },
      { roundId: "r1", playerId: "bot", chips: 300, reason: "round", at: 3 },
    ]);
    // A departing bot's residual goes back to the mint, not onto a dead account.
    expect(l.retire("bot", "botCashout", 4)).toBe(2_300);
    expect(l.balance("bot")).toBe(0);
    expect(l.retire("bot", "botCashout", 5)).toBe(0); // nothing left: nothing written
    expect(l.mintBalance()).toBe(-2_200);
    expect(l.totalInPlay()).toBe(2_200);
    expect(l.sumOfAllAccounts()).toBe(0);
    expect(l.entries().reduce((a, e) => a + e.chips, 0)).toBe(0);
    expect(new Set(l.entries().map((e) => e.reason))).toEqual(
      new Set(["buyin", "botBuyin", "topup", "round", "botCashout"]),
    );
    // Batches are numbered, and each one sums to zero.
    const byBatch = new Map<number, number>();
    for (const e of l.entries()) byBatch.set(e.batch, (byBatch.get(e.batch) ?? 0) + e.chips);
    expect([...byBatch.values()]).toEqual([0, 0, 0, 0, 0]);
    expect(l.lastEntryAt("human", "topup")).toBe(2);
    expect(l.lastEntryAt("bot", "topup")).toBeNull();
    l.verify();
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
