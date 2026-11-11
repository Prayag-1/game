import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { matchMaker } from "@colyseus/core";
import { Client, type Room as SDKRoom } from "@colyseus/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openChipStore } from "../src/db/open.js";
import type { DrizzleChipStore } from "../src/db/store.js";
import { DEV_HOST, startDevServer, type DevServer } from "../src/devServer.js";
import { CODE_ALPHABET, newTableCode, parseTableCode, type TableInfo } from "../src/lobby/directory.js";
import { DEFAULT_EMPTY_TIMEOUT_MS, MOVED_CLOSE_CODE, SESSION_ENDED_CLOSE_CODE } from "../src/room.js";

/**
 * The lobby end to end: the real dev server, real HTTP and WebSockets, a
 * fresh in-memory PGlite, and one fake clock shared by the sessions, the
 * rate limits and the tables. Every table is torn down between tests, so
 * each starts with an empty lobby.
 */
let t = Date.UTC(2026, 10, 1);
let store: DrizzleChipStore;
let dev: DevServer;
const GUESSES = { perSession: 5, perIp: 8, windowMs: 10 * 60_000 };

beforeAll(async () => {
  store = await openChipStore({ dataDir: null });
  dev = await startDevServer({
    port: 0,
    store,
    auth: { secret: randomBytes(32), turnstileSiteKey: "k", turnstile: { verify: async () => true }, now: () => t },
    lobby: { codeGuesses: GUESSES },
    room: { now: () => t, tickMs: 20 },
  });
});
afterAll(async () => {
  await dev.close();
  await store.close();
});
// A fresh rate-limit window for each test.
beforeEach(() => {
  t += 60 * 60_000;
});
const open: SDKRoom[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) r.removeAllListeners();
  await Promise.all(matchMaker.disconnectAll());
  await until(() => dev.directory.publicTables().length === 0, "every table to be disposed");
});

const own = () => `http://${DEV_HOST}:${dev.port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown> | null;
}
function http(method: string, path: string, cookie?: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Origin: own() };
    if (cookie !== undefined) headers.Cookie = cookie;
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(text));
    }
    const req = request({ host: DEV_HOST, port: dev.port, path, method, headers }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (out += c));
      res.on("end", () => {
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(out) as Record<string, unknown>;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

interface Player {
  readonly id: string;
  readonly cookie: string;
}
let guestNo = 0;
async function guest(): Promise<Player> {
  const g = await dev.sessions.createGuest(`Guest ${++guestNo}`, 2_000);
  return { id: g.accountId, cookie: g.setCookie.split(";")[0] ?? "" };
}

const tables = async (): Promise<TableInfo[]> => ((await http("GET", "/tables")).json?.tables ?? []) as TableInfo[];

/** POSTs a seat request and, if it worked, connects with the reservation and waits to be welcomed. */
async function seat(p: Player, path: string, body: unknown = {}): Promise<{ reply: Reply; room: SDKRoom }> {
  const reply = await http("POST", path, p.cookie, body);
  expect(reply.status, `${path}: ${JSON.stringify(reply.json)}`).toBeLessThan(300);
  const client = new Client(own(), { headers: { Origin: own(), Cookie: p.cookie } });
  const room = await client.consumeSeatReservation(reply.json?.reservation as never);
  room.reconnection.enabled = false;
  open.push(room);
  const welcomed = new Promise<string>((resolve) => room.onMessage("welcome", (m: { playerId: string }) => resolve(m.playerId)));
  for (const type of ["view", "round", "error", "topUp", "replaced", "paused", "ended"]) room.onMessage(type, () => {});
  room.send("sync");
  expect(await welcomed).toBe(p.id);
  return { reply, room };
}

const tableIdOf = (reply: Reply): string => String((reply.json?.table as TableInfo | undefined)?.id);

describe("table codes", () => {
  it("are 6 characters from an alphabet with no 0, O, 1, I or l", () => {
    for (const bad of ["0", "O", "1", "I", "l"]) expect(CODE_ALPHABET).not.toContain(bad);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const code = newTableCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(495);
    expect(parseTableCode(" abcdef ")).toBe("ABCDEF");
    expect(parseTableCode("ABCDE0")).toBeNull();
    expect(parseTableCode(42)).toBeNull();
  });
});

describe("public tables and Quick Play", () => {
  it("fills a table that has humans before an empty one, and never lists more than it should", async () => {
    const a = await guest();
    const first = await seat(a, "/tables/quickplay");
    const occupied = tableIdOf(first.reply);
    const empty = (await dev.directory.create("public", "default")).room.roomId;
    const b = await guest();
    const second = await seat(b, "/tables/quickplay");
    expect(tableIdOf(second.reply)).toBe(occupied); // not the empty one
    const list = await tables();
    expect(list.map((x) => x.id)).toEqual([occupied, empty]); // most humans first
    expect(list[0]).toMatchObject({ humans: 2, preset: "default", phase: expect.any(String), stake: expect.any(Number) });
    expect(list[0]?.bots).toBeGreaterThanOrEqual(0);
    expect(list[1]).toMatchObject({ humans: 0 });
  });

  it("skips a full table and makes a new one", async () => {
    const a = await guest();
    const full = tableIdOf((await seat(a, "/tables/quickplay")).reply);
    // Fill it to the last place a human can take.
    for (let i = 0; i < 20; i += 1) {
      const room = (await tables()).find((x) => x.id === full)?.room ?? 0;
      if (room === 0) break;
      const r = await seat(await guest(), "/tables/quickplay");
      expect(tableIdOf(r.reply)).toBe(full);
    }
    expect((await tables()).find((x) => x.id === full)?.room).toBe(0);
    const x = await guest();
    const next = tableIdOf((await seat(x, "/tables/quickplay")).reply);
    expect(next).not.toBe(full);
    expect((await tables()).map((tb) => tb.id).sort()).toEqual([full, next].sort());
    // Joining the full one by id is refused, not squeezed in.
    expect((await http("POST", "/tables/public/join", (await guest()).cookie, { tableId: full })).status).toBe(409);
  });
});

describe("private tables", () => {
  it("never appear in the list or in Quick Play, and cannot be joined by id", async () => {
    const c = await guest();
    const created = await seat(c, "/tables/private", { preset: "simple" });
    expect(created.reply.status).toBe(201);
    const privateId = tableIdOf(created.reply);
    const code = String(created.reply.json?.code);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(created.reply.json?.shareUrl).toBe(`${own()}/?code=${code}`);
    expect(created.reply.json?.table).toMatchObject({ visibility: "private", preset: "simple" });
    expect(await tables()).toEqual([]);
    // Quick Play makes a public table rather than use the private one with room.
    const d = await guest();
    const quick = tableIdOf((await seat(d, "/tables/quickplay")).reply);
    expect(quick).not.toBe(privateId);
    expect((await tables()).map((x) => x.id)).toEqual([quick]);
    expect(await http("POST", "/tables/public/join", (await guest()).cookie, { tableId: privateId })).toMatchObject({
      status: 404,
      json: { error: "not-found" },
    });
  });

  it("joins with the right code, gives a plain 404 for a wrong one, and stops a guess storm", async () => {
    const e = await guest();
    const created = await seat(e, "/tables/private", { preset: "default" });
    const code = String(created.reply.json?.code);
    const wrong = code.slice(0, 5) + (code.endsWith("A") ? "B" : "A");
    const f = await guest();
    for (const guess of [wrong, "abc", "0OOOOO"]) {
      expect(await http("POST", "/tables/join", f.cookie, { code: guess })).toEqual({ status: 404, json: { error: "not-found" } });
    }
    const joined = await seat(f, "/tables/join", { code: code.toLowerCase() }); // case does not matter
    expect(tableIdOf(joined.reply)).toBe(tableIdOf(created.reply));
    // Per session: F has used 4 of 5 guesses; the 6th is refused, right code or not.
    expect((await http("POST", "/tables/join", f.cookie, { code: wrong })).status).toBe(404);
    expect(await http("POST", "/tables/join", f.cookie, { code })).toEqual({ status: 429, json: { error: "too-many-guesses" } });
    // Per IP: fresh sessions from the same address run into it too.
    let refused = 0;
    for (let i = 0; i < 6; i += 1) {
      if ((await http("POST", "/tables/join", (await guest()).cookie, { code: wrong })).status === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("loses its code when the table is disposed, after 10 minutes empty", async () => {
    const g = await guest();
    const created = await seat(g, "/tables/private", { preset: "default" });
    const code = String(created.reply.json?.code);
    await created.room.leave(true);
    await until(() => (dev.directory.byCode(code)?.emptySince ?? null) !== null, "the table to notice it is empty");
    t += DEFAULT_EMPTY_TIMEOUT_MS.private - 5_000;
    await sleep(150);
    expect(dev.directory.byCode(code)).not.toBeNull(); // a public table would be gone by now
    t += 10_000;
    await until(() => dev.directory.byCode(code) === null, "the private table to be disposed");
    expect(await http("POST", "/tables/join", (await guest()).cookie, { code })).toEqual({ status: 404, json: { error: "not-found" } });
  });
});

describe("table lifetime", () => {
  it("disposes an empty public table after 2 minutes", async () => {
    const a = await guest();
    const { reply, room } = await seat(a, "/tables/quickplay");
    const id = tableIdOf(reply);
    await room.leave(true);
    await until(() => (dev.directory.publicById(id)?.emptySince ?? null) !== null, "the table to notice it is empty");
    t += DEFAULT_EMPTY_TIMEOUT_MS.public - 5_000;
    await sleep(150);
    expect((await tables()).map((x) => x.id)).toEqual([id]); // bots alone, but not yet timed out
    t += 10_000;
    await until(() => dev.directory.publicById(id) === null, "the empty table to be disposed");
    expect(await tables()).toEqual([]);
  });
});

describe("one table per player", () => {
  it("leaves the first table when joining a second", async () => {
    const a = await guest();
    const first = await seat(a, "/tables/quickplay");
    const firstId = tableIdOf(first.reply);
    const closed = new Promise<number>((resolve) => first.room.onLeave((code) => resolve(code)));
    const second = await seat(a, "/tables/private", { preset: "default" });
    expect(await closed).toBe(MOVED_CLOSE_CODE);
    expect(dev.directory.publicById(firstId)?.table.hasPlayer(a.id)).toBe(false);
    expect(dev.directory.tableOf(a.id)?.roomId).toBe(tableIdOf(second.reply));
  });
});

describe("logout", () => {
  it("disconnects every open table connection of the account at once", async () => {
    const a = await guest();
    const { reply, room } = await seat(a, "/tables/quickplay");
    const closed = new Promise<number>((resolve) => room.onLeave((code) => resolve(code)));
    expect((await http("POST", "/session/logout", a.cookie, {})).status).toBe(204);
    expect(await closed).toBe(SESSION_ENDED_CLOSE_CODE);
    expect(dev.directory.publicById(tableIdOf(reply))?.table.hasPlayer(a.id)).toBe(false);
    // And the revoked session cannot take a seat again.
    expect((await http("POST", "/tables/rejoin", a.cookie, {})).status).toBe(401);
    expect((await http("POST", "/tables/quickplay", a.cookie, {})).status).toBe(401);
  });
});
