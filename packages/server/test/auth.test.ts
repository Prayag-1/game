import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Room as SDKRoom } from "@colyseus/sdk";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSessionSecret } from "../src/auth/secret.js";
import { SESSION_TTL_MS } from "../src/auth/sessions.js";
import { SITEVERIFY_URL, cloudflareTurnstile, type TurnstileVerifier } from "../src/auth/turnstile.js";
import { openChipStore } from "../src/db/open.js";
import type { DrizzleChipStore } from "../src/db/store.js";
import { DEV_HOST, startDevServer, type DevServer } from "../src/devServer.js";
import { MINT_ACCOUNT } from "../src/index.js";

/**
 * Guest sessions end to end: the real dev server, real HTTP and WebSockets,
 * a fresh in-memory PGlite, a fake clock, and a Turnstile verifier that
 * accepts only "good-token" (the real one is tested on its own below).
 */
let t = Date.UTC(2026, 10, 1);
const GUESTS_PER_HOUR = 3;
const turnstileCalls: { token: string; ip: string | undefined }[] = [];
const fakeTurnstile: TurnstileVerifier = {
  async verify(token, ip) {
    turnstileCalls.push({ token, ip });
    return token === "good-token";
  },
};

let store: DrizzleChipStore;
let dev: DevServer;

beforeAll(async () => {
  store = await openChipStore({ dataDir: null });
  dev = await startDevServer({
    port: 0,
    store,
    auth: { secret: randomBytes(32), turnstileSiteKey: "test-site-key", turnstile: fakeTurnstile, guestsPerHour: GUESTS_PER_HOUR, now: () => t },
    room: { tickMs: 20 },
  });
});
afterAll(async () => {
  await dev.close();
  await store.close();
});
// Each test starts in a fresh rate-limit hour.
beforeEach(() => {
  t += 2 * 60 * 60 * 1000;
});

const own = () => `http://${DEV_HOST}:${dev.port}`;

interface Reply {
  readonly status: number;
  readonly setCookie: string | undefined;
  readonly json: Record<string, unknown> | null;
}

function http(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string | null; type?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.origin !== null) headers.Origin = opts.origin ?? own();
    if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) {
      headers["Content-Type"] = opts.type ?? "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const req = request({ host: DEV_HOST, port: dev.port, path, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => {
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          json = null;
        }
        const sc = res.headers["set-cookie"];
        resolve({ status: res.statusCode ?? 0, setCookie: Array.isArray(sc) ? sc[0] : sc, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** "name=value" from a Set-Cookie header, for sending back. */
const cookieOf = (setCookie: string | undefined): string => (setCookie ?? "").split(";")[0] ?? "";

async function guest(name: string): Promise<{ cookie: string; id: string; reply: Reply }> {
  const reply = await http("POST", "/session/guest", { body: { name, turnstileToken: "good-token" } });
  expect(reply.status).toBe(201);
  return { cookie: cookieOf(reply.setCookie), id: String(reply.json?.id), reply };
}

async function rows<T>(q: SQL): Promise<T[]> {
  return ((await store.db.execute(q)) as unknown as { rows: T[] }).rows;
}

/** An SDK client that sends this cookie (and our Origin) on every request and the socket. */
function sdk(cookie?: string): Client {
  return new Client(own(), { headers: { Origin: own(), ...(cookie === undefined ? {} : { Cookie: cookie }) } });
}

async function welcomeOf(room: SDKRoom): Promise<string> {
  return new Promise((resolve) => {
    room.onMessage("welcome", (m: { playerId: string }) => resolve(m.playerId));
    for (const type of ["view", "round", "error", "topUp", "replaced", "paused"]) room.onMessage(type, () => {});
    room.send("sync");
  });
}

describe("guest creation", () => {
  it("sets a valid signed cookie and creates an account funded from the mint", async () => {
    const mintBefore = await store.balanceOf(MINT_ACCOUNT);
    const { reply, cookie, id } = await guest("Asha");
    expect(reply.json).toMatchObject({ name: "Asha", balance: 2000 });
    // httpOnly, SameSite=Lax, Path=/, 90 days; not Secure over plain HTTP in dev.
    expect(reply.setCookie).toMatch(/^kauda_session=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; /);
    expect(reply.setCookie).toContain("HttpOnly");
    expect(reply.setCookie).toContain("SameSite=Lax");
    expect(reply.setCookie).toContain("Path=/");
    expect(reply.setCookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(reply.setCookie).not.toContain("Secure");
    // The cookie works.
    expect((await http("GET", "/session/me", { cookie })).json).toEqual({ id, name: "Asha", balance: 2000 });
    // Funded from the mint, as a human buy-in.
    expect(await store.balanceOf(id)).toBe(2000);
    expect(await store.balanceOf(MINT_ACCOUNT)).toBe((mintBefore ?? 0) - 2000);
    const [account] = await rows<{ kind: string }>(sql`SELECT kind FROM accounts WHERE id = ${id}`);
    expect(account?.kind).toBe("human");
    // Only the hash of the session id is stored.
    const raw = Buffer.from(cookie.split("=")[1]?.split(".")[0] ?? "", "base64url");
    const stored = await rows<{ id: string }>(sql`SELECT id FROM sessions WHERE account_id = ${id}`);
    expect(stored).toEqual([{ id: createHash("sha256").update(raw).digest("hex") }]);
    expect(JSON.stringify(stored)).not.toContain(raw.toString("hex"));
    expect((await store.verify()).ok).toBe(true);
  });

  it("refuses a bad Turnstile token, and creates nothing", async () => {
    const before = await rows<{ n: string }>(sql`SELECT COUNT(*) AS n FROM accounts`);
    const reply = await http("POST", "/session/guest", { body: { name: "Bina", turnstileToken: "forged" } });
    expect(reply).toMatchObject({ status: 400, json: { error: "turnstile-failed" } });
    expect(reply.setCookie).toBeUndefined();
    expect(turnstileCalls.at(-1)).toEqual({ token: "forged", ip: "127.0.0.1" });
    expect(await rows<{ n: string }>(sql`SELECT COUNT(*) AS n FROM accounts`)).toEqual(before);
  });

  it("refuses a name that breaks the rules, rather than renaming it", async () => {
    for (const name of ["<b>x</b>", "ab", "Ha​ri", "x".repeat(21)]) {
      t += 2 * 60 * 60 * 1000;
      const reply = await http("POST", "/session/guest", { body: { name, turnstileToken: "good-token" } });
      expect(reply, name).toMatchObject({ status: 400, json: { error: "bad-name" } });
    }
  });

  it("refuses the N+1th guest from one IP within the hour", async () => {
    for (let i = 0; i < GUESTS_PER_HOUR; i += 1) await guest(`Rate ${i}`);
    const refused = await http("POST", "/session/guest", { body: { name: "Rate X", turnstileToken: "good-token" } });
    expect(refused).toMatchObject({ status: 429, json: { error: "too-many-guests" } });
    t += 60 * 60 * 1000 + 1; // an hour later the window has moved on
    await guest("Rate Y");
  });

  it("refuses state changes from another origin, or without a JSON body", async () => {
    const body = { name: "Chet", turnstileToken: "good-token" };
    expect((await http("POST", "/session/guest", { body, origin: "http://evil.example" })).status).toBe(403);
    expect((await http("POST", "/session/guest", { body, origin: null })).status).toBe(403);
    expect((await http("POST", "/session/guest", { body, type: "text/plain" })).status).toBe(415);
    expect((await http("POST", "/session/logout", { body: {}, origin: "http://evil.example" })).status).toBe(403);
  });
});

describe("sessions", () => {
  it("rejects a tampered cookie signature, or a tampered id", async () => {
    const { cookie } = await guest("Dipa");
    const [name, value] = cookie.split("=") as [string, string];
    const [id, mac] = value.split(".") as [string, string];
    const flip = (s: string) => s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.slice(-1);
    for (const bad of [`${id}.${flip(mac)}`, `${flip(id)}.${mac}`, `${id}.${id}`, "garbage", `${id}.`]) {
      expect((await http("GET", "/session/me", { cookie: `${name}=${bad}` })).status, bad).toBe(401);
    }
    expect((await http("GET", "/session/me", { cookie })).status).toBe(200);
  });

  it("rejects a revoked session after logout, and clears the cookie", async () => {
    const { cookie } = await guest("Esha");
    const out = await http("POST", "/session/logout", { body: {}, cookie });
    expect(out.status).toBe(204);
    expect(out.setCookie).toMatch(/^kauda_session=; .*Max-Age=0/);
    expect((await http("GET", "/session/me", { cookie })).status).toBe(401);
    const [row] = await rows<{ revoked: boolean }>(
      sql`SELECT revoked_at IS NOT NULL AS revoked FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.display_name = 'Esha'`,
    );
    expect(row?.revoked).toBe(true);
  });

  it("rejects an expired session, and slides the expiry while it is used", async () => {
    const idle = await guest("Gita");
    const used = await guest("Hari");
    t += SESSION_TTL_MS - 24 * 60 * 60 * 1000; // day 89
    expect((await http("GET", "/session/me", { cookie: used.cookie })).status).toBe(200); // slides
    t += 2 * 24 * 60 * 60 * 1000; // day 91
    expect((await http("GET", "/session/me", { cookie: idle.cookie })).status).toBe(401);
    expect((await http("GET", "/session/me", { cookie: used.cookie })).status).toBe(200);
  });
});

describe("joining a room", () => {
  it("refuses a join with no session, and resolves a valid one to its account", async () => {
    await expect(sdk().joinOrCreate("kauda", {})).rejects.toThrow(/identity/);
    // A token in the join options is ignored entirely.
    await expect(sdk().joinOrCreate("kauda", { token: "anything", playerId: "guest:x" })).rejects.toThrow(/identity/);
    const { cookie, id } = await guest("Indra");
    const room = await sdk(cookie).joinOrCreate("kauda", {});
    room.reconnection.enabled = false;
    expect(await welcomeOf(room)).toBe(id);
    await room.leave(true);
  });

  it("replaces the first connection when the same session connects again", async () => {
    const { cookie, id } = await guest("Jamuna");
    const first = await sdk(cookie).joinOrCreate("kauda", {});
    first.reconnection.enabled = false;
    expect(await welcomeOf(first)).toBe(id);
    const closed = new Promise<number>((resolve) => first.onLeave((code) => resolve(code)));
    const second = await sdk(cookie).joinById(first.roomId, {});
    second.reconnection.enabled = false;
    expect(await welcomeOf(second)).toBe(id);
    expect(await closed).toBe(4100);
    await second.leave(true);
  });
});

describe("logs", () => {
  it("never contain a session id, through a whole flow", async () => {
    const captured: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    for (const m of methods) console[m] = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return outWrite(chunk as string, ...(rest as []));
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return errWrite(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;
    let cookie = "";
    try {
      ({ cookie } = await guest("Kamal"));
      await http("GET", "/session/me", { cookie });
      const room = await sdk(cookie).joinOrCreate("kauda", {});
      room.reconnection.enabled = false;
      await welcomeOf(room);
      room.send("command", { type: "sit", seat: "teeya" });
      room.send("bogus", {});
      await new Promise((r) => setTimeout(r, 200));
      await room.leave(true);
      await http("GET", "/session/me", { cookie: cookie.replace(/.$/, "x") }); // a tampered one too
      await http("POST", "/session/logout", { body: {}, cookie });
      await http("GET", "/session/me", { cookie }); // and a revoked one
    } finally {
      methods.forEach((m, i) => (console[m] = originals[i] as (typeof console)[typeof m]));
      process.stdout.write = outWrite;
      process.stderr.write = errWrite;
    }
    const value = cookie.split("=")[1] ?? "";
    const idPart = value.split(".")[0] ?? "";
    const rawHex = Buffer.from(idPart, "base64url").toString("hex");
    expect(idPart).toHaveLength(43);
    const all = captured.join("\n");
    for (const secret of [value, idPart, rawHex]) expect(all).not.toContain(secret);
  });
});

describe("Turnstile verification", () => {
  it("asks Cloudflare's siteverify, and fails closed", async () => {
    const seen: { url: string; body: string }[] = [];
    const reply = (status: number, json: unknown) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify(json), { status });
      }) as typeof fetch;
    expect(await cloudflareTurnstile({ secretKey: "sk", fetch: reply(200, { success: true }) }).verify("tok", "1.2.3.4")).toBe(true);
    expect(seen[0]?.url).toBe(SITEVERIFY_URL);
    expect(new URLSearchParams(seen[0]?.body)).toEqual(new URLSearchParams({ secret: "sk", response: "tok", remoteip: "1.2.3.4" }));
    expect(await cloudflareTurnstile({ secretKey: "sk", fetch: reply(200, { success: false }) }).verify("tok", undefined)).toBe(false);
    expect(await cloudflareTurnstile({ secretKey: "sk", fetch: reply(500, { success: true }) }).verify("tok", undefined)).toBe(false);
    const broken = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await cloudflareTurnstile({ secretKey: "sk", fetch: broken }).verify("tok", undefined)).toBe(false);
    expect(await cloudflareTurnstile({ secretKey: "sk", fetch: reply(200, { success: true }) }).verify("", undefined)).toBe(false);
  });
});

describe("the signing key", () => {
  it("comes from KAUDA_SESSION_SECRET, is required in production, and is kept on disk only in development", () => {
    const dir = mkdtempSync(join(tmpdir(), "kauda-secret-"));
    try {
      const file = join(dir, "session-secret");
      const hex = randomBytes(32).toString("hex");
      expect(loadSessionSecret({ KAUDA_SESSION_SECRET: hex }, file).secret.toString("hex")).toBe(hex);
      expect(() => loadSessionSecret({ KAUDA_SESSION_SECRET: "short" }, file)).toThrow();
      expect(() => loadSessionSecret({ NODE_ENV: "production" }, file)).toThrow(/required in production/);
      const made = loadSessionSecret({}, file);
      expect(readFileSync(file, "utf8")).toBe(made.secret.toString("hex"));
      expect(loadSessionSecret({}, file).secret.equals(made.secret)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
