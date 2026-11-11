import { CloseCode, ErrorCode, Room, ServerError, type Client } from "@colyseus/core";
import { isValidPlayerId, parseCommand } from "./commands.js";
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
 *   "welcome"     { playerId, name } for this connection
 *   "view"        TableView, on every change
 *   "round"       RoundRecord, once per settled round, in order
 *   "error"       the reason string, when a request is refused
 *   "topUp"       the result of a claimTopUp
 *   "replaced"    this connection was replaced by a newer one for the same player
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
   * Shared by every room made from these deps, so a balance follows a player
   * from table to table. Defaults to one in-memory ledger per definition.
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
  const resolved: ResolvedDeps = { ...deps, ledger: deps.ledger ?? new Ledger() };
  return class extends KaudaRoom {
    protected override readonly deps: ResolvedDeps = resolved;
  };
}

export class KaudaRoom extends Room {
  protected readonly deps: ResolvedDeps | undefined = undefined;
  /** Set in onCreate. */
  table!: Table;

  readonly #playerBySession = new Map<string, string>();
  readonly #clientByPlayer = new Map<string, Client>();
  /** Dropped humans inside their reconnect window. */
  readonly #away = new Map<string, Away>();
  #now: () => number = Date.now;
  #window: ReconnectWindow = DEFAULT_RECONNECT_WINDOW;
  #lastView = "";
  #roundsSent = 0;

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
        ledger: deps.ledger,
        ...(deps.commitments === undefined ? {} : { commitments: deps.commitments }),
        ...(deps.botRandom === undefined ? {} : { botRandom: deps.botRandom }),
      },
    );

    this.onMessage("command", (client, raw: unknown) => {
      const playerId = this.#playerBySession.get(client.sessionId);
      if (playerId === undefined) return void client.send("error", "not-at-table");
      // Schema first; the table then checks phase and balance. Strict, so a
      // smuggled playerId (or anything else) makes the message malformed.
      const command = parseCommand(raw);
      if (command === null) return void client.send("error", "malformed");
      const result = this.table.handle(playerId, command);
      if (!result.ok) client.send("error", result.reason);
      this.#publish();
    });

    this.onMessage("claimTopUp", (client) => {
      const playerId = this.#playerBySession.get(client.sessionId);
      if (playerId === undefined) return void client.send("error", "not-at-table");
      const result = this.table.claimTopUp(playerId);
      client.send("topUp", result);
      if (!result.ok) client.send("error", result.reason);
      this.#publish();
    });

    // A client asks for this once its handlers are in place (messages sent
    // during the join can arrive before it has any), and again to resync.
    this.onMessage("sync", (client) => {
      const playerId = this.#playerBySession.get(client.sessionId);
      if (playerId === undefined) return void client.send("error", "not-at-table");
      client.send("welcome", { playerId, name: this.#nameOf(playerId) });
      client.send("view", this.table.view());
    });

    this.onMessage("*", (client) => client.send("error", "unknown-message"));

    this.setSimulationInterval(() => this.#step(), deps.tickMs ?? DEFAULT_TICK_MS);
  }

  override async onAuth(_client: Client, options: unknown): Promise<Identity> {
    const deps = this.deps;
    if (deps === undefined) throw new ServerError(ErrorCode.AUTH_FAILED, "room not configured");
    const token = options !== null && typeof options === "object" ? (options as { token?: unknown }).token : undefined;
    const identity = await deps.identity.resolveIdentity(token);
    if (identity === null || !isValidPlayerId(identity.playerId) || identity.playerId === MINT_ACCOUNT) {
      throw new ServerError(ErrorCode.AUTH_FAILED, "unknown identity");
    }
    return identity;
  }

  override onJoin(client: Client, _options: unknown, identity: Identity): void {
    const { playerId, name } = identity;
    // A player the ledger has never seen is new, and gets the standard buy-in.
    const isNew = !this.table.ledger.hasAccount(playerId);
    const joined = this.table.join(playerId, { name, ...(isNew ? { buyIn: this.table.standardBuyIn } : {}) });
    if (!joined.ok) throw new ServerError(ErrorCode.APPLICATION_ERROR, joined.reason);

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

    client.send("welcome", { playerId, name });
    if (!this.#publish()) client.send("view", this.table.view());
  }

  override onLeave(client: Client, code?: number): void {
    const playerId = this.#playerBySession.get(client.sessionId);
    // Unknown: replaced by a newer connection, or never finished joining.
    if (playerId === undefined) return;
    this.#playerBySession.delete(client.sessionId);
    if (this.#clientByPlayer.get(playerId) === client) this.#clientByPlayer.delete(playerId);

    if (code === CloseCode.CONSENTED) {
      this.table.handle(playerId, { type: "leave" });
    } else {
      this.table.setConnected(playerId, false);
      this.#away.set(playerId, { since: this.#now(), roundsAtDrop: this.table.roundCount });
    }
    this.#syncAutoDispose();
    this.#publish();
  }

  #nameOf(playerId: string): string {
    const v = this.table.view();
    for (const p of [...Object.values(v.seats), ...v.chyakhe]) if (p?.playerId === playerId) return p.name;
    return playerId;
  }

  /** Who is currently away, for tests and monitoring. */
  away(): readonly string[] {
    return [...this.#away.keys()];
  }

  // ------------------------------------------------------------------ loop

  #step(): void {
    try {
      this.#expireAway();
      this.table.tick();
      // A tick can settle a round and move into revealing, so look again.
      this.#expireAway();
      this.#drainRounds();
      this.#publish();
    } catch (e) {
      // An invariant broke (the ledger refuses to go wrong silently). Fail
      // closed: stop this table rather than play on in a bad state.
      console.error(`table ${this.roomId} halted:`, e);
      this.broadcast("error", "table-halted");
      this.setSimulationInterval(undefined);
      void this.disconnect();
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

  /** While anyone is inside a reconnect window, the room must outlive its last client. */
  #syncAutoDispose(): void {
    this.autoDispose = this.#away.size === 0;
  }
}
