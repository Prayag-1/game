/**
 * Cloudflare Turnstile, checked on the server: the browser's widget yields a
 * token, and the server asks siteverify whether it is good. A failure of any
 * kind (network, timeout, bad JSON) counts as "no": fail closed.
 *
 * Development uses Cloudflare's documented test keys, so nothing needs an
 * account yet: the site key always passes, and the secret accepts the dummy
 * token that widget produces. Production must set TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY, or the server refuses to start.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Cloudflare's always-pass test keys. Public, documented, useless in production. */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";

export interface TurnstileVerifier {
  /** Whether Cloudflare accepts this token. Never throws. */
  verify(token: string, remoteIp: string | undefined): Promise<boolean>;
}

export interface TurnstileOptions {
  readonly secretKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function cloudflareTurnstile(options: TurnstileOptions): TurnstileVerifier {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async verify(token, remoteIp) {
      if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
      const body = new URLSearchParams({ secret: options.secretKey, response: token });
      if (remoteIp !== undefined) body.set("remoteip", remoteIp);
      try {
        const res = await doFetch(SITEVERIFY_URL, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        });
        if (!res.ok) return false;
        const json = (await res.json()) as { success?: unknown };
        return json.success === true;
      } catch {
        return false;
      }
    },
  };
}

/** Real keys from the environment; Cloudflare's test keys in development. */
export function turnstileFromEnv(env: NodeJS.ProcessEnv): { siteKey: string; secretKey: string; testKeys: boolean } {
  const siteKey = env.TURNSTILE_SITE_KEY;
  const secretKey = env.TURNSTILE_SECRET_KEY;
  if (siteKey && secretKey) return { siteKey, secretKey, testKeys: false };
  if (env.NODE_ENV === "production") {
    throw new Error("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are required in production");
  }
  return { siteKey: TURNSTILE_TEST_SITE_KEY, secretKey: TURNSTILE_TEST_SECRET_KEY, testKeys: true };
}
