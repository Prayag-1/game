import { z } from "zod";
import type { RateLimiter } from "../auth/rateLimit.js";
import type { Sessions } from "../auth/sessions.js";
import { NO_STORE, header, readJsonBody, stateChangeAllowed, type Req, type Res, type RouteApp } from "../httpRoutes.js";
import type { KaudaRoom } from "../room.js";
import { parseTableCode, type TableDirectory, type TableInfo } from "./directory.js";

/**
 * The lobby routes. Every route but the list needs a session, and every
 * state change needs an allowed Origin and a JSON body.
 *
 *   GET  /tables                 { tables: TableInfo[] }  public tables only
 *   POST /tables/quickplay       {}                -> { reservation, table }
 *   POST /tables/public/join     { tableId }       -> { reservation, table }
 *   POST /tables/private         { preset }        -> 201 { code, shareUrl, reservation, table }
 *   POST /tables/join            { code }          -> { reservation, table, code }
 *   POST /tables/rejoin          {}                -> { reservation, table }, or 404
 *
 * A reservation is a seat held for this account only, which the client
 * takes with the Colyseus SDK's consumeSeatReservation(); the room checks the
 * session cookie on the WebSocket upgrade and that it is the same account.
 * Taking a seat at one table first leaves any other (TableDirectory.release).
 *
 * A wrong code is a plain 404, the same as a malformed one: no hint. Code
 * guesses are rate-limited per IP and per session, and every guess counts.
 */

export interface TableRouteDeps {
  readonly sessions: Sessions;
  readonly directory: TableDirectory;
  /** Code guesses per IP, and per session. */
  readonly codeGuessesPerIp: RateLimiter;
  readonly codeGuessesPerSession: RateLimiter;
  /** Private tables created per session. */
  readonly privateTablesPerSession: RateLimiter;
  allowedOrigins(): readonly string[];
}

const Empty = z.strictObject({});
const PublicJoin = z.strictObject({ tableId: z.string().min(1).max(64) });
const CreatePrivate = z.strictObject({ preset: z.enum(["default", "simple"]) });
const JoinByCode = z.strictObject({ code: z.string().max(32) });

export function mountTableRoutes(app: RouteApp, deps: TableRouteDeps): void {
  const fail = (res: Res, status: number, error: string) => void res.status(status).set(NO_STORE).json({ error });

  /** The account behind the session cookie, after the state-change checks. Answers and returns null if none. */
  const begin = async <T>(req: Req, res: Res, schema: z.ZodType<T>): Promise<{ accountId: string; body: T } | null> => {
    if (!stateChangeAllowed(req, res, deps.allowedOrigins())) return null;
    const session = await deps.sessions.resolve(header(req, "cookie"));
    if (session === null) return void fail(res, 401, "no-session"), null;
    const body = schema.safeParse(await readJsonBody(req));
    if (!body.success) return void fail(res, 400, "malformed"), null;
    return { accountId: session.accountId, body: body.data };
  };

  /** Leaves any other table, then reserves a seat at this one. */
  const seat = async (res: Res, accountId: string, room: KaudaRoom, extra: Record<string, unknown> = {}, status = 200) => {
    const alreadyHere = room.table.hasPlayer(accountId);
    if (!alreadyHere && !deps.directory.hasRoom(room)) return fail(res, 409, "table-full");
    if (!(await deps.directory.release(accountId, room))) return fail(res, 409, "still-leaving-previous-table");
    if (room.paused !== null) return fail(res, 409, "table-paused");
    const reservation = await deps.directory.reserve(room, accountId);
    res.status(status).set(NO_STORE).json({ ...extra, reservation, table: deps.directory.info(room) satisfies TableInfo });
  };

  app.get("/tables", (_req, res) => {
    res.status(200).set(NO_STORE).json({ tables: deps.directory.publicTables() });
  });

  app.post("/tables/quickplay", async (req, res) => {
    const who = await begin(req, res, Empty);
    if (who === null) return;
    await seat(res, who.accountId, await deps.directory.quickPlay(who.accountId));
  });

  app.post("/tables/public/join", async (req, res) => {
    const who = await begin(req, res, PublicJoin);
    if (who === null) return;
    // Only public tables by id: a private table's id gets the same 404 as none.
    const room = deps.directory.publicById(who.body.tableId);
    if (room === null) return fail(res, 404, "not-found");
    await seat(res, who.accountId, room);
  });

  app.post("/tables/private", async (req, res) => {
    const who = await begin(req, res, CreatePrivate);
    if (who === null) return;
    if (!deps.privateTablesPerSession.take(who.accountId)) return fail(res, 429, "too-many-tables");
    const { room, code } = await deps.directory.create("private", who.body.preset);
    if (code === null) throw new Error("a private table always has a code");
    await seat(res, who.accountId, room, { code, shareUrl: shareUrl(req, deps, code) }, 201);
  });

  app.post("/tables/join", async (req, res) => {
    if (!stateChangeAllowed(req, res, deps.allowedOrigins())) return;
    const session = await deps.sessions.resolve(header(req, "cookie"));
    if (session === null) return fail(res, 401, "no-session");
    // Every guess counts, right or wrong, against both the address and the session.
    const ipOk = deps.codeGuessesPerIp.take(req.socket.remoteAddress ?? "unknown");
    const sessionOk = deps.codeGuessesPerSession.take(session.accountId);
    if (!ipOk || !sessionOk) return fail(res, 429, "too-many-guesses");
    const body = JoinByCode.safeParse(await readJsonBody(req));
    const code = body.success ? parseTableCode(body.data.code) : null;
    const room = code === null ? null : deps.directory.byCode(code);
    if (room === null) return fail(res, 404, "not-found"); // no hint: wrong, malformed and dead codes look alike
    await seat(res, session.accountId, room, { code });
  });

  app.post("/tables/rejoin", async (req, res) => {
    const who = await begin(req, res, Empty);
    if (who === null) return;
    const room = deps.directory.tableOf(who.accountId);
    if (room === null || room.paused !== null) return fail(res, 404, "not-at-a-table");
    const code = deps.directory.codeOf(room);
    await seat(res, who.accountId, room, code === null ? {} : { code });
  });
}

/** The page URL that opens a private table: /?code=XXXXXX on the caller's own (allowed) origin. */
function shareUrl(req: Req, deps: TableRouteDeps, code: string): string {
  const origin = header(req, "origin") ?? deps.allowedOrigins()[0] ?? "";
  return `${origin}/?code=${code}`;
}
