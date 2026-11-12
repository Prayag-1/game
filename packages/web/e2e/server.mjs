/**
 * The game server for the Playwright run: the real dev server, serving
 * packages/web/dist, with a fresh in-temp database so runs never touch
 * packages/server/.data/pglite or each other, and a guest limit high enough
 * for repeated runs. Turnstile: Cloudflare's always-pass test keys.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../../server/dist/dev.js", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const env = { ...process.env };
// The test keys only: never a real Turnstile secret, database or session key.
delete env.TURNSTILE_SITE_KEY;
delete env.TURNSTILE_SECRET_KEY;
delete env.DATABASE_URL;
delete env.KAUDA_SESSION_SECRET;
delete env.KAUDA_PROXY_ORIGINS;

const child = spawn(process.execPath, [server], {
  stdio: "inherit",
  env: {
    ...env,
    PORT: process.env.KAUDA_E2E_PORT ?? "3210",
    KAUDA_WEB_DIST: dist,
    KAUDA_DATA_DIR: join(mkdtempSync(join(tmpdir(), "kauda-e2e-")), "pglite"),
    KAUDA_GUESTS_PER_HOUR: "1000",
    KAUDA_FAST_ROUNDS: "1",
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
