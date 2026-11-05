/**
 * Terminal demo: `pnpm --filter @kauda/server demo`, or ROUNDS=500 for a
 * longer session. SEAT_FILLING=off turns the table's seat filling off, to
 * compare against the old behaviour. Exits non-zero if chips are not
 * conserved or any throw fails verification.
 */
import { runDemo } from "./demo.js";

const raw = process.env.ROUNDS ?? "40";
const rounds = Number(raw);
if (!Number.isSafeInteger(rounds) || rounds < 1) {
  process.stderr.write(`ROUNDS must be a positive integer, got "${raw}"\n`);
  process.exit(2);
}
const filling = (process.env.SEAT_FILLING ?? "on").toLowerCase();
if (filling !== "on" && filling !== "off") {
  process.stderr.write(`SEAT_FILLING must be "on" or "off", got "${filling}"\n`);
  process.exit(2);
}

const summary = runDemo({
  rounds,
  out: (line) => process.stdout.write(`${line}\n`),
  ...(filling === "off" ? { seatFilling: null } : {}),
});
process.exitCode = summary.conserved && summary.allVerified ? 0 : 1;
