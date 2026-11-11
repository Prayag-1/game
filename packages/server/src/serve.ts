/**
 * Development game server: `pnpm --filter @kauda/server serve` (PORT=2567).
 *
 * Uses the dev identity stub, which is NOT authentication. Bind to localhost
 * only; nothing here is fit to expose (no Origin check on the websocket
 * upgrade yet, no real sessions). See SECURITY.md.
 */
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { devIdentityStub } from "./identity.js";
import { defineKaudaRoom } from "./room.js";

const port = Number(process.env.PORT ?? "2567");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(`PORT must be a port number, got "${process.env.PORT}"\n`);
  process.exit(2);
}

const server = new Server({ transport: new WebSocketTransport() });
server.define("kauda", defineKaudaRoom({ identity: devIdentityStub() }));
await server.listen(port, "127.0.0.1");
process.stdout.write(`Kauda dev server on ws://127.0.0.1:${port}  (DEV IDENTITY STUB: not authentication)\n`);
