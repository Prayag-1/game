#!/usr/bin/env node
/**
 * `pnpm dev`: the game server on http://127.0.0.1:3000 and the web client's
 * Vite dev server on http://127.0.0.1:5173, which proxies /session, /tables
 * and the /ws WebSocket to the game server (see packages/web/vite.config.ts).
 * Open http://127.0.0.1:5173/. The debug client stays at http://127.0.0.1:3000/.
 *
 * Ctrl+C stops both. If either exits, the other is stopped too.
 */
import { spawn, spawnSync } from "node:child_process";

const WEB_ORIGINS = "http://127.0.0.1:5173,http://localhost:5173";
const shell = process.platform === "win32";

// The server imports these packages' built output.
for (const pkg of ["@kauda/rules", "@kauda/protocol"]) {
  const built = spawnSync("pnpm", ["--filter", pkg, "build"], { stdio: "inherit", shell });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const children = [
  spawn("pnpm", ["--filter", "@kauda/server", "dev"], {
    stdio: "inherit",
    shell,
    env: { ...process.env, KAUDA_PROXY_ORIGINS: WEB_ORIGINS },
  }),
  spawn("pnpm", ["--filter", "@kauda/web", "dev"], { stdio: "inherit", shell }),
];

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGINT");
  setTimeout(() => process.exit(code), 1500).unref();
}
for (const child of children) child.on("exit", (code) => stopAll(code ?? 0));
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
