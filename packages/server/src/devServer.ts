/**
 * DEVELOPER SERVER. FOR YOUR OWN MACHINE ONLY. NEVER EXPOSE IT TO A NETWORK.
 *
 * Serves the session routes (auth/http.ts), the lobby routes (lobby/http.ts),
 * the KaudaRoom and, with `web`, the built web client, on one port, bound to
 * 127.0.0.1 only.
 * Identity is a real guest session (signed cookie, hashed id in the
 * database), but this server runs over plain HTTP with Cloudflare's test
 * Turnstile keys and a dev signing key, so it is a tool, not a service.
 *
 * ONE ORIGIN, ON PURPOSE. The page, the session routes, the matchmaking
 * routes and the WebSocket all live on http://127.0.0.1:<port>. The session
 * cookie is SameSite=Lax and host-only, so a browser sends it with the
 * WebSocket upgrade only because the upgrade goes to the same host as the
 * page that holds it. Split them across ports or hosts and the room would
 * see no cookie, and every join would be refused.
 *
 * Locked to its own origin, since a web page open in the same browser can
 * still try to reach a server on localhost:
 * - the websocket upgrade is refused unless Origin is this server's own
 *   (SECURITY.md: "CSRF and cross-origin websockets"), including no Origin;
 * - matchmaking CORS answers only this server's own origin, and the session
 *   routes refuse state changes from any other Origin;
 * - pages are served only for a Host of 127.0.0.1 or localhost on this
 *   port, against DNS rebinding;
 * - the page has a strict Content-Security-Policy (webClient.ts): scripts
 *   from this origin and Cloudflare's Turnstile, no inline code, no eval.
 *
 * With `web`, the built web client (packages/web/dist) is served at /.
 * Without it (`pnpm dev`), the Vite dev server serves the page instead.
 *
 * `proxyOrigins` are the origins of a dev front end that proxies to this
 * server: the Vite dev server (packages/web/vite.config.ts). Through the
 * proxy the browser's Origin header is the Vite page's, so the Origin checks
 * above accept those as well. Nothing else is relaxed, and there is no CORS.
 */
import type { AddressInfo } from "node:net";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { DEFAULT_HOUSE_RULES } from "@kauda/rules";
import { mountSessionRoutes, sessionIdentity } from "./auth/http.js";
import { RateLimiter } from "./auth/rateLimit.js";
import { Sessions } from "./auth/sessions.js";
import type { TurnstileVerifier } from "./auth/turnstile.js";
import type { DrizzleChipStore } from "./db/store.js";
import type { RouteApp } from "./httpRoutes.js";
import { TableDirectory } from "./lobby/directory.js";
import { mountTableRoutes } from "./lobby/http.js";
import { defineKaudaRoom, type KaudaRoomDeps } from "./room.js";
import { defaultBotBuyIn } from "./table.js";
import { webClient, wsOriginsOf } from "./webClient.js";

/** The only address the dev server ever binds. */
export const DEV_HOST = "127.0.0.1";
export const DEFAULT_DEV_PORT = 3000;
export const DEFAULT_GUESTS_PER_HOUR = 5;
/** Table code guesses allowed per 10 minutes: per IP, and per session. */
export const DEFAULT_CODE_GUESSES = { perIp: 30, perSession: 10, windowMs: 10 * 60_000 } as const;
export const DEFAULT_PRIVATE_TABLES_PER_HOUR = 10;

export interface DevServerOptions {
  /** 0 picks a free port. */
  readonly port?: number;
  /** The database: chips, and the sessions table. */
  readonly store: DrizzleChipStore;
  readonly auth: {
    /** Signs session cookies; at least 32 bytes. */
    readonly secret: Buffer;
    readonly turnstileSiteKey: string;
    readonly turnstile: TurnstileVerifier;
    /** Guest creations per IP per hour. */
    readonly guestsPerHour?: number;
    readonly now?: () => number;
  };
  /** Lobby limits, for tests. */
  readonly lobby?: {
    readonly codeGuesses?: { readonly perIp?: number; readonly perSession?: number; readonly windowMs?: number };
    readonly privateTablesPerHour?: number;
  };
  /** Overrides for the room, for tests. */
  readonly room?: Partial<KaudaRoomDeps>;
  /** Serve the built web client from this directory at /. */
  readonly web?: { readonly distDir: string };
  /** Origins of a dev front end that proxies to this server, such as http://127.0.0.1:5173. */
  readonly proxyOrigins?: readonly string[];
}

export interface DevServer {
  readonly server: Server;
  readonly sessions: Sessions;
  readonly directory: TableDirectory;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  let port = -1; // known once listening
  const ownOrigins = (): readonly string[] => [`http://${DEV_HOST}:${port}`, `http://localhost:${port}`];
  const proxyOrigins = options.proxyOrigins ?? [];
  for (const o of proxyOrigins) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(o)) throw new Error(`proxy origin must be http://127.0.0.1 or localhost with a port: ${o}`);
  }
  const origins = (): readonly string[] => [...ownOrigins(), ...proxyOrigins];
  const web = options.web === undefined ? null : webClient({ distDir: options.web.distDir, wsOrigins: () => wsOriginsOf(ownOrigins()) });
  const hosts = (): readonly string[] => [`${DEV_HOST}:${port}`, `localhost:${port}`];

  // Plain HTTP on 127.0.0.1, so the cookie cannot be Secure here. Production
  // serves over HTTPS with secure: true.
  const sessions = new Sessions(options.store.db, {
    secret: options.auth.secret,
    secure: false,
    ...(options.auth.now === undefined ? {} : { now: options.auth.now }),
  });
  const rules = options.room?.table?.rules ?? DEFAULT_HOUSE_RULES;
  const buyIn = options.room?.table?.standardBuyIn ?? defaultBotBuyIn(rules);
  const directory = new TableDirectory("kauda", options.room?.now ?? options.auth.now);
  const guesses = { ...DEFAULT_CODE_GUESSES, ...options.lobby?.codeGuesses };
  const now = options.auth.now;

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
      if (web !== null) app.use((req, res, next) => web.handle(req, res, next));
      mountSessionRoutes(app as unknown as RouteApp, {
        db: options.store.db,
        sessions,
        turnstile: options.auth.turnstile,
        turnstileSiteKey: options.auth.turnstileSiteKey,
        guestLimiter: new RateLimiter(options.auth.guestsPerHour ?? DEFAULT_GUESTS_PER_HOUR, 60 * 60 * 1000, now),
        buyIn,
        allowedOrigins: origins,
        onLogout: (accountId) => directory.endAccount(accountId),
      });
      mountTableRoutes(app as unknown as RouteApp, {
        sessions,
        directory,
        codeGuessesPerIp: new RateLimiter(guesses.perIp, guesses.windowMs, now),
        codeGuessesPerSession: new RateLimiter(guesses.perSession, guesses.windowMs, now),
        privateTablesPerSession: new RateLimiter(
          options.lobby?.privateTablesPerHour ?? DEFAULT_PRIVATE_TABLES_PER_HOUR,
          60 * 60 * 1000,
          now,
        ),
        allowedOrigins: origins,
      });
    },
  });
  server.define("kauda", defineKaudaRoom({ identity: sessionIdentity(sessions), store: options.store, directory, ...options.room }));

  // Only the server reserves seats (TableDirectory, through the /tables
  // routes). Colyseus's own client matchmaking routes would let anyone create
  // a room, or join one by id or by name, around private codes and the
  // one-table rule, so none of them is exposed.
  matchMaker.controller.exposedMethods = [];

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
    sessions,
    directory,
    port,
    url: `http://${DEV_HOST}:${port}/`,
    close: () => server.gracefullyShutdown(false),
  };
}
