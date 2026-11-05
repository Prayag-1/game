import type { SeatId } from "@kauda/rules";

/**
 * Seat filling.
 *
 * A Kauda table needs all four inside seats. With an empty seat, a throw that
 * lands there is a push and nothing happens, and once two seats are empty
 * about half of all rounds are pushes. So while a table is live (it has a
 * connected human) the table keeps every seat filled:
 *
 * - A seated bot that cannot cover the stake leaves the table, and a fresh bot
 *   with a full buy-in takes its seat.
 * - A seat a human leaves, or is stood up from, gets a bot.
 * - A human is never displaced, and a seat a human has reserved is never given
 *   to a bot. A human may take a bot's seat between rounds; the bot leaves.
 *
 * Humans who go broke are stood up and keep their real balance. They are
 * never topped up here; that is for the lobby to offer.
 *
 * The policy is injected so tests (and any table that wants it) can turn it
 * off and still see empty seats and pushes.
 */

export interface BotSpec {
  readonly id: string;
  readonly name: string;
  readonly buyIn: number;
}

export interface SeatFillPolicy {
  /** A fresh bot for an empty seat, or null to leave the seat empty. */
  nextBot(seat: SeatId): BotSpec | null;
}

const BOT_NAMES = [
  "Aarati", "Bishnu", "Chandra", "Dipak", "Ganga", "Hira", "Jamuna", "Kamal",
  "Laxmi", "Madan", "Nabin", "Parbati", "Ramesh", "Sabitri", "Tika", "Uma",
] as const;

export interface BotSeatFillingOptions {
  /** Chips each fresh bot buys in with. */
  readonly buyIn: number;
  /** Prefix for bot ids. Must be unique per table. */
  readonly idPrefix: string;
  readonly names?: readonly string[];
}

/** The standard policy: a numbered bot with a full buy-in for every empty seat. */
export function botSeatFilling(options: BotSeatFillingOptions): SeatFillPolicy {
  const names = options.names ?? BOT_NAMES;
  let n = 0;
  return {
    nextBot: () => {
      n += 1;
      const base = names[(n - 1) % names.length] ?? "Bot";
      return { id: `${options.idPrefix}${n}`, name: `${base} (bot)`, buyIn: options.buyIn };
    },
  };
}
