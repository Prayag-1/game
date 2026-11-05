import { type SeatId, TURN_ORDER } from "./types.js";

/**
 * Seat that wins for a given number of face-up shells.
 *
 * The article states that four up is chauka, five up is panja, and that all up
 * (16) or all down (0) are chauka, which is why chauka takes five of the
 * seventeen outcomes while the others take four. That is exactly face count
 * modulo four.
 */
const BY_REMAINDER: readonly SeatId[] = ["chauka", "panja", "chakka", "teeya"] as const;

export function seatForFaceCount(faceUp: number): SeatId {
  if (!Number.isInteger(faceUp) || faceUp < 0 || faceUp > 16) {
    throw new RangeError(`faceUp must be an integer 0..16, got ${faceUp}`);
  }
  const seat = BY_REMAINDER[faceUp % 4];
  if (seat === undefined) throw new Error("unreachable");
  return seat;
}

/** Next seat anticlockwise, skipping empty seats. Falls back to the thrower. */
export function nextSeat(
  from: SeatId,
  occupied: (seat: SeatId) => boolean,
): SeatId {
  const start = TURN_ORDER.indexOf(from);
  for (let step = 1; step <= TURN_ORDER.length; step += 1) {
    const candidate = TURN_ORDER[(start + step) % TURN_ORDER.length];
    if (candidate !== undefined && occupied(candidate)) return candidate;
  }
  return from;
}
