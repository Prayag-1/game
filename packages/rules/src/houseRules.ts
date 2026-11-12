import type { HouseRules } from "./types.js";

/**
 * The default house rules.
 *
 * On a hit the thrower collects the current stake from each of the three other
 * seats; on a miss the thrower pays the current stake to the winning seat
 * only, so a throw is worth stake x (4 x P(hit) - 1) to the thrower:
 * - From teeya or panja, exactly zero: each lands one time in four.
 * - Chauka takes 5 of the 17 face counts, so chauka's thrower gains 1/128 of
 *   the stake per throw and chakka's loses the same. Chyakhe bets involving
 *   those two seats carry a correspondingly small edge.
 * This asymmetry is part of the traditional game, not a bug, and is kept on
 * purpose (CLAUDE.md, "The rules model"; proved in test/settlement.test.ts,
 * "the game is exactly fair"). Doubling scales that edge with the stake but
 * adds no new one, and the cap exists to protect chip balances rather than to
 * balance the odds.
 *
 * This also reconciles the article's two descriptions of mar-taal: the payout
 * really is "multiplied by the number of wins", because the stake has doubled
 * once per win.
 */
export const DEFAULT_HOUSE_RULES: HouseRules = {
  thini: 10,
  doubling: true,
  maxStakeMultiplier: 8,
  ghantiChips: 10,
  chyakheEnabled: true,
  maxChyakhe: 8,
};

/** Doubling and ghanti off: the plainest form of the game. */
export const SIMPLE_HOUSE_RULES: HouseRules = {
  ...DEFAULT_HOUSE_RULES,
  doubling: false,
  maxStakeMultiplier: 1,
  ghantiChips: 0,
};

/**
 * Largest chip amount any single stake, fee or bet may be. Well inside
 * Number.MAX_SAFE_INTEGER so that summing every transfer of a round can never
 * lose precision.
 */
export const MAX_CHIP_AMOUNT = 2 ** 40;

/** A whole number of chips in [min, MAX_CHIP_AMOUNT]. */
export function isChipAmount(value: number, min: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= MAX_CHIP_AMOUNT;
}

export function validateHouseRules(rules: HouseRules): void {
  if (!isChipAmount(rules.thini, 1)) {
    throw new RangeError("thini must be a positive integer number of chips");
  }
  if (!Number.isSafeInteger(rules.maxStakeMultiplier) || rules.maxStakeMultiplier < 1) {
    throw new RangeError("maxStakeMultiplier must be an integer >= 1");
  }
  if (!isChipAmount(rules.thini * rules.maxStakeMultiplier, 1)) {
    throw new RangeError(`thini x maxStakeMultiplier must not exceed ${MAX_CHIP_AMOUNT} chips`);
  }
  if (!isChipAmount(rules.ghantiChips, 0)) {
    throw new RangeError("ghantiChips must be a non-negative integer");
  }
  if (!Number.isSafeInteger(rules.maxChyakhe) || rules.maxChyakhe < 0) {
    throw new RangeError("maxChyakhe must be a non-negative integer");
  }
  if (typeof rules.doubling !== "boolean" || typeof rules.chyakheEnabled !== "boolean") {
    throw new TypeError("doubling and chyakheEnabled must be booleans");
  }
}

/** Stake multiplier for a throw, given the hits already made this turn. */
export function stakeMultiplier(streak: number, rules: HouseRules): number {
  if (!Number.isInteger(streak) || streak < 0) {
    throw new RangeError("streak must be a non-negative integer");
  }
  if (!rules.doubling) return 1;
  const raw = streak >= 31 ? Number.MAX_SAFE_INTEGER : 2 ** streak;
  return Math.min(raw, rules.maxStakeMultiplier);
}
