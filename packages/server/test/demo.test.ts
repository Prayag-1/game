import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { HIT, MISS, commitmentFromSeed, runDemo } from "../src/index.js";
import { lcg } from "./harness.js";

function deterministic(prefix = "demo") {
  let i = 0;
  return () => commitmentFromSeed(Uint8Array.from(createHash("sha256").update(`${prefix}-${i++}`).digest()));
}

describe("terminal demo", () => {
  it("reports every settled round, including the ones bots throw", () => {
    const lines: string[] = [];
    const s = runDemo({ rounds: 80, out: (l) => lines.push(l), commitments: deterministic(), botRandom: lcg(3) });
    const roundLines = lines.filter((l) => l.startsWith("#"));
    expect(s.roundsPlayed).toBe(80);
    expect(roundLines).toHaveLength(80);
    // Three of the four seats are bots, so most throws are theirs. Logging
    // only what one tick returns would show the human's throws alone.
    expect(s.botThrows).toBeGreaterThan(s.humanThrows);
    expect(s.hits + s.misses + s.pushes).toBe(80);
    expect(roundLines.some((l) => l.includes(HIT))).toBe(true);
    expect(roundLines.some((l) => l.includes(MISS))).toBe(true);
    expect(s.conserved).toBe(true);
    expect(s.allVerified).toBe(true);
    // Settlement alone nets to zero, whatever funding did.
    expect(s.roundNet).toBe(0);
    // Every account, the mint included, sums to zero.
    expect(s.allAccountsSum).toBe(0);
    expect(s.chipsAtEnd).toBe(-s.mintBalance);
    expect(s.chipsAtEnd).toBe(s.chipsAtStart + s.chipsIssued - s.chipsReturned);
  });

  it("lets a human who goes broke claim a top-up and sit again, and still conserves", () => {
    const lines: string[] = [];
    // A buy-in just over the 80-chip minimum, and a seed stream in which the
    // human drops below it early.
    const s = runDemo({ rounds: 300, buyIn: 100, out: (l) => lines.push(l), commitments: deterministic("bust-a"), botRandom: lcg(5) });
    expect(s.roundsPlayed).toBe(300);
    expect(s.topUps).toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => l.includes("claims a top-up"))).toBe(true);
    expect(s.chipsReturned).toBeGreaterThan(0);
    expect(s.roundNet).toBe(0);
    expect(s.allAccountsSum).toBe(0);
    expect(s.conserved).toBe(true);
    expect(s.allVerified).toBe(true);
  });

  it("stops at once if the seed source hands back a seed that does not match its hash", () => {
    // A factory that lies: the seed it hands back hashes to something else.
    const honest = deterministic();
    let n = 0;
    const lying = () => {
      const c = honest();
      return n++ === 2 ? { ...c, commitHash: honest().commitHash } : c;
    };
    expect(() => runDemo({ rounds: 5, out: () => {}, commitments: lying })).toThrow(/does not match/);
  });
});
