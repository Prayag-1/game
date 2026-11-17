import type { SeatId } from "@kauda/rules";

/**
 * THE HAND, as data: its poses (joint angles) and its proportions. Pure: no
 * three.js. The sequence (handSequence.ts) says where the hand is and which
 * pose it holds at every moment; the model (board3d/Hand.tsx) only draws
 * what it is told. A rigged model can replace Hand.tsx and read the same
 * HandFrame, mapping `phase` and `progress` to its own animation clips.
 *
 * The hand's own frame: the wrist at the origin, the fingers along +z, the
 * back of the hand towards +y (the palm faces -y), the thumb towards +x (a
 * right hand). A finger bends towards the palm by a positive turn about its
 * own x axis; a positive spread turns it towards the thumb.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface FingerAngles {
  /** Sideways at the knuckle, towards the thumb positive. */
  readonly spread: number;
  /** Bend at the knuckle (MCP), the middle joint (PIP) and the end joint (DIP). */
  readonly mcp: number;
  readonly pip: number;
  readonly dip: number;
}

export interface ThumbAngles {
  /** How far the thumb swings out from the palm (0: along the index finger). */
  readonly swing: number;
  /** Bend at its two joints. */
  readonly mcp: number;
  readonly ip: number;
}

export interface HandPose {
  /** Index, middle, ring, little. */
  readonly fingers: readonly [FingerAngles, FingerAngles, FingerAngles, FingerAngles];
  readonly thumb: ThumbAngles;
}

const finger = (spread: number, mcp: number, pip: number, dip: number): FingerAngles => ({ spread, mcp, pip, dip });

/** The four named poses. The sequence moves between them with easing. */
export const POSES = {
  /** Relaxed and open, fingers a little curved: reaching in. */
  open: {
    fingers: [finger(0.1, 0.15, 0.2, 0.1), finger(0.03, 0.15, 0.22, 0.1), finger(-0.04, 0.18, 0.24, 0.12), finger(-0.12, 0.2, 0.26, 0.14)],
    thumb: { swing: 0.75, mcp: 0.1, ip: 0.1 },
  },
  /** Cupped over the shells, scooping them in. */
  cupped: {
    fingers: [finger(0.05, 0.55, 0.7, 0.45), finger(0.02, 0.6, 0.72, 0.45), finger(-0.02, 0.62, 0.74, 0.48), finger(-0.06, 0.65, 0.78, 0.5)],
    thumb: { swing: 0.45, mcp: 0.45, ip: 0.35 },
  },
  /** A closed fist round the shells. */
  fist: {
    fingers: [finger(0.02, 1.45, 1.6, 1.0), finger(0, 1.5, 1.65, 1.0), finger(-0.02, 1.5, 1.65, 1.05), finger(-0.04, 1.45, 1.6, 1.05)],
    thumb: { swing: 0.12, mcp: 0.85, ip: 0.6 },
  },
  /** Flung open as the shells leave: fingers straight and spread, a little bent back. */
  flung: {
    fingers: [finger(0.22, -0.2, -0.05, 0), finger(0.07, -0.22, -0.05, 0), finger(-0.08, -0.2, -0.05, 0), finger(-0.24, -0.18, -0.04, 0)],
    thumb: { swing: 1.05, mcp: -0.1, ip: 0 },
  },
} as const satisfies Record<string, HandPose>;

export type PoseName = keyof typeof POSES;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Between two poses, joint by joint. */
export function blendPose(a: HandPose, b: HandPose, t: number): HandPose {
  const f = (i: 0 | 1 | 2 | 3): FingerAngles => ({
    spread: mix(a.fingers[i].spread, b.fingers[i].spread, t),
    mcp: mix(a.fingers[i].mcp, b.fingers[i].mcp, t),
    pip: mix(a.fingers[i].pip, b.fingers[i].pip, t),
    dip: mix(a.fingers[i].dip, b.fingers[i].dip, t),
  });
  return {
    fingers: [f(0), f(1), f(2), f(3)],
    thumb: { swing: mix(a.thumb.swing, b.thumb.swing, t), mcp: mix(a.thumb.mcp, b.thumb.mcp, t), ip: mix(a.thumb.ip, b.thumb.ip, t) },
  };
}

// ------------------------------------------------------------ proportions

/**
 * Board units (the board's radius is 1, a shell about 0.21 long). A real hand
 * would cover most of this small board, so this one is drawn smaller than
 * life: about 0.7 from wrist to fingertip.
 */
export const HAND = {
  palm: { width: 0.3, length: 0.3, thickness: 0.09 },
  /** Knuckles across the front of the palm, index (thumb side, +x) to little. */
  knuckles: [0.105, 0.035, -0.035, -0.1],
  /** Proximal, middle, distal lengths, and radius, per finger. */
  fingers: [
    { lengths: [0.12, 0.075, 0.06], radius: 0.03 },
    { lengths: [0.13, 0.085, 0.065], radius: 0.031 },
    { lengths: [0.125, 0.08, 0.062], radius: 0.03 },
    { lengths: [0.095, 0.06, 0.05], radius: 0.026 },
  ],
  thumb: { base: [0.12, -0.02, 0.06] as Vec3, lengths: [0.1, 0.08], radius: 0.034 },
  /** The wrist joint, and the sleeve that covers the forearm. */
  wrist: { radius: 0.075 },
  /** The sleeve fades out over `fade` (from the cuff): the forearm dissolves into the dark at the board's edge. */
  sleeve: { radius: 0.088, cuff: 0.05, length: 0.75, fade: [0.08, 0.6] as const },
} as const;

/**
 * The palm's anchor, in the hand's frame: just under the middle of the palm.
 * The shells are drawn to it as they are scooped, are hidden there in the
 * fist, and leave from it: at the release it is exactly the physics'
 * release point.
 */
export const PALM_ANCHOR: Vec3 = [0, -0.07, 0.16];

// ------------------------------------------------------------- the frame

export type HandPhase = "reach" | "scoop" | "lift" | "hold" | "shake" | "swing" | "follow" | "withdraw";

/**
 * Everything a hand model needs for one frame, in the board's frame (the
 * thrower's side of the board is where `seat` sits). Produced by the
 * sequence every frame; a model never decides timing.
 */
export interface HandFrame {
  /** Whose hand: it reaches in from that seat's side and withdraws to it. */
  readonly seat: SeatId;
  readonly phase: HandPhase;
  /** 0 to 1 through the phase (the held shake repeats). For a rigged model's clips. */
  readonly progress: number;
  /** The wrist's position, and the hand's rotation. */
  readonly wrist: Vec3;
  readonly rotation: Quat;
  /** The palm's anchor (see PALM_ANCHOR), where the shells gather and leave. */
  readonly anchor: Vec3;
  /** The forearm runs from the wrist towards this point, beyond the board's edge, and fades out. */
  readonly shoulder: Vec3;
  readonly pose: HandPose;
  /** 0 to 1. */
  readonly opacity: number;
}
