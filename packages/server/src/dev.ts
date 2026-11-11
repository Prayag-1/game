/**
 * DEVELOPER DEBUG SERVER. NO REAL AUTHENTICATION. NEVER EXPOSE IT TO A NETWORK.
 *
 * `pnpm dev` from the repo root, then open http://127.0.0.1:3000/ . PORT
 * changes the port; the address is always 127.0.0.1. See devServer.ts.
 */
import { openChipStoreFromEnv } from "./db/open.js";
import { DEFAULT_DEV_PORT, startDevServer } from "./devServer.js";

const raw = process.env.PORT ?? String(DEFAULT_DEV_PORT);
const port = Number(raw);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(`PORT must be a port number, got "${raw}"\n`);
  process.exit(2);
}

// The chip economy survives restarts: DATABASE_URL if set, else PGlite under .data/.
const store = await openChipStoreFromEnv();
let dev: Awaited<ReturnType<typeof startDevServer>>;
try {
  dev = await startDevServer({ port, room: { store } });
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
    "",
    "  DEV ONLY. The identity is a stub, not authentication: anyone holding a",
    "  player's token is that player. Bound to 127.0.0.1; never expose it.",
    "",
  ].join("\n") + "\n",
);
