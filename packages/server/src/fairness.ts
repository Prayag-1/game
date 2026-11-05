import { createHash, randomBytes } from "node:crypto";
import { SHELL_COUNT, type ShellFace } from "@kauda/rules";

/**
 * Commit-reveal for the throw.
 *
 * Before betting opens the server draws a 32-byte seed and publishes only
 * sha256(seed). The sixteen faces follow from the seed alone: byte i is shell
 * i, and its low bit decides face up. After settlement the seed is revealed,
 * and anyone can check that it hashes to the published commitment and gives
 * the faces that were settled. Because the commitment is fixed before any bet
 * is placed, the server cannot choose a throw to suit the money on the table.
 */

export const SEED_BYTES = 32;

export interface Commitment {
  /** Hex, 64 characters. Secret until the round has settled. */
  readonly seed: string;
  /** Hex sha256 of the seed bytes. Published when betting opens. */
  readonly commitHash: string;
}

/** Produces the commitment for each new round. Injected so tests can script seeds. */
export type CommitmentFactory = () => Commitment;

const HEX_SEED = /^[0-9a-f]{64}$/;

/** Parses a hex seed. Returns null for anything that is not exactly 32 bytes of lowercase hex. */
export function parseSeed(seed: string): Uint8Array | null {
  if (!HEX_SEED.test(seed)) return null;
  return Uint8Array.from(Buffer.from(seed, "hex"));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The sixteen faces a seed produces: shell i is face up when byte i is odd. */
export function facesFromSeed(seed: Uint8Array | string): ShellFace[] {
  const bytes = typeof seed === "string" ? parseSeed(seed) : seed;
  if (bytes === null || bytes.length !== SEED_BYTES) {
    throw new RangeError(`a seed must be ${SEED_BYTES} bytes`);
  }
  const faces: ShellFace[] = [];
  for (let i = 0; i < SHELL_COUNT; i += 1) faces.push(((bytes[i] ?? 0) & 1) === 1);
  return faces;
}

export function commitmentFromSeed(seed: Uint8Array): Commitment {
  if (seed.length !== SEED_BYTES) throw new RangeError(`a seed must be ${SEED_BYTES} bytes`);
  return { seed: Buffer.from(seed).toString("hex"), commitHash: sha256Hex(seed) };
}

/** The production factory: 32 bytes from the OS CSPRNG. */
export const cryptoCommitment: CommitmentFactory = () => commitmentFromSeed(randomBytes(SEED_BYTES));

/**
 * What a client runs to check a settled round: the revealed seed hashes to
 * the commitment published before betting, and produces exactly these faces.
 */
export function verifyThrow(seed: string, commitHash: string, faces: readonly ShellFace[]): boolean {
  const bytes = parseSeed(seed);
  if (bytes === null) return false;
  if (sha256Hex(bytes) !== commitHash.toLowerCase()) return false;
  const expected = facesFromSeed(bytes);
  return faces.length === expected.length && expected.every((f, i) => faces[i] === f);
}

/**
 * Builds a seed whose first `faceUp` shells land face up and the rest face
 * down. For tests only. `variant` changes the other bits, so several seeds
 * with the same face count still have different hashes.
 */
export function seedForFaceCount(faceUp: number, variant = 0): Uint8Array {
  if (!Number.isInteger(faceUp) || faceUp < 0 || faceUp > SHELL_COUNT) {
    throw new RangeError(`faceUp must be 0..${SHELL_COUNT}`);
  }
  if (!Number.isInteger(variant) || variant < 0 || variant > 0xffffffff) {
    throw new RangeError("variant must be a 32-bit unsigned integer");
  }
  const seed = new Uint8Array(SEED_BYTES);
  for (let i = 0; i < SHELL_COUNT; i += 1) {
    // Even filler bytes, so only the deliberate low bit decides the face.
    seed[i] = ((i * 37 + 13) & 0xfe) | (i < faceUp ? 1 : 0);
  }
  // The variant goes into the last four bytes, so every variant is a distinct seed.
  new DataView(seed.buffer).setUint32(SEED_BYTES - 4, variant);
  return seed;
}
