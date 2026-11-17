import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openChipStore } from "../src/db/open.js";
import type { DrizzleChipStore } from "../src/db/store.js";
import { DEV_HOST, startDevServer, type DevServer } from "../src/devServer.js";
import { acceptedEncodings, webContentSecurityPolicy, wsOriginsOf } from "../src/webClient.js";

/**
 * The game server serving a built web client: the page under its strict
 * CSP, hashed assets, client-side routes, nothing outside dist/, the
 * server's own routes untouched, and the Vite proxy's Origin accepted.
 */
const PROXY = "http://127.0.0.1:5173";
/** Stands in for a WebAssembly module: the magic number, a version, and a compressible body. */
const WASM = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.alloc(4096, 7)]);
let dev: DevServer;
let store: DrizzleChipStore;

beforeAll(async () => {
  const dist = mkdtempSync(join(tmpdir(), "kauda-web-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), '<!doctype html><script type="module" src="/assets/app-abc.js"></script>');
  writeFileSync(join(dist, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(dist, "assets", "app-abc.js.map"), "{}");
  writeFileSync(join(dist, "robots.txt"), "User-agent: *");
  // Rapier's WebAssembly, with the build's precompressed copies beside it (vite.config.ts precompress).
  writeFileSync(join(dist, "assets", "rapier-abc.wasm"), WASM);
  writeFileSync(join(dist, "assets", "rapier-abc.wasm.br"), brotliCompressSync(WASM));
  writeFileSync(join(dist, "assets", "rapier-abc.wasm.gz"), gzipSync(WASM));
  store = await openChipStore({ dataDir: null });
  dev = await startDevServer({
    port: 0,
    store,
    web: { distDir: dist },
    proxyOrigins: [PROXY],
    auth: { secret: randomBytes(32), turnstileSiteKey: "k", turnstile: { verify: async (t) => t === "good" } },
  });
});
afterAll(async () => {
  await dev.close();
  await store.close();
});

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}
/** A GET whose body is kept as bytes (a compressed reply is not text). */
function raw(path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: DEV_HOST, port: dev.port, path, method: "GET", headers: { Host: `${DEV_HOST}:${dev.port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function http(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: DEV_HOST, port: dev.port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("the strict page policy", () => {
  it("has no unsafe-inline, no unsafe-eval and no data:, and only the two additions the physics needs", () => {
    const csp = webContentSecurityPolicy(wsOriginsOf(["http://127.0.0.1:3000"]));
    // 'wasm-unsafe-eval' compiles WebAssembly only; nothing else unsafe is allowed.
    expect(csp.replace("'wasm-unsafe-eval'", "")).not.toMatch(/unsafe|data:|\*/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com;");
    expect(csp).toContain("worker-src 'self';");
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:3000;");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("maps https origins to wss", () => {
    expect(wsOriginsOf(["https://kauda.example", "http://127.0.0.1:3000"])).toEqual(["wss://kauda.example", "ws://127.0.0.1:3000"]);
  });
});

describe("serving the built client", () => {
  it("serves index.html at / under the strict CSP", async () => {
    const res = await http("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("/assets/app-abc.js");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toBe(webContentSecurityPolicy([`ws://${DEV_HOST}:${dev.port}`, `ws://localhost:${dev.port}`]));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("serves client-side routes as the page, so a refresh on /table/x works", async () => {
    const res = await http("/table/abc123");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<!doctype html>");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("serves hashed assets with their type and a long cache", async () => {
    const res = await http("/assets/app-abc.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await http("/robots.txt")).status).toBe(200);
  });

  it("serves the brotli copy of the wasm to a request that accepts br, with the wasm's type", async () => {
    const res = await raw("/assets/rapier-abc.wasm", { "Accept-Encoding": "gzip, deflate, br" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/wasm");
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["vary"]).toBe("Accept-Encoding");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(Number(res.headers["content-length"])).toBe(res.body.length);
    expect(res.body.length).toBeLessThan(WASM.length);
    expect(brotliDecompressSync(res.body).equals(WASM)).toBe(true);
  });

  it("falls back to gzip, then to the file itself, as the request allows", async () => {
    const gz = await raw("/assets/rapier-abc.wasm", { "Accept-Encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body).equals(WASM)).toBe(true);
    const refusedBr = await raw("/assets/rapier-abc.wasm", { "Accept-Encoding": "br;q=0, gzip;q=0.5" });
    expect(refusedBr.headers["content-encoding"]).toBe("gzip");
    const plain = await raw("/assets/rapier-abc.wasm", {});
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers["vary"]).toBe("Accept-Encoding");
    expect(plain.body.equals(WASM)).toBe(true);
  });

  it("never serves a compressed copy under its own name", async () => {
    expect((await http("/assets/rapier-abc.wasm.br")).status).toBe(404);
    expect((await http("/assets/rapier-abc.wasm.gz")).status).toBe(404);
  });

  it("reads Accept-Encoding with q-values and the * wildcard", () => {
    expect([...acceptedEncodings(undefined)]).toEqual([]);
    expect([...acceptedEncodings("gzip, deflate, br, zstd")].sort()).toEqual(["br", "gzip"]);
    expect([...acceptedEncodings("br;q=0")]).toEqual([]);
    expect([...acceptedEncodings("*")].sort()).toEqual(["br", "gzip"]);
    expect([...acceptedEncodings("*;q=0.1, br;q=0")]).toEqual(["gzip"]);
    expect([...acceptedEncodings("identity")]).toEqual([]);
  });

  it("answers 404 for missing assets, source maps and anything outside dist/", async () => {
    expect((await http("/assets/nope.js")).status).toBe(404);
    expect((await http("/assets/app-abc.js.map")).status).toBe(404);
    expect((await http("/assets/../../package.json")).status).toBe(404);
    expect((await http("/%2e%2e/%2e%2e/package.json")).status).toBe(404);
    expect((await http("/assets/no-extension")).status).toBe(404);
  });

  it("leaves the server's own routes alone", async () => {
    const tables = await http("/tables");
    expect(tables.status).toBe(200);
    expect(JSON.parse(tables.body)).toEqual({ tables: [] });
    expect((await http("/session/me")).status).toBe(401);
    expect((await http("/vendor/colyseus.js")).status).toBe(404); // the retired debug client's
  });

  it("still refuses a foreign Host header", async () => {
    expect((await http("/", { headers: { Host: "evil.example" } })).status).toBe(421);
  });
});

describe("the Vite proxy's origin", () => {
  const post = (origin: string) =>
    http("/session/logout", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });

  it("is accepted on state changes, as the server's own origin is", async () => {
    expect((await post(PROXY)).status).toBe(204);
    expect((await post(`http://${DEV_HOST}:${dev.port}`)).status).toBe(204);
  });

  it("does not open the door to anyone else", async () => {
    expect((await post("http://127.0.0.1:5174")).status).toBe(403);
    expect((await post("https://evil.example")).status).toBe(403);
  });

  it("must be a loopback http origin", async () => {
    const other = await openChipStore({ dataDir: null });
    try {
      await expect(
        startDevServer({
          port: 0,
          store: other,
          proxyOrigins: ["https://evil.example"],
          auth: { secret: randomBytes(32), turnstileSiteKey: "k", turnstile: { verify: async () => false } },
        }),
      ).rejects.toThrow(/proxy origin/);
    } finally {
      await other.close();
    }
  });
});
