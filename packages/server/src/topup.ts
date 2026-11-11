import { MINT_ACCOUNT, type Ledger } from "./ledger.js";

/**
 * Free top-ups for humans.
 *
 * Why this has to exist: Kauda is exactly fair, but a fair game between one
 * finite bankroll and bots that are re-funded forever is gambler's ruin. The
 * human busts with probability 1; from a 2000-chip buy-in the median is about
 * 745 rounds. Without a top-up every player is eventually locked out for good.
 *
 * The rules:
 * - Only a human whose balance is below the amount needed to sit may claim.
 * - A claim brings the balance back up to the standard buy-in, written as one
 *   "topup" transfer from the mint.
 * - One claim per account per cooldown. The cooldown runs from the account's
 *   last "topup" entry in the ledger, so it holds across every table that
 *   shares the ledger and needs no state of its own.
 * - Never automatic. The player has to claim it, so the lobby can show it as a
 *   choice. Nothing in the table tops anyone up by itself.
 *
 * This is deliberately NOT anti-abuse. With guest login a busted player can
 * just create a new guest and get a fresh buy-in, so tighter gating here
 * (device or IP limits, play-before-claim, shrinking amounts, a long cooldown)
 * buys nothing until real accounts exist. Revisit it then, together with the
 * grant limits in SECURITY.md ("Chip farming by bots").
 */

export interface TopUpPolicy {
  /** The balance a claim tops up to. */
  readonly standardBuyIn: number;
  /** A claim is allowed only below this balance. */
  readonly minChipsToSit: number;
  /** Time between claims on one account. */
  readonly cooldownMs: number;
}

/** Generous on purpose; see the note above. */
export const DEFAULT_TOP_UP_COOLDOWN_MS = 15 * 60_000;

export type TopUpRefusal = "topup-not-needed" | "topup-cooldown";

export type TopUpOffer =
  | { readonly ok: true; readonly chips: number }
  | {
      readonly ok: false;
      readonly reason: TopUpRefusal;
      /** When the cooldown ends, for "topup-cooldown". Null otherwise. */
      readonly availableAt: number | null;
    };

/** What a claim would do right now. Writes nothing; for the lobby to show. */
export function topUpOffer(ledger: Ledger, playerId: string, policy: TopUpPolicy, now: number): TopUpOffer {
  if (playerId === MINT_ACCOUNT) return { ok: false, reason: "topup-not-needed", availableAt: null };
  const balance = ledger.balance(playerId);
  if (balance >= policy.minChipsToSit) return { ok: false, reason: "topup-not-needed", availableAt: null };
  const last = ledger.lastEntryAt(playerId, "topup");
  if (last !== null && now < last + policy.cooldownMs) {
    return { ok: false, reason: "topup-cooldown", availableAt: last + policy.cooldownMs };
  }
  return { ok: true, chips: policy.standardBuyIn - balance };
}

/** Claims a top-up if one is due, and writes it to the ledger. */
export function claimTopUp(ledger: Ledger, playerId: string, policy: TopUpPolicy, now: number): TopUpOffer {
  const offer = topUpOffer(ledger, playerId, policy, now);
  if (offer.ok) ledger.issue(playerId, offer.chips, "topup", now);
  return offer;
}
