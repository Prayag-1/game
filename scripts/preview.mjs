#!/usr/bin/env node
/**
 * `pnpm preview`: the production build of the web client, served by the game
 * server itself under the strict CSP, on http://127.0.0.1:3000/ (the debug
 * client moves to /debug). `pnpm preview` builds packages/web first.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const shell = process.platform === "win32";
const dist = fileURLToPath(new URL("../packages/web/dist", import.meta.url));

for (const pkg of ["@kauda/rules", "@kauda/protocol"]) {
  const built = spawnSync("pnpm", ["--filter", pkg, "build"], { stdio: "inherit", shell });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const server = spawn("pnpm", ["--filter", "@kauda/server", "dev"], {
  stdio: "inherit",
  shell,
  env: { ...process.env, KAUDA_WEB_DIST: dist },
});
server.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => server.kill("SIGINT"));
