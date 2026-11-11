/**
 * `pnpm --filter @kauda/server db:verify`: recomputes every balance from
 * ledger_entries, compares it with accounts.balance, and checks that every
 * account including the mint sums to exactly 0, that every round nets to 0
 * and matches its recorded deltas. Read-only. Uses DATABASE_URL if set, else
 * the PGlite data under .data/ (or KAUDA_DATA_DIR). Exits 1 on any problem.
 */
import { openChipStoreFromEnv } from "./open.js";

const store = await openChipStoreFromEnv(process.env, false);
try {
  const report = await store.verify();
  process.stdout.write(`Ledger check of ${store.description}\n`);
  process.stdout.write(
    `  ${report.accounts} accounts, ${report.entries} ledger entries, ${report.rounds} rounds, ${report.chipsInExistence} chips in existence\n`,
  );
  if (report.ok) {
    process.stdout.write("  OK: every balance matches its ledger, and all accounts sum to 0\n");
  } else {
    for (const p of report.problems) process.stdout.write(`  PROBLEM: ${p}\n`);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
