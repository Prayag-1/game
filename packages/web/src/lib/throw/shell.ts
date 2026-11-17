import { SHELL } from "../board";

export { SHELL_SET, type ShellLook } from "../board";

/**
 * The sixteen shells as bodies, shared by the physics (in the worker) and
 * the 3D board. Pure: no three.js, no Rapier.
 *
 * THE SYMMETRIC COLLIDER. A cowrie's two sides differ (a tall glossy dome,
 * a flatter slit underside), but its collider must not, or the physics
 * would favour one face. It is a flat ellipse on the shell's own outline,
 * rounded all round by half the shell's height: a smooth pebble, the same
 * whichever way up it lies, so physics cannot tell face up from face down.
 * Which way up a shell is SHOWN is decided afterwards, by turning the
 * visible mesh 180 degrees about its long axis inside the collider (see
 * flipsFor in playback.ts).
 *
 * Why this shape. Its flat faces let a shell lie exactly level. Its
 * rounded sides cannot hold it up on edge: the centre of mass sits above
 * the side's centre of curvature, so it tips over. And colliding shells
 * bump rather than ride over each other, as sharp-edged lenses did, which
 * kept leaving one shell lying on another.
 *
 * The visible shell spans from the base's lowest point (SHELL.base below
 * its edge) to the dome's top (SHELL.dome above). The collider is centred
 * between them, HALF_THICKNESS each side of its middle, and the mesh sits
 * MESH_OFFSET along the collider's +y (its edge just below the middle).
 * Either way up, the visible shell's lowest point (the dome's top, or the
 * base's deepest point, both at the shell's centre) is exactly the
 * collider's flat face: neither side floats or sinks at rest.
 */

/** Half the collider's thickness at scale 1: the visible shell's full height, halved. */
export const HALF_THICKNESS = (SHELL.dome + SHELL.base) / 2;
/** Where the mesh's edge plane sits along the collider's +y, at scale 1 (negative: below the middle). */
export const MESH_OFFSET = (SHELL.base - SHELL.dome) / 2;

/**
 * Rounds to 1e-5. Points built with Math.cos could differ in the last bit
 * between browsers; rounded, they are the same everywhere (unless a value
 * sat within one ulp of a rounding boundary, which none here does).
 */
export const quantize = (v: number): number => Math.round(v * 1e5) / 1e5;

/** The core's half-thickness at scale 1: thin, but not flat, so its hull is a solid. */
const CORE = 0.0006;
const OUTLINE_POINTS = 16;

/**
 * The collider for a shell of this scale, for Rapier's roundConvexHull:
 * a thin flat ellipse (the core), grown by `radius` in every direction.
 * The result is HALF_THICKNESS x scale thick each side of its middle, and
 * its outline is the drawn shell's.
 */
export function shellCollider(scale: number): { points: Float32Array; radius: number } {
  const radius = (HALF_THICKNESS - CORE) * scale;
  const ax = (SHELL.length / 2) * scale - radius;
  const bz = (SHELL.width / 2) * scale - radius;
  const pts: number[] = [];
  for (let k = 0; k < OUTLINE_POINTS; k += 1) {
    const phi = (2 * Math.PI * k) / OUTLINE_POINTS;
    const t = quantize(Math.cos(phi));
    const x = ax * t;
    // The drawn outline is very slightly fuller towards one end.
    const z = bz * quantize(Math.sin(phi)) * (1 + 0.04 * t);
    pts.push(x, CORE * scale, z, x, -CORE * scale, z);
  }
  return { points: Float32Array.from(pts), radius };
}
