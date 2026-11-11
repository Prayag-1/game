import { randomUUID } from "node:crypto";

/**
 * Who a connection belongs to. The room only ever asks this interface, so
 * real authentication (SECURITY.md rule 5: a signed, httpOnly, SameSite=Lax
 * session cookie checked on the websocket upgrade) replaces the stub below
 * without touching the room.
 */
export interface Identity {
  /** Stable, server-assigned player id. Never taken from a client message. */
  readonly playerId: string;
  readonly name: string;
}

/** Non-authoritative things a client may suggest, such as a display name. */
export interface IdentityHints {
  readonly name?: unknown;
}

export interface IdentityResolver {
  /**
   * Maps whatever credential the client presented to an identity, or null to
   * refuse the connection. Both arguments are untrusted input.
   */
  resolveIdentity(credential: unknown, hints?: IdentityHints): Identity | null | Promise<Identity | null>;
}

/**
 * A display name as SECURITY.md allows it ("XSS via usernames and chat"):
 * NFC-normalised; Latin or Devanagari letters and marks, digits, space, `_`
 * and `-`; 3 to 20 characters. Bidi controls, zero-width characters and
 * everything else fall outside the class, so a name cannot pose as someone
 * else or flip the text around it. Returns null for anything else.
 */
export function normaliseDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").trim().replace(/ {2,}/g, " ");
  const length = [...name].length;
  if (length < 3 || length > 20) return null;
  return /^[\p{Script=Latin}\p{Script=Devanagari}\p{Nd} _-]+$/u.test(name) ? name : null;
}

/**
 * DEV STUB. THIS IS NOT AUTHENTICATION.
 *
 * The client presents an opaque token; anyone who knows a token *is* that
 * player. An unseen token silently becomes a new player, and the room gives a
 * new player the standard buy-in the first time it sees them. The suggested
 * name is used only when the player is created, and only if it is a valid
 * display name. Tokens live in memory and vanish on restart. It exists so the
 * room can be built and tested before auth (build step 3), and must be
 * replaced before anything is exposed beyond a developer's machine.
 */
export function devIdentityStub(): IdentityResolver {
  const known = new Map<string, Identity>();
  return {
    resolveIdentity(credential, hints) {
      if (typeof credential !== "string" || credential.length === 0 || credential.length > 256) return null;
      let identity = known.get(credential);
      if (identity === undefined) {
        const name = normaliseDisplayName(hints?.name) ?? `Guest ${known.size + 1}`;
        identity = { playerId: `guest:${randomUUID()}`, name };
        known.set(credential, identity);
      }
      return identity;
    },
  };
}
