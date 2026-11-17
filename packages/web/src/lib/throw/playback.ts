import { SHELL_COUNT, type SeatId } from "@kauda/rules";
import { BOARD, SHELL, seatAngle, SHELL_SET, type ShellPose } from "../board";
import { MESH_OFFSET } from "./shell";
import { POSE, type Recording } from "./simulate";

/**
 * From a recorded throw to what the board draws. Pure: plain numbers, no
 * three.js, so the tests can check every rule here directly.
 *
 * A MESH FRAME is where the sixteen drawn shells are, in the board's frame:
 * 16 x MESH floats, each shell's position (x, y, z), rotation (qx, qy, qz,
 * qw) and scale. The drawn shell's own frame is the one shellGeometry.ts
 * builds: length along x, edge at y = 0, dome towards +y.
 */

/** Floats per shell in a mesh frame. */
export const MESH = 8;

export type MeshFrame = Float32Array;

export function meshFrame(): MeshFrame {
  return new Float32Array(SHELL_COUNT * MESH);
}

// ------------------------------------------------------------------ flips

/**
 * THE FLIP RULE. The collider cannot tell up from down, so the recording
 * says only which way the collider finished (colliderUp). A drawn shell
 * that is not flipped has its dome along the collider's +y: it finishes
 * dome up, which is FACE DOWN (the slit is underneath), exactly when its
 * collider finished +y up. Where that differs from the server's face, the
 * mesh is turned 180 degrees about its long axis inside its collider, from
 * the first frame of the throw. The motion is unchanged; the shell lands
 * showing the server's face. Shell i always shows server face i.
 */
export function flipsFor(colliderUp: readonly boolean[], faces: readonly boolean[]): boolean[] {
  return Array.from({ length: SHELL_COUNT }, (_, i) => {
    const faceUpUnflipped = colliderUp[i] !== true;
    return faceUpUnflipped !== (faces[i] === true);
  });
}

/** Is this drawn shell face up (its dome pointing down, the slit showing)? From its rotation alone. */
export function visibleFaceUp(frame: MeshFrame, i: number): boolean {
  const qx = frame[i * MESH + 3] ?? 0;
  const qz = frame[i * MESH + 5] ?? 0;
  // The world y of the shell's own +y (its dome): 1 - 2(qx^2 + qz^2).
  return 1 - 2 * (qx * qx + qz * qz) < 0;
}

// -------------------------------------------------------------- transforms

type Quat = [number, number, number, number];

function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** Rotates (0, y, 0) by q. */
function rotateUp(q: Quat, y: number): [number, number, number] {
  const [x, , z, w] = q;
  const qy = q[1];
  return [2 * (x * qy - w * z) * y, (1 - 2 * (x * x + z * z)) * y, 2 * (qy * z + w * x) * y];
}

/** A turn about +y: the thrower's side, in the board's frame. */
function yaw(angle: number): Quat {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

/**
 * Writes shell i's drawn pose, given its collider's pose in the canonical
 * frame (thrower at +z), into `out`, turned to the thrower's side. The mesh
 * sits MESH_OFFSET along the collider's +y; flipped, it is turned 180
 * degrees about the collider's x (the shell's long axis), which also moves
 * it to -MESH_OFFSET.
 */
export function placeShell(out: MeshFrame, i: number, collider: ArrayLike<number>, at: number, flip: boolean, thrower: SeatId): void {
  const s = SHELL_SET[i]?.scale ?? 1;
  let q: Quat = [collider[at + 3] ?? 0, collider[at + 4] ?? 0, collider[at + 5] ?? 0, collider[at + 6] ?? 1];
  const [ox, oy, oz] = rotateUp(q, (flip ? -MESH_OFFSET : MESH_OFFSET) * s);
  // q x (180 degrees about x).
  if (flip) q = [q[3], q[2], -q[1], -q[0]];
  let x = (collider[at] ?? 0) + ox;
  const y = (collider[at + 1] ?? 0) + oy;
  let z = (collider[at + 2] ?? 0) + oz;
  const a = seatAngle(thrower);
  if (a !== 0) {
    const c = Math.cos(a);
    const sn = Math.sin(a);
    [x, z] = [x * c + z * sn, -x * sn + z * c];
    q = mul(yaw(a), q);
  }
  out.set([x, y, z, q[0], q[1], q[2], q[3], s], i * MESH);
}

/** A recorded frame (or a moment between two), as drawn. `t`: seconds since the release. */
export function sampleRecording(out: MeshFrame, rec: Recording, t: number, flips: readonly boolean[], thrower: SeatId): void {
  const last = rec.frames - 1;
  const f = Math.max(0, Math.min(last, t / rec.dt));
  const f0 = Math.floor(f);
  const f1 = Math.min(last, f0 + 1);
  const k = f - f0;
  const scratch = new Float32Array(POSE);
  for (let i = 0; i < SHELL_COUNT; i += 1) {
    const a = (f0 * SHELL_COUNT + i) * POSE;
    const b = (f1 * SHELL_COUNT + i) * POSE;
    for (let j = 0; j < 3; j += 1) scratch[j] = (rec.poses[a + j] ?? 0) * (1 - k) + (rec.poses[b + j] ?? 0) * k;
    // nlerp, on the near hemisphere.
    let dot = 0;
    for (let j = 3; j < 7; j += 1) dot += (rec.poses[a + j] ?? 0) * (rec.poses[b + j] ?? 0);
    const sign = dot < 0 ? -1 : 1;
    let n = 0;
    for (let j = 3; j < 7; j += 1) {
      const v = (rec.poses[a + j] ?? 0) * (1 - k) + sign * (rec.poses[b + j] ?? 0) * k;
      scratch[j] = v;
      n += v * v;
    }
    n = Math.sqrt(n) || 1;
    for (let j = 3; j < 7; j += 1) scratch[j] = (scratch[j] ?? 0) / n;
    placeShell(out, i, scratch, 0, flips[i] === true, thrower);
  }
}

/** Seconds from the release to rest. */
export function flightSeconds(rec: Recording): number {
  return Math.max(0, rec.frames - 1) * rec.dt;
}

/** Each shell's release velocity, turned to the thrower's side (16 x 3). */
export function releaseVelocities(rec: Recording, thrower: SeatId): Float32Array {
  const out = new Float32Array(SHELL_COUNT * 3);
  const a = seatAngle(thrower);
  const c = Math.cos(a);
  const sn = Math.sin(a);
  for (let i = 0; i < SHELL_COUNT; i += 1) {
    const x = rec.releaseVelocity[i * 3] ?? 0;
    const y = rec.releaseVelocity[i * 3 + 1] ?? 0;
    const z = rec.releaseVelocity[i * 3 + 2] ?? 0;
    out.set([x * c + z * sn, y, -x * sn + z * c], i * 3);
  }
  return out;
}

/** The release point, turned to the thrower's side. */
export function releasePoint(rec: Recording, thrower: SeatId): [number, number, number] {
  const [x, y, z] = rec.releasePoint;
  const a = seatAngle(thrower);
  return [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
}

// ------------------------------------------------------- the still layouts

/** A shell lying in the heap or the seeded scatter (board.ts), as drawn. */
export function placeLyingShell(out: MeshFrame, i: number, p: ShellPose): void {
  const rest = (p.up ? SHELL.dome : SHELL.base) * p.scale;
  // three.js Euler (roll, yaw, pitch) in order YXZ, as a quaternion.
  const c1 = Math.cos(p.roll / 2);
  const s1 = Math.sin(p.roll / 2);
  const c2 = Math.cos(p.yaw / 2);
  const s2 = Math.sin(p.yaw / 2);
  const c3 = Math.cos(p.pitch / 2);
  const s3 = Math.sin(p.pitch / 2);
  let q: Quat = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
  // Face up: turned over about its length, resting on its dome.
  if (p.up) q = [q[3], q[2], -q[1], -q[0]];
  out.set([p.x, BOARD.surface + rest + p.lift, p.z, q[0], q[1], q[2], q[3], p.scale], i * MESH);
}

export function lyingFrame(poses: readonly ShellPose[]): MeshFrame {
  const out = meshFrame();
  poses.forEach((p, i) => placeLyingShell(out, i, p));
  return out;
}

/** Where a recorded throw comes to rest, as drawn: the still scene for a settled round. */
export function restingFrame(rec: Recording, faces: readonly boolean[], thrower: SeatId): MeshFrame {
  const out = meshFrame();
  sampleRecording(out, rec, flightSeconds(rec), flipsFor(rec.colliderUp, faces), thrower);
  return out;
}

// --------------------------------------------------------------- the gather

function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) {
    dot = -dot;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (dot > 0.9995) {
    const r: Quat = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const n = Math.hypot(...r) || 1;
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const th = Math.acos(Math.min(1, dot));
  const sa = Math.sin((1 - t) * th) / Math.sin(th);
  const sb = Math.sin(t * th) / Math.sin(th);
  return [a[0] * sa + bb[0] * sb, a[1] * sa + bb[1] * sb, a[2] * sa + bb[2] * sb, a[3] * sa + bb[3] * sb];
}

const quatAt = (f: MeshFrame, i: number): Quat => [f[i * MESH + 3] ?? 0, f[i * MESH + 4] ?? 0, f[i * MESH + 5] ?? 0, f[i * MESH + 6] ?? 1];

/** Between two drawn poses of shell i: position lerped, rotation slerped. */
export function blendShell(out: MeshFrame, i: number, a: MeshFrame, b: MeshFrame, t: number): void {
  const o = i * MESH;
  const q = slerp(quatAt(a, i), quatAt(b, i), t);
  out.set(
    [
      (a[o] ?? 0) + ((b[o] ?? 0) - (a[o] ?? 0)) * t,
      (a[o + 1] ?? 0) + ((b[o + 1] ?? 0) - (a[o + 1] ?? 0)) * t,
      (a[o + 2] ?? 0) + ((b[o + 2] ?? 0) - (a[o + 2] ?? 0)) * t,
      q[0],
      q[1],
      q[2],
      q[3],
      (a[o + 7] ?? 1) + ((b[o + 7] ?? 1) - (a[o + 7] ?? 1)) * t,
    ],
    o,
  );
}

/** How fast a gathered shell is lifted off the board at the start of the gather, board units per second. */
const LIFT = 1.4;

/**
 * THE GATHER: every shell from where it lies to its place in the handful at
 * the release point, along a Hermite curve that leaves the board upwards and
 * arrives moving at the shell's own release velocity, so the throw carries
 * on from the gather with no stop and no jerk. Rotation eases from one pose
 * to the other. `s` runs 0 to 1 over `seconds`; `endVelocity` is in board
 * units per second of what is shown.
 */
export function gatherShell(out: MeshFrame, i: number, from: MeshFrame, to: MeshFrame, endVelocity: Float32Array, s: number, seconds: number): void {
  const o = i * MESH;
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
  const h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2;
  const h11 = s ** 3 - s ** 2;
  const m0 = [0, LIFT * seconds, 0];
  const m1 = [0, 1, 2].map((j) => (endVelocity[i * 3 + j] ?? 0) * seconds);
  const p = [0, 1, 2].map((j) => h00 * (from[o + j] ?? 0) + h10 * (m0[j] ?? 0) + h01 * (to[o + j] ?? 0) + h11 * (m1[j] ?? 0));
  const eased = s * s * (3 - 2 * s);
  const q = slerp(quatAt(from, i), quatAt(to, i), eased);
  out.set([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, q[0], q[1], q[2], q[3], to[o + 7] ?? 1], o);
}
