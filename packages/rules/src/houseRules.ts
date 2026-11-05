import type { HouseRules } from "./types.js";

/**
 * Defaults chosen so the game is provably fair.
 *
 * On a hit the thrower collects the current stake from each of the three other
 * seats; on a miss the thrower pays the current stake to the winning seat
 * only. Since a hit happens one time in four and a miss three times in four,
 * collecting 3x and paying 1x is exactly even at any stake level. Doubling
 * therefore changes the swing of the game without changing its fairness, and
 * the cap exists to protect chip balances rather than to balance the odds.
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

export function validateHouseRules(rules: HouseRules): void {
  if (!Number.isInteger(rules.thini) || rules.thini <= 0) {
    throw new RangeError("thini must be a positive integer number of chips");
  }
  if (!Number.isInteger(rules.maxStakeMultiplier) || rules.maxStakeMultiplier < 1) {
    throw new RangeError("maxStakeMultiplier must be an integer >= 1");
  }
  if (!Number.isInteger(rules.ghantiChips) || rules.ghantiChips < 0) {
    throw new RangeError("ghantiChips must be a non-negative integer");
  }
  if (!Number.isInteger(rules.maxChyakhe) || rules.maxChyakhe < 0) {
    throw new RangeError("maxChyakhe must be a non-negative integer");
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
