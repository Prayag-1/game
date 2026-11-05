import { z } from "zod";
import { MAX_CHIP_AMOUNT, type SeatId } from "@kauda/rules";

/**
 * Everything a client may ask the table to do. Parsed from untrusted input
 * (SECURITY.md rule 3). Objects are strict, so a message cannot smuggle in an
 * extra field such as a winner or a balance. No command carries a playerId:
 * who is asking comes from the authenticated session, never from the message.
 */

export const SeatSchema = z.enum(["teeya", "chauka", "panja", "chakka"]);

// Compile-time check that the schema and the rules agree on the seats.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const seatsAgree: Same<z.infer<typeof SeatSchema>, SeatId> = true;
void seatsAgree;

export const ChipsSchema = z.number().int().positive().max(MAX_CHIP_AMOUNT);

export const CommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("sit"), seat: SeatSchema }),
  z.strictObject({ type: z.literal("stand") }),
  z.strictObject({ type: z.literal("placeBet"), seat: SeatSchema, chips: ChipsSchema }),
  z.strictObject({ type: z.literal("clearBet") }),
  z.strictObject({ type: z.literal("throw") }),
  z.strictObject({ type: z.literal("leave") }),
]);

export type Command = z.infer<typeof CommandSchema>;

export const PlayerIdSchema = z.string().min(1).max(64);

/** Parses untrusted input. Returns null rather than throwing. */
export function parseCommand(raw: unknown): Command | null {
  const result = CommandSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function isValidPlayerId(id: unknown): id is string {
  return PlayerIdSchema.safeParse(id).success;
}
