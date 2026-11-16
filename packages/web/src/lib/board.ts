import { SHELL_COUNT, TURN_ORDER, type SeatId } from "@kauda/rules";

/**
 * The board's geometry and the shells' resting places, as plain numbers.
 * Pure: no three.js and no DOM, so the table screen and the tests can use it
 * without pulling the 3D chunk in. The 3D stage (Stage3D.tsx) draws exactly
 * what these functions say.
 *
 * Units: the board's radius is 1. x is to the right, z towards the camera,
 * y up. In the board's own frame teeya sits at +z, and the seats go round
 * anticlockwise seen from above: teeya +z, chauka +x, panja -z, chakka -x.
 */

// ------------------------------------------------------------------ seats

/** Where a seat appears on screen, relative to me. */
export type Side = "bottom" | "right" | "top" | "left";

/** The sides, anticlockwise from my own. */
export const SIDES: readonly Side[] = ["bottom", "right", "top", "left"];

/**
 * Which side of the screen each seat is on. My seat is always at the
 * bottom, nearest the camera, and the rest follow anticlockwise seen from
 * above: sitting at teeya, chauka is on my right, panja across from me and
 * chakka on my left. A chyakhe with no seat watches from teeya's side.
 */
export function seatSides(mySeat: SeatId | null): Record<SeatId, Side> {
  const start = TURN_ORDER.indexOf(mySeat ?? "teeya");
  const out = {} as Record<SeatId, Side>;
  TURN_ORDER.forEach((seat, i) => {
    out[seat] = SIDES[(i - start + TURN_ORDER.length) % TURN_ORDER.length] as Side;
  });
  return out;
}

/** The direction of a seat from the board's centre, in the board's frame (radians about +y; teeya is 0). */
export function seatAngle(seat: SeatId): number {
  return (TURN_ORDER.indexOf(seat) * Math.PI) / 2;
}

/**
 * How far to turn the board about +y so my seat faces the camera. The camera
 * and the lamp stay put; the board, the shells on it and the thrower's glow
 * turn together, so everyone at the table sees the same throw from their own
 * side.
 */
export function boardTurn(mySeat: SeatId | null): number {
  return -seatAngle(mySeat ?? "teeya");
}

// ------------------------------------------------------------------ board

export const BOARD = {
  /** Outer edge of the rim. */
  radius: 1,
  /** Where the flat playing surface meets the rim. */
  rimInner: 0.88,
  /** The flat surface's height above the floor. */
  surface: 0.05,
  /** The rim's top. */
  rimTop: 0.095,
  /** Shells come to rest inside this circle: well inside the rim, in the lamp's pool. */
  scatterRadius: 0.66,
} as const;

/** A shell at scale 1: length along its own x, width along its own z. About 3:2. */
export const SHELL = {
  length: 0.21,
  width: 0.142,
  /** The domed back's height above the base. */
  dome: 0.064,
  /** The flatter underside's depth below the base. */
  base: 0.015,
} as const;

/** The radius of a circle that holds a shell of this scale, however it is turned. */
export function shellRadius(scale: number): number {
  return (SHELL.length / 2) * scale;
}

// ----------------------------------------------------------------- shells

export interface ShellPose {
  /** Centre on the board, in the board's frame. */
  readonly x: number;
  readonly z: number;
  /** Turn about +y, radians. */
  readonly yaw: number;
  /** Face up: the slit side showing. */
  readonly up: boolean;
  /** About 0.93 to 1.06: no two shells are quite the same size. */
  readonly scale: number;
  /** 0 to 1: from the creamier tint to the paler one. */
  readonly tint: number;
  /** A small rock about the shell's own length (x) and width (z) axes, radians. */
  readonly roll: number;
  readonly pitch: number;
  /** Raised above resting on the board, for shells on top of the heap. */
  readonly lift: number;
}

/** FNV-1a: a string to 32 bits. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * mulberry32: a small seeded generator for the LOOK of the scatter only. It
 * decides nothing about the game: the faces come from the server's seed,
 * and this only places them on the board, the same way every time.
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Space left between two shells' circles, so they never touch. */
const GAP = 0.006;

/**
 * Where the sixteen shells lie after a throw: a natural scatter in the middle
 * of the board, decided by the round id alone, so the same round always
 * shows the same scatter on every screen. No two shells overlap and none
 * leaves the scatter circle, which sits well inside the rim. Faces are not
 * chosen here; see shellPoses.
 */
export function scatter(roundId: string): ShellPose[] {
  const next = seeded(hash32(roundId));
  // Random sequential placement. At this density (about a third of the
  // circle covered) it almost always succeeds on the first pass; when a
  // shell finds no room, the whole layout starts again from where the
  // generator has got to, which is still fixed by the round id.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const out: ShellPose[] = [];
    for (let i = 0; i < SHELL_COUNT; i += 1) {
      const scale = 0.93 + next() * 0.13;
      const tint = next();
      const yaw = next() * Math.PI * 2;
      const roll = (next() - 0.5) * 0.08;
      const pitch = (next() - 0.5) * 0.06;
      const r = shellRadius(scale);
      let placed = false;
      for (let tries = 0; tries < 300 && !placed; tries += 1) {
        // A little denser towards the middle, as thrown shells fall.
        const d = (BOARD.scatterRadius - r) * next() ** 0.65;
        const a = next() * Math.PI * 2;
        const x = d * Math.cos(a);
        const z = d * Math.sin(a);
        if (out.every((o) => Math.hypot(o.x - x, o.z - z) >= shellRadius(o.scale) + r + GAP)) {
          out.push({ x, z, yaw, up: false, scale, tint, roll, pitch, lift: 0 });
          placed = true;
        }
      }
      if (!placed) break;
    }
    if (out.length === SHELL_COUNT) return out;
  }
  throw new Error(`no room for ${SHELL_COUNT} shells (round ${roundId})`);
}

/**
 * Before the first throw, and while a round waits for its throw: the sixteen
 * shells gathered in a loose heap at the centre, all face down. Fixed, so the
 * heap never shuffles between renders. Shells on top of the heap rest on the
 * ones below, raised and tipped.
 */
export function heap(): ShellPose[] {
  const next = seeded(hash32("heap"));
  const out: ShellPose[] = [];
  const add = (x: number, z: number, yaw: number, lift = 0, roll = 0, pitch = 0) =>
    out.push({ x, z, yaw, up: false, scale: 0.94 + next() * 0.11, tint: next(), roll, pitch, lift });
  // The bottom layer: one in the middle, a ring of six round it, four outliers.
  add(0, 0, 0.4);
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + 0.25;
    add(0.15 * Math.cos(a), 0.15 * Math.sin(a), a + Math.PI / 2 + (next() - 0.5) * 0.6);
  }
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + 0.9 + (next() - 0.5) * 0.4;
    add(0.27 * Math.cos(a), 0.27 * Math.sin(a), a + (next() - 0.5) * 1.2);
  }
  // On top, resting on the shells below.
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2 + 0.6;
    const tip = 0.22 + next() * 0.12;
    add(0.075 * Math.cos(a), 0.075 * Math.sin(a), a + Math.PI / 2 + (next() - 0.5) * 0.5, 0.034 + next() * 0.012, tip * Math.cos(a), tip * Math.sin(a));
  }
  return out;
}

/**
 * The shells to draw: shell i is face up exactly when faces[i] is, in the
 * server's order. With no throw to show, the face-down heap.
 */
export function shellPoses(throwShown: { readonly roundId: string; readonly faces: readonly boolean[] } | null): ShellPose[] {
  if (throwShown === null) return heap();
  return scatter(throwShown.roundId).map((pose, i) => ({ ...pose, up: throwShown.faces[i] === true }));
}
