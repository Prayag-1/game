import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_HOUSE_RULES,
  MAX_CHIP_AMOUNT,
  SHELL_COUNT,
  SIMPLE_HOUSE_RULES,
  TURN_ORDER,
  facesForCount,
  seatForFaceCount,
  settleRound,
  stakeMultiplier,
  type ChyakheBet,
  type HouseRules,
  type RoundInput,
  type SeatId,
} from "../src/index.js";

/** Row 16 of Pascal's triangle, built by integer addition only. */
const BINOMIAL: readonly number[] = (() => {
  let row = [1];
  for (let n = 1; n <= SHELL_COUNT; n += 1) {
    const next = [1];
    for (let k = 1; k < n; k += 1) next.push((row[k - 1] ?? 0) + (row[k] ?? 0));
    next.push(1);
    row = next;
  }
  return row;
})();

function ways(k: number): number {
  const w = BINOMIAL[k];
  if (w === undefined) throw new Error(`no binomial weight for ${k}`);
  return w;
}

/** Number of the 65536 throws that land on each seat. */
const SEAT_WAYS: Readonly<Record<SeatId, number>> = (() => {
  const t: Record<SeatId, number> = { teeya: 0, chauka: 0, panja: 0, chakka: 0 };
  for (let k = 0; k <= SHELL_COUNT; k += 1) t[seatForFaceCount(k)] += ways(k);
  return t;
})();

const ALL_THROWS = 2 ** SHELL_COUNT;

const FULL_TABLE: Record<SeatId, string> = {
  teeya: "p-teeya",
  chauka: "p-chauka",
  panja: "p-panja",
  chakka: "p-chakka",
};

const NO_GHANTI: HouseRules = { ...DEFAULT_HOUSE_RULES, ghantiChips: 0 };

function sum(deltas: Readonly<Record<string, number>>): number {
  return Object.values(deltas).reduce((a, b) => a + b, 0);
}

function round(overrides: Partial<RoundInput> & { faceUp: number }): ReturnType<typeof settleRound> {
  const { faceUp, ...rest } = overrides;
  return settleRound({
    thrower: "teeya",
    occupants: FULL_TABLE,
    chyakhe: [],
    streak: 0,
    rules: SIMPLE_HOUSE_RULES,
    faces: facesForCount(faceUp),
    ...rest,
  });
}

/**
 * Total chip change for one player across all 65536 possible throws, each
 * face count weighted by C(16, k). Integer arithmetic throughout, so a result
 * of exactly zero means exactly fair. Divide by 65536 for the edge per throw.
 */
function weightedTotal(
  playerId: string,
  opts: {
    thrower: SeatId;
    streak?: number;
    rules?: HouseRules;
    chyakhe?: readonly ChyakheBet[];
    occupants?: Readonly<Partial<Record<SeatId, string>>>;
  },
): number {
  let total = 0;
  for (let k = 0; k <= SHELL_COUNT; k += 1) {
    const outcome = settleRound({
      thrower: opts.thrower,
      occupants: opts.occupants ?? FULL_TABLE,
      chyakhe: opts.chyakhe ?? [],
      streak: opts.streak ?? 0,
      rules: opts.rules ?? SIMPLE_HOUSE_RULES,
      faces: facesForCount(k),
    });
    total += ways(k) * (outcome.deltas[playerId] ?? 0);
  }
  expect(Number.isSafeInteger(total)).toBe(true);
  return total;
}

describe("the integer weights used below", () => {
  it("are the binomial coefficients and give the exact seat counts", () => {
    expect(BINOMIAL.reduce((a, b) => a + b, 0)).toBe(ALL_THROWS);
    expect(ways(8)).toBe(12870);
    expect(SEAT_WAYS).toEqual({ chauka: 16512, panja: 16384, chakka: 16256, teeya: 16384 });
  });
});

describe("every settlement balances", () => {
  const seatArb = fc.constantFrom<SeatId>(...TURN_ORDER);

  const tableArb = fc
    .record({
      thrower: seatArb,
      // Which of the other seats are filled; the thrower's seat always is.
      filled: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      streak: fc.integer({ min: 0, max: 40 }),
      faces: fc.array(fc.boolean(), { minLength: SHELL_COUNT, maxLength: SHELL_COUNT }),
      thini: fc.integer({ min: 1, max: 1000 }),
      ghantiChips: fc.integer({ min: 0, max: 997 }),
      cap: fc.integer({ min: 1, max: 1024 }),
      doubling: fc.boolean(),
      maxChyakhe: fc.integer({ min: 0, max: 8 }),
      bets: fc.array(
        fc.record({ seatIndex: fc.integer({ min: 0, max: 2 }), chips: fc.integer({ min: 1, max: 5000 }) }),
        { maxLength: 8 },
      ),
    })
    .map((t): RoundInput => {
      const occupants: Partial<Record<SeatId, string>> = {};
      TURN_ORDER.forEach((seat, i) => {
        if (seat === t.thrower || t.filled[i]) occupants[seat] = `p-${seat}`;
      });
      const betSeats = TURN_ORDER.filter((s) => s !== t.thrower);
      const chyakhe: ChyakheBet[] = t.bets.slice(0, t.maxChyakhe).map((b, i) => ({
        playerId: `c-${i}`,
        seat: betSeats[b.seatIndex] ?? "chauka",
        chips: b.chips,
      }));
      return {
        thrower: t.thrower,
        occupants,
        chyakhe,
        streak: t.streak,
        faces: t.faces,
        rules: {
          thini: t.thini,
          ghantiChips: t.ghantiChips,
          maxStakeMultiplier: t.cap,
          doubling: t.doubling,
          chyakheEnabled: true,
          maxChyakhe: t.maxChyakhe,
        },
      };
    });

  it("sums to exactly zero, in whole chips, across random tables, streaks, caps and bets", () => {
    fc.assert(
      fc.property(tableArb, (input) => {
        const outcome = settleRound(input);
        expect(sum(outcome.deltas)).toBe(0);
        for (const v of Object.values(outcome.deltas)) expect(Number.isSafeInteger(v)).toBe(true);
        // The stake never exceeds the cap.
        expect(outcome.stake).toBeLessThanOrEqual(input.rules.thini * input.rules.maxStakeMultiplier);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("the game is exactly fair", () => {
  it("gives the thrower exactly zero edge from teeya and from panja, at every streak", () => {
    for (const streak of [0, 1, 2, 3, 5, 9]) {
      for (const thrower of ["teeya", "panja"] as const) {
        expect(weightedTotal(`p-${thrower}`, { thrower, streak, rules: NO_GHANTI })).toBe(0);
      }
    }
  });

  it("gives chauka exactly 1/128 of a thini per throw, and chakka the opposite", () => {
    const { thini } = SIMPLE_HOUSE_RULES;
    const chauka = weightedTotal("p-chauka", { thrower: "chauka" });
    const chakka = weightedTotal("p-chakka", { thrower: "chakka" });
    // edge per throw = total / 65536; 1/128 thini means total * 128 = thini * 65536.
    expect(chauka * 128).toBe(thini * ALL_THROWS);
    expect(chakka).toBe(-chauka);
  });

  it("scales the chauka edge with the stake, so doubling does not create a new one", () => {
    for (const streak of [0, 1, 2, 3, 5, 9]) {
      const m = stakeMultiplier(streak, NO_GHANTI);
      const chauka = weightedTotal("p-chauka", { thrower: "chauka", streak, rules: NO_GHANTI });
      expect(chauka * 128).toBe(m * NO_GHANTI.thini * ALL_THROWS);
    }
  });

  it("gives an outside bettor exactly zero edge between equal seats", () => {
    const chips = 9;
    for (const [thrower, seat] of [
      ["teeya", "panja"],
      ["panja", "teeya"],
    ] as const) {
      const chyakhe: ChyakheBet[] = [{ playerId: "c1", seat, chips }];
      expect(weightedTotal("c1", { thrower, chyakhe })).toBe(0);
    }
  });

  it("gives every chyakhe bet exactly chips x (P(seat) - P(thrower))", () => {
    // Zero whenever the two seats are equally likely. Only chauka and chakka
    // differ, so that is the only place a chyakhe has any edge.
    const chips = 7;
    for (const thrower of TURN_ORDER) {
      for (const seat of TURN_ORDER) {
        if (seat === thrower) continue;
        const chyakhe: ChyakheBet[] = [{ playerId: "c1", seat, chips }];
        expect(weightedTotal("c1", { thrower, chyakhe })).toBe(
          chips * (SEAT_WAYS[seat] - SEAT_WAYS[thrower]),
        );
      }
    }
  });

  it("makes ghanti a pure transfer: the four players' totals sum to zero", () => {
    for (const ghantiChips of [30, 31, 1]) {
      const rules: HouseRules = { ...DEFAULT_HOUSE_RULES, ghantiChips };
      for (const thrower of TURN_ORDER) {
        const table = TURN_ORDER.reduce(
          (acc, seat) => acc + weightedTotal(`p-${seat}`, { thrower, rules }),
          0,
        );
        expect(table).toBe(0);
      }
      // It costs the thrower exactly ghanti x P(hit) on a first throw.
      const withG = weightedTotal("p-teeya", { thrower: "teeya", rules });
      const without = weightedTotal("p-teeya", { thrower: "teeya", rules: NO_GHANTI });
      expect(without - withG).toBe(ghantiChips * SEAT_WAYS.teeya);
    }
  });
});

describe("settlement amounts", () => {
  it("on a hit, collects the stake from each of the three others", () => {
    const o = round({ thrower: "teeya", faceUp: 3 });
    expect(o.hit).toBe(true);
    expect(o.deltas).toEqual({ "p-teeya": 30, "p-chauka": -10, "p-panja": -10, "p-chakka": -10 });
  });

  it("on a miss, pays the stake to the winning seat only", () => {
    const o = round({ thrower: "teeya", faceUp: 5 }); // panja
    expect(o.hit).toBe(false);
    expect(o.deltas).toEqual({ "p-teeya": -10, "p-chauka": 0, "p-panja": 10, "p-chakka": 0 });
  });

  it("pays a chyakhe 1:1 from the thrower when their seat wins, and returns the rest", () => {
    const chyakhe: ChyakheBet[] = [
      { playerId: "c-chauka", seat: "chauka", chips: 5 },
      { playerId: "c-panja", seat: "panja", chips: 7 },
      { playerId: "c-chakka", seat: "chakka", chips: 9 },
    ];
    const o = round({ thrower: "teeya", faceUp: 5, chyakhe }); // panja
    expect(o.deltas["c-panja"]).toBe(7);
    expect(o.deltas["c-chauka"]).toBe(0);
    expect(o.deltas["c-chakka"]).toBe(0);
    expect(o.deltas["p-teeya"]).toBe(-10 - 7);
  });

  it("gives the thrower every chyakhe bet on a hit", () => {
    const chyakhe: ChyakheBet[] = [
      { playerId: "c-chauka", seat: "chauka", chips: 5 },
      { playerId: "c-panja", seat: "panja", chips: 7 },
    ];
    const o = round({ thrower: "teeya", faceUp: 3, chyakhe });
    expect(o.deltas["c-chauka"]).toBe(-5);
    expect(o.deltas["c-panja"]).toBe(-7);
    expect(o.deltas["p-teeya"]).toBe(30 + 12);
  });

  it("splits ghanti among the others, handing out the remainder one chip at a time", () => {
    const rules: HouseRules = { ...SIMPLE_HOUSE_RULES, ghantiChips: 11 };
    const o = round({ thrower: "teeya", faceUp: 3, rules });
    // 11 over three seats is 4, 4, 3, given out in seating order.
    expect(o.deltas).toEqual({ "p-teeya": 30 - 11, "p-chauka": -10 + 4, "p-panja": -10 + 4, "p-chakka": -10 + 3 });
  });

  it("charges ghanti only on the first hit of a turn", () => {
    const rules: HouseRules = { ...DEFAULT_HOUSE_RULES, ghantiChips: 11 };
    const o = round({ thrower: "teeya", faceUp: 3, streak: 1, rules });
    expect(o.deltas["p-teeya"]).toBe(3 * 20);
  });

  it("is a push when the winning seat is empty", () => {
    const o = round({
      thrower: "teeya",
      occupants: { teeya: "p-teeya", panja: "p-panja" },
      chyakhe: [{ playerId: "c1", seat: "chauka", chips: 5 }],
      faceUp: 4, // chauka, which nobody is sitting on
    });
    expect(o.push).toBe(true);
    expect(Object.values(o.deltas).every((v) => v === 0)).toBe(true);
    expect(o.nextThrower).toBe("panja");
  });
});

describe("turn flow", () => {
  it("keeps the throw on a hit and doubles the stake, up to the cap", () => {
    const rules: HouseRules = { ...NO_GHANTI, maxStakeMultiplier: 8 };
    let streak = 0;
    const stakes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const o = round({ thrower: "panja", faceUp: 5, streak, rules });
      expect(o.hit).toBe(true);
      expect(o.nextThrower).toBe("panja");
      stakes.push(o.stake);
      streak = o.nextStreak;
    }
    expect(stakes).toEqual([10, 20, 40, 80, 80, 80]);
  });

  it("holds a cap that is not a power of two", () => {
    const rules: HouseRules = { ...NO_GHANTI, maxStakeMultiplier: 5 };
    expect([0, 1, 2, 3, 4, 30, 1000].map((s) => stakeMultiplier(s, rules))).toEqual([1, 2, 4, 5, 5, 5, 5]);
  });

  it("never escalates with doubling off", () => {
    const rules: HouseRules = { ...NO_GHANTI, doubling: false };
    expect([0, 1, 5, 40].map((s) => stakeMultiplier(s, rules))).toEqual([1, 1, 1, 1]);
  });

  it("passes the throw anticlockwise on a miss and resets the stake", () => {
    const o = round({ thrower: "teeya", faceUp: 4, streak: 4, rules: DEFAULT_HOUSE_RULES });
    expect(o.hit).toBe(false);
    expect(o.nextThrower).toBe("chauka");
    expect(o.nextStreak).toBe(0);
    expect(stakeMultiplier(o.nextStreak, DEFAULT_HOUSE_RULES)).toBe(1);
  });

  it("goes round the table in order and skips empty seats", () => {
    const expected: Record<SeatId, SeatId> = { teeya: "chauka", chauka: "panja", panja: "chakka", chakka: "teeya" };
    for (const thrower of TURN_ORDER) {
      // A miss: pick a face count that does not land on the thrower.
      const faceUp = [0, 1, 2, 3].find((k) => seatForFaceCount(k) !== thrower) ?? 0;
      expect(round({ thrower, faceUp }).nextThrower).toBe(expected[thrower]);
    }
    const sparse = { teeya: "p-teeya", chakka: "p-chakka" };
    expect(round({ thrower: "teeya", occupants: sparse, faceUp: 5 }).nextThrower).toBe("chakka");
  });
});

describe("invalid input is rejected", () => {
  it("refuses a chyakhe bet on the thrower's own seat", () => {
    expect(() =>
      round({ thrower: "teeya", chyakhe: [{ playerId: "c1", seat: "teeya", chips: 5 }], faceUp: 3 }),
    ).toThrow(/thrower's seat/);
  });

  it("refuses an empty thrower seat", () => {
    expect(() => round({ thrower: "teeya", occupants: { panja: "p-panja" }, faceUp: 3 })).toThrow(/empty/);
  });

  it("refuses more chyakhe than the table allows", () => {
    const rules: HouseRules = { ...DEFAULT_HOUSE_RULES, maxChyakhe: 1 };
    const chyakhe: ChyakheBet[] = [
      { playerId: "c1", seat: "panja", chips: 5 },
      { playerId: "c2", seat: "chauka", chips: 5 },
    ];
    expect(() => round({ chyakhe, rules, faceUp: 3 })).toThrow(/too many chyakhe/);
  });

  it("refuses chyakhe when the house rules turn them off", () => {
    const rules: HouseRules = { ...DEFAULT_HOUSE_RULES, chyakheEnabled: false };
    expect(() =>
      round({ chyakhe: [{ playerId: "c1", seat: "panja", chips: 5 }], rules, faceUp: 3 }),
    ).toThrow(/disabled/);
  });

  it("refuses a fractional thini", () => {
    expect(() => round({ rules: { ...DEFAULT_HOUSE_RULES, thini: 2.5 }, faceUp: 3 })).toThrow(RangeError);
  });

  it("refuses fractional, zero or oversized amounts elsewhere", () => {
    const bad: HouseRules[] = [
      { ...DEFAULT_HOUSE_RULES, thini: 0 },
      { ...DEFAULT_HOUSE_RULES, ghantiChips: 1.5 },
      { ...DEFAULT_HOUSE_RULES, ghantiChips: -1 },
      { ...DEFAULT_HOUSE_RULES, maxStakeMultiplier: 0 },
      { ...DEFAULT_HOUSE_RULES, thini: 1e300 },
      // Each value is fine alone, but the capped stake would lose precision.
      { ...DEFAULT_HOUSE_RULES, thini: 2 ** 30, maxStakeMultiplier: 2 ** 30 },
    ];
    for (const rules of bad) expect(() => round({ rules, faceUp: 3 }), JSON.stringify(rules)).toThrow(RangeError);
    for (const chips of [0, -5, 2.5, MAX_CHIP_AMOUNT + 1]) {
      expect(() => round({ chyakhe: [{ playerId: "c1", seat: "panja", chips }], faceUp: 3 })).toThrow(
        RangeError,
      );
    }
  });

  it("refuses a negative or fractional streak", () => {
    expect(() => round({ streak: -1, faceUp: 3 })).toThrow(RangeError);
    expect(() => round({ streak: 1.5, faceUp: 3, rules: DEFAULT_HOUSE_RULES })).toThrow(RangeError);
  });
});
