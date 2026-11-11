/**
 * Who a connection belongs to. The room only ever asks this interface, and
 * hands it nothing but the WebSocket upgrade request: never anything the
 * client put in its join options. The real implementation is
 * sessionIdentity() in auth/http.ts, which reads the signed session cookie
 * (SECURITY.md rule 5).
 */
export interface Identity {
  /** Stable, server-assigned account id. Never taken from a client message. */
  readonly playerId: string;
  readonly name: string;
}

/** What the server knows about a connection from the upgrade request itself. */
export interface ConnectionRequest {
  readonly headers: Headers;
  /** May come from a proxy header, so it is a hint, not a fact. */
  readonly ip: string | undefined;
}

export interface IdentityResolver {
  /** The identity behind this connection, or null to refuse it. */
  resolveIdentity(request: ConnectionRequest): Identity | null | Promise<Identity | null>;
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
