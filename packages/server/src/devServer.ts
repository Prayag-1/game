/**
 * DEVELOPER DEBUG SERVER. NO REAL AUTHENTICATION. NEVER EXPOSE IT TO A NETWORK.
 *
 * Serves the debug client (debug-client/index.html) and the KaudaRoom on one
 * port, bound to 127.0.0.1 only. Identity is the dev stub: whoever presents a
 * token is that player. It is a tool for clicking through a real game on
 * your own machine, nothing more.
 *
 * Even so, a web page open in the same browser can try to reach a server on
 * localhost, so it is locked to its own origin:
 * - the websocket upgrade is refused unless Origin is this server's own
 *   (SECURITY.md: "CSRF and cross-origin websockets"), including no Origin;
 * - matchmaking CORS answers only this server's own origin;
 * - pages are served only for a Host of 127.0.0.1 or localhost on this
 *   port, against DNS rebinding;
 * - the page has a strict Content-Security-Policy: scripts from this origin
 *   and the page's one inline script (by hash), nothing else.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { devIdentityStub } from "./identity.js";
import { defineKaudaRoom, type KaudaRoomDeps } from "./room.js";

/** The only address the dev server ever binds. */
export const DEV_HOST = "127.0.0.1";
export const DEFAULT_DEV_PORT = 3000;

const CLIENT_HTML = fileURLToPath(new URL("../debug-client/index.html", import.meta.url));
const SDK_BUNDLE = join(dirname(createRequire(import.meta.url).resolve("@colyseus/sdk/package.json")), "dist", "colyseus.js");

export interface DevServerOptions {
  /** 0 picks a free port. */
  readonly port?: number;
  /** Overrides for the room, for tests. */
  readonly room?: Partial<KaudaRoomDeps>;
}

export interface DevServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The sha256 CSP source for the content of the page's single bare <tag>.
 * Browsers hash the element's text after the HTML parser has turned CRLF and
 * lone CR into LF, so this does the same: a Windows checkout with CRLF line
 * endings must still produce the hash the browser computes.
 */
function inlineHash(html: string, tag: "script" | "style"): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html);
  if (match?.[1] === undefined) throw new Error(`debug client has no inline <${tag}>`);
  const text = match[1].replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export function contentSecurityPolicy(html: string, port: number): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${inlineHash(html, "script")}`,
    `style-src ${inlineHash(html, "style")}`,
    `connect-src 'self' ws://${DEV_HOST}:${port} ws://localhost:${port}`,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export async function startDevServer(options: DevServerOptions = {}): Promise<DevServer> {
  let port = -1; // known once listening
  const origins = (): readonly string[] => [`http://${DEV_HOST}:${port}`, `http://localhost:${port}`];
  const hosts = (): readonly string[] => [`${DEV_HOST}:${port}`, `localhost:${port}`];

  const transport = new WebSocketTransport({
    // Refuse any upgrade whose Origin is not this server, and one with none.
    verifyClient: (info: { origin?: string }) => info.origin !== undefined && origins().includes(info.origin),
  });

  const server = new Server({
    transport,
    greet: false,
    express: (app) => {
      app.use((req, res, next) => {
        if (hosts().includes(req.headers.host ?? "")) return next();
        res.status(421).type("text/plain").send("wrong host");
      });
      app.get("/", (_req, res) => {
        // Read on every request, so editing the page needs no restart.
        const html = readFileSync(CLIENT_HTML, "utf8");
        res
          .set({
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": contentSecurityPolicy(html, port),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cache-Control": "no-store",
          })
          .send(html);
      });
      app.get("/vendor/colyseus.js", (_req, res) => {
        res
          .set({
            "Content-Type": "text/javascript; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          })
          .send(readFileSync(SDK_BUNDLE, "utf8"));
      });
    },
  });
  server.define("kauda", defineKaudaRoom({ identity: devIdentityStub(), ...options.room }));

  // Matchmaking CORS: answer only our own origin. Anything else is told our
  // origin, which never matches, so the browser blocks it.
  matchMaker.controller.getCorsHeaders = (headers: Headers) => {
    const origin = headers.get("origin");
    return {
      "Access-Control-Allow-Origin": origin !== null && origins().includes(origin) ? origin : (origins()[0] ?? ""),
      Vary: "Origin",
    };
  };

  // Colyseus logs a listen error (such as a port in use) but does not reject,
  // so watch the HTTP server's own error event as well.
  await new Promise<void>((resolve, reject) => {
    transport.server?.once("error", reject);
    server.listen(options.port ?? DEFAULT_DEV_PORT, DEV_HOST).then(() => resolve(), reject);
  });
  port = (transport.server?.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://${DEV_HOST}:${port}/`,
    close: () => server.gracefullyShutdown(false),
  };
}
