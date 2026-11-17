/**
 * Serves the built web client (packages/web/dist) from the game server, so
 * the page, the HTTP routes and the Colyseus WebSocket share one origin and
 * the session cookie rides the WebSocket upgrade. In development the Vite
 * server proxies to this server instead (packages/web/vite.config.ts).
 *
 * The page runs under a strict Content-Security-Policy: no 'unsafe-inline'
 * and no 'unsafe-eval' anywhere, scripts only from this origin and
 * Cloudflare's Turnstile, no data: URIs. The Vite build emits no inline
 * script or style and inlines no assets, which is what makes that possible.
 * Two additions, for the throw's physics (Rapier, WebAssembly, in a Web
 * Worker): 'wasm-unsafe-eval', which lets the page compile WebAssembly and
 * nothing else (no eval, no new Function), and worker-src 'self'.
 *
 * COMPRESSION. The build writes brotli (.br) and gzip (.gz) copies of every
 * text asset and the .wasm (vite.config.ts precompress). Each response is
 * the copy that matches the request's Accept-Encoding, brotli first, with
 * Content-Encoding and Vary: Accept-Encoding; the copies are never served
 * under their own names. Hashed files under assets/ are cached for a year,
 * immutably; the page itself is never cached.
 *
 * Only files that exist in dist/ when the server starts can be served: the
 * request path is looked up in a fixed map, never joined onto a directory,
 * so no path can reach outside dist/. Unknown paths without an extension get
 * index.html (client-side routes such as /table/abc); anything else is a 404.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, sep } from "node:path";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

/** Paths that belong to the server, never to the page. */
const SERVER_PREFIXES = ["/session/", "/tables", "/ws/", "/matchmake/"];

/**
 * The production page's policy. `wsOrigins` are the ws:// or wss:// forms of
 * the page's own origins: 'self' covers same-host WebSockets in current
 * browsers, but Safari before 15.4 did not, so they are listed as well.
 */
export function webContentSecurityPolicy(wsOrigins: readonly string[]): string {
  return [
    "default-src 'none'",
    // 'wasm-unsafe-eval' compiles WebAssembly only (the throw's physics); it allows no eval of strings.
    `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE_ORIGIN}`,
    // The physics runs in a Web Worker, from this origin only.
    "worker-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self'",
    ["connect-src 'self'", ...wsOrigins].join(" "),
    `frame-src ${TURNSTILE_ORIGIN}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** ws:// for http://, wss:// for https://. */
export function wsOriginsOf(origins: readonly string[]): string[] {
  return origins.map((o) => o.replace(/^http(s?):\/\//, "ws$1://"));
}

interface Asset {
  readonly body: Buffer;
  readonly type: string;
  readonly immutable: boolean;
  /** The build's precompressed copies, when it wrote them. */
  readonly br?: Buffer;
  readonly gz?: Buffer;
}

type Encoding = "br" | "gzip";

/**
 * The encodings a request accepts, from its Accept-Encoding header: a coding
 * is acceptable if listed (or covered by *) with a q-value above 0.
 */
export function acceptedEncodings(header: string | undefined): Set<Encoding> {
  const out = new Set<Encoding>();
  if (header === undefined) return out;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    if (name === "") continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const value = qParam === undefined ? 1 : Number(qParam.slice(2));
    q.set(name.trim(), Number.isFinite(value) ? value : 0);
  }
  const star = q.get("*");
  for (const coding of ["br", "gzip"] as const) {
    const v = q.get(coding) ?? star ?? 0;
    if (v > 0) out.add(coding);
  }
  return out;
}

const readIfThere = (path: string): Buffer | undefined => (existsSync(path) ? readFileSync(path) : undefined);

function walk(dir: string, root: string, into: Map<string, Asset>): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, root, into);
      continue;
    }
    const type = TYPES[extname(name).toLowerCase()];
    if (type === undefined) continue; // not a type we serve (source maps, etc.)
    const path = "/" + relative(root, full).split(sep).join("/");
    // Vite puts content-hashed files under assets/: safe to cache for good.
    const br = readIfThere(`${full}.br`);
    const gz = readIfThere(`${full}.gz`);
    into.set(path, { body: readFileSync(full), type, immutable: path.startsWith("/assets/"), ...(br ? { br } : {}), ...(gz ? { gz } : {}) });
  }
}

export interface WebClient {
  /** Express-style middleware. Calls next() for anything that is not the page's. */
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  readonly fileCount: number;
}

export function webClient(options: { readonly distDir: string; readonly wsOrigins: () => readonly string[] }): WebClient {
  const files = new Map<string, Asset>();
  walk(options.distDir, options.distDir, files);
  const index = files.get("/index.html");
  if (index === undefined) throw new Error(`no index.html in ${options.distDir}: run pnpm --filter @kauda/web build`);
  files.delete("/index.html");

  const common = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };

  return {
    fileCount: files.size + 1,
    handle(req, res, next) {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      let path: string;
      try {
        path = new URL(req.url ?? "/", "http://page").pathname;
      } catch {
        return next();
      }
      if (SERVER_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p))) return next();

      const send = (status: number, asset: Asset, headers: Record<string, string>) => {
        // The precompressed copy the request accepts, brotli first.
        const accepted = acceptedEncodings(req.headers["accept-encoding"]);
        const [encoding, body] =
          asset.br !== undefined && accepted.has("br") ? (["br", asset.br] as const) : asset.gz !== undefined && accepted.has("gzip") ? (["gzip", asset.gz] as const) : ([null, asset.body] as const);
        const varies = asset.br !== undefined || asset.gz !== undefined;
        res.writeHead(status, {
          ...common,
          "Content-Type": asset.type,
          "Content-Length": String(body.length),
          ...(encoding === null ? {} : { "Content-Encoding": encoding }),
          ...(varies ? { Vary: "Accept-Encoding" } : {}),
          ...headers,
        });
        res.end(req.method === "HEAD" ? undefined : body);
      };

      const file = files.get(path);
      if (file !== undefined) {
        return send(200, file, { "Cache-Control": file.immutable ? "public, max-age=31536000, immutable" : "no-cache" });
      }
      // A client-side route: the page. A missing file (with an extension) is a 404.
      if (extname(path) === "" && !path.startsWith("/assets/")) {
        return send(200, index, {
          "Content-Security-Policy": webContentSecurityPolicy(options.wsOrigins()),
          // Never cached: it names the hashed files of the current build.
          "Cache-Control": "no-store",
        });
      }
      res.writeHead(404, { ...common, "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    },
  };
}
