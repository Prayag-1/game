import { createHash } from "node:crypto";
import { DEFAULT_HOUSE_RULES, type HouseRules, type SeatId } from "@kauda/rules";
import {
  Table,
  commitmentFromSeed,
  seedForFaceCount,
  type CommandResult,
  type SeatFillPolicy,
  type TableOptions,
} from "../src/index.js";

/** Default rules for tests: thini 10, cap 8, no ghanti so sums are easy to read. */
export const TEST_RULES: HouseRules = { ...DEFAULT_HOUSE_RULES, ghantiChips: 0 };

/** A small deterministic generator for bot decisions. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface Harness {
  readonly table: Table;
  /** Queues seeds for the next rounds, by face-up count. */
  queue(...faceUps: number[]): void;
  /** Moves the fake clock forward and ticks the table. */
  advance(ms: number): void;
  now(): number;
  /** Ends betting, then has the thrower throw, or lets the timer throw for them. */
  playRound(throwerId?: string): void;
  ok(result: CommandResult): void;
}

export function harness(
  options: Partial<TableOptions> = {},
  botSeed = 7,
  // Off by default, so these tests see empty seats; pass a policy to turn it on.
  seatFilling: SeatFillPolicy | null = null,
): Harness {
  let t = 1_000_000;
  const scripted: Uint8Array[] = [];
  let variant = 0;
  let fallback = 0;
  const table = new Table(
    { tableId: "t1", rules: TEST_RULES, minChipsToSit: 100, ...options },
    {
      now: () => t,
      // Scripted seeds first, then a deterministic stream.
      commitments: () =>
        commitmentFromSeed(
          scripted.shift() ?? Uint8Array.from(createHash("sha256").update(`seed-${fallback++}`).digest()),
        ),
      botRandom: lcg(botSeed),
      seatFilling,
    },
  );
  const h: Harness = {
    table,
    queue: (...faceUps) => {
      for (const k of faceUps) scripted.push(seedForFaceCount(k, variant++));
    },
    advance: (ms) => {
      t += ms;
      table.tick();
    },
    now: () => t,
    playRound: (throwerId) => {
      h.advance(table.timings.bettingMs);
      if (throwerId === undefined) h.advance(table.timings.throwingMs);
      else h.ok(table.handle(throwerId, { type: "throw" }));
      h.advance(table.timings.revealMs);
    },
    ok: (result) => {
      if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    },
  };
  return h;
}

/** Seats humans A-D on teeya, chauka, panja, chakka, each with `chips`. */
export function seatFour(h: Harness, chips: number | readonly number[] = 1000): void {
  const seats: SeatId[] = ["teeya", "chauka", "panja", "chakka"];
  seats.forEach((seat, i) => {
    const id = "ABCD"[i] ?? "?";
    const buyIn = typeof chips === "number" ? chips : (chips[i] ?? 1000);
    h.ok(h.table.join(id, { name: id, buyIn }));
    h.ok(h.table.handle(id, { type: "sit", seat }));
  });
}
