import type { SeatId } from "@kauda/rules";
import { BOARD, seatAngle } from "../board";
import { blendPose, PALM_ANCHOR, POSES, type HandFrame, type HandPhase, type HandPose, type Quat, type Vec3 } from "./hand";

/**
 * THE HAND'S SEQUENCE: its timing and its path, as pure functions of time.
 * The director (director.ts) keeps the state (when the throwing phase began,
 * when the throw was triggered, when the shells left) and calls these every
 * frame. The hand model only draws the HandFrame it is given.
 *
 *   reach     0-600 ms     in from beyond the thrower's edge, open, palm down
 *   scoop     600-1200     over the shells: cupped, then a fist; the shells
 *                          are drawn into the palm, shrinking, and are hidden
 *                          in the fist from 1150
 *   lift      1200-1550    up to the hold, beside the release point
 *   hold      ...          a gentle idle shake, waiting: the suspense
 *   shake     2+ x 170     quick shakes once the throw happens; more while
 *                          the result is not back yet
 *   swing     200          forward and up, flinging open as the shells leave
 *                          at exactly the physics' release point and moment
 *   follow    250          the arm carries on with the throw
 *   withdraw  450          back the way it came, fading out, clear of the
 *                          board before the shells can come to rest
 *
 * The throw cannot come before the hold: the server takes no throw in the
 * first 1.5 s of the throwing phase (the same hold a bot keeps), and my
 * Throw button opens only once my hand is holding the shells (holdAt).
 */
export const SEQ = {
  reachEnd: 600,
  scoopEnd: 1200,
  /** The shells drawn in one by one, the nearest first: from scoopFirst, each over scoopEach, the last starting scoopSpread later. */
  scoopFirst: 650,
  scoopSpread: 280,
  scoopEach: 220,
  /** The fist is closed: every shell is hidden in it from here to the release. */
  fistClosed: 1150,
  holdAt: 1550,
  shakeMs: 170,
  minShakes: 2,
  swingMs: 200,
  /** The fingers fling open over the last part of the swing and just after. */
  flungMs: 60,
  followMs: 250,
  withdrawMs: 450,
  /** After the release the shells grow from GROW_FROM of their size to full over this long. */
  growMs: 150,
} as const;
export const GROW_FROM = 0.3;
/** How much smaller a shell is when it reaches the palm (it is hidden in the fist after). */
export const SCOOPED_SIZE = 0.25;

const UP: Vec3 = [0, 1, 0];

// ------------------------------------------------------------ vector maths

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

export const smooth = (t: number) => {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
};
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** The quaternion of the rotation whose columns are x, y, z (orthonormal). */
export function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const u: Vec3 = [x, y, z];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, w)), cross(u, t));
}

export function slerpQ(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) {
    d = -d;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (d > 0.9995) {
    const r: Quat = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const n = Math.hypot(...r) || 1;
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const th = Math.acos(Math.min(1, d));
  const sa = Math.sin((1 - t) * th) / Math.sin(th);
  const sb = Math.sin(t * th) / Math.sin(th);
  return [a[0] * sa + bb[0] * sb, a[1] * sa + bb[1] * sb, a[2] * sa + bb[2] * sb, a[3] * sa + bb[3] * sb];
}

/** A hand pointing its fingers along `fingers`, its palm facing `palm` (made square to the fingers). */
export function handRotation(fingers: Vec3, palm: Vec3): Quat {
  const z = norm(fingers);
  const n = norm(sub(palm, scale(z, dot(palm, z))));
  const y = scale(n, -1);
  return quatFromBasis(cross(y, z), y, z);
}

// ------------------------------------------------------- the seat's side

/** From the board's middle towards the seat, level. */
export function seatDirection(seat: SeatId): Vec3 {
  const a = seatAngle(seat);
  return [Math.sin(a), 0, Math.cos(a)];
}

/** Where the hand comes from and goes back to: beyond the seat's edge of the board, raised. */
export const entryPoint = (seat: SeatId): Vec3 => add(scale(seatDirection(seat), 2.3), [0, 0.85, 0]);
/**
 * The forearm runs towards here: far out beyond the seat's edge and only a
 * little higher than the hand, so it stays clear of the rim and leaves the
 * picture low (through the bottom of the screen for my own seat), never
 * rising towards the camera, which sits above my side of the board.
 */
export const shoulderPoint = (seat: SeatId): Vec3 => add(scale(seatDirection(seat), 3.4), [0, 0.65, 0]);
/** Before the physics has answered: about where every throw is released from. */
export const nominalRelease = (seat: SeatId): Vec3 => add(scale(seatDirection(seat), 1.0), [0, 0.46, 0]);
/** ...and about the direction it goes in (up and in towards the middle). */
export const nominalThrow = (seat: SeatId): Vec3 => norm(add(scale(seatDirection(seat), -1.6), [0, 2.8, 0]));

/** Reaching in and scooping: fingers in towards the middle and a little down, palm down. */
export const reachRotation = (seat: SeatId): Quat => handRotation(add(scale(seatDirection(seat), -0.87), [0, -0.5, 0]), [0, -1, 0]);
/** Holding and shaking the shells: a fist, palm down, knuckles up, fingers in towards the middle. */
export const holdRotation = (seat: SeatId): Quat => handRotation(add(scale(seatDirection(seat), -0.95), [0, -0.3, 0]), [0, -1, 0]);
/** Flung open: fingers up and forward, palm facing the throw. */
export const releaseRotation = (seat: SeatId): Quat => handRotation(add(scale(seatDirection(seat), -0.8), [0, 1.4, 0]), scale(seatDirection(seat), -1));

/** Where the wrist must be for the palm's anchor to be at `anchor`. */
export const wristFor = (anchor: Vec3, rotation: Quat): Vec3 => sub(anchor, rotate(rotation, PALM_ANCHOR));

/**
 * The anchor held a little above the release point and back towards the
 * thrower. The swing from there dips and flings up into the release, as an
 * underhand toss does (it arrives moving with the throw).
 */
export const holdPoint = (release: Vec3, throwDir: Vec3): Vec3 => {
  const level = norm([throwDir[0], 0, throwDir[2]]);
  return add(sub(release, scale(level, 0.12)), [0, 0.1, 0]);
};

// ------------------------------------------------------------- the poses

/** The pose through the scoop: open, cupped, then a fist by the time the shells are hidden. */
export function scoopPose(clock: number): HandPose {
  if (clock < SEQ.reachEnd) return POSES.open;
  if (clock < 1000) return blendPose(POSES.open, POSES.cupped, smooth((clock - SEQ.reachEnd) / (1000 - SEQ.reachEnd)));
  return blendPose(POSES.cupped, POSES.fist, smooth((clock - 1000) / (SEQ.fistClosed - 1000)));
}

/** The idle shake while holding (none when `quiet`), and the quick throwing shakes: offsets of the anchor. */
export function holdShake(now: number, throwDir: Vec3, quiet: boolean): Vec3 {
  if (quiet) return [0, 0, 0];
  const t = now / 1000;
  return add(scale(UP, 0.012 * Math.sin(2 * Math.PI * 1.7 * t)), scale(throwDir, 0.006 * Math.sin(2 * Math.PI * 0.9 * t)));
}
export function throwShake(sinceShakeStart: number, throwDir: Vec3): Vec3 {
  const u = (sinceShakeStart % SEQ.shakeMs) / SEQ.shakeMs;
  return add(scale(throwDir, 0.06 * Math.sin(2 * Math.PI * u)), scale(UP, 0.025 * Math.sin(4 * Math.PI * u)));
}

/** Hermite: from p0 at rest to p1 arriving at velocity v1 (units per second), over `seconds`. */
export function swingPath(p0: Vec3, p1: Vec3, v1: Vec3, s: number, seconds: number): Vec3 {
  const h01 = -2 * s ** 3 + 3 * s ** 2;
  const h11 = s ** 3 - s ** 2;
  return add(add(scale(p0, 1 - h01), scale(p1, h01)), scale(v1, h11 * seconds));
}

/** After the release: carrying on along the throw, slowing to a stop over followMs. */
export function followPath(release: Vec3, v: Vec3, ms: number): Vec3 {
  const T = SEQ.followMs / 1000;
  const tau = Math.min(ms, SEQ.followMs) / 1000;
  return add(release, scale(v, tau * (1 - tau / (2 * T))));
}

/** A frame of the hand. */
export function frame(seat: SeatId, phase: HandPhase, progress: number, anchor: Vec3, rotation: Quat, pose: HandPose, opacity = 1): HandFrame {
  return { seat, phase, progress: clamp01(progress), anchor, rotation, wrist: wristFor(anchor, rotation), shoulder: shoulderPoint(seat), pose, opacity: clamp01(opacity) };
}

/** Is the hand clear of the board (out past its rim, or gone)? */
export function clearOfBoard(h: HandFrame | null): boolean {
  if (h === null || h.opacity <= 0) return true;
  return Math.hypot(h.anchor[0], h.anchor[2]) > BOARD.radius + 0.15 && Math.hypot(h.wrist[0], h.wrist[2]) > BOARD.radius + 0.15;
}
