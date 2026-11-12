import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openChipStore } from "../src/db/open.js";
import type { DrizzleChipStore } from "../src/db/store.js";
import { DEV_HOST, startDevServer, type DevServer } from "../src/devServer.js";

/**
 * The dev server itself: where it listens, and how it locks itself to its own
 * origin. The web client's end-to-end tests are in packages/web/e2e
 * (Playwright, against this server).
 */
let dev: DevServer;
let store: DrizzleChipStore;

beforeAll(async () => {
  store = await openChipStore({ dataDir: null });
  dev = await startDevServer({
    port: 0,
    store,
    auth: { secret: randomBytes(32), turnstileSiteKey: "test-site-key", turnstile: { verify: async (tok) => tok === "good-token" } },
    room: {
      tickMs: 20,
      table: { timings: { bettingMs: 400, throwingMs: 700, revealMs: 300, botThrowDelayMs: 60, botBetDelayMs: 60 } },
    },
  });
});
afterAll(async () => {
  await dev.close();
  await store.close();
});

const own = () => `http://${DEV_HOST}:${dev.port}`;
interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}
function http(path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: DEV_HOST, port: dev.port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A raw websocket upgrade: resolves to the HTTP status the server answers with. */
function upgrade(origin: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    };
    if (origin !== null) headers.Origin = origin;
    const req = request({ host: DEV_HOST, port: dev.port, path: "/abc123?sessionId=x", headers });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("dev server", () => {
  it("listens on 127.0.0.1 only", () => {
    const address = (dev.server.transport as unknown as { server: { address(): AddressInfo } }).server.address();
    expect(address.address).toBe("127.0.0.1");
  });

  it("serves no page of its own: the web client is served by Vite in dev, or with `web`", async () => {
    expect((await http("/")).status).toBe(404);
    expect((await http("/debug")).status).toBe(404);
    expect((await http("/vendor/colyseus.js")).status).toBe(404);
  });

  it("refuses pages for any other Host, against DNS rebinding", async () => {
    expect((await http("/", { headers: { Host: `evil.example:${dev.port}` } })).status).toBe(421);
  });

  it("refuses a websocket upgrade from another origin, or with no origin", async () => {
    expect(await upgrade("http://evil.example")).toBe(401);
    expect(await upgrade(`http://${DEV_HOST}:${dev.port + 1}`)).toBe(401);
    expect(await upgrade(null)).toBe(401);
    expect(await upgrade(own())).toBe(101);
  });

  it("answers matchmaking CORS only for its own origin", async () => {
    const preflight = (origin: string) =>
      http("/matchmake/joinOrCreate/kauda", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
    expect((await preflight("http://evil.example")).headers["access-control-allow-origin"]).not.toBe("http://evil.example");
    expect((await preflight(own())).headers["access-control-allow-origin"]).toBe(own());
  });
});
