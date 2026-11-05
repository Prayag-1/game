import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_HOUSE_RULES,
  SHELL_COUNT,
  SIMPLE_HOUSE_RULES,
  TURN_ORDER,
  facesForCount,
  settleRound,
  stakeMultiplier,
  type ChyakheBet,
  type HouseRules,
  type SeatId,
} from "../src/index.js";

function comb(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i += 1) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

const FULL_TABLE: Record<SeatId, string> = {
  teeya: "p-teeya",
  chauka: "p-chauka",
  panja: "p-panja",
  chakka: "p-chakka",
};

function sum(deltas: Readonly<Record<string, number>>): number {
  return Object.values(deltas).reduce((a, b) => a + b, 0);
}

/**
 * Total chip change for one player across all 65536 possible throws, each
 * weighted by how many ways it can occur. Integer arithmetic throughout, so
 * a result of exactly zero means exactly fair.
 */
function weightedTotal(
  playerId: string,
  opts: {
    thrower: SeatId;
    streak?: number;
    rules?: HouseRules;
    chyakhe?: readonly ChyakheBet[];
    occupants?: Record<SeatId, string>;
  },
): number {
  const rules = opts.rules ?? SIMPLE_HOUSE_RULES;
  let total = 0;
  for (let k = 0; k <= SHELL_COUNT; k += 1) {
    const outcome = settleRound({
      thrower: opts.thrower,
      occupants: opts.occupants ?? FULL_TABLE,
      chyakhe: opts.chyakhe ?? [],
      streak: opts.streak ?? 0,
      rules,
      faces: facesForCount(k),
    });
    total += comb(SHELL_COUNT, k) * (outcome.deltas[playerId] ?? 0);
  }
  return total;
}

describe("every settlement balances", () => {
  it("never creates or destroys chips, across random tables", () => {
    const seatArb = fc.constantFrom<SeatId>(...TURN_ORDER);
    fc.assert(
      fc.property(
        seatArb,
        fc.integer({ min: 0, max: 12 }),
        fc.array(fc.boolean(), { minLength: SHELL_COUNT, maxLength: SHELL_COUNT }),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1, max: 64 }),
        fc.boolean(),
        (thrower, streak, faces, thini, ghantiChips, cap, doubling) => {
          const rules: HouseRules = {
            ...DEFAULT_HOUSE_RULES,
            thini,
            ghantiChips,
            maxStakeMultiplier: cap,
            doubling,
          };
          const chyakhe: ChyakheBet[] = TURN_ORDER.filter((s) => s !== thrower).map(
            (seat, i) => ({ playerId: `c-${i}`, seat, chips: (i + 1) * 3 }),
          );
          const outcome = settleRound({
            thrower,
            occupants: FULL_TABLE,
            chyakhe,
            streak,
            rules,
            faces,
          });
          expect(sum(outcome.deltas)).toBe(0);
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("keeps every delta a whole number of chips", () => {
    for (let k = 0; k <= SHELL_COUNT; k += 1) {
      const outcome = settleRound({
        thrower: "teeya",
        occupants: FULL_TABLE,
        chyakhe: [{ playerId: "c1", seat: "panja", chips: 7 }],
        streak: 2,
        rules: { ...DEFAULT_HOUSE_RULES, ghantiChips: 7 },
        faces: facesForCount(k),
      });
      for (const v of Object.values(outcome.deltas)) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});

describe("the game is fair", () => {
  it("gives the thrower exactly zero edge from teeya and panja", () => {
    expect(weightedTotal("p-teeya", { thrower: "teeya" })).toBe(0);
    expect(weightedTotal("p-panja", { thrower: "panja" })).toBe(0);
  });

  it("stays exactly zero at every stake level once doubling is on", () => {
    for (const streak of [0, 1, 2, 3, 5, 9]) {
      const rules: HouseRules = { ...DEFAULT_HOUSE_RULES, ghantiChips: 0 };
      expect(weightedTotal("p-teeya", { thrower: "teeya", streak, rules })).toBe(0);
    }
  });

  it("leaves only the chauka and chakka asymmetry", () => {
    expect(weightedTotal("p-chauka", { thrower: "chauka" })).toBeGreaterThan(0);
    expect(weightedTotal("p-chakka", { thrower: "chakka" })).toBeLessThan(0);
    // Equal and opposite, and small.
    const edge = weightedTotal("p-chauka", { thrower: "chauka" });
    expect(weightedTotal("p-chakka", { thrower: "chakka" })).toBe(-edge);
    // Per throw the thrower's edge is m * (4p - 1) thini. For chauka
    // p = 16512/65536, so the edge is 512/65536 = 1/128 of a thini.
    expect(Math.abs(edge) / 2 ** SHELL_COUNT / SIMPLE_HOUSE_RULES.thini).toBeCloseTo(
      1 / 128,
      10,
    );
  });

  it("gives an outside bettor exactly zero edge", () => {
    const chyakhe: ChyakheBet[] = [{ playerId: "c1", seat: "panja", chips: 9 }];
    expect(weightedTotal("c1", { thrower: "teeya", chyakhe })).toBe(0);
  });

  it("makes ghanti a pure transfer, not a rake", () => {
    const withGhanti: HouseRules = { ...DEFAULT_HOUSE_RULES, ghantiChips: 30 };
    const everyone = ["p-teeya", "p-chauka", "p-panja", "p-chakka"];
    const table = everyone.reduce(
      (acc, id) => acc + weightedTotal(id, { thrower: "teeya", rules: withGhanti }),
      0,
    );
    expect(table).toBe(0);
    // Ghanti costs the thrower, so it is not free.
    const plain: HouseRules = { ...DEFAULT_HOUSE_RULES, ghantiChips: 0 };
    expect(weightedTotal("p-teeya", { thrower: "teeya", rules: withGhanti })).toBeLessThan(
      weightedTotal("p-teeya", { thrower: "teeya", rules: plain }),
    );
  });
});

describe("turn flow", () => {
  it("keeps the throw on a hit and doubles the stake", () => {
    const outcome = settleRound({
      thrower: "panja",
      occupants: FULL_TABLE,
      chyakhe: [],
      streak: 0,
      rules: DEFAULT_HOUSE_RULES,
      faces: facesForCount(5), // panja
    });
    expect(outcome.hit).toBe(true);
    expect(outcome.nextThrower).toBe("panja");
    expect(outcome.nextStreak).toBe(1);
    expect(outcome.stakeMultiplier).toBe(1);
    expect(stakeMultiplier(outcome.nextStreak, DEFAULT_HOUSE_RULES)).toBe(2);
  });

  it("passes the throw anticlockwise on a miss and resets the stake", () => {
    const outcome = settleRound({
      thrower: "teeya",
      occupants: FULL_TABLE,
      chyakhe: [],
      streak: 4,
      rules: DEFAULT_HOUSE_RULES,
      faces: facesForCount(4), // chauka
    });
    expect(outcome.hit).toBe(false);
    expect(outcome.nextThrower).toBe("chauka");
    expect(outcome.nextStreak).toBe(0);
  });

  it("caps the stake multiplier", () => {
    const rules: HouseRules = { ...DEFAULT_HOUSE_RULES, maxStakeMultiplier: 8 };
    expect(stakeMultiplier(0, rules)).toBe(1);
    expect(stakeMultiplier(3, rules)).toBe(8);
    expect(stakeMultiplier(20, rules)).toBe(8);
  });

  it("pays nothing when the winning seat is empty", () => {
    const outcome = settleRound({
      thrower: "teeya",
      occupants: { teeya: "p-teeya", panja: "p-panja" },
      chyakhe: [],
      streak: 0,
      rules: SIMPLE_HOUSE_RULES,
      faces: facesForCount(4), // chauka, which nobody is sitting on
    });
    expect(outcome.push).toBe(true);
    expect(sum(outcome.deltas)).toBe(0);
    expect(outcome.deltas["p-teeya"]).toBe(0);
    expect(outcome.nextThrower).toBe("panja");
  });
});

describe("invalid input is rejected", () => {
  it("refuses a chyakhe bet on the thrower's own seat", () => {
    expect(() =>
      settleRound({
        thrower: "teeya",
        occupants: FULL_TABLE,
        chyakhe: [{ playerId: "c1", seat: "teeya", chips: 5 }],
        streak: 0,
        rules: DEFAULT_HOUSE_RULES,
        faces: facesForCount(3),
      }),
    ).toThrow(/thrower's seat/);
  });

  it("refuses an empty thrower seat", () => {
    expect(() =>
      settleRound({
        thrower: "teeya",
        occupants: { panja: "p-panja" },
        chyakhe: [],
        streak: 0,
        rules: SIMPLE_HOUSE_RULES,
        faces: facesForCount(3),
      }),
    ).toThrow(/empty/);
  });

  it("refuses more chyakhe than the table allows", () => {
    const rules: HouseRules = { ...DEFAULT_HOUSE_RULES, maxChyakhe: 1 };
    expect(() =>
      settleRound({
        thrower: "teeya",
        occupants: FULL_TABLE,
        chyakhe: [
          { playerId: "c1", seat: "panja", chips: 5 },
          { playerId: "c2", seat: "chauka", chips: 5 },
        ],
        streak: 0,
        rules,
        faces: facesForCount(3),
      }),
    ).toThrow(/too many chyakhe/);
  });

  it("refuses a fractional stake", () => {
    expect(() =>
      settleRound({
        thrower: "teeya",
        occupants: FULL_TABLE,
        chyakhe: [],
        streak: 0,
        rules: { ...DEFAULT_HOUSE_RULES, thini: 2.5 },
        faces: facesForCount(3),
      }),
    ).toThrow(RangeError);
  });
});
