import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema.js";
import { DrizzleChipStore, type KaudaDb } from "./store.js";

/**
 * Two drivers behind one schema:
 * - DATABASE_URL set: node-postgres, for production.
 * - otherwise: PGlite (Postgres compiled to WebAssembly, in process), for dev
 *   and tests, persisted under .data/ (gitignored) or held in memory.
 * Migrations in ./drizzle are applied on open unless told not to.
 */

/** packages/server/.data/pglite, from src/db or dist/db alike. */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../.data/pglite", import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface OpenOptions {
  /** A postgres:// URL: use node-postgres. */
  readonly databaseUrl?: string;
  /** PGlite directory; null keeps the database in memory. Ignored with databaseUrl. */
  readonly dataDir?: string | null;
  /** Apply pending migrations. Default true. */
  readonly migrate?: boolean;
}

export async function openChipStore(options: OpenOptions = {}): Promise<DrizzleChipStore> {
  const migrations = { migrationsFolder: MIGRATIONS_DIR };
  if (options.databaseUrl !== undefined) {
    const pool = new pg.Pool({ connectionString: options.databaseUrl });
    const db = drizzlePg({ client: pool, schema });
    if (options.migrate !== false) await migratePg(db, migrations);
    return new DrizzleChipStore(db as unknown as KaudaDb, `Postgres at ${redact(options.databaseUrl)}`, () => pool.end());
  }
  const dir = options.dataDir === undefined ? DEFAULT_DATA_DIR : options.dataDir;
  if (dir !== null) mkdirSync(dir, { recursive: true });
  const client = dir === null ? new PGlite() : new PGlite(dir);
  const db = drizzlePglite({ client, schema });
  if (options.migrate !== false) await migratePglite(db, migrations);
  return new DrizzleChipStore(db as unknown as KaudaDb, dir === null ? "PGlite in memory" : `PGlite at ${dir}`, () => client.close());
}

/** DATABASE_URL if set, else PGlite under KAUDA_DATA_DIR or .data/pglite. */
export function openChipStoreFromEnv(env: NodeJS.ProcessEnv = process.env, migrate = true): Promise<DrizzleChipStore> {
  const url = env.DATABASE_URL;
  if (url !== undefined && url.length > 0) return openChipStore({ databaseUrl: url, migrate });
  return openChipStore({ dataDir: env.KAUDA_DATA_DIR ?? DEFAULT_DATA_DIR, migrate });
}

/** A connection URL with any password removed, for logs. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password !== "") u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}
