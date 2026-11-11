import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import * as jsdom from "jsdom";
import { CookieJar, JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openChipStore } from "../src/db/open.js";
import type { DrizzleChipStore } from "../src/db/store.js";
import { DEV_HOST, contentSecurityPolicy, startDevServer, type DevServer } from "../src/devServer.js";

/**
 * The dev server and the debug client, end to end: real HTTP, real sockets,
 * and the real page running in jsdom against them. Fast timings, so rounds
 * settle in well under a second.
 */
let dev: DevServer;
let store: DrizzleChipStore;
const HTML = readFileSync(fileURLToPath(new URL("../debug-client/index.html", import.meta.url)), "utf8");

beforeAll(async () => {
  store = await openChipStore({ dataDir: null });
  dev = await startDevServer({
    port: 0,
    store,
    // The page's Turnstile widget is stubbed below to produce "good-token".
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

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

  it("serves the page with a strict CSP whose hash matches the inline script", async () => {
    const res = await http("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    // Hash the script and style the way a browser does: their exact text.
    const dom = new JSDOM(res.body);
    const inline = dom.window.document.querySelector("script:not([src])")?.textContent ?? "";
    const style = dom.window.document.querySelector("style")?.textContent ?? "";
    const b64 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");
    expect(csp).toContain(`script-src 'self' https://challenges.cloudflare.com 'sha256-${b64(inline)}'`);
    expect(csp).toContain(`style-src 'sha256-${b64(style)}'`);
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    dom.window.close();
  });

  it("hashes as a browser does, so a CRLF checkout still matches", () => {
    // Git on Windows may check the page out with CRLF; the HTML parser turns
    // it back into LF before the browser hashes the inline script and style.
    const crlf = HTML.replace(/\r?\n/g, "\r\n");
    const lf = HTML.replace(/\r\n/g, "\n");
    expect(contentSecurityPolicy(crlf, 3000)).toBe(contentSecurityPolicy(lf, 3000));
    const doc = new JSDOM(crlf).window.document;
    const b64 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");
    const csp = contentSecurityPolicy(crlf, 3000);
    expect(csp).toContain(`'sha256-${b64(doc.querySelector("script:not([src])")?.textContent ?? "")}'`);
    expect(csp).toContain(`'sha256-${b64(doc.querySelector("style")?.textContent ?? "")}'`);
  });

  it("serves the Colyseus browser SDK from /vendor", async () => {
    const res = await http("/vendor/colyseus.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.body).toContain("Colyseus");
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

describe("debug client page", () => {
  it("never parses server data as HTML", () => {
    expect(HTML).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    expect(HTML).toContain("never expose it to");
    // No token of its own: identity is the httpOnly session cookie.
    expect(HTML).not.toMatch(/kauda\.dev\.token|getRandomValues/);
  });

  /**
   * Stands in for Cloudflare's Turnstile script, so the test never touches the
   * network; everything else loads from the dev server as usual. The stub
   * widget hands the page "good-token", as the real one does once a visitor
   * passes the check. (jsdom 29's requestInterceptor postdates @types/jsdom.)
   */
  const TURNSTILE_STUB = `window.turnstile = {
    render(el, opts) { setTimeout(() => opts.callback("good-token"), 10); return "w1"; },
    reset() {},
  };`;
  const interceptor = (jsdom as unknown as {
    requestInterceptor(fn: (request: Request) => Response | undefined): unknown;
  }).requestInterceptor((request) =>
    request.url.startsWith("https://challenges.cloudflare.com/")
      ? new Response(TURNSTILE_STUB, { headers: { "Content-Type": "text/javascript" } })
      : undefined,
  );

  /**
   * Browsers send Origin on every POST, same-origin ones included (Fetch
   * spec), and the server refuses a state change without it. jsdom's XHR
   * leaves it out, so add it here, the way a browser would. The server stays
   * strict; only the test's browser is made to behave like a real one.
   */
  type Dispatch = (opts: { method?: string; headers?: unknown }, handler: unknown) => boolean;
  const browserOrigin = (dispatch: Dispatch): Dispatch => (opts, handler) => {
    if (opts.method === "GET" || opts.method === "HEAD") return dispatch(opts, handler);
    const headers = opts.headers;
    const withOrigin = Array.isArray(headers)
      ? [...(headers as string[]), "origin", own()]
      : { ...(headers as Record<string, string> | undefined), origin: own() };
    return dispatch({ ...opts, headers: withOrigin }, handler);
  };

  /** Loads the real page from the dev server, as a browser would, sharing a cookie jar. */
  async function openPage(cookieJar: CookieJar, path = "/"): Promise<JSDOM> {
    const dom = await JSDOM.fromURL(own() + path, {
      runScripts: "dangerously",
      resources: { interceptors: [interceptor, browserOrigin] } as unknown as "usable",
      cookieJar,
      pretendToBeVisual: true,
      beforeParse(window) {
        // jsdom lacks these; a real browser on 127.0.0.1 has them.
        const w = window as unknown as Record<string, unknown> & { crypto: Crypto };
        if (w.crypto.subtle === undefined) Object.defineProperty(w.crypto, "subtle", { value: globalThis.crypto.subtle });
        w.Headers ??= globalThis.Headers;
      },
    });
    await new Promise<void>((r) => dom.window.addEventListener("load", () => r()));
    return dom;
  }

  const text = (dom: JSDOM, id: string) => dom.window.document.getElementById(id)?.textContent ?? "";
  const seatCard = (dom: JSDOM, i: number) => dom.window.document.querySelectorAll("#seats .seat")[i] as HTMLElement;

  /** Signs up as a new guest on a page showing the sign-up form. */
  async function signUp(dom: JSDOM, name: string): Promise<void> {
    const doc = dom.window.document;
    const join = doc.getElementById("join") as HTMLButtonElement;
    await until(() => doc.getElementById("join-panel")?.hidden === false, "the sign-up form");
    await until(() => !join.disabled, "the Turnstile widget to pass");
    (doc.getElementById("name") as HTMLInputElement).value = name;
    join.click();
    await until(
      () => doc.getElementById("lobby-panel")?.hidden === false || text(dom, "conn") === "connected",
      "the lobby, or the table a shared link names",
    );
  }

  const click = (dom: JSDOM, id: string) => (dom.window.document.getElementById(id) as HTMLButtonElement).click();

  /** From the lobby, Quick Play, and wait to be at the table. */
  async function quickPlay(dom: JSDOM): Promise<void> {
    await until(() => dom.window.document.getElementById("lobby-panel")?.hidden === false, "the lobby");
    click(dom, "quickplay");
    await until(() => text(dom, "conn") === "connected", "the page to connect");
  }

  it("signs up, plays rounds, verifies every seed, sits, throws, comes back after a refresh, and logs out", async () => {
    const jar = new CookieJar();
    const dom = await openPage(jar);
    const doc = dom.window.document;
    await signUp(dom, "हरि Test");
    await quickPlay(dom);
    // The session cookie is httpOnly: in the jar, invisible to the page.
    expect(jar.getCookieStringSync(own())).toMatch(/kauda_session=/);
    expect(doc.cookie).toBe("");
    await until(() => (seatCard(dom, 0).textContent ?? "").includes("bot"), "bots in the seats");
    expect(text(dom, "me-name")).toBe("हरि Test");
    expect(text(dom, "me-chips")).toBe("2000");
    for (let i = 0; i < 4; i += 1) expect(seatCard(dom, i).textContent).toMatch(/तीया|चौका|पञ्जा|छक्का/);

    // A round settles: logged, shells drawn, and the seed checked in the page.
    await until(() => doc.querySelectorAll("#log li").length >= 1, "a settled round in the log");
    await until(() => doc.querySelectorAll("#log li .ok").length >= 1, "the log's seed check");
    expect(doc.querySelectorAll("#log li .bad")).toHaveLength(0);
    expect(text(dom, "log")).toMatch(/मा-र्यो|ति-र्यो/);
    await until(() => text(dom, "reveal-line").includes("matches the round's commitHash"), "the reveal check");
    expect(doc.querySelectorAll("#reveal-line .bad")).toHaveLength(0);
    expect(doc.querySelectorAll("#shells .shell")).toHaveLength(16);

    // Sit on teeya: between rounds it is direct, mid-round a reservation.
    const sit = seatCard(dom, 0).querySelector("button") as HTMLButtonElement;
    expect(sit.hidden).toBe(false);
    sit.click();
    await until(() => (seatCard(dom, 0).textContent ?? "").includes("you"), "A on teeya");
    expect(text(dom, "me-where")).toBe("on तीया");

    // Throw when it is ours; the Throw button is enabled only then.
    const throwBtn = doc.getElementById("throw") as HTMLButtonElement;
    await until(() => !throwBtn.disabled, "our turn to throw", 20_000);
    const before = doc.querySelectorAll("#log li").length;
    throwBtn.click();
    await until(() => doc.querySelectorAll("#log li").length > before, "our throw to settle");

    // Refresh: a new page with the same cookies is the same player, same seat,
    // straight away and with no sign-up.
    const again = await openPage(jar);
    await until(() => text(again, "conn") === "connected", "the refreshed page to reconnect");
    expect(again.window.document.getElementById("join-panel")?.hidden).toBe(true);
    await until(() => (seatCard(again, 0).textContent ?? "").includes("you"), "the same seat after refresh");
    expect(text(again, "me-name")).toBe("हरि Test");
    // Two tabs are one player: the old page was replaced, and says so.
    await until(() => text(dom, "conn") === "replaced", "the old page to be replaced");
    expect(dom.window.document.getElementById("banner")?.hidden).toBe(false);

    // Simulated drop: banner, held seat, then Reconnect brings it back.
    (again.window.document.getElementById("drop") as HTMLButtonElement).click();
    await until(() => text(again, "conn") === "dropped", "the simulated drop");
    expect(again.window.document.getElementById("banner")?.hidden).toBe(false);
    (again.window.document.getElementById("reconnect") as HTMLButtonElement).click();
    await until(() => text(again, "conn") === "connected", "the reconnect");
    await until(() => (seatCard(again, 0).textContent ?? "").includes("you"), "the seat after reconnecting");

    // Logout, then a new guest: a fresh account with a fresh buy-in.
    (again.window.document.getElementById("logout") as HTMLButtonElement).click();
    await until(() => again.window.document.getElementById("join-panel")?.hidden === false, "the sign-up form after logout");
    expect(jar.getCookieStringSync(own())).not.toMatch(/kauda_session=/);
    await signUp(again, "Sita New");
    await quickPlay(again);
    await until(() => text(again, "me-name") === "Sita New", "the new guest's name");
    await until(() => text(again, "me-chips") === "2000", "the new guest's buy-in");
    expect(text(again, "me-where")).toBe("chyakhe");
    const named = ((await store.db.execute(
      sql`SELECT display_name, balance FROM accounts WHERE display_name IN ('हरि Test', 'Sita New') ORDER BY display_name`,
    )) as unknown as { rows: { display_name: string; balance: string | number }[] }).rows;
    expect(named.map((r) => r.display_name).sort()).toEqual(["Sita New", "हरि Test"]); // two accounts
    expect(Number(named.find((r) => r.display_name === "Sita New")?.balance)).toBe(2000);

    dom.window.close();
    again.window.close();
  }, 60_000);

  it("creates a private table whose share link takes a friend straight to it, and Leave Table returns to the lobby", async () => {
    const host = await openPage(new CookieJar());
    await signUp(host, "Host One");
    (host.window.document.getElementById("preset") as HTMLSelectElement).value = "simple";
    click(host, "create-private");
    await until(() => text(host, "conn") === "connected", "the host at the private table");
    await until(() => host.window.document.getElementById("share")?.hidden === false, "the share link");
    const code = text(host, "share-code");
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(text(host, "share-url")).toBe(`${own()}/?code=${code}`);
    // The lobby never lists it (other tests' public tables may well be there).
    const privateId = dev.directory.byCode(code)?.roomId;
    expect(privateId).toBeDefined();
    const listed = ((await (await fetch(`${own()}/tables`)).json()) as { tables: { id: string }[] }).tables;
    expect(listed.map((x) => x.id)).not.toContain(privateId);

    // A friend opens the link, signs up, and lands at that table with no lobby in between.
    const friend = await openPage(new CookieJar(), `/?code=${code}`);
    await signUp(friend, "Friend Two");
    await until(() => text(friend, "conn") === "connected", "the friend at the table");
    expect(text(friend, "share-code")).toBe(code);
    expect(friend.window.location.search).toBe(""); // the code is used once, not kept in the address
    // Same table: the server has both of them at the table behind the code.
    const names = () => {
      const v = dev.directory.byCode(code)?.table.view();
      return v === undefined ? [] : [...Object.values(v.seats), ...v.chyakhe].flatMap((p) => (p === null ? [] : [p.name]));
    };
    await until(() => names().includes("Friend Two") && names().includes("Host One"), "both at the private table");

    // Leave Table: back to the lobby, off the table.
    click(friend, "leave");
    await until(() => friend.window.document.getElementById("lobby-panel")?.hidden === false, "the friend's lobby");
    expect(friend.window.document.getElementById("table-panel")?.hidden).toBe(true);

    host.window.close();
    friend.window.close();
  }, 60_000);
});
