import { describe, expect, it } from "vitest";
import {
  SHELL_COUNT,
  TURN_ORDER,
  facesForCount,
  resolveThrow,
  seatForFaceCount,
  throwShells,
  type SeatId,
} from "../src/index.js";

/** Exact binomial coefficient. */
function comb(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i += 1) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

describe("seat mapping", () => {
  it("matches the facts stated in the article", () => {
    // "Four shells up, rest down: chauka wins. Five shells up: panja wins."
    expect(seatForFaceCount(4)).toBe("chauka");
    expect(seatForFaceCount(5)).toBe("panja");
    // "All shells up or all down are rare and represent chauka."
    expect(seatForFaceCount(0)).toBe("chauka");
    expect(seatForFaceCount(16)).toBe("chauka");
    // Seat numbers: teeya 3, chakka 6.
    expect(seatForFaceCount(3)).toBe("teeya");
    expect(seatForFaceCount(6)).toBe("chakka");
  });

  it("gives seventeen outcomes, five of them chauka and four each to the rest", () => {
    const outcomes = Array.from({ length: SHELL_COUNT + 1 }, (_, k) => seatForFaceCount(k));
    expect(outcomes).toHaveLength(17);
    const tally: Record<SeatId, number> = { teeya: 0, chauka: 0, panja: 0, chakka: 0 };
    for (const seat of outcomes) tally[seat] += 1;
    expect(tally).toEqual({ chauka: 5, panja: 4, chakka: 4, teeya: 4 });
  });

  it("rejects impossible face counts", () => {
    expect(() => seatForFaceCount(-1)).toThrow(RangeError);
    expect(() => seatForFaceCount(17)).toThrow(RangeError);
    expect(() => seatForFaceCount(1.5)).toThrow(RangeError);
  });
});

describe("exact odds over all 65536 throws", () => {
  it("counts every possible throw and matches the binomial weights", () => {
    const tally: Record<SeatId, number> = { teeya: 0, chauka: 0, panja: 0, chakka: 0 };
    for (let mask = 0; mask < 1 << SHELL_COUNT; mask += 1) {
      let up = 0;
      for (let bit = 0; bit < SHELL_COUNT; bit += 1) if (mask & (1 << bit)) up += 1;
      tally[seatForFaceCount(up)] += 1;
    }
    const total = tally.chauka + tally.panja + tally.chakka + tally.teeya;
    expect(total).toBe(2 ** SHELL_COUNT);
    expect(tally).toEqual({ chauka: 16512, panja: 16384, chakka: 16256, teeya: 16384 });

    // Cross-check against the binomial coefficients directly.
    const byComb: Record<SeatId, number> = { teeya: 0, chauka: 0, panja: 0, chakka: 0 };
    for (let k = 0; k <= SHELL_COUNT; k += 1) byComb[seatForFaceCount(k)] += comb(SHELL_COUNT, k);
    expect(byComb).toEqual(tally);
  });

  it("leaves teeya and panja at exactly one quarter", () => {
    expect(16384 / 2 ** SHELL_COUNT).toBe(0.25);
  });

  it("gives chauka the only real edge, worth about four tenths of a percent", () => {
    const edge = (16512 - 16256) / 2 ** SHELL_COUNT;
    expect(edge).toBeCloseTo(0.00390625, 10);
  });
});

describe("throwing", () => {
  it("reads a set of faces", () => {
    const r = resolveThrow(facesForCount(5));
    expect(r.faceUp).toBe(5);
    expect(r.winningSeat).toBe("panja");
  });

  it("insists on sixteen shells", () => {
    expect(() => resolveThrow([true, false])).toThrow(RangeError);
  });

  it("produces every seat over many throws from a seeded source", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const seen = new Set<SeatId>();
    for (let i = 0; i < 5000; i += 1) seen.add(throwShells(random).winningSeat);
    expect([...seen].sort()).toEqual([...TURN_ORDER].sort());
  });
});
