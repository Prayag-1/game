/**
 * `pnpm --filter @kauda/server db:migrate`: applies the SQL migrations in
 * ./drizzle to DATABASE_URL if set, else to the PGlite data under .data/.
 * The dev server also migrates on start; this is for a production database.
 */
import { openChipStoreFromEnv } from "./open.js";

const store = await openChipStoreFromEnv(process.env, true);
process.stdout.write(`Migrated ${store.description}\n`);
await store.close();
