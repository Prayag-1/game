import { z } from "zod";
import { eq } from "drizzle-orm";
import { accounts } from "../db/schema.js";
import type { KaudaDb } from "../db/store.js";
import { normaliseDisplayName, type IdentityResolver } from "../identity.js";
import type { RateLimiter } from "./rateLimit.js";
import type { Sessions } from "./sessions.js";
import type { TurnstileVerifier } from "./turnstile.js";

/**
 * The session routes:
 *   GET  /session/config  { turnstileSiteKey }
 *   GET  /session/me      { id, name, balance }, or 401
 *   POST /session/guest   { name, turnstileToken } -> 201 { id, name, balance } + cookie
 *   POST /session/logout  revokes the session, clears the cookie -> 204
 *
 * State-changing requests must carry an Origin on the allowlist and a JSON
 * body (so a cross-site form cannot post here, and a cross-origin fetch
 * needs a preflight that CORS refuses). The rate limit is per socket peer
 * address, not X-Forwarded-For, which any client can set; behind a proxy
 * this must read the proxy's header instead.
 *
 * Responses never contain a session id except in Set-Cookie, and nothing
 * here logs one.
 */

/** The parts of an Express request and response these routes use. */
interface Req {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
  readonly socket: { readonly remoteAddress?: string | undefined };
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "error", listener: () => void): unknown;
  destroy(): unknown;
}

/** The whole JSON body, at most 4 KB. Null if it is too big or not JSON. */
const MAX_BODY_BYTES = 4 * 1024;
function readJsonBody(req: Req): Promise<unknown> {
  if (req.body !== undefined) return Promise.resolve(req.body); // already read by a framework
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: unknown) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(null);
      }
    });
    req.on("error", () => finish(null));
  });
}
interface Res {
  status(code: number): Res;
  set(headers: Record<string, string>): Res;
  json(body: unknown): void;
  end(): void;
}
type Handler = (req: Req, res: Res) => void | Promise<void>;
export interface RouteApp {
  get(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
}

export interface SessionRouteDeps {
  readonly db: KaudaDb;
  readonly sessions: Sessions;
  readonly turnstile: TurnstileVerifier;
  readonly turnstileSiteKey: string;
  /** Guest creations per IP. */
  readonly guestLimiter: RateLimiter;
  /** Chips a new guest starts with, from the mint. */
  readonly buyIn: number;
  /** Origins allowed to make state-changing requests. */
  allowedOrigins(): readonly string[];
}

const GuestBody = z.strictObject({
  name: z.string().max(200),
  turnstileToken: z.string().min(1).max(2048),
});

const header = (req: Req, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function mountSessionRoutes(app: RouteApp, deps: SessionRouteDeps): void {
  const noStore = { "Cache-Control": "no-store" };

  const balanceOf = async (accountId: string): Promise<number> => {
    const [row] = await deps.db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, accountId));
    return row?.balance ?? 0;
  };

  /** Origin on the allowlist, and a JSON body. Answers and returns false if not. */
  const stateChangeAllowed = (req: Req, res: Res): boolean => {
    const origin = header(req, "origin");
    if (origin === undefined || !deps.allowedOrigins().includes(origin)) {
      res.status(403).set(noStore).json({ error: "bad-origin" });
      return false;
    }
    if (!(header(req, "content-type") ?? "").toLowerCase().startsWith("application/json")) {
      res.status(415).set(noStore).json({ error: "json-only" });
      return false;
    }
    return true;
  };

  app.get("/session/config", (_req, res) => {
    res.status(200).set(noStore).json({ turnstileSiteKey: deps.turnstileSiteKey });
  });

  app.get("/session/me", async (req, res) => {
    const session = await deps.sessions.resolve(header(req, "cookie"));
    if (session === null) return void res.status(401).set(noStore).json({ error: "no-session" });
    res
      .status(200)
      .set({ ...noStore, "Set-Cookie": session.refresh }) // the browser's expiry slides too
      .json({ id: session.accountId, name: session.displayName, balance: await balanceOf(session.accountId) });
  });

  app.post("/session/guest", async (req, res) => {
    if (!stateChangeAllowed(req, res)) return;
    if (!deps.guestLimiter.take(req.socket.remoteAddress ?? "unknown")) {
      return void res.status(429).set(noStore).json({ error: "too-many-guests" });
    }
    const body = GuestBody.safeParse(await readJsonBody(req));
    if (!body.success) return void res.status(400).set(noStore).json({ error: "malformed" });
    // The rules from SECURITY.md. A name that fails is refused, never renamed.
    const name = normaliseDisplayName(body.data.name);
    if (name === null) return void res.status(400).set(noStore).json({ error: "bad-name" });
    if (!(await deps.turnstile.verify(body.data.turnstileToken, req.socket.remoteAddress))) {
      return void res.status(400).set(noStore).json({ error: "turnstile-failed" });
    }
    const guest = await deps.sessions.createGuest(name, deps.buyIn);
    res
      .status(201)
      .set({ ...noStore, "Set-Cookie": guest.setCookie })
      .json({ id: guest.accountId, name: guest.displayName, balance: guest.balance });
  });

  app.post("/session/logout", async (req, res) => {
    if (!stateChangeAllowed(req, res)) return;
    await readJsonBody(req); // drain it; logout takes no fields
    await deps.sessions.revoke(header(req, "cookie"));
    res.status(204).set({ ...noStore, "Set-Cookie": deps.sessions.clearCookie() }).end();
  });
}

/**
 * The room's identity, from the session cookie on the WebSocket upgrade
 * request. Nothing the client puts in its join options is read.
 */
export function sessionIdentity(sessions: Sessions): IdentityResolver {
  return {
    async resolveIdentity(request) {
      const session = await sessions.resolve(request.headers.get("cookie"));
      return session === null ? null : { playerId: session.accountId, name: session.displayName };
    },
  };
}
