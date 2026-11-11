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

export interface IdentityResolver {
  /**
   * Maps whatever credential the client presented to an identity, or null to
   * refuse the connection. `credential` is untrusted input.
   */
  resolveIdentity(credential: unknown): Identity | null | Promise<Identity | null>;
}

/**
 * DEV STUB. THIS IS NOT AUTHENTICATION.
 *
 * The client presents an opaque token; anyone who knows a token *is* that
 * player. An unseen token silently becomes a new player, and the room gives a
 * new player the standard buy-in the first time it sees them. Tokens live in
 * memory and vanish on restart. It exists so the room can be built and tested
 * before auth (build step 3), and must be replaced before anything is exposed
 * beyond a developer's machine.
 */
export function devIdentityStub(): IdentityResolver {
  const known = new Map<string, Identity>();
  return {
    resolveIdentity(credential) {
      if (typeof credential !== "string" || credential.length === 0 || credential.length > 256) return null;
      let identity = known.get(credential);
      if (identity === undefined) {
        identity = { playerId: `guest:${randomUUID()}`, name: `Guest ${known.size + 1}` };
        known.set(credential, identity);
      }
      return identity;
    },
  };
}
