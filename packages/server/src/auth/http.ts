import { z } from "zod";
import { eq } from "drizzle-orm";
import { accounts } from "../db/schema.js";
import type { KaudaDb } from "../db/store.js";
import { NO_STORE as noStore, header, readJsonBody, stateChangeAllowed, type RouteApp } from "../httpRoutes.js";
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
  /** Called after a logout, with the account: its table connections must end now. */
  onLogout?(accountId: string): void;
}

const GuestBody = z.strictObject({
  name: z.string().max(200),
  turnstileToken: z.string().min(1).max(2048),
});

export function mountSessionRoutes(app: RouteApp, deps: SessionRouteDeps): void {
  const balanceOf = async (accountId: string): Promise<number> => {
    const [row] = await deps.db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, accountId));
    return row?.balance ?? 0;
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
    if (!stateChangeAllowed(req, res, deps.allowedOrigins())) return;
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
    if (!stateChangeAllowed(req, res, deps.allowedOrigins())) return;
    await readJsonBody(req); // drain it; logout takes no fields
    const accountId = await deps.sessions.revoke(header(req, "cookie"));
    // A revoked session must not keep playing: end its table connections now.
    if (accountId !== null) deps.onLogout?.(accountId);
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
