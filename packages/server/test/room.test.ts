import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Server } from "@colyseus/core";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { Client as SDKClient, type Room as SDKRoom } from "@colyseus/sdk";
import { WebSocketTransport } from "@colyseus/ws-transport";
import type { SeatId } from "@kauda/rules";
import {
  DEFAULT_RECONNECT_WINDOW,
  KaudaRoom,
  REPLACED_CLOSE_CODE,
  commitmentFromSeed,
  defineKaudaRoom,
  seedForFaceCount,
  type Commitment,
  type RoundRecord,
  type TableView,
} from "../src/index.js";
import { sessionIdentity } from "../src/auth/http.js";
import { Sessions } from "../src/auth/sessions.js";
import { openChipStore } from "../src/db/open.js";
import type { IdentityResolver } from "../src/identity.js";
import type { ChipStore, DrizzleChipStore } from "../src/db/store.js";
import { lcg } from "./harness.js";

/**
 * The room runs on a fake clock: the simulation interval ticks in real time,
 * but the table only moves when a test moves `t`. So every phase change and
 * every reconnect window here happens exactly when the test says.
 */
let t = 1_000_000;
let scripted: Uint8Array[] = [];
const issuedSeeds: string[] = [];
let n = 0;
const commitments = (): Commitment => {
  const bytes = scripted.shift() ?? Uint8Array.from(createHash("sha256").update(`room-${n++}`).digest());
  issuedSeeds.push(Buffer.from(bytes).toString("hex"));
  return commitmentFromSeed(bytes);
};
/** Queues seeds for the next rounds, by face-up count. */
const queue = (...faceUps: number[]): void => {
  for (const k of faceUps) scripted.push(seedForFaceCount(k, n++));
};

/**
 * Identity is a real guest session in this file's database. The rooms are
 * defined before that database exists, so the resolver looks it up late.
 */
let sessions: Sessions;
const identity: IdentityResolver = {
  resolveIdentity: (request) => sessionIdentity(sessions).resolveIdentity(request),
};
/** One guest session per label, made on first use; the cookie to send. */
const cookies = new Map<string, string>();
async function cookieFor(label: string): Promise<string> {
  let cookie = cookies.get(label);
  if (cookie === undefined) {
    const guest = await sessions.createGuest(label, 2_000);
    cookie = guest.setCookie.split(";")[0] ?? "";
    cookies.set(label, cookie);
  }
  return cookie;
}
/** An SDK client that presents this label's session cookie, as a browser would. */
async function clientFor(label: string): Promise<SDKClient> {
  return new SDKClient("http://localhost:2568", { headers: { Cookie: await cookieFor(label) } });
}

const KaudaTestRoom = defineKaudaRoom({
  identity,
  now: () => t,
  commitments,
  botRandom: lcg(11),
  tickMs: 5,
});

let colyseus: ColyseusTestServer;
let room: KaudaRoom;

/** A fresh in-memory PGlite for this file, behind a switch that makes the next round's write fail. */
let store: DrizzleChipStore;
let failNextRound = false;
const failing: ChipStore = {
  get description() {
    return store.description;
  },
  openAccount: (i) => store.openAccount(i),
  balanceOf: (id) => store.balanceOf(id),
  lastEntryAt: (id, r) => store.lastEntryAt(id, r),
  transfer: (tr) => store.transfer(tr),
  settleRound: async (tableId, r) => {
    if (failNextRound) {
      failNextRound = false;
      throw new Error("simulated database failure");
    }
    return store.settleRound(tableId, r);
  },
  verify: () => store.verify(),
  close: async () => {},
};

beforeAll(async () => {
  store = await openChipStore({ dataDir: null });
  sessions = new Sessions(store.db, { secret: randomBytes(32), secure: false });
  // A Server instance rather than a @colyseus/tools config: tools' listen()
  // calls process.send("ready"), which breaks vitest's worker IPC channel.
  const server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define("kauda", KaudaTestRoom);
  server.define(
    "kauda-db",
    defineKaudaRoom({ identity, now: () => t, commitments, botRandom: lcg(13), tickMs: 5, store: failing }),
  );
  colyseus = await boot(server);
});
afterAll(async () => {
  await colyseus.shutdown();
  await store.close();
});
beforeEach(async () => {
  scripted = [];
  room = (await colyseus.createRoom("kauda", {})) as unknown as KaudaRoom;
});
afterEach(async () => {
  await colyseus.cleanup();
});

// ------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Moves the fake clock and lets the room run one simulation step. */
async function advance(ms: number): Promise<void> {
  t += ms;
  await nextStep();
  await nextStep();
}

/** The room's next simulation step, or a short wait if it has none (a paused room stops its loop). */
function nextStep(): Promise<void> {
  return Promise.race([room.waitForNextTimestep(), sleep(250)]).then(() => undefined);
}

/**
 * Runs the table on towards its next phase change, at most 500 ms of table
 * time per step. Real ticks are 200 ms against phases of seconds; jumping
 * further would let one tick run a throw, the reveal and the next open
 * together, which the live server never does.
 */
async function toPhaseEnd(): Promise<void> {
  const end = room.table.view().phaseEndsAt;
  const phase = room.table.phase;
  const roundNo = room.table.roundCount;
  for (let i = 0; i < 200; i += 1) {
    const left = end === null ? 1_000 : Math.max(0, end - t);
    await advance(Math.min(left, 500));
    if (room.table.phase !== phase || room.table.roundCount !== roundNo || end === null) return;
  }
}

async function toPhase(phase: TableView["phase"]): Promise<void> {
  for (let i = 0; i < 20 && room.table.phase !== phase; i += 1) await toPhaseEnd();
  expect(room.table.phase).toBe(phase);
}

/** Plays until `count` more rounds have settled. */
async function settleRounds(count = 1): Promise<void> {
  const target = room.table.roundCount + count;
  for (let i = 0; i < 40 * count && room.table.roundCount < target; i += 1) await toPhaseEnd();
  expect(room.table.roundCount).toBe(target);
}

interface Conn {
  readonly sdk: SDKRoom;
  readonly views: TableView[];
  readonly errors: string[];
  readonly rounds: RoundRecord[];
  playerId: string;
  closedWith: number | null;
  replaced: boolean;
  paused: string | null;
  view(): TableView;
}

/** Joins the current room as the guest behind this label: its session cookie, no token. */
async function connect(token: string): Promise<Conn> {
  const sdk = await (await clientFor(token)).joinById(room.roomId, {});
  // This test drops connections on purpose; the SDK must not reconnect by itself.
  sdk.reconnection.enabled = false;
  const c: Conn = {
    sdk,
    views: [],
    errors: [],
    rounds: [],
    playerId: "",
    closedWith: null,
    replaced: false,
    paused: null,
    view() {
      const v = this.views.at(-1);
      if (v === undefined) throw new Error("no view yet");
      return v;
    },
  };
  sdk.onMessage("welcome", (m: { playerId: string }) => (c.playerId = m.playerId));
  sdk.onMessage("view", (v: TableView) => c.views.push(v));
  sdk.onMessage("error", (e: string) => c.errors.push(e));
  sdk.onMessage("round", (r: RoundRecord) => c.rounds.push(r));
  sdk.onMessage("replaced", () => (c.replaced = true));
  sdk.onMessage("topUp", () => {});
  sdk.onMessage("paused", (m: { reason: string }) => (c.paused = m.reason));
  sdk.onLeave((code: number) => (c.closedWith = code));
  sdk.send("sync");
  await until(() => c.playerId !== "" && c.views.length > 0, `${token} to sync`);
  return c;
}

const send = (c: Conn, command: unknown): void => c.sdk.send("command", command);

async function drop(c: Conn): Promise<void> {
  await c.sdk.leave(false); // close the socket without saying goodbye
  await until(() => room.away().includes(c.playerId), "the server to see the drop");
}

const seatOf = (id: string): SeatId | null => room.table.seatOf(id);
const seatedHere = (v: TableView, id: string): boolean => Object.values(v.seats).some((p) => p?.playerId === id);
const presentHere = (v: TableView, id: string): boolean =>
  seatedHere(v, id) || v.chyakhe.some((p) => p.playerId === id);

/** A joins, asks for teeya, and is seated at the next round open. */
async function seatedOnTeeya(token = "token-alice"): Promise<Conn> {
  const a = await connect(token);
  await advance(0); // first open: bots fill all four seats, A reserves
  send(a, { type: "sit", seat: "teeya" });
  await until(() => room.table.view().reservations.length === 1 || seatOf(a.playerId) !== null, "A's sit");
  await settleRounds(1);
  await toPhase("betting");
  expect(seatOf(a.playerId)).toBe("teeya");
  return a;
}

// -------------------------------------------------------------------- tests

describe("KaudaRoom", () => {
  it("sends two clients the same view, with the pending seed absent", async () => {
    const a = await connect("token-alice");
    await advance(0);
    const b = await connect("token-bob");
    await until(
      () => presentHere(a.view(), b.playerId) && JSON.stringify(a.view()) === JSON.stringify(b.view()),
      "both clients to see the same view",
    );
    const v = a.view();
    expect(b.view()).toEqual(v);
    expect(v.phase).toBe("betting");
    expect(v.commitHash).toMatch(/^[0-9a-f]{64}$/);
    // Bots filled the seats from the standard policy.
    expect(Object.values(v.seats).every((p) => p?.isBot)).toBe(true);
    // No round has settled, so every seed issued so far is pending, and none
    // may appear in anything either client was sent.
    expect(room.table.roundCount).toBe(0);
    const sent = JSON.stringify([...a.views, ...b.views]);
    for (const seed of issuedSeeds) expect(sent).not.toContain(seed);
  });

  it("refuses a command carrying a forged playerId, and acts on no one", async () => {
    const a = await connect("token-alice");
    await advance(0);
    const b = await connect("token-bob");
    const before = JSON.stringify(room.table.view());
    send(a, { type: "sit", seat: "chakka", playerId: b.playerId });
    send(a, { type: "leave", playerId: b.playerId });
    await until(() => a.errors.length === 2, "both refusals");
    expect(a.errors).toEqual(["malformed", "malformed"]);
    expect(JSON.stringify(room.table.view())).toBe(before);
    expect(presentHere(room.table.view(), b.playerId)).toBe(true);
    expect(b.errors).toEqual([]);
    // The same request without the forged field acts on the sender only.
    send(a, { type: "sit", seat: "chakka" });
    await until(() => room.table.view().reservations.length === 1, "A's reservation");
    expect(room.table.view().reservations).toEqual([{ seat: "chakka", playerId: a.playerId }]);
  });

  it("lets a seated player who drops reconnect within the window to the same seat and chips", async () => {
    const a = await seatedOnTeeya();
    const chips = room.table.balance(a.playerId);
    await drop(a);
    // Still seated, still staking, marked disconnected.
    expect(seatOf(a.playerId)).toBe("teeya");
    expect(room.table.view().seats.teeya?.connected).toBe(false);
    await advance(1_000); // still the same betting phase
    const again = await connect("token-alice");
    expect(again.playerId).toBe(a.playerId);
    expect(again.view().seats.teeya).toMatchObject({ playerId: a.playerId, connected: true, chips });
    expect(room.away()).toEqual([]);
  });

  it("stands up a seated player who stays away 3 rounds, fills the seat with a bot, and keeps their chips", async () => {
    const watcher = await connect("token-watcher"); // keeps the table live
    const a = await seatedOnTeeya();
    await drop(a);
    const dropAt = room.table.roundCount;
    await settleRounds(DEFAULT_RECONNECT_WINDOW.rounds - 1);
    expect(seatOf(a.playerId)).toBe("teeya"); // still inside the window, still playing
    await settleRounds(1);
    expect(room.table.roundCount - dropAt).toBe(3);
    await until(() => !presentHere(room.table.view(), a.playerId), "A to be taken off the table");
    expect(room.away()).toEqual([]);
    await toPhase("betting");
    expect(room.table.view().seats.teeya?.isBot).toBe(true);
    // Chips intact: the buy-in plus what A won or lost while playing, nothing else.
    const played = room.table.records().reduce((acc, r) => acc + (r.deltas[a.playerId] ?? 0), 0);
    expect(room.table.balance(a.playerId)).toBe(room.table.standardBuyIn + played);
    const credits = room.table.ledger.entries().filter((e) => e.playerId === a.playerId && e.reason !== "round");
    expect(credits).toEqual([expect.objectContaining({ reason: "buyin", chips: room.table.standardBuyIn })]);
    await until(() => !presentHere(watcher.view(), a.playerId), "clients to see it");
  });

  it("also ends the window after 60 seconds, if fewer than 3 rounds have run", async () => {
    const a = await seatedOnTeeya();
    await drop(a); // the only human: the table stops opening rounds
    const dropAt = room.table.roundCount;
    await advance(DEFAULT_RECONNECT_WINDOW.ms - 1); // the round in hand plays out, then the table waits
    expect(room.table.phase).toBe("waiting");
    // One millisecond short: still away, still on the table.
    expect(room.away()).toEqual([a.playerId]);
    expect(presentHere(room.table.view(), a.playerId)).toBe(true);
    await advance(1);
    await until(() => room.away().length === 0, "the window to close");
    expect(room.table.roundCount - dropAt).toBeLessThan(3);
    expect(presentHere(room.table.view(), a.playerId)).toBe(false);
    expect(room.table.balance(a.playerId)).toBeGreaterThan(0);
  });

  it("settles the bet of a chyakhe who drops with a bet down", async () => {
    await connect("token-watcher");
    await advance(0);
    const c = await connect("token-carol");
    const v = room.table.view();
    const seat = (["chauka", "panja", "chakka", "teeya"] as const).find((s) => s !== v.thrower) ?? "panja";
    send(c, { type: "placeBet", seat, chips: 50 });
    await until(() => room.table.view().bets.length > 0, "C's bet");
    await drop(c);
    expect(room.table.view().bets).toContainEqual({ playerId: c.playerId, seat, chips: 50 });
    await settleRounds(1);
    const r = room.table.records().at(-1);
    expect(r?.chyakhe).toContainEqual({ playerId: c.playerId, seat, chips: 50 });
    expect(room.table.balance(c.playerId)).toBe(room.table.standardBuyIn + (r?.deltas[c.playerId] ?? 0));
  });

  it("resumes a dropped chyakhe's bet on reconnect", async () => {
    await connect("token-watcher");
    await advance(0);
    const c = await connect("token-carol");
    const seat = room.table.view().thrower === "panja" ? "chakka" : "panja";
    send(c, { type: "placeBet", seat, chips: 40 });
    await until(() => room.table.view().bets.length > 0, "C's bet");
    await drop(c);
    const again = await connect("token-carol");
    expect(again.playerId).toBe(c.playerId);
    expect(again.view().bets).toContainEqual({ playerId: c.playerId, seat, chips: 40 });
  });

  it("still settles the round on timeout when the thrower drops during throwing", async () => {
    queue(3); // the first round: the bot on teeya hits and keeps the throw
    const a = await seatedOnTeeya(); // A takes teeya, and with it the throw
    expect(room.table.view().thrower).toBe("teeya");
    await toPhase("throwing");
    await drop(a);
    const settled = room.table.roundCount;
    await advance(room.table.timings.throwingMs - 1);
    expect(room.table.roundCount).toBe(settled); // nobody threw
    await advance(1);
    expect(room.table.roundCount).toBe(settled + 1);
    expect(room.table.records().at(-1)?.occupants.teeya).toBe(a.playerId);
  });

  it("replaces the first connection when the same session connects again", async () => {
    const first = await connect("token-alice");
    const second = await connect("token-alice");
    expect(second.playerId).toBe(first.playerId);
    await until(() => first.closedWith !== null, "the first connection to close");
    expect(first.closedWith).toBe(REPLACED_CLOSE_CODE);
    expect(first.replaced).toBe(true);
    // The server drops the old connection a beat after the client sees it close.
    await until(() => room.clients.length === 1, "the server to drop the old connection");
    expect(room.away()).toEqual([]); // a replacement is not a disconnect
    const me = room.table.view().chyakhe.filter((p) => p.playerId === first.playerId);
    expect(me).toHaveLength(1);
    expect(me[0]?.connected).toBe(true);
    // And it still plays: commands from the new connection work.
    send(second, { type: "sit", seat: "panja" }); // mid-round, so a reservation
    await until(
      () => room.table.view().reservations.some((r) => r.playerId === second.playerId && r.seat === "panja"),
      "the new connection's reservation",
    );
  });

  it("refuses a 13th client", async () => {
    const seated = await Promise.all(["s0", "s1", "s2", "s3"].map((k) => connect(`token-${k}`)));
    await advance(0);
    (["teeya", "chauka", "panja", "chakka"] as const).forEach((seat, i) => {
      const c = seated[i];
      if (c !== undefined) send(c, { type: "sit", seat });
    });
    await until(() => room.table.view().reservations.length === 4, "four reservations");
    await settleRounds(1);
    await toPhase("betting");
    expect(Object.values(room.table.view().seats).every((p) => p !== null && !p.isBot)).toBe(true);
    for (let i = 0; i < 8; i += 1) await connect(`token-u${i}`);
    expect(room.clients).toHaveLength(12);
    await expect((await clientFor("token-thirteenth")).joinById(room.roomId, {})).rejects.toThrow();
    expect(room.clients).toHaveLength(12);
  });
});

describe("KaudaRoom with a database", () => {
  async function dbRoom(): Promise<void> {
    room = (await colyseus.createRoom("kauda-db", {})) as unknown as KaudaRoom;
  }

  it("keeps a player's chips across a restart of the table", async () => {
    await dbRoom();
    const a = await seatedOnTeeya("token-db-asha");
    await settleRounds(3);
    await room.persistence?.idle();
    const chips = room.table.balance(a.playerId);
    expect(chips).not.toBe(room.table.standardBuyIn); // A really played
    expect(await store.balanceOf(a.playerId)).toBe(chips);
    await toPhase("revealing"); // between rounds, so leaving moves no chips
    await a.sdk.leave(true);
    await until(() => room.clients.length === 0, "A to leave");

    // A new table, empty memory: the chips come back from the database.
    await dbRoom();
    expect(room.table.balance(a.playerId)).toBe(0);
    const again = await connect("token-db-asha");
    expect(again.playerId).toBe(a.playerId);
    await until(() => again.view().chyakhe.some((p) => p.playerId === a.playerId), "A at the new table");
    expect(again.view().chyakhe.find((p) => p.playerId === a.playerId)?.chips).toBe(chips);
    expect((await store.verify()).ok).toBe(true);
  });

  it("pauses the table for good when a write fails, and says so", async () => {
    await dbRoom();
    const a = await connect("token-db-bina");
    await advance(0);
    const persisted = room.table.roundCount;
    failNextRound = true;
    for (let i = 0; i < 60 && room.paused === null; i += 1) await toPhaseEnd();
    expect(room.paused).toMatch(/write to the database failed/);
    await until(() => a.paused !== null, "the client to hear about it");
    // Nothing continues: commands are refused, and time moves nothing.
    send(a, { type: "sit", seat: "teeya" });
    await until(() => a.errors.includes("table-paused"), "the refusal");
    const rounds = room.table.roundCount;
    // A paused room has stopped its loop, so there is no next step to wait
    // for: move the clock, give it real time, and see that nothing happened.
    t += 120_000;
    await sleep(200);
    expect(room.table.roundCount).toBe(rounds);
    // The database has every round before the failure, and not the failed one.
    expect(rounds).toBe(persisted + 1);
    const report = await store.verify();
    expect(report.ok).toBe(true);
    // Nobody can join a paused table.
    await expect((await clientFor("token-db-late")).joinById(room.roomId, {})).rejects.toThrow();
  });

  it("keeps a player at one table at a time, so only one room ever writes their chips", async () => {
    await dbRoom();
    const first = room;
    const a = await connect("token-db-chet");
    await dbRoom();
    const second: KaudaRoom = room;
    await expect((await clientFor("token-db-chet")).joinById(second.roomId, {})).rejects.toThrow(/at-another-table/);
    await a.sdk.leave(true);
    await until(() => !first.table.hasPlayer(a.playerId), "A to leave the first table");
    // Off the first table, A may sit down at another. (The refused join left
    // the second room empty, so Colyseus has disposed of it: use a new one.)
    await dbRoom();
    const again = await connect("token-db-chet");
    expect(again.playerId).toBe(a.playerId);
  });
});
