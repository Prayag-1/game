import * as RAPIER from "@dimforge/rapier3d";
import { SHELL_COUNT, TURN_ORDER } from "@kauda/rules";
import { describe, expect, it, vi } from "vitest";
import { BOARD, SHELL, SHELL_SET } from "../src/lib/board";
import { PLAYBACK_RATE } from "../src/lib/throw/director";
import { SEQ } from "../src/lib/throw/handSequence";
import { flipsFor, MESH, meshFrame, placeShell, restingFrame, visibleFaceUp } from "../src/lib/throw/playback";
import { seededRng } from "../src/lib/throw/rng";
import { HALF_THICKNESS } from "../src/lib/throw/shell";
import { landingProblems, POSE, round6, SIM, simulateAttempt, simulateRound, type Recording } from "../src/lib/throw/simulate";

/**
 * The throw's physics, against the real Rapier (the same pinned build the
 * worker runs): the flip rule, determinism, and clean landings.
 */

const cache = new Map<string, Recording>();
function recording(roundId: string): Recording {
  let r = cache.get(roundId);
  if (r === undefined) {
    r = simulateRound(RAPIER, roundId);
    cache.set(roundId, r);
  }
  return r;
}

const restOf = (r: Recording) => r.poses.subarray((r.frames - 1) * SHELL_COUNT * POSE);

describe("the flip rule", () => {
  it("shows exactly the server's faces at rest, shell by shell, for every pattern, seed and thrower", () => {
    const rng = seededRng("test:face-patterns");
    let checked = 0;
    for (let seed = 0; seed < 10; seed += 1) {
      const rec = recording(`flip:${seed}`);
      expect(rec.fallback).toBe(false);
      const patterns: boolean[][] = [Array(SHELL_COUNT).fill(true), Array(SHELL_COUNT).fill(false)];
      for (let k = 0; k < 8; k += 1) patterns.push(Array.from({ length: SHELL_COUNT }, () => rng.next() < 0.5));
      for (const faces of patterns) {
        for (const thrower of TURN_ORDER) {
          const frame = restingFrame(rec, faces, thrower);
          for (let i = 0; i < SHELL_COUNT; i += 1) expect(visibleFaceUp(frame, i), `seed ${seed} shell ${i}`).toBe(faces[i]);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(10 * 10 * 4);
  });

  it("turns a mesh over inside its collider from the first frame, never during the throw", () => {
    const rec = recording("flip:0");
    const faces = Array.from({ length: SHELL_COUNT }, (_, i) => i % 3 === 0);
    const flips = flipsFor(rec.colliderUp, faces);
    const frame = meshFrame();
    for (let i = 0; i < SHELL_COUNT; i += 1) {
      // Which side of its collider the drawn dome is on: the same at every frame.
      const side = new Set<boolean>();
      for (let f = 0; f < rec.frames; f += 7) {
        const at = (f * SHELL_COUNT + i) * POSE;
        placeShell(frame, i, rec.poses, at, flips[i] === true, "teeya");
        const [cx, cy, cz, cw] = [rec.poses[at + 3], rec.poses[at + 4], rec.poses[at + 5], rec.poses[at + 6]] as number[] as [number, number, number, number];
        const [mx, my, mz, mw] = Array.from(frame.subarray(i * MESH + 3, i * MESH + 7)) as [number, number, number, number];
        // The collider's +y and the mesh's +y (the dome), in the world: same way or opposite.
        const cUp = [2 * (cx * cy - cw * cz), 1 - 2 * (cx * cx + cz * cz), 2 * (cy * cz + cw * cx)];
        const mUp = [2 * (mx * my - mw * mz), 1 - 2 * (mx * mx + mz * mz), 2 * (my * mz + mw * mx)];
        side.add((cUp[0] ?? 0) * (mUp[0] ?? 0) + (cUp[1] ?? 0) * (mUp[1] ?? 0) + (cUp[2] ?? 0) * (mUp[2] ?? 0) > 0);
      }
      expect([...side]).toEqual([flips[i] !== true]);
    }
  });

  it("rests every drawn shell on the board, face up or down: neither side floats or sinks", () => {
    for (let seed = 0; seed < 4; seed += 1) {
      const rec = recording(`flip:${seed}`);
      for (const faces of [Array(SHELL_COUNT).fill(true), Array(SHELL_COUNT).fill(false)]) {
        const frame = restingFrame(rec, faces, "teeya");
        for (let i = 0; i < SHELL_COUNT; i += 1) {
          const s = SHELL_SET[i]?.scale ?? 1;
          // The mesh's edge plane, and how far its lowest point lies below it: the dome (face up) or the base (face down).
          const lowest = (frame[i * MESH + 1] ?? 0) - (faces[i] ? SHELL.dome : SHELL.base) * s;
          // Lying within 8 degrees of flat moves the lowest point by under 2 thousandths.
          expect(Math.abs(lowest - BOARD.surface), `seed ${seed} shell ${i}`).toBeLessThan(0.003);
        }
      }
    }
  });
});

describe("the same throw for everyone", () => {
  it("gives the same round id identical resting positions on two separate runs", () => {
    for (const id of ["Hx7Kq2mPa:12", "det:1", "det:2"]) {
      const a = simulateRound(RAPIER, id);
      const b = simulateRound(RAPIER, id);
      expect(b.attempt).toBe(a.attempt);
      expect(b.frames).toBe(a.frames);
      expect(Buffer.from(b.poses.buffer).equals(Buffer.from(a.poses.buffer))).toBe(true);
      expect(Array.from(restOf(b))).toEqual(Array.from(restOf(a)));
    }
  });

  it("gives different rounds different throws", () => {
    expect(Array.from(restOf(recording("det:1")))).not.toEqual(Array.from(restOf(recording("det:2"))));
  });
});

describe("every input handed to Rapier", () => {
  it("is already rounded to 6 decimal places: positions, rotations, velocities, spin, rolling resistance, shapes, the board", () => {
    // Plain numbers must be 6-decimal values; Float32Array entries, the float32 of one.
    const seen: { where: string; value: number; f32: boolean }[] = [];
    type Read = { plain?: number[]; f32?: ArrayLike<number> };
    const xyz = (v: { x: number; y: number; z: number; w?: number }) => [v.x, v.y, v.z, ...(v.w === undefined ? [] : [v.w])];
    const spy = <T extends object>(target: T, name: keyof T, read: (self: never, ...args: never[]) => Read) => {
      const original = target[name] as (...args: unknown[]) => unknown;
      vi.spyOn(target, name as never).mockImplementation(function (this: unknown, ...args: unknown[]) {
        const r = read(this as never, ...(args as never[]));
        for (const value of r.plain ?? []) seen.push({ where: String(name), value, f32: false });
        for (const value of Array.from(r.f32 ?? [])) seen.push({ where: String(name), value, f32: true });
        return original.apply(this, args);
      } as never);
    };
    spy(RAPIER.RigidBodyDesc.prototype, "setTranslation", (_s, x: number, y: number, z: number) => ({ plain: [x, y, z] }));
    spy(RAPIER.RigidBodyDesc.prototype, "setRotation", (_s, q: { x: number; y: number; z: number; w: number }) => ({ plain: xyz(q) }));
    spy(RAPIER.RigidBody.prototype, "setLinvel", (_s, v: { x: number; y: number; z: number }) => ({ plain: xyz(v) }));
    spy(RAPIER.RigidBody.prototype, "setAngvel", (_s, v: { x: number; y: number; z: number }) => ({ plain: xyz(v) }));
    spy(RAPIER.ColliderDesc.prototype, "setTranslation", (_s, x: number, y: number, z: number) => ({ plain: [x, y, z] }));
    spy(RAPIER.ColliderDesc, "roundConvexHull", (_s, p: Float32Array, r: number) => ({ f32: p, plain: [r] }));
    spy(RAPIER.ColliderDesc, "convexHull", (_s, p: Float32Array) => ({ f32: p }));
    spy(RAPIER.ColliderDesc, "cuboid", (_s, x: number, y: number, z: number) => ({ plain: [x, y, z] }));
    // Gravity is set as a field: read it on every step.
    spy(RAPIER.World.prototype, "step", (self: RAPIER.World) => ({ plain: xyz(self.gravity) }));

    simulateAttempt(RAPIER, "rounded-inputs", 0);

    const kinds = new Set(seen.map((s) => s.where));
    for (const k of ["setTranslation", "setRotation", "setLinvel", "setAngvel", "roundConvexHull", "convexHull", "cuboid", "step"]) expect(kinds).toContain(k);
    const unrounded = seen.filter(({ value, f32 }) => (f32 ? Math.fround(round6(value)) !== value : round6(value) !== value));
    expect(unrounded.slice(0, 5)).toEqual([]);
    expect(seen.length).toBeGreaterThan(10_000);
  });
});

describe("clean landings", () => {
  it(
    "over 200 rounds, every accepted throw lies flat, apart and inside the rim",
    () => {
      const ROUNDS = 200;
      const attempts: number[] = [];
      const seconds: number[] = [];
      let fallbacks = 0;
      for (let r = 0; r < ROUNDS; r += 1) {
        const rec = simulateRound(RAPIER, `clean:${r}`);
        attempts.push(rec.attempts);
        if (rec.fallback) {
          fallbacks += 1;
          continue;
        }
        seconds.push((rec.frames - 1) * rec.dt);
        const rest = restOf(rec);
        expect(landingProblems(rest)).toEqual([]);
        // The same three facts again, from first principles.
        for (let i = 0; i < SHELL_COUNT; i += 1) {
          const o = i * POSE;
          const [x, y, z, qx, , qz] = Array.from(rest.subarray(o, o + 7)) as [number, number, number, number, number, number];
          const s = SHELL_SET[i]?.scale ?? 1;
          expect(Math.abs(1 - 2 * (qx * qx + qz * qz)), "flat").toBeGreaterThan(Math.cos((8 * Math.PI) / 180));
          expect(Math.abs(y - (BOARD.surface + HALF_THICKNESS * s)), "on the board, not on a shell").toBeLessThan(0.004);
          expect(Math.hypot(x, z) + (SHELL.length / 2) * s, "inside the rim").toBeLessThan(BOARD.rimInner);
          for (let k = 0; k < i; k += 1) {
            expect(Math.hypot((rest[k * POSE] ?? 0) - x, (rest[k * POSE + 2] ?? 0) - z), "apart").toBeGreaterThan(SHELL.width * 0.85);
          }
        }
      }
      const avg = attempts.reduce((a, b) => a + b, 0) / ROUNDS;
      const worst = Math.max(...attempts);
      seconds.sort((a, b) => a - b);
      console.log(
        `clean landings over ${ROUNDS} rounds: ${avg.toFixed(2)} attempts on average, worst ${worst}, ${fallbacks} fallbacks; ` +
          `release to rest (simulated) median ${seconds[Math.floor(seconds.length / 2)]?.toFixed(2)} s, longest ${seconds.at(-1)?.toFixed(2)} s`,
      );
      expect(avg).toBeLessThan(3);
      expect(fallbacks).toBeLessThanOrEqual(1);
      // No accepted throw outlasts the time the server's reveal allows for it...
      expect(Math.max(...seconds)).toBeLessThanOrEqual(SIM.maxFlightSeconds);
      // ...and none is so short that the shells rest before the hand has cleared the board.
      expect(((seconds[0] ?? 0) / PLAYBACK_RATE) * 1000).toBeGreaterThan(SEQ.followMs + SEQ.withdrawMs);
    },
    300_000,
  );

  it("falls back, with every attempt tried, when no attempt lands clean", () => {
    let tried = 0;
    const rec = simulateRound(RAPIER, "never-clean", () => {
      tried += 1;
      return false;
    });
    expect(tried).toBe(SIM.maxAttempts);
    expect(rec.fallback).toBe(true);
    expect(rec.attempt).toBe(-1);
    expect(rec.frames).toBe(0);
  });

  it("uses the attempt number as part of the seed: attempts differ, and each is the same every time", () => {
    const a0 = simulateAttempt(RAPIER, "attempts", 0);
    const a1 = simulateAttempt(RAPIER, "attempts", 1);
    expect(Array.from(a0.releasePoint)).not.toEqual(Array.from(a1.releasePoint));
    expect(Array.from(simulateAttempt(RAPIER, "attempts", 1).poses)).toEqual(Array.from(a1.poses));
  });
});
