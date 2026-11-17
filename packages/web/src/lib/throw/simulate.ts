import type * as RAPIER from "@dimforge/rapier3d";
import { SHELL_COUNT } from "@kauda/rules";
import { BOARD, RIM_PROFILE, SHELL } from "../board";
import { randomQuaternion, randomUnitVector, seededRng, type Rng } from "./rng";
import { HALF_THICKNESS, quantize, shellCollider, SHELL_SET } from "./shell";

/**
 * A round's throw, simulated ahead of time and recorded for playback.
 *
 * Runs in a Web Worker (board3d/throw.worker.ts) and in the tests. Depends
 * on the round id ONLY, never on the faces: the colliders are symmetric
 * (shell.ts), so the physics cannot tell face up from face down, and the
 * whole throw can be simulated as soon as a round starts. When the result
 * arrives the only work left is choosing which meshes to flip
 * (playback.ts flipsFor).
 *
 * THE SAME THROW FOR EVERYONE. Every starting value comes from a generator
 * seeded with the round id and the attempt number (rng.ts), built with
 * arithmetic and square roots only; the board and shells are built from
 * rounded numbers (shell.ts quantize); the world steps at a fixed timestep
 * with bodies created in a fixed order; and Rapier is pinned to one version
 * (0.19.3, no SIMD build), whose WebAssembly does the same float arithmetic
 * on every browser. So every client gets the same tumble, the same resting
 * layout, and the same choice of attempt.
 *
 * The throw is simulated in a canonical frame, with the thrower at +z
 * (teeya's side); playback turns it to the real thrower's side. The board is
 * round, so turning a throw is exact.
 *
 * THE THROW. The shells start as one tight handful above the board's edge
 * on the thrower's side, packed by the physics itself. Each shell is then
 * released towards its own resting spot: sixteen spots spread through the
 * middle of the board, well apart, drawn from the seeded generator. A shell
 * lands short of its spot and skids on, so it is aimed at the landing point
 * that skids there. From the release on, everything is physics: the handful
 * spreads in the air, tumbles, lands, bounces a little, skitters and
 * settles.
 *
 * CLEAN LANDINGS. A finished throw must be countable: every shell flat on
 * the board, none on another, none against the rim, none off the board. An
 * attempt that ends otherwise, or takes too long to settle, is discarded and
 * the next attempt number is tried, up to SIM.maxAttempts. If all fail, the
 * recording says so and the board falls back to the seeded scatter.
 */

type Rapier = typeof RAPIER;

/**
 * EVERY NUMBER HANDED TO RAPIER IS ROUNDED TO 6 DECIMAL PLACES.
 *
 * Rapier's WebAssembly does the same arithmetic on every browser, but a
 * value computed in JavaScript with Math.sin, Math.cos, Math.pow and the
 * like may differ in its last digits between engines (V8 and JavaScript-
 * Core are not required to agree), and a throw is chaotic enough that one
 * digit sends two players' shells apart. Rounding at the one boundary into
 * Rapier (positions, rotations, velocities, spin, the rolling resistance,
 * the collider shapes, the board) makes each input the same everywhere:
 * Math.round, * and / are exact IEEE operations. (A value would round
 * differently only if it lay within a last-digit wobble of a rounding
 * boundary; for inputs this varied that is vanishingly unlikely.)
 */
export const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const vec = (x: number, y: number, z: number) => ({ x: round6(x), y: round6(y), z: round6(z) });
const points = (p: ArrayLike<number>): Float32Array => Float32Array.from(p, round6);

/** Every tunable of the throw, in board units (the board's radius is 1) and seconds. */
export const SIM = {
  /** Seconds per step, and per recorded frame. */
  dt: 1 / 120,
  gravity: 12,
  /** An attempt not at rest by then is discarded. */
  maxFlightSeconds: 3,
  maxAttempts: 20,
  /** Contact tolerances scale with this: the shells are about 0.15 board units long, not a metre. */
  lengthUnit: 0.15,
  solverIterations: 4,

  /** The handful is packed for this many steps, in zero gravity, before the release (not recorded). */
  packSteps: 42,
  packPull: 9,

  // Dry glossy shells on a wooden board: little bounce; shells slide easily
  // off each other, less easily over the wood.
  restitution: 0.03,
  rimRestitution: 0.2,
  boardFriction: 0.25,
  shellFriction: 0.1,
  linearDamping: 0.25,
  angularDamping: 1,
  density: 1,

  /** The release's upward speed. */
  liftMin: 2.6,
  liftMax: 3,
  /** The resting spots: a disc this big round a point near the middle, spots at least aimGap apart. */
  aimRadius: 0.42,
  aimStretch: 1.05,
  aimGap: 0.22,
  aimNear: -0.1,
  aimFar: 0.05,
  /** A landing shell skids on about this many seconds' worth of its speed. */
  skid: 0.22,
  /** Each shell's own error on its aim, and its spin. */
  jitter: 0.02,
  spinMin: 4,
  spinMax: 8,

  /**
   * Rolling resistance, which Rapier does not model. A shell near the board
   * loses this share of its spin each step, so it falls over instead of
   * rolling away like a coin; and one lying flat and nearly still also stops
   * rocking and creeping, as a dry shell on wood does. Never a shell leaning
   * on another: that one must stay free to slide off.
   */
  rollHeight: 0.15,
  rollKeep: 0.85,
  settleHeight: 0.048,
  settleLevel: 0.985,
  settleSpeed: 0.3,
  settleSpin: 0.9,
  settleSlide: 0.97,

  /** At rest: every shell slower than these for restSteps steps in a row... */
  restLinear: 0.012,
  restAngular: 0.12,
  restSteps: 14,
  /** ...or, judged by eye: from the rest frame on, no shell moves further than restDrift or turns more than restTurn (|q1 . q2|, about 1.5 degrees). */
  restDrift: 0.002,
  restTurn: 0.99991,
} as const;

export interface Recording {
  readonly roundId: string;
  /** The accepted attempt (0-based); -1 when every attempt failed. */
  readonly attempt: number;
  /** Every attempt failed: show the seeded scatter instead. */
  readonly fallback: boolean;
  /** Attempts tried, the accepted one included. */
  readonly attempts: number;
  /** Seconds per frame. */
  readonly dt: number;
  /** Frames recorded, from the release (frame 0) to rest (the last). 0 for a fallback. */
  readonly frames: number;
  /** frames x 16 x 7 floats: each shell's collider position (x, y, z) and rotation (qx, qy, qz, qw), canonical frame. */
  readonly poses: Float32Array;
  /** 16 x 3: each shell's velocity at the release, for the gather's last moment. */
  readonly releaseVelocity: Float32Array;
  /** The middle of the handful at the release (canonical frame). */
  readonly releasePoint: readonly [number, number, number];
  /** Per shell: at rest, the collider's own +y points up. */
  readonly colliderUp: readonly boolean[];
}

/** Floats per shell per frame. */
export const POSE = 7;

// ------------------------------------------------------------------ board

/**
 * The rim, lathed from the drawn profile, as RIM_SEGMENTS convex pieces
 * round the board. One triangle mesh would have a bounding box covering the
 * whole board, so every shell would be tested against it on every step;
 * small pieces are tested only when a shell comes near. Each piece's chord
 * cuts inside the true circle by under 2 thousandths of the board's radius.
 */
const RIM_SEGMENTS = 48;

function rimPieces(): Float32Array[] {
  const ring = (i: number): [number, number] => {
    const a = (2 * Math.PI * i) / RIM_SEGMENTS;
    return [quantize(Math.cos(a)), quantize(Math.sin(a))];
  };
  const out: Float32Array[] = [];
  for (let i = 0; i < RIM_SEGMENTS; i += 1) {
    const pts: number[] = [];
    for (const [c, sn] of [ring(i), ring(i + 1)]) for (const [r, y] of RIM_PROFILE) pts.push(r * c, y, r * sn);
    out.push(Float32Array.from(pts));
  }
  return out;
}

function buildBoard(R: Rapier, world: RAPIER.World): void {
  // The board's friction wins over the shells' (Max), so shell-on-wood
  // keeps the board's grip while shell-on-shell stays slippery.
  // The playing surface, and the floor beyond the rim at the same height (a shell out there has failed anyway).
  world.createCollider(
    R.ColliderDesc.cuboid(4, 0.5, 4)
      .setTranslation(0, round6(BOARD.surface - 0.5), 0)
      .setFriction(SIM.boardFriction)
      .setFrictionCombineRule(R.CoefficientCombineRule.Max)
      .setRestitution(SIM.restitution),
  );
  for (const piece of rimPieces()) {
    const hull = R.ColliderDesc.convexHull(points(piece));
    if (hull === null) throw new Error("could not build the rim");
    world.createCollider(hull.setFriction(SIM.boardFriction).setFrictionCombineRule(R.CoefficientCombineRule.Max).setRestitution(SIM.rimRestitution));
  }
}

// --------------------------------------------------------------- landings

/** Within 8 degrees of lying flat. */
const FLAT = 0.9903;

/** Why a resting layout cannot be counted; empty when it can. Poses: 16 x 7, canonical frame. */
export function landingProblems(rest: Float32Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < SHELL_COUNT; i += 1) {
    const o = i * POSE;
    const x = rest[o] ?? 0;
    const y = rest[o + 1] ?? 0;
    const z = rest[o + 2] ?? 0;
    const qx = rest[o + 3] ?? 0;
    const qz = rest[o + 5] ?? 0;
    const s = SHELL_SET[i]?.scale ?? 1;
    if (Math.abs(1 - 2 * (qx * qx + qz * qz)) < FLAT) out.push(`shell ${i} is not flat`);
    if (Math.abs(y - (BOARD.surface + HALF_THICKNESS * s)) > 0.004) out.push(`shell ${i} is not lying on the board`);
    if (Math.sqrt(x * x + z * z) + (SHELL.length / 2) * s > BOARD.rimInner - 0.004) out.push(`shell ${i} is against the rim or off the board`);
    for (let k = 0; k < i; k += 1) {
      const dx = (rest[k * POSE] ?? 0) - x;
      const dz = (rest[k * POSE + 2] ?? 0) - z;
      // Two shells lying side by side, touching, are a shell's width apart: closer than that, one is over the other.
      if (Math.sqrt(dx * dx + dz * dz) < 0.95 * SHELL.width * Math.min(s, SHELL_SET[k]?.scale ?? 1)) out.push(`shells ${k} and ${i} overlap`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- attempt

export interface Attempt {
  readonly frames: number;
  readonly poses: Float32Array;
  readonly releaseVelocity: Float32Array;
  readonly releasePoint: [number, number, number];
  readonly settled: boolean;
  readonly problems: readonly string[];
}

function shuffled(n: number, rng: Rng): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j] as number, out[i] as number];
  }
  return out;
}

/**
 * Sixteen resting spots in a disc round `centre`, at least SIM.aimGap apart
 * (seeded dart throwing, square roots only), each matched to the shell lying
 * furthest in its direction within the handful, so the shells fan out
 * without crossing.
 */
function restingSpots(rng: Rng, from: readonly { x: number; z: number }[], c: readonly [number, number, number], centre: readonly [number, number]): [number, number][] {
  const pts: [number, number][] = [];
  for (let tries = 0; pts.length < SHELL_COUNT && tries < 5000; tries += 1) {
    const x = rng.range(-1, 1);
    const z = rng.range(-1, 1);
    if (x * x + z * z > 1) continue;
    const p: [number, number] = [centre[0] + x * SIM.aimRadius, centre[1] + z * SIM.aimRadius * SIM.aimStretch];
    if (pts.every(([qx, qz]) => (qx - p[0]) * (qx - p[0]) + (qz - p[1]) * (qz - p[1]) >= SIM.aimGap * SIM.aimGap)) pts.push(p);
  }
  // Practically never: the disc holds sixteen spots with room to spare. The attempt then most likely fails its landing check.
  while (pts.length < SHELL_COUNT) pts.push([centre[0], centre[1]]);
  // Greedy matching: the pair whose directions (from the handful's middle, and from the spots' centre) agree best goes first.
  const pairs: [number, number, number][] = [];
  from.forEach((p, i) => pts.forEach(([x, z], j) => pairs.push([(p.x - c[0]) * (x - centre[0]) + (p.z - c[2]) * (z - centre[1]), i, j])));
  pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const out: ([number, number] | undefined)[] = Array.from({ length: SHELL_COUNT }, () => undefined);
  const taken = new Set<number>();
  for (const [, i, j] of pairs) {
    if (out[i] !== undefined || taken.has(j)) continue;
    out[i] = pts[j];
    taken.add(j);
  }
  return out as [number, number][];
}

/** One attempt at a round's throw. */
export function simulateAttempt(R: Rapier, roundId: string, attempt: number): Attempt {
  const rng = seededRng(`kauda:throw:${roundId}#${attempt}`);
  const world = new R.World({ x: 0, y: 0, z: 0 });
  try {
    world.timestep = SIM.dt;
    world.lengthUnit = SIM.lengthUnit;
    world.numSolverIterations = SIM.solverIterations;
    buildBoard(R, world);

    // The release point: above the board's edge on the thrower's side (+z).
    const c: [number, number, number] = [rng.range(-0.16, 0.16), rng.range(0.42, 0.5), rng.range(0.96, 1.04)];

    // The shells start spread on a grid round it, never touching, in a seeded order and orientation...
    const slots = shuffled(SHELL_COUNT, rng);
    const bodies = SHELL_SET.map((look, i) => {
      const slot = slots[i] as number;
      const gx = (slot % 4) - 1.5;
      const gy = (Math.floor(slot / 4) % 2) - 0.5;
      const gz = Math.floor(slot / 8) - 0.5;
      const [qx, qy, qz, qw] = randomQuaternion(rng);
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(round6(c[0] + gx * 0.235), round6(c[1] + gy * 0.235), round6(c[2] + gz * 0.235))
          .setRotation({ x: round6(qx), y: round6(qy), z: round6(qz), w: round6(qw) })
          .setLinearDamping(SIM.linearDamping)
          .setAngularDamping(SIM.angularDamping)
          .setCanSleep(false),
      );
      const shape = shellCollider(look.scale);
      const desc = R.ColliderDesc.roundConvexHull(points(shape.points), round6(shape.radius));
      if (desc === null) throw new Error("could not build a shell's collider");
      world.createCollider(desc.setFriction(SIM.shellFriction).setRestitution(SIM.restitution).setDensity(SIM.density), body);
      return body;
    });

    // ...and are pulled together into one tight handful, in zero gravity. Contacts keep them apart.
    for (let step = 0; step < SIM.packSteps; step += 1) {
      for (const b of bodies) {
        const p = b.translation();
        b.setLinvel(vec(SIM.packPull * (c[0] - p.x), SIM.packPull * (c[1] - p.y), SIM.packPull * (c[2] - p.z)), true);
        const w = b.angvel();
        b.setAngvel(vec(w.x * 0.7, w.y * 0.7, w.z * 0.7), true);
      }
      world.step();
    }

    // The release: each shell towards its own resting spot, with its own spin.
    world.gravity = vec(0, -SIM.gravity, 0);
    const centre: [number, number] = [rng.range(-0.1, 0.1), rng.range(SIM.aimNear, SIM.aimFar)];
    const vy = rng.range(SIM.liftMin, SIM.liftMax);
    const spin = rng.range(SIM.spinMin, SIM.spinMax);
    const spots = restingSpots(
      rng,
      bodies.map((b) => b.translation()),
      c,
      centre,
    );
    const releaseVelocity = new Float32Array(SHELL_COUNT * 3);
    bodies.forEach((b, i) => {
      const p = b.translation();
      const [fx, fz] = spots[i] as [number, number];
      const t = (vy + Math.sqrt(vy * vy + 2 * SIM.gravity * (p.y - (BOARD.surface + HALF_THICKNESS)))) / SIM.gravity;
      // It lands short of its spot and skids on: aim at the landing point that skids there.
      const k = SIM.skid / t;
      const tx = (fx + k * p.x) / (1 + k);
      const tz = (fz + k * p.z) / (1 + k);
      const v = vec((tx - p.x) / t + rng.range(-SIM.jitter, SIM.jitter), vy + rng.range(-0.08, 0.08), (tz - p.z) / t + rng.range(-SIM.jitter, SIM.jitter));
      b.setLinvel(v, true);
      const [ax, ay, az] = randomUnitVector(rng);
      const w = spin * rng.range(0.6, 1.2);
      b.setAngvel(vec(ax * w, ay * w, az * w), true);
      releaseVelocity.set([v.x, v.y, v.z], i * 3);
    });

    // Fly, recording every step, until everything is still.
    const maxFrames = Math.ceil(SIM.maxFlightSeconds / SIM.dt) + 1;
    const poses = new Float32Array(maxFrames * SHELL_COUNT * POSE);
    const record = (frame: number) => {
      bodies.forEach((b, i) => {
        const p = b.translation();
        const q = b.rotation();
        poses.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w], (frame * SHELL_COUNT + i) * POSE);
      });
    };
    record(0);
    let frames = 1;
    let still = 0;
    let settled = false as boolean;
    while (frames < maxFrames) {
      for (const b of bodies) resist(b);
      world.step();
      record(frames);
      frames += 1;
      const moving = bodies.some((b) => {
        const v = b.linvel();
        const w = b.angvel();
        return v.x * v.x + v.y * v.y + v.z * v.z > SIM.restLinear * SIM.restLinear || w.x * w.x + w.y * w.y + w.z * w.z > SIM.restAngular * SIM.restAngular;
      });
      still = moving ? 0 : still + 1;
      if (still >= SIM.restSteps) {
        settled = true;
        break;
      }
    }
    // Not still by the numbers in time? Then by eye: the earliest frame after
    // which nothing visibly moves (solver noise, an imperceptible creep).
    // Playback ends there and the board holds that frame.
    if (!settled) {
      const restFrame = stillFrom(poses, frames);
      if (restFrame !== null) {
        frames = restFrame + 1;
        settled = true;
      }
    }
    const trimmed = poses.slice(0, frames * SHELL_COUNT * POSE);
    const rest = trimmed.subarray((frames - 1) * SHELL_COUNT * POSE);
    const problems = settled ? landingProblems(rest) : ["the shells did not settle in time"];
    return { frames, poses: trimmed, releaseVelocity, releasePoint: c, settled, problems };
  } finally {
    world.free();
  }
}

/** Rolling resistance, before each step (see SIM.rollKeep). */
function resist(b: RAPIER.RigidBody): void {
  const y = b.translation().y;
  if (y >= BOARD.surface + SIM.rollHeight) return;
  const w = b.angvel();
  b.setAngvel(vec(w.x * SIM.rollKeep, w.y * SIM.rollKeep, w.z * SIM.rollKeep), true);
  const v = b.linvel();
  if (y > BOARD.surface + SIM.settleHeight || v.x * v.x + v.y * v.y + v.z * v.z > SIM.settleSpeed * SIM.settleSpeed) return;
  const q = b.rotation();
  if (Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)) < SIM.settleLevel) return;
  const w2 = b.angvel();
  b.setAngvel(vec(w2.x * SIM.settleSpin, w2.y * SIM.settleSpin, w2.z * SIM.settleSpin), true);
  b.setLinvel(vec(v.x * SIM.settleSlide, v.y, v.z * SIM.settleSlide), true);
}

/** The earliest frame from which every shell stays within restDrift and restTurn of where it is then, to the last frame; null if none before the last half second. */
function stillFrom(poses: Float32Array, frames: number): number | null {
  const last = frames - 1;
  const near = (a: number, b: number) => {
    for (let i = 0; i < SHELL_COUNT; i += 1) {
      const o = (a * SHELL_COUNT + i) * POSE;
      const p = (b * SHELL_COUNT + i) * POSE;
      const dx = (poses[o] ?? 0) - (poses[p] ?? 0);
      const dy = (poses[o + 1] ?? 0) - (poses[p + 1] ?? 0);
      const dz = (poses[o + 2] ?? 0) - (poses[p + 2] ?? 0);
      if (dx * dx + dy * dy + dz * dz > SIM.restDrift * SIM.restDrift) return false;
      let dot = 0;
      for (let k = 3; k < 7; k += 1) dot += (poses[o + k] ?? 0) * (poses[p + k] ?? 0);
      if (Math.abs(dot) < SIM.restTurn) return false;
    }
    return true;
  };
  // Walk back from the end while every frame is close to the last; then find
  // the earliest frame that every later frame stays close to.
  let f = last;
  while (f > 0 && near(f - 1, last)) f -= 1;
  for (; f <= last - Math.round(0.5 / SIM.dt); f += 1) {
    let ok = true;
    for (let g = f + 1; g <= last && ok; g += 1) ok = near(g, f);
    if (ok) return f;
  }
  return null;
}

/** Per shell: at rest, does the collider's own +y point up? */
export function colliderUpAtRest(rest: Float32Array): boolean[] {
  return Array.from({ length: SHELL_COUNT }, (_, i) => {
    const qx = rest[i * POSE + 3] ?? 0;
    const qz = rest[i * POSE + 5] ?? 0;
    return 1 - 2 * (qx * qx + qz * qz) > 0;
  });
}

/**
 * A round's throw: the first attempt that lands clean, trying attempt 0,
 * 1, 2, ... up to SIM.maxAttempts. `accept` exists for the tests (to force
 * the fallback); the app never passes it.
 */
export function simulateRound(R: Rapier, roundId: string, accept: (a: Attempt) => boolean = (a) => a.problems.length === 0): Recording {
  for (let attempt = 0; attempt < SIM.maxAttempts; attempt += 1) {
    const a = simulateAttempt(R, roundId, attempt);
    if (!accept(a)) continue;
    return {
      roundId,
      attempt,
      fallback: false,
      attempts: attempt + 1,
      dt: SIM.dt,
      frames: a.frames,
      poses: a.poses,
      releaseVelocity: a.releaseVelocity,
      releasePoint: a.releasePoint,
      colliderUp: colliderUpAtRest(a.poses.subarray((a.frames - 1) * SHELL_COUNT * POSE)),
    };
  }
  return {
    roundId,
    attempt: -1,
    fallback: true,
    attempts: SIM.maxAttempts,
    dt: SIM.dt,
    frames: 0,
    poses: new Float32Array(0),
    releaseVelocity: new Float32Array(SHELL_COUNT * 3),
    releasePoint: [0, 0, 0],
    colliderUp: Array.from({ length: SHELL_COUNT }, () => true),
  };
}
