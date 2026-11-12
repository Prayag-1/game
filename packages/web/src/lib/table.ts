import type { Client, Room } from "@colyseus/sdk";
import { api, type Result, type SeatGrant } from "./api";
import type { Command } from "./protocol";
import { useSession, type Notice } from "./session";
import { ingest, initialTableState, useTable } from "./tableStore";

/**
 * The socket adapter: the only code that touches the Colyseus room. It feeds
 * every message into the store (tableStore.ts) and offers a few actions;
 * components read the store and call these, never the socket.
 *
 * The server reserves a seat over HTTP (lobby routes); this takes it with the
 * reservation over the WebSocket, whose upgrade carries the session cookie,
 * so who we are comes from the cookie and never from anything sent here.
 */

export { useTable } from "./tableStore";
export type { Connection } from "./tableStore";

/** Close codes from packages/server/src/room.ts. */
const CONSENTED_CLOSE_CODE = 4000;
const REPLACED_CLOSE_CODE = 4100;
const MOVED_CLOSE_CODE = 4101;
const SESSION_ENDED_CLOSE_CODE = 4102;
const MAX_RECONNECT_ATTEMPTS = 8;
const MESSAGES = ["welcome", "view", "round", "error", "topUp", "paused"] as const;

let client: Client | null = null;
let room: Room | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let replaced = false;

/**
 * The Colyseus client: /ws/<processId>/<roomId> on this page's own origin.
 * Loaded on first use, so sign-in and the lobby do not download it.
 */
async function colyseus(): Promise<Client> {
  if (client === null) {
    const { Client: ColyseusClient } = await import("@colyseus/sdk");
    client ??= new ColyseusClient(`${window.location.origin}/ws`);
  }
  return client;
}

/** Sends a table command. The server validates it against the phase and my real balance. */
export function send(command: Command): void {
  room?.send("command", command);
}

/** Asks for a free top-up; the answer arrives as a "topUp" message. */
export function claimTopUp(): void {
  room?.send("claimTopUp");
}

/**
 * Asks the server for a seat with `request`, then connects to it. Returns the
 * table id, or the server's error code.
 */
export async function takeSeat(request: () => Promise<Result<SeatGrant>>): Promise<Result<string>> {
  clearTimeout(retryTimer);
  if (useTable.getState().conn !== "reconnecting") useTable.setState({ conn: "connecting" });
  const grant = await request();
  if (!grant.ok) {
    if (useTable.getState().conn === "connecting") useTable.setState({ conn: "idle" });
    if (grant.error === "no-session") useSession.getState().signedOut();
    return grant;
  }
  let joined: Room;
  try {
    joined = await (await colyseus()).consumeSeatReservation(grant.value.reservation as never);
  } catch {
    if (useTable.getState().conn === "connecting") useTable.setState({ conn: "idle" });
    return { ok: false, error: "network", status: 0 };
  }
  attach(joined, grant.value);
  return { ok: true, value: grant.value.table.id };
}

function attach(joined: Room, grant: SeatGrant): void {
  const previous = room;
  room = joined;
  replaced = false;
  if (previous !== null && previous !== joined) void previous.leave(true).catch(() => {});
  // The server resumes a player by their session, not by Colyseus
  // reconnection tokens, so the SDK's own reconnect loop is off; ours is below.
  joined.reconnection.enabled = false;
  const code = grant.code ?? null;
  const sameTable = useTable.getState().tableId === grant.table.id;
  useTable.setState({
    // A reconnect to the same table keeps the log and the fairness checks.
    ...(sameTable ? {} : { ...initialTableState }),
    conn: "connected",
    attempt: 0,
    tableId: grant.table.id,
    code,
    shareUrl: grant.shareUrl ?? (code === null ? null : `${window.location.origin}/?code=${code}`),
    refusal: null,
    pausedReason: null,
  });
  for (const type of MESSAGES) {
    joined.onMessage(type, (payload: unknown) => {
      if (room === joined) ingest(type, payload);
    });
  }
  joined.onMessage("ended", () => {});
  joined.onMessage("replaced", () => {
    if (room === joined) replaced = true;
  });
  joined.onLeave((closeCode: number) => onLeave(joined, closeCode));
  joined.send("sync");
}

function toLobby(notice: Notice | null): void {
  clearTimeout(retryTimer);
  room = null;
  useTable.setState({ ...initialTableState });
  if (notice !== null) useSession.getState().setNotice(notice);
}

function onLeave(left: Room, closeCode: number): void {
  if (left !== room) return; // an older connection
  room = null;
  if (replaced || closeCode === REPLACED_CLOSE_CODE) {
    useTable.setState({ conn: "replaced" });
  } else if (closeCode === CONSENTED_CLOSE_CODE) {
    toLobby(null);
  } else if (closeCode === MOVED_CLOSE_CODE) {
    toLobby({ key: "notices.moved" });
  } else if (closeCode === SESSION_ENDED_CLOSE_CODE) {
    toLobby(null);
    useSession.getState().signedOut({ key: "notices.sessionEnded" });
  } else if (useTable.getState().conn !== "paused") {
    scheduleReconnect(); // a paused table stays on screen; leaving takes the player back
  }
}

function scheduleReconnect(): void {
  const attempt = useTable.getState().attempt + 1;
  if (attempt > MAX_RECONNECT_ATTEMPTS) return toLobby({ key: "errors.network" });
  useTable.setState({ conn: "reconnecting", attempt });
  const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
  retryTimer = setTimeout(() => void reconnect(), delay);
}

async function reconnect(): Promise<void> {
  const result = await takeSeat(() => api.rejoin());
  if (result.ok) return;
  if (result.error === "no-session") return toLobby(null);
  if (result.error === "not-at-a-table") return toLobby({ key: "notices.seatGivenUp" });
  scheduleReconnect();
}

/**
 * Back to the table this account is at, after a page refresh or when taking
 * over from another tab. Shares one attempt between callers (React
 * StrictMode runs effects twice in development).
 */
let resuming: Promise<Result<string>> | null = null;
export function resume(): Promise<Result<string>> {
  if (resuming !== null) return resuming;
  const { conn, tableId } = useTable.getState();
  if (conn !== "idle" && conn !== "replaced" && tableId !== null) return Promise.resolve({ ok: true, value: tableId });
  resuming = takeSeat(() => api.rejoin()).finally(() => {
    resuming = null;
  });
  return resuming;
}

/** Leaves the table on purpose: no reconnect window. */
export async function leaveTable(): Promise<void> {
  const current = room;
  toLobby(null);
  if (current !== null) await current.leave(true).catch(() => {});
}

/** Leaves the table, then ends the session on the server. */
export async function logout(): Promise<void> {
  await leaveTable();
  await useSession.getState().logout();
}

/** For tests. */
export function resetTableForTests(): void {
  clearTimeout(retryTimer);
  room = null;
  client = null;
  useTable.setState({ ...initialTableState });
}
