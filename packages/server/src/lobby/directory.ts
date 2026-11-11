import { randomInt } from "node:crypto";
import { matchMaker } from "@colyseus/core";
import type { Phase } from "../table.js";
import type { KaudaRoom } from "../room.js";

/**
 * Every table in this process, and how players find them.
 *
 * - Public tables are made on demand. Quick Play picks the public table with
 *   the most humans that still has room, and makes a new one only when none
 *   has, so nobody is put alone at an empty table while people are playing.
 * - Private tables are found only by their 6-character code, never listed and
 *   never chosen by Quick Play. The code dies with the table.
 * - Seats are only ever reserved here, on the server. Colyseus's own client
 *   matchmaking routes are switched off (see devServer.ts), so a client
 *   cannot create a room or join one by id or by name.
 * - One table per player: joining another table first takes the player off
 *   the one they are at, as a voluntary leave, and waits until any chips they
 *   have in a round there are settled and written.
 *
 * In process only, like the one-table rule it enforces (SECURITY.md).
 */

export type Visibility = "public" | "private";
export type Preset = "default" | "simple";

/** No 0, O, 1, I, and no lowercase (so no l): easy to read aloud and type. 32 symbols. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

/** A table code from the OS CSPRNG. */
export function newTableCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Normalises what a person typed. Null if it cannot be a code. */
export function parseTableCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

export interface TableInfo {
  readonly id: string;
  readonly visibility: Visibility;
  readonly preset: Preset;
  readonly humans: number;
  readonly bots: number;
  readonly chyakhe: number;
  readonly phase: Phase;
  readonly stake: number;
  /** How many more humans can join now. */
  readonly room: number;
}

export interface SeatReservation {
  readonly name: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly [key: string]: unknown;
}

/** How long a reserved seat counts against a table's room while its player connects. */
const PENDING_MS = 20_000;

export class TableDirectory {
  readonly roomName: string;
  readonly #now: () => number;
  readonly #rooms = new Map<string, KaudaRoom>();
  readonly #codes = new Map<string, string>(); // code -> roomId
  readonly #codeOf = new Map<string, string>(); // roomId -> code
  readonly #order: string[] = []; // roomIds, oldest first
  /** roomId -> accountId -> when the reservation stops counting. */
  readonly #pending = new Map<string, Map<string, number>>();

  constructor(roomName = "kauda", now: () => number = Date.now) {
    this.roomName = roomName;
    this.#now = now;
  }

  // ------------------------------------------------------- called by rooms

  register(room: KaudaRoom): void {
    this.#rooms.set(room.roomId, room);
    this.#order.push(room.roomId);
  }

  unregister(room: KaudaRoom): void {
    this.#rooms.delete(room.roomId);
    this.#pending.delete(room.roomId);
    const i = this.#order.indexOf(room.roomId);
    if (i !== -1) this.#order.splice(i, 1);
    const code = this.#codeOf.get(room.roomId);
    if (code !== undefined) this.#codes.delete(code); // the code dies with the table
    this.#codeOf.delete(room.roomId);
  }

  /** A reserved seat has been taken. */
  joined(roomId: string, accountId: string): void {
    this.#pending.get(roomId)?.delete(accountId);
  }

  // --------------------------------------------------------------- reading

  info(room: KaudaRoom): TableInfo {
    const v = room.table.view();
    const players = [...Object.values(v.seats).flatMap((p) => (p === null ? [] : [p])), ...v.chyakhe];
    return {
      id: room.roomId,
      visibility: room.visibility,
      preset: room.preset,
      humans: players.filter((p) => !p.isBot).length,
      bots: players.filter((p) => p.isBot).length,
      chyakhe: v.chyakhe.length,
      phase: v.phase,
      stake: v.stake,
      room: this.#room(room),
    };
  }

  /** Public tables only, most humans first. Private tables never appear. */
  publicTables(): TableInfo[] {
    return this.#live()
      .filter((r) => r.visibility === "public")
      .map((r) => this.info(r))
      .sort((a, b) => b.humans - a.humans);
  }

  byCode(code: string): KaudaRoom | null {
    const id = this.#codes.get(code);
    return id === undefined ? null : (this.#usable(id) ?? null);
  }

  codeOf(room: KaudaRoom): string | null {
    return this.#codeOf.get(room.roomId) ?? null;
  }

  /** A public table by id. A private table's id gets nothing here. */
  publicById(id: string): KaudaRoom | null {
    const room = this.#usable(id);
    return room !== undefined && room.visibility === "public" ? room : null;
  }

  /** The table this account is at, if any. */
  tableOf(accountId: string): KaudaRoom | null {
    return this.#live().find((r) => r.table.hasPlayer(accountId)) ?? null;
  }

  hasRoom(room: KaudaRoom): boolean {
    return this.#room(room) > 0;
  }

  // ------------------------------------------------------------- choosing

  /**
   * The public table Quick Play puts this account at: the one it is already
   * at, or the one with the most humans that has room (oldest first on a
   * tie), or a new one.
   */
  async quickPlay(accountId: string): Promise<KaudaRoom> {
    const current = this.tableOf(accountId);
    if (current !== null && current.visibility === "public") return current;
    const humansAt = (r: KaudaRoom) => this.info(r).humans;
    const candidates = this.#live()
      .filter((r) => r.visibility === "public" && this.#room(r) > 0)
      .sort((a, b) => humansAt(b) - humansAt(a)); // stable: oldest first on a tie
    return candidates[0] ?? (await this.create("public", "default")).room;
  }

  async create(visibility: Visibility, preset: Preset): Promise<{ room: KaudaRoom; code: string | null }> {
    const listing = await matchMaker.createRoom(this.roomName, { visibility, preset });
    const room = matchMaker.getLocalRoomById(listing.roomId) as unknown as KaudaRoom;
    if (visibility === "public") return { room, code: null };
    let code = newTableCode();
    while (this.#codes.has(code)) code = newTableCode();
    this.#codes.set(code, room.roomId);
    this.#codeOf.set(room.roomId, code);
    return { room, code };
  }

  // --------------------------------------------------------------- moving

  /**
   * Takes the account off every table but `keep`, as a voluntary leave, and
   * waits until it is gone from them and their writes are done, so only one
   * table ever writes its chips. False if that took longer than `timeoutMs`
   * (a seat with chips in a long round).
   */
  async release(accountId: string, keep: KaudaRoom | null, timeoutMs = 30_000): Promise<boolean> {
    const others = () => this.#live().filter((r) => r !== keep && r.paused === null && r.table.hasPlayer(accountId));
    for (const room of others()) room.evict(accountId, "moved");
    const end = Date.now() + timeoutMs;
    for (;;) {
      const busy = this.#live().some(
        (r) => r !== keep && ((r.paused === null && r.table.hasPlayer(accountId)) || (r.persistence?.pending ?? 0) > 0),
      );
      if (!busy) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Reserves a seat at this table for this account. Only that account can take it. */
  async reserve(room: KaudaRoom, accountId: string): Promise<SeatReservation> {
    const [listing] = await matchMaker.query({ roomId: room.roomId });
    if (listing === undefined) throw new Error("table is gone");
    const pending = this.#pending.get(room.roomId) ?? new Map<string, number>();
    pending.set(accountId, this.#now() + PENDING_MS);
    this.#pending.set(room.roomId, pending);
    return (await matchMaker.reserveSeatFor(listing, { accountId })) as unknown as SeatReservation;
  }

  /** Disconnects every table connection of this account, now: it logged out. */
  endAccount(accountId: string): void {
    for (const room of this.#live()) room.evict(accountId, "logged-out");
  }

  // --------------------------------------------------------------- private

  #live(): KaudaRoom[] {
    return this.#order.flatMap((id) => {
      const r = this.#rooms.get(id);
      return r === undefined ? [] : [r];
    });
  }

  /** A table that can take players: registered, not paused, not disposing. */
  #usable(id: string): KaudaRoom | undefined {
    const room = this.#rooms.get(id);
    return room !== undefined && room.paused === null ? room : undefined;
  }

  /** Room for more humans, net of seats reserved but not yet taken. */
  #room(room: KaudaRoom): number {
    if (room.paused !== null) return 0;
    const pending = this.#pending.get(room.roomId);
    let waiting = 0;
    const now = this.#now();
    for (const [account, until] of pending ?? []) {
      if (until <= now || room.table.hasPlayer(account)) pending?.delete(account);
      else waiting += 1;
    }
    const clientsLeft = room.maxClients - room.clients.length - waiting;
    return Math.max(0, Math.min(room.table.humanCapacity() - waiting, clientsLeft));
  }
}
