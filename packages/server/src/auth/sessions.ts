import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { MINT_ID, accounts, ledgerEntries, sessions } from "../db/schema.js";
import type { KaudaDb } from "../db/store.js";

/**
 * Guest sessions (SECURITY.md rule 5, "Identity: guest sessions").
 *
 * A session id is 32 bytes from crypto.randomBytes. The cookie carries it
 * with an HMAC-SHA256 signature: `<id>.<signature>`, both base64url. The
 * database stores only sha256(id), so a leaked sessions table hands out no
 * live sessions. Signatures and hashes are compared in constant time, and a
 * session id is never logged: nothing in this file writes one anywhere but
 * the Set-Cookie header.
 *
 * Expiry slides: 90 days from the last time the session was used. A guest
 * has no password and no other way to log in, so LOSING THE COOKIE MEANS
 * LOSING THE ACCOUNT: cleared cookies, another browser, another device. That
 * is why the window is long, and why linking a real login method to a guest
 * account comes later (see CLAUDE.md: auth_methods).
 */

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Expiry slides at most this often, to keep a write off every request. */
export const SESSION_SLIDE_EVERY_MS = 60 * 60 * 1000;
const ID_BYTES = 32;
const MAC_LABEL = "kauda-session-v1:";

export interface SessionConfig {
  /** The signing key: at least 32 bytes. Never committed (see loadSessionSecret). */
  readonly secret: Buffer;
  /**
   * Production: the cookie is Secure and named with the __Host- prefix, which
   * browsers accept only over HTTPS, with Path=/ and no Domain. Development on
   * http://127.0.0.1 cannot use either.
   */
  readonly secure: boolean;
  readonly now?: () => number;
}

export interface SessionAccount {
  readonly accountId: string;
  readonly displayName: string;
}

export interface CreatedGuest extends SessionAccount {
  readonly balance: number;
  /** The Set-Cookie header value. Contains the session id: never log it. */
  readonly setCookie: string;
}

const b64url = (b: Buffer): string => b.toString("base64url");
const sha256Hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export class Sessions {
  readonly #db: KaudaDb;
  readonly #secret: Buffer;
  readonly #now: () => number;
  readonly secure: boolean;
  readonly cookieName: string;

  constructor(db: KaudaDb, config: SessionConfig) {
    if (config.secret.length < 32) throw new RangeError("the session secret must be at least 32 bytes");
    this.#db = db;
    this.#secret = config.secret;
    this.#now = config.now ?? Date.now;
    this.secure = config.secure;
    this.cookieName = config.secure ? "__Host-kauda_session" : "kauda_session";
  }

  /**
   * Creates a guest in one transaction: a human account, its buy-in from
   * the mint, and a session. Returns the cookie to set.
   */
  async createGuest(displayName: string, buyIn: number): Promise<CreatedGuest> {
    if (!Number.isSafeInteger(buyIn) || buyIn < 1) throw new RangeError("buyIn must be a positive whole number of chips");
    const accountId = `guest:${randomUUID()}`;
    const raw = randomBytes(ID_BYTES);
    const now = new Date(this.#now());
    await this.#db.transaction(async (tx) => {
      await tx.insert(accounts).values({ id: accountId, displayName, kind: "human", createdAt: now });
      await tx.insert(ledgerEntries).values([
        { accountId, chips: buyIn, reason: "buyin", createdAt: now },
        { accountId: MINT_ID, chips: -buyIn, reason: "buyin", createdAt: now },
      ]);
      await tx.insert(sessions).values({
        id: sha256Hex(raw),
        accountId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      });
    });
    return { accountId, displayName, balance: buyIn, setCookie: this.#setCookie(raw) };
  }

  /**
   * The account behind a Cookie header, or null: no cookie, a bad signature,
   * an unknown, revoked or expired session. Slides the expiry when it is
   * used. `refresh` is a Set-Cookie value to send back where a response can
   * carry one, so the browser's copy slides too.
   */
  async resolve(cookieHeader: string | null | undefined): Promise<(SessionAccount & { refresh: string }) | null> {
    const raw = this.#verifiedId(cookieHeader);
    if (raw === null) return null;
    const hash = sha256Hex(raw);
    const [row] = await this.#db
      .select({
        id: sessions.id,
        accountId: sessions.accountId,
        displayName: accounts.displayName,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .innerJoin(accounts, eq(accounts.id, sessions.accountId))
      .where(eq(sessions.id, hash));
    if (row === undefined) return null;
    // The lookup was by this hash; compare it again in constant time anyway.
    if (!timingSafeEqual(Buffer.from(row.id, "hex"), Buffer.from(hash, "hex"))) return null;
    const now = this.#now();
    if (row.revokedAt !== null || row.expiresAt.getTime() <= now) return null;
    if (now - row.lastSeenAt.getTime() >= SESSION_SLIDE_EVERY_MS) {
      await this.#db
        .update(sessions)
        .set({ lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) })
        .where(and(eq(sessions.id, hash), isNull(sessions.revokedAt)));
    }
    return { accountId: row.accountId, displayName: row.displayName, refresh: this.#setCookie(raw) };
  }

  /** Revokes the session in this Cookie header, if it is a valid one. */
  async revoke(cookieHeader: string | null | undefined): Promise<void> {
    const raw = this.#verifiedId(cookieHeader);
    if (raw === null) return;
    await this.#db
      .update(sessions)
      .set({ revokedAt: new Date(this.#now()) })
      .where(and(eq(sessions.id, sha256Hex(raw)), isNull(sessions.revokedAt)));
  }

  /** A Set-Cookie value that deletes the session cookie. */
  clearCookie(): string {
    return `${this.cookieName}=; ${this.#attributes()}; Max-Age=0`;
  }

  #setCookie(raw: Buffer): string {
    return `${this.cookieName}=${b64url(raw)}.${b64url(this.#mac(raw))}; ${this.#attributes()}; Max-Age=${SESSION_TTL_MS / 1000}`;
  }

  #attributes(): string {
    return `Path=/; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}`;
  }

  #mac(raw: Buffer): Buffer {
    return createHmac("sha256", this.#secret).update(MAC_LABEL).update(raw).digest();
  }

  /** The raw session id from a Cookie header, if its signature verifies. */
  #verifiedId(cookieHeader: string | null | undefined): Buffer | null {
    const value = readCookie(cookieHeader, this.cookieName);
    if (value === null) return null;
    const parts = value.split(".");
    if (parts.length !== 2) return null;
    const [idPart, macPart] = parts as [string, string];
    if (!/^[A-Za-z0-9_-]{43}$/.test(idPart) || !/^[A-Za-z0-9_-]{43}$/.test(macPart)) return null;
    const raw = Buffer.from(idPart, "base64url");
    const given = Buffer.from(macPart, "base64url");
    if (raw.length !== ID_BYTES || given.length !== 32) return null;
    return timingSafeEqual(given, this.#mac(raw)) ? raw : null;
  }
}

/** One cookie's value from a Cookie header, or null. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (typeof header !== "string" || header.length === 0 || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
