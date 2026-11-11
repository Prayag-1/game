import { CloseCode, ErrorCode, Room, ServerError, type AuthContext, type Client } from "@colyseus/core";
import { isValidPlayerId, parseCommand } from "./commands.js";
import { TablePersistence } from "./db/persistence.js";
import type { ChipStore } from "./db/store.js";
import type { CommitmentFactory } from "./fairness.js";
import type { Identity, IdentityResolver } from "./identity.js";
import { Ledger, MINT_ACCOUNT } from "./ledger.js";
import { MAX_PLAYERS, Table, type TableOptions } from "./table.js";

/**
 * The real-time layer: one Colyseus room wraps one Table. The room is only an
 * adapter. It maps connections to players, forwards their commands, runs the
 * table's clock and broadcasts what the table says. Every decision about the
 * game stays in Table.
 *
 * State is not Colyseus Schema. The room broadcasts table.view() as a plain
 * "view" message whenever it changes, and every settled round as a "round"
 * message. Schema can come later if bandwidth matters.
 *
 * Client -> server messages:
 *   "command"     a Command (commands.ts). Never carries a playerId: who is
 *                 asking comes from the connection.
 *   "claimTopUp"  ask for a free top-up (topup.ts).
 *   "sync"        ask for "welcome" and the current "view" again.
 * Server -> client messages:
 *   "welcome"     { playerId, name, minChipsToSit, standardBuyIn } for this connection
 *   "view"        TableView, on every change
 *   "round"       RoundRecord, once per settled round, in order
 *   "error"       the reason string, when a request is refused
 *   "topUp"       the result of a claimTopUp
 *   "replaced"    this connection was replaced by a newer one for the same player
 *   "paused"      { reason }: the table has stopped and will not continue
 *
 * Disconnects (game rules):
 * - A human who drops keeps their seat, and keeps staking, for a reconnect
 *   window of `reconnectWindow.rounds` settled rounds or `.ms`, whichever
 *   comes first. That is safe because a seated player is always solvent for
 *   the round they are in. Once the window is over, at the next moment
 *   between rounds, they leave the table: stood up if seated, their chips
 *   still on their account, and a bot fills the seat at the next open.
 * - A chyakhe who drops with a bet down: the bet stands and settles.
 * - A thrower who drops during throwing is auto-thrown on timeout, as always.
 * - Reconnecting within the window resumes the same player, seat and bets.
 * - The same identity connecting again replaces the earlier connection. Two
 *   tabs are one player, never two.
 * A consented leave (the client says it is leaving) is a "leave" command:
 * no reconnect window.
 *
 * Persistence (with a `store`): the database is the authority between
 * sessions, and the Table's in-memory ledger is a cache of it for the players
 * at this table. A player's balance is loaded on join; every settled round,
 * buy-in, top-up and bot residual is written through TablePersistence, in
 * order; the table does not advance while a write is pending. If a write
 * fails the table pauses for good: clients are told, nothing further is
 * written, and chips are as of the last write that succeeded.
 *
 * SINGLE-WRITER RULE: all chip mutations for a player go through the room
 * they are in. Nothing else writes to a player's balance while they are at
 * a table. The room enforces its half: a player may be at one table at a
 * time (per server process; across processes this needs a shared lock, see
 * SECURITY.md).
 */

export interface ReconnectWindow {
  /** Settled rounds after the drop. */
  readonly rounds: number;
  readonly ms: number;
}

export const DEFAULT_RECONNECT_WINDOW: ReconnectWindow = { rounds: 3, ms: 60_000 };
export const DEFAULT_TICK_MS = 200;
/** Close code for a connection replaced by a newer one for the same player. */
export const REPLACED_CLOSE_CODE = 4100;

export interface KaudaRoomDeps {
  readonly identity: IdentityResolver;
  /**
   * The database. With it, balances survive restarts, and each table keeps
   * its own in-memory ledger as a cache. Without it, chips live in memory.
   */
  readonly store?: ChipStore;
  /**
   * Without a store: shared by every room made from these deps, so a balance
   * follows a player from table to table. Defaults to one in-memory ledger
   * per definition. Ignored with a store.
   */
  readonly ledger?: Ledger;
  /** Defaults to Date.now. Tests inject a fake clock. */
  readonly now?: () => number;
  /** Table options other than its id, which is the room id. */
  readonly table?: Omit<TableOptions, "tableId">;
  readonly commitments?: CommitmentFactory;
  readonly botRandom?: () => number;
  /** Simulation interval. */
  readonly tickMs?: number;
  readonly reconnectWindow?: ReconnectWindow;
  readonly maxMessagesPerSecond?: number;
}

interface ResolvedDeps extends KaudaRoomDeps {
  readonly ledger: Ledger;
  /** playerId -> roomId: which table each player is at. One table at a time. */
  readonly atTable: Map<string, string>;
}

interface Away {
  readonly since: number;
  readonly roundsAtDrop: number;
}

/**
 * Makes the room class to register with the server, closing over its
 * dependencies. Room options sent by clients are ignored entirely, so a
 * client can never reach the ledger, the clock or the house rules.
 */
export function defineKaudaRoom(deps: KaudaRoomDeps): typeof KaudaRoom {
  const resolved: ResolvedDeps = { ...deps, ledger: deps.ledger ?? new Ledger(), atTable: new Map() };
  return class extends KaudaRoom {
    protected override readonly deps: ResolvedDeps = resolved;
  };
}

export class KaudaRoom extends Room {
  protected readonly deps: ResolvedDeps | undefined = undefined;
  /** Set in onCreate. */
  table!: Table;
  /** Set in onCreate when there is a store. */
  persistence: TablePersistence | null = null;

  readonly #playerBySession = new Map<string, string>();
  readonly #clientByPlayer = new Map<string, Client>();
  /** Dropped humans inside their reconnect window. */
  readonly #away = new Map<string, Away>();
  /** Every name seen at this table, for accounts the database does not have yet. */
  readonly #names = new Map<string, string>();
  #now: () => number = Date.now;
  #window: ReconnectWindow = DEFAULT_RECONNECT_WINDOW;
  #lastView = "";
  #roundsSent = 0;
  #paused: string | null = null;

  override onCreate(): void {
    const deps = this.deps;
    if (deps === undefined) throw new Error("register the room with defineKaudaRoom(deps)");
    this.maxClients = MAX_PLAYERS;
    this.patchRate = null; // no Schema state to patch
    this.autoDispose = true;
    this.maxMessagesPerSecond = deps.maxMessagesPerSecond ?? 20;
    this.#now = deps.now ?? Date.now;
    this.#window = deps.reconnectWindow ?? DEFAULT_RECONNECT_WINDOW;

    this.table = new Table(
      { ...deps.table, tableId: this.roomId },
      {
        now: this.#now,
        // With a database, this table's own cache; the database is what is shared.
        ledger: deps.store === undefined ? deps.ledger : new Ledger(),
        ...(deps.commitments === undefined ? {} : { commitments: deps.commitments }),
        ...(deps.botRandom === undefined ? {} : { botRandom: deps.botRandom }),
      },
    );
    if (deps.store !== undefined) {
      this.persistence = new TablePersistence(this.table, deps.store, {
        onFailure: (e) => this.#pause("a write to the database failed", e),
        displayName: (id) => this.#names.get(id) ?? id,
        now: this.#now,
      });
    }

    this.onMessage("command", (client, raw: unknown) => {
      const playerId = this.#playerBySession.get(client.sessionId);
      if (playerId === undefined) return void client.send("error", "not-at-table");
      if (this.#paused !== null) return void client.send("error", "table-paused");
      // Schema first; the table then checks phase and balance. Strict, so a
      // smuggled playerId (or anything else) makes the message malformed.
      const command = parseCommand(raw);
      if (command === null) return void client.send("error", "malformed");
      const result = this.table.handle(playerId, command);
      if (!result.ok) client.send("error", result.reason);
      this.#changed();
    });

    this.onMessage("claimTopUp", async (client) => {
      const playerId = this.#playerBySession.get(client.sessionId);
      if (playerId === undefined) return void client.send("error", "not-at-table");
      if (this.#paused !== null) return void client.send("error", "table-paused");
      // The cooldown is per account, so with a database it is read from there:
      // it holds across tables and restarts, not just this table's memory.
      const store = this.deps?.store;
      if (store !== undefined && this.persistence !== null) {
        await this.persistence.idle();
        const last = await store.lastEntryAt(playerId, "topup");
        const availableAt = last === null ? null : last + this.table.topUpCooldownMs;
        if (availableAt !== null && this.#now() < availableAt) {
          client.send("topUp", { ok: false, reason: "topup-cooldown", availableAt });
          return void client.send("error", "topup-cooldown");
        }
        if (this.#paused !== null) return void client.send("error", "table-paused");
      }
      const result = this.table.claimTopUp(playerId);
      client.send("topUp", result);
      if (!result.ok) client.send("error", result.reason);
      this.#changed();
    });

    // A client asks for this once its handlers are in place (messages sent
    // during the join can arrive before it has any), and again to resync.
    this.onMessage("sync", (client) => {
      const playerId = this.#playerBySession.get(client.sessionId);
      if (playerId === undefined) return void client.send("error", "not-at-table");
      client.send("welcome", this.#welcome(playerId, this.#nameOf(playerId)));
      client.send("view", this.table.view());
      if (this.#paused !== null) client.send("paused", { reason: this.#paused });
    });

    this.onMessage("*", (client) => client.send("error", "unknown-message"));

    this.setSimulationInterval(() => this.#step(), deps.tickMs ?? DEFAULT_TICK_MS);
  }

  /**
   * Runs on the WebSocket upgrade. Identity comes only from that request
   * (the session cookie rides along because the page and the socket share
   * one origin); the client's join options are never read.
   */
  override async onAuth(_client: Client, _options: unknown, context: AuthContext): Promise<Identity> {
    const deps = this.deps;
    if (deps === undefined) throw new ServerError(ErrorCode.AUTH_FAILED, "room not configured");
    const identity = await deps.identity.resolveIdentity({ headers: context.headers, ip: context.ip });
    if (identity === null || !isValidPlayerId(identity.playerId) || identity.playerId === MINT_ACCOUNT) {
      throw new ServerError(ErrorCode.AUTH_FAILED, "unknown identity");
    }
    return identity;
  }

  override async onJoin(client: Client, _options: unknown, identity: Identity): Promise<void> {
    const deps = this.deps;
    if (deps === undefined) throw new ServerError(ErrorCode.APPLICATION_ERROR, "room not configured");
    if (this.#paused !== null) throw new ServerError(ErrorCode.APPLICATION_ERROR, "table-paused");
    const { playerId, name } = identity;
    // One table at a time, so this room is the only writer for this player.
    const elsewhere = deps.atTable.get(playerId);
    if (elsewhere !== undefined && elsewhere !== this.roomId) {
      throw new ServerError(ErrorCode.APPLICATION_ERROR, "at-another-table");
    }
    this.#names.set(playerId, name);

    let buyIn: number | undefined;
    if (this.persistence !== null) {
      // The database is the authority: load the balance, or create the
      // account, which then gets the standard buy-in.
      const { created } = await this.persistence.admit(playerId, name);
      if (created) buyIn = this.table.standardBuyIn;
      if (this.#paused !== null) throw new ServerError(ErrorCode.APPLICATION_ERROR, "table-paused");
    } else if (!this.table.ledger.hasAccount(playerId)) {
      // In memory: a player the ledger has never seen is new.
      buyIn = this.table.standardBuyIn;
    }
    const joined = this.table.join(playerId, { name, ...(buyIn === undefined ? {} : { buyIn }) });
    if (!joined.ok) throw new ServerError(ErrorCode.APPLICATION_ERROR, joined.reason);
    deps.atTable.set(playerId, this.roomId);

    const previous = this.#clientByPlayer.get(playerId);
    if (previous !== undefined && previous !== client) {
      // Forget it first, so its onLeave does not count as a disconnect.
      this.#playerBySession.delete(previous.sessionId);
      previous.send("replaced", { by: client.sessionId });
      previous.leave(REPLACED_CLOSE_CODE, "replaced by a newer connection");
    }
    this.#playerBySession.set(client.sessionId, playerId);
    this.#clientByPlayer.set(playerId, client);
    this.#away.delete(playerId);
    this.#syncAutoDispose();

    client.send("welcome", this.#welcome(playerId, name));
    if (!this.#changed()) client.send("view", this.table.view());
  }

  override onLeave(client: Client, code?: number): void {
    const playerId = this.#playerBySession.get(client.sessionId);
    // Unknown: replaced by a newer connection, or never finished joining.
    if (playerId === undefined) return;
    this.#playerBySession.delete(client.sessionId);
    if (this.#clientByPlayer.get(playerId) === client) this.#clientByPlayer.delete(playerId);

    if (code === CloseCode.CONSENTED) {
      if (this.#paused === null) this.table.handle(playerId, { type: "leave" });
    } else {
      this.table.setConnected(playerId, false);
      this.#away.set(playerId, { since: this.#now(), roundsAtDrop: this.table.roundCount });
    }
    this.#syncAutoDispose();
    this.#changed();
  }

  override async onDispose(): Promise<void> {
    // Whatever is queued is written before the table goes.
    await this.persistence?.idle();
    for (const [playerId, roomId] of this.deps?.atTable ?? []) {
      if (roomId === this.roomId) this.deps?.atTable.delete(playerId);
    }
  }

  /** Who this connection is, and the table limits a client needs to offer the right buttons. */
  #welcome(playerId: string, name: string) {
    return { playerId, name, minChipsToSit: this.table.minChipsToSit, standardBuyIn: this.table.standardBuyIn };
  }

  #nameOf(playerId: string): string {
    const v = this.table.view();
    for (const p of [...Object.values(v.seats), ...v.chyakhe]) if (p?.playerId === playerId) return p.name;
    return this.#names.get(playerId) ?? playerId;
  }

  /** Who is currently away, for tests and monitoring. */
  away(): readonly string[] {
    return [...this.#away.keys()];
  }

  /** Why the table is paused, or null. */
  get paused(): string | null {
    return this.#paused;
  }

  // ------------------------------------------------------------------ loop

  #step(): void {
    if (this.#paused !== null) return;
    // Never run ahead of the database: wait for pending writes.
    if (this.persistence !== null && this.persistence.pending > 0) return;
    try {
      this.#expireAway();
      this.table.tick();
      // A tick can settle a round and move into revealing, so look again.
      this.#expireAway();
      this.#changed();
    } catch (e) {
      // An invariant broke (the ledger refuses to go wrong silently).
      this.#pause("the table broke an invariant", e);
    }
  }

  /**
   * Takes players whose reconnect window is over off the table, but only
   * between rounds: until a round settles their chips may be in it.
   */
  #expireAway(): void {
    if (this.#away.size === 0) return;
    const phase = this.table.phase;
    if (phase !== "waiting" && phase !== "revealing") return;
    const t = this.#now();
    for (const [playerId, a] of this.#away) {
      const rounds = this.table.roundCount - a.roundsAtDrop;
      if (rounds < this.#window.rounds && t - a.since < this.#window.ms) continue;
      // Stood up if seated, off the table either way. Their balance is untouched.
      this.table.handle(playerId, { type: "leave" });
      this.#away.delete(playerId);
    }
    this.#syncAutoDispose();
  }

  /** After anything happened: queue it for the database, send settled rounds, publish the view. */
  #changed(): boolean {
    try {
      this.persistence?.pump();
    } catch (e) {
      this.#pause("the table's ledger could not be queued for the database", e);
    }
    this.#releaseDeparted();
    this.#drainRounds();
    const v = this.table.view();
    for (const p of [...Object.values(v.seats), ...v.chyakhe]) if (p !== null) this.#names.set(p.playerId, p.name);
    return this.#publish();
  }

  #drainRounds(): void {
    for (const r of this.table.recordsSince(this.#roundsSent)) {
      this.broadcast("round", r);
      this.#roundsSent += 1;
    }
  }

  /** Broadcasts the view if it changed. Returns whether it did. */
  #publish(): boolean {
    const view = this.table.view();
    const json = JSON.stringify(view);
    if (json === this.#lastView) return false;
    this.#lastView = json;
    this.broadcast("view", view);
    return true;
  }

  /**
   * Stops this table for good, failing closed. Never silently continue with
   * state the database does not have: chips are as of the last write that
   * succeeded, and whatever the table did after it is discarded.
   */
  #pause(why: string, error: unknown): void {
    if (this.#paused !== null) return;
    this.#paused = why;
    console.error(
      [
        "",
        "=".repeat(72),
        `TABLE ${this.roomId} PAUSED: ${why}.`,
        "Chips are as of the last write that succeeded. Nothing after it is saved.",
        "=".repeat(72),
      ].join("\n"),
      error,
    );
    this.setSimulationInterval(undefined);
    this.broadcast("paused", { reason: why });
    this.broadcast("error", "table-paused");
    void this.lock();
    // Nothing more is written here, so the players are free to go elsewhere.
    for (const [playerId, roomId] of this.deps?.atTable ?? []) {
      if (roomId === this.roomId) this.deps?.atTable.delete(playerId);
    }
  }

  /** Frees, for other tables, every player who is no longer at this one. */
  #releaseDeparted(): void {
    const atTable = this.deps?.atTable;
    if (atTable === undefined) return;
    for (const [playerId, roomId] of atTable) {
      if (roomId === this.roomId && !this.table.hasPlayer(playerId)) atTable.delete(playerId);
    }
  }

  /** While anyone is inside a reconnect window, the room must outlive its last client. */
  #syncAutoDispose(): void {
    this.autoDispose = this.#away.size === 0;
  }
}
