import { seatForFaceCount } from "@kauda/rules";
import type { RoundRecord } from "./protocol";

/**
 * The commit-reveal check, run in the browser with crypto.subtle
 * (packages/server/src/fairness.ts is the other side). Before betting the
 * server publishes sha256(seed); after settling it reveals the seed. A round
 * is fair when:
 *   - sha256(seed) is the commitHash in the round record,
 *   - that is the hash this page saw published before the throw, if it saw one,
 *   - the seed gives exactly the faces settled (shell i is up when byte i is odd),
 *   - and those faces give the winning seat the server paid (face-up count mod 4).
 */

export interface FairnessResult {
  /** sha256 of the revealed seed, hex. Empty if the seed is malformed. */
  readonly computed: string;
  readonly hashMatches: boolean;
  /** Null when this page never saw the commitment published (it joined mid-round). */
  readonly matchesPublished: boolean | null;
  readonly facesMatch: boolean;
  readonly seatMatches: boolean;
  readonly ok: boolean;
}

export function seedBytes(seedHex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function checkRound(round: RoundRecord, published: string | undefined): Promise<FairnessResult> {
  const bytes = seedBytes(round.seed);
  if (bytes === null) {
    return { computed: "", hashMatches: false, matchesPublished: published === undefined ? null : false, facesMatch: false, seatMatches: false, ok: false };
  }
  const computed = await sha256Hex(bytes);
  const hashMatches = computed === round.commitHash;
  const matchesPublished = published === undefined ? null : published === computed;
  const faces = Array.from(bytes.slice(0, 16), (b) => (b & 1) === 1);
  const facesMatch = round.faces.length === 16 && faces.every((f, i) => round.faces[i] === f);
  const faceUp = faces.filter(Boolean).length;
  const seatMatches = round.faceUp === faceUp && seatForFaceCount(faceUp) === round.winningSeat;
  return {
    computed,
    hashMatches,
    matchesPublished,
    facesMatch,
    seatMatches,
    ok: hashMatches && matchesPublished !== false && facesMatch && seatMatches,
  };
}
