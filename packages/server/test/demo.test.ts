import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { HIT, MISS, commitmentFromSeed, runDemo } from "../src/index.js";
import { lcg } from "./harness.js";

function deterministic() {
  let i = 0;
  return () => commitmentFromSeed(Uint8Array.from(createHash("sha256").update(`demo-${i++}`).digest()));
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
    expect(s.chipsAtEnd).toBe(s.chipsAtStart + s.chipsIssued);
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
