/**
 * The chip economy in Postgres (SECURITY.md, "The ledger in the database").
 *
 * drizzle-kit generates the tables from this file. What a schema file cannot
 * express is hand-written at the end of the first migration, drizzle/0000_*:
 * the mint row, the triggers that keep ledger_entries and rounds append-only,
 * the trigger that moves accounts.balance on every ledger write, the guard
 * that lets balances move only that way, and the deferred check that the
 * books balance at every commit.
 *
 * Self-contained on purpose: drizzle-kit loads this file on its own.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Must equal MINT_ACCOUNT in ledger.ts; the first migration creates this row. */
export const MINT_ID = "system:mint";

export const accountKind = pgEnum("account_kind", ["human", "bot", "mint"]);
/** The persisted reasons. "opening" and "closing" exist only in memory. */
export const ledgerReason = pgEnum("ledger_reason", ["buyin", "botBuyin", "round", "topup", "botResidual"]);
export const seat = pgEnum("seat", ["teeya", "chauka", "panja", "chakka"]);

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    kind: accountKind("kind").notNull(),
    /** A cache of the sum of this account's ledger entries, moved only by the ledger trigger. */
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check("accounts_balance_non_negative", sql`${t.balance} >= 0 OR ${t.kind} = 'mint'`),
    uniqueIndex("accounts_one_mint").on(t.kind).where(sql`${t.kind} = 'mint'`),
  ],
);

/** Everything needed to replay a round's settlement (SECURITY.md rule 8). */
export interface RoundReplay {
  readonly thrower: string;
  readonly streak: number;
  readonly occupants: Readonly<Record<string, string>>;
  readonly chyakhe: readonly { readonly playerId: string; readonly seat: string; readonly chips: number }[];
  readonly faces: readonly boolean[];
  readonly rules: Readonly<Record<string, unknown>>;
}

export const rounds = pgTable(
  "rounds",
  {
    id: text("id").primaryKey(),
    tableId: text("table_id").notNull(),
    throwerSeat: seat("thrower_seat").notNull(),
    throwerAccountId: text("thrower_account_id")
      .notNull()
      .references(() => accounts.id),
    commitHash: text("commit_hash").notNull(),
    seed: text("seed").notNull(),
    faceUp: integer("face_up").notNull(),
    winningSeat: seat("winning_seat").notNull(),
    hit: boolean("hit").notNull(),
    stake: bigint("stake", { mode: "number" }).notNull(),
    stakeMultiplier: integer("stake_multiplier").notNull(),
    /** Every participant's net change, zeros included. */
    deltas: jsonb("deltas").$type<Record<string, number>>().notNull(),
    /** Settlement inputs, so the round replays from the database alone. */
    replay: jsonb("replay").$type<RoundReplay>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("rounds_face_up_range", sql`${t.faceUp} BETWEEN 0 AND 16`),
    check("rounds_commit_hash_hex", sql`${t.commitHash} ~ '^[0-9a-f]{64}$'`),
    check("rounds_seed_hex", sql`${t.seed} ~ '^[0-9a-f]{64}$'`),
    check("rounds_stake_positive", sql`${t.stake} > 0 AND ${t.stakeMultiplier} > 0`),
    index("rounds_table").on(t.tableId, t.createdAt),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /** Set exactly when reason is "round". */
    roundId: text("round_id").references(() => rounds.id),
    chips: bigint("chips", { mode: "number" }).notNull(),
    reason: ledgerReason("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("ledger_chips_non_zero", sql`${t.chips} <> 0`),
    check("ledger_round_iff_reason_round", sql`(${t.reason} = 'round') = (${t.roundId} IS NOT NULL)`),
    check("ledger_mint_never_in_a_round", sql`${t.reason} <> 'round' OR ${t.accountId} <> 'system:mint'`),
    uniqueIndex("ledger_one_entry_per_account_per_round").on(t.roundId, t.accountId),
    index("ledger_account").on(t.accountId, t.seq),
    index("ledger_account_reason").on(t.accountId, t.reason, t.createdAt),
  ],
);

/**
 * Login sessions. The id is sha256 of the 32 random bytes in the cookie, as
 * hex: the raw id is never stored, so a leak of this table hands out no live
 * sessions. Not append-only: last_seen_at and expires_at slide, and
 * revoked_at is set on logout.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    check("sessions_id_is_a_sha256", sql`${t.id} ~ '^[0-9a-f]{64}$'`),
    check("sessions_expire_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    index("sessions_account").on(t.accountId),
  ],
);
