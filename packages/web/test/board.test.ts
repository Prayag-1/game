import { SHELL_COUNT, TURN_ORDER, type SeatId } from "@kauda/rules";
import { describe, expect, it } from "vitest";
import { BOARD, boardTurn, heap, scatter, seatAngle, seatSides, shellPoses, shellRadius, SHELL, type ShellPose, type Side } from "../src/lib/board";

// ------------------------------------------------------------------ seats

describe("seat sides", () => {
  it.each<[SeatId | null, Record<SeatId, Side>]>([
    ["teeya", { teeya: "bottom", chauka: "right", panja: "top", chakka: "left" }],
    ["chauka", { chauka: "bottom", panja: "right", chakka: "top", teeya: "left" }],
    ["panja", { panja: "bottom", chakka: "right", teeya: "top", chauka: "left" }],
    ["chakka", { chakka: "bottom", teeya: "right", chauka: "top", panja: "left" }],
    [null, { teeya: "bottom", chauka: "right", panja: "top", chakka: "left" }],
  ])("sitting at %s, puts me at the bottom and the rest anticlockwise", (mySeat, expected) => {
    expect(seatSides(mySeat)).toEqual(expected);
  });

  it("turns the 3D board so each seat's edge faces the side its panel is on", () => {
    // Screen directions in the scene: the camera looks from +z, so bottom is +z and right is +x.
    const screen: Record<Side, [number, number]> = { bottom: [0, 1], right: [1, 0], top: [0, -1], left: [-1, 0] };
    for (const mySeat of [...TURN_ORDER, null]) {
      const sides = seatSides(mySeat);
      const turn = boardTurn(mySeat);
      for (const seat of TURN_ORDER) {
        // A seat's edge in the board's frame is (sin a, cos a); the board turns by `turn` about +y.
        const a = seatAngle(seat) + turn;
        const [x, z] = screen[sides[seat]];
        expect(Math.sin(a)).toBeCloseTo(x, 9);
        expect(Math.cos(a)).toBeCloseTo(z, 9);
      }
    }
  });
});

// ---------------------------------------------------------------- scatter

const SEEDS = Array.from({ length: 2_000 }, (_, i) => `Hx7Kq2mPa:${i + 1}`);

function overlaps(poses: readonly ShellPose[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < poses.length; i += 1) {
    for (let j = i + 1; j < poses.length; j += 1) {
      const a = poses[i] as ShellPose;
      const b = poses[j] as ShellPose;
      const gap = Math.hypot(a.x - b.x, a.z - b.z) - shellRadius(a.scale) - shellRadius(b.scale);
      if (gap < 0) out.push(`${i}/${j} by ${(-gap).toFixed(4)}`);
    }
  }
  return out;
}

describe("the scatter", () => {
  it(`lays out sixteen shells with no two overlapping, over ${SEEDS.length} rounds`, () => {
    for (const id of SEEDS) {
      const poses = scatter(id);
      expect(poses).toHaveLength(SHELL_COUNT);
      // Each shell's circle holds it whatever its turn, so circles apart means shells apart.
      expect(overlaps(poses), id).toEqual([]);
    }
  });

  it("keeps every shell inside the scatter circle, and so well inside the rim", () => {
    expect(BOARD.scatterRadius + shellRadius(1.1)).toBeLessThan(BOARD.rimInner);
    for (const id of SEEDS) {
      for (const p of scatter(id)) {
        expect(Math.hypot(p.x, p.z) + shellRadius(p.scale), id).toBeLessThanOrEqual(BOARD.scatterRadius + 1e-12);
      }
    }
  });

  it("gives the same round the same scatter, and different rounds different ones", () => {
    expect(scatter("table:42")).toEqual(scatter("table:42"));
    expect(scatter("table:42")).not.toEqual(scatter("table:43"));
    const distinct = new Set(SEEDS.slice(0, 200).map((id) => JSON.stringify(scatter(id)[0])));
    expect(distinct.size).toBe(200);
  });

  it("varies the shells a little in size and tint, so they do not look cloned", () => {
    const poses = scatter("table:7");
    const scales = poses.map((p) => p.scale);
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(0.93);
    expect(Math.max(...scales)).toBeLessThanOrEqual(1.06);
    expect(new Set(scales).size).toBe(SHELL_COUNT);
    expect(new Set(poses.map((p) => p.tint)).size).toBe(SHELL_COUNT);
  });

  it("keeps a shell about 3:2, length to width", () => {
    expect(SHELL.length / SHELL.width).toBeGreaterThan(1.4);
    expect(SHELL.length / SHELL.width).toBeLessThan(1.6);
  });
});

// ------------------------------------------------------------------ faces

describe("faces on the board", () => {
  it("turns shell i face up exactly when faces[i] is, in the server's order", () => {
    const faces = [true, false, false, true, true, true, false, false, true, false, true, false, false, false, true, true];
    const poses = shellPoses({ roundId: "r:9", faces });
    expect(poses.map((p) => p.up)).toEqual(faces);
    // And only the faces change: the layout is the round's scatter.
    expect(poses.map((p) => ({ ...p, up: null }))).toEqual(scatter("r:9").map((p) => ({ ...p, up: null })));
  });

  it("shows sixteen face-down shells in a heap before any throw", () => {
    const poses = shellPoses(null);
    expect(poses).toHaveLength(SHELL_COUNT);
    expect(poses.every((p) => !p.up)).toBe(true);
    expect(poses).toEqual(heap());
    // A heap: gathered near the middle, some resting on others.
    expect(Math.max(...poses.map((p) => Math.hypot(p.x, p.z)))).toBeLessThan(0.35);
    expect(poses.filter((p) => p.lift > 0).length).toBeGreaterThan(0);
  });
});
