import { defineConfig } from "drizzle-kit";

/**
 * `pnpm --filter @kauda/server db:generate` writes SQL migrations to
 * ./drizzle from src/db/schema.ts. The generated SQL is committed. The first
 * migration also carries hand-written SQL (mint row, triggers) after the
 * generated statements; see the comment at the top of schema.ts.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
});
