import { TURN_ORDER, type SeatId } from "@kauda/rules";

/**
 * Bot behaviour.
 *
 * A seated bot has no decisions to make: its stake is automatic, and the
 * table throws for it promptly when it holds the throw. Only a chyakhe bot
 * chooses anything, and what it chooses goes through the same command
 * validation as a human's, so a bot can never do what a player could not.
 */

export interface ChyakheContext {
  readonly thrower: SeatId;
  readonly seats: Readonly<Partial<Record<SeatId, string>>>;
  readonly balance: number;
  readonly thini: number;
}

export interface BotBet {
  readonly seat: SeatId;
  readonly chips: number;
}

/**
 * A simple, cautious policy: bet half the time, on a random occupied seat
 * other than the thrower's, for one to three thini, and never more than a
 * quarter of the bot's balance. `random` returns a number in [0, 1).
 */
export function chooseChyakheBet(ctx: ChyakheContext, random: () => number): BotBet | null {
  if (random() >= 0.5) return null;
  const options = TURN_ORDER.filter((s) => s !== ctx.thrower && ctx.seats[s] !== undefined);
  const seat = options[Math.floor(random() * options.length)];
  if (seat === undefined) return null;
  const units = 1 + Math.floor(random() * 3);
  const chips = Math.min(units * ctx.thini, Math.floor(ctx.balance / 4));
  return chips >= 1 ? { seat, chips } : null;
}
