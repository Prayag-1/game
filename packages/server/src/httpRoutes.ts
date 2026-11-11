/**
 * What the HTTP routes share: the slice of an Express request and response
 * they use, a capped JSON body reader, and the check every state-changing
 * request must pass (an allowed Origin and a JSON body, so a cross-site form
 * cannot post, and a cross-origin fetch needs a preflight that CORS refuses).
 */

export interface Req {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
  readonly socket: { readonly remoteAddress?: string | undefined };
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "error", listener: () => void): unknown;
  destroy(): unknown;
}

export interface Res {
  status(code: number): Res;
  set(headers: Record<string, string>): Res;
  json(body: unknown): void;
  end(): void;
}

export type Handler = (req: Req, res: Res) => void | Promise<void>;

export interface RouteApp {
  get(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The whole JSON body, at most 4 KB. Null if it is too big or not JSON. */
const MAX_BODY_BYTES = 4 * 1024;
export function readJsonBody(req: Req): Promise<unknown> {
  if (req.body !== undefined) return Promise.resolve(req.body); // already read by a framework
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: unknown) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(null);
      }
    });
    req.on("error", () => finish(null));
  });
}

/** Origin on the allowlist, and a JSON body. Answers and returns false if not. */
export function stateChangeAllowed(req: Req, res: Res, allowedOrigins: readonly string[]): boolean {
  const origin = header(req, "origin");
  if (origin === undefined || !allowedOrigins.includes(origin)) {
    res.status(403).set(NO_STORE).json({ error: "bad-origin" });
    return false;
  }
  if (!(header(req, "content-type") ?? "").toLowerCase().startsWith("application/json")) {
    res.status(415).set(NO_STORE).json({ error: "json-only" });
    return false;
  }
  return true;
}
