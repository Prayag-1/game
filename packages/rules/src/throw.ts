import { SHELL_COUNT, type ShellFace, type ThrowResult } from "./types.js";
import { seatForFaceCount } from "./seats.js";

/** Reads a set of shell faces into a result. */
export function resolveThrow(faces: readonly ShellFace[]): ThrowResult {
  if (faces.length !== SHELL_COUNT) {
    throw new RangeError(`expected ${SHELL_COUNT} shells, got ${faces.length}`);
  }
  let faceUp = 0;
  for (const f of faces) if (f) faceUp += 1;
  return { faces: [...faces], faceUp, winningSeat: seatForFaceCount(faceUp) };
}

/**
 * Throws the shells. The random source is injected so the server can use a
 * cryptographic generator and tests can use a seeded one. Each shell is an
 * independent fair coin.
 */
export function throwShells(random: () => number): ThrowResult {
  const faces: ShellFace[] = [];
  for (let i = 0; i < SHELL_COUNT; i += 1) faces.push(random() < 0.5);
  return resolveThrow(faces);
}

/** Face layout for a given face-up count, lowest shells up. Testing aid. */
export function facesForCount(faceUp: number): ShellFace[] {
  if (!Number.isInteger(faceUp) || faceUp < 0 || faceUp > SHELL_COUNT) {
    throw new RangeError(`faceUp must be 0..${SHELL_COUNT}`);
  }
  return Array.from({ length: SHELL_COUNT }, (_, i) => i < faceUp);
}
