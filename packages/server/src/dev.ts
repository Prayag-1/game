/**
 * DEVELOPER DEBUG SERVER. NO REAL AUTHENTICATION. NEVER EXPOSE IT TO A NETWORK.
 *
 * `pnpm dev` from the repo root, then open http://127.0.0.1:3000/ . PORT
 * changes the port; the address is always 127.0.0.1. See devServer.ts.
 */
import { DEFAULT_DEV_PORT, startDevServer } from "./devServer.js";

const raw = process.env.PORT ?? String(DEFAULT_DEV_PORT);
const port = Number(raw);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(`PORT must be a port number, got "${raw}"\n`);
  process.exit(2);
}

const dev = await startDevServer({ port });
process.stdout.write(
  [
    "",
    `  Kauda debug client: ${dev.url}`,
    "",
    "  DEV ONLY. The identity is a stub, not authentication: anyone holding a",
    "  player's token is that player. Bound to 127.0.0.1; never expose it.",
    "",
  ].join("\n") + "\n",
);
