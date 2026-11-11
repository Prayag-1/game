/**
 * DEVELOPER SERVER. FOR YOUR OWN MACHINE ONLY. NEVER EXPOSE IT TO A NETWORK.
 *
 * `pnpm dev` from the repo root, then open http://127.0.0.1:3000/ . PORT
 * changes the port; the address is always 127.0.0.1. See devServer.ts.
 *
 * Environment (all optional in development):
 *   DATABASE_URL          Postgres; otherwise PGlite under .data/
 *   KAUDA_SESSION_SECRET  cookie signing key, 64+ hex chars; otherwise a dev
 *                         key kept in .data/ (gitignored). Required in production.
 *   TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY
 *                         otherwise Cloudflare's always-pass test keys
 *   KAUDA_GUESTS_PER_HOUR guest creations per IP per hour (default 5)
 */
import { fileURLToPath } from "node:url";
import { loadSessionSecret } from "./auth/secret.js";
import { cloudflareTurnstile, turnstileFromEnv } from "./auth/turnstile.js";
import { openChipStoreFromEnv } from "./db/open.js";
import { DEFAULT_DEV_PORT, DEFAULT_GUESTS_PER_HOUR, startDevServer } from "./devServer.js";

const raw = process.env.PORT ?? String(DEFAULT_DEV_PORT);
const port = Number(raw);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(`PORT must be a port number, got "${raw}"\n`);
  process.exit(2);
}
const guestsPerHour = Number(process.env.KAUDA_GUESTS_PER_HOUR ?? DEFAULT_GUESTS_PER_HOUR);
if (!Number.isSafeInteger(guestsPerHour) || guestsPerHour < 1) {
  process.stderr.write("KAUDA_GUESTS_PER_HOUR must be a positive integer\n");
  process.exit(2);
}

// Both throw in production when their environment variables are missing.
const { secret, source: secretSource } = loadSessionSecret(
  process.env,
  fileURLToPath(new URL("../.data/session-secret", import.meta.url)),
);
const turnstileKeys = turnstileFromEnv(process.env);

// The chip economy survives restarts: DATABASE_URL if set, else PGlite under .data/.
const store = await openChipStoreFromEnv();
let dev: Awaited<ReturnType<typeof startDevServer>>;
try {
  dev = await startDevServer({
    port,
    store,
    auth: {
      secret,
      turnstileSiteKey: turnstileKeys.siteKey,
      turnstile: cloudflareTurnstile({ secretKey: turnstileKeys.secretKey }),
      guestsPerHour,
    },
  });
} catch (e) {
  // Close the database cleanly, or the open handle keeps the process alive.
  await store.close();
  const busy = (e as { code?: string }).code === "EADDRINUSE";
  process.stderr.write(
    busy ? `Port ${port} is already in use (another dev server?). Stop it, or set PORT.\n` : `Could not start: ${String(e)}\n`,
  );
  process.exit(1);
}
const stop = async (): Promise<void> => {
  await dev.close();
  await store.close(); // PGlite must close cleanly to flush to disk
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.stdout.write(
  [
    "",
    `  Kauda debug client: ${dev.url}`,
    `  Chips stored in:    ${store.description}`,
    `  Session key:        ${secretSource}`,
    `  Turnstile:          ${turnstileKeys.testKeys ? "Cloudflare's always-pass TEST keys" : "keys from the environment"}`,
    "",
    "  DEV ONLY: plain HTTP on 127.0.0.1. Never expose it to a network.",
    "",
  ].join("\n") + "\n",
);
