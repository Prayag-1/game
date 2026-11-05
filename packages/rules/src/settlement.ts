import { TURN_ORDER, type RoundInput, type RoundOutcome, type SeatId } from "./types.js";
import { nextSeat } from "./seats.js";
import { resolveThrow } from "./throw.js";
import { isChipAmount, stakeMultiplier, validateHouseRules } from "./houseRules.js";

class Ledger {
  private readonly deltas = new Map<string, number>();

  /** Registers a player with no change, so they appear in the deltas. */
  touch(playerId: string): void {
    if (!this.deltas.has(playerId)) this.deltas.set(playerId, 0);
  }

  /**
   * Moves chips between two players. This is the only way to change a delta,
   * so the ledger can never drift.
   */
  transfer(from: string, to: string, chips: number): void {
    if (!Number.isSafeInteger(chips) || chips < 0) {
      throw new RangeError(`transfer must be a whole, non-negative number of chips, got ${chips}`);
    }
    this.bump(from, -chips);
    this.bump(to, chips);
  }

  private bump(playerId: string, chips: number): void {
    const next = (this.deltas.get(playerId) ?? 0) + chips;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(`delta for ${playerId} left the safe integer range`);
    }
    this.deltas.set(playerId, next);
  }

  finish(): Record<string, number> {
    let sum = 0;
    for (const v of this.deltas.values()) sum += v;
    if (sum !== 0) {
      throw new Error(`settlement did not balance: total ${sum} chips`);
    }
    return Object.fromEntries(this.deltas);
  }
}

/**
 * Settles one throw.
 *
 * Hit: the thrower collects the stake from each of the other seated players
 * and keeps the throw, with the stake doubling for the next throw.
 * Miss: the thrower pays the stake to the winning seat and the throw passes
 * anticlockwise. Stakes on the two seats that did not win are not at risk.
 */
export function settleRound(input: RoundInput): RoundOutcome {
  const { thrower, occupants, chyakhe, streak, rules, faces } = input;
  validateHouseRules(rules);

  const throwerPlayer = occupants[thrower];
  if (throwerPlayer === undefined) {
    throw new Error(`thrower seat ${thrower} is empty`);
  }

  if (rules.chyakheEnabled && chyakhe.length > rules.maxChyakhe) {
    throw new RangeError(`too many chyakhe: ${chyakhe.length} > ${rules.maxChyakhe}`);
  }
  if (!rules.chyakheEnabled && chyakhe.length > 0) {
    throw new Error("chyakhe bets are disabled by the house rules");
  }
  for (const bet of chyakhe) {
    if (bet.seat === thrower) {
      throw new Error("a chyakhe may not bet on the thrower's seat");
    }
    if (!isChipAmount(bet.chips, 1)) {
      throw new RangeError("a chyakhe bet must be a positive whole number of chips");
    }
  }

  const { faceUp, winningSeat } = resolveThrow(faces);
  const hit = winningSeat === thrower;
  const multiplier = stakeMultiplier(streak, rules);
  const stake = rules.thini * multiplier;

  const otherSeats: SeatId[] = TURN_ORDER.filter(
    (s) => s !== thrower && occupants[s] !== undefined,
  );

  const ledger = new Ledger();
  ledger.touch(throwerPlayer);
  for (const seat of otherSeats) {
    const p = occupants[seat];
    if (p !== undefined) ledger.touch(p);
  }
  for (const bet of chyakhe) ledger.touch(bet.playerId);

  let push = false;

  if (hit) {
    for (const seat of otherSeats) {
      const player = occupants[seat];
      if (player !== undefined) ledger.transfer(player, throwerPlayer, stake);
    }
    for (const bet of chyakhe) {
      ledger.transfer(bet.playerId, throwerPlayer, bet.chips);
    }
    // Ghanti: paid once, on the first hit of a turn, and shared out among the
    // other seated players so that no chips leave the table.
    if (streak === 0 && rules.ghantiChips > 0 && otherSeats.length > 0) {
      const base = Math.floor(rules.ghantiChips / otherSeats.length);
      let remainder = rules.ghantiChips - base * otherSeats.length;
      for (const seat of otherSeats) {
        const player = occupants[seat];
        if (player === undefined) continue;
        let share = base;
        if (remainder > 0) {
          share += 1;
          remainder -= 1;
        }
        if (share > 0) ledger.transfer(throwerPlayer, player, share);
      }
    }
  } else {
    const winner = occupants[winningSeat];
    if (winner === undefined) {
      // Nobody is sitting on the winning seat, so no chips move.
      push = true;
    } else {
      ledger.transfer(throwerPlayer, winner, stake);
      for (const bet of chyakhe) {
        if (bet.seat === winningSeat) {
          ledger.transfer(throwerPlayer, bet.playerId, bet.chips);
        }
      }
    }
  }

  return {
    faceUp,
    winningSeat,
    hit,
    stakeMultiplier: multiplier,
    stake,
    deltas: ledger.finish(),
    nextThrower: hit
      ? thrower
      : nextSeat(thrower, (s) => occupants[s] !== undefined),
    nextStreak: hit ? streak + 1 : 0,
    push,
  };
}
