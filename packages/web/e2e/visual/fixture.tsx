/**
 * VISUAL BASELINES ONLY. Never part of the app build.
 *
 * Renders the real <App> (real components, real CSS, real fonts) from fixed
 * data, so a screenshot changes only when the UI does. The session and lobby
 * come from a stubbed fetch; the table from the real store, fed through
 * ingest() exactly as the socket adapter feeds it. The rounds are played
 * through @kauda/rules from fixed seeds, so their deltas, hashes and the
 * browser's fairness check are all genuine.
 *
 *   ?screen=signin | lobby | table
 */
import { DEFAULT_HOUSE_RULES, SHELL_COUNT, seatForFaceCount, settleRound, type SeatId } from "@kauda/rules";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App } from "../../src/App";
import { initI18n } from "../../src/i18n";
import { ingest, useTable } from "../../src/lib/tableStore";
import "../../src/index.css";

const screen = new URLSearchParams(window.location.search).get("screen") ?? "signin";
const ME = { id: "guest:sita", name: "सीता", balance: 1_990 };

// ------------------------------------------------------------- the server

const TABLES = [
  { id: "Hx7Kq2mPa", visibility: "public", preset: "default", humans: 3, bots: 3, chyakhe: 2, phase: "betting", stake: 20, room: 5 },
  { id: "Rb4Tn8wLc", visibility: "public", preset: "simple", humans: 1, bots: 4, chyakhe: 1, phase: "revealing", stake: 10, room: 7 },
  { id: "Mz9Pv3sDe", visibility: "public", preset: "default", humans: 8, bots: 4, chyakhe: 8, phase: "throwing", stake: 40, room: 0 },
];

window.fetch = async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (path === "/session/me") return screen === "signin" ? json(401, { error: "no-session" }) : json(200, ME);
  if (path === "/session/config") return json(200, { turnstileSiteKey: "fixture" });
  if (path === "/tables") return json(200, { tables: TABLES });
  return json(404, { error: "not-found" });
};

/** Stands in for Cloudflare's widget: a box of the same size, so the layout is real. */
window.turnstile = {
  render(container, options) {
    const box = document.createElement("div");
    box.className = "flex h-[65px] w-[300px] max-w-full items-center gap-3 rounded-md border border-line-strong bg-bg/70 px-4 text-sm text-ink-muted";
    const tick = document.createElement("span");
    tick.className = "font-bold text-ok";
    tick.textContent = "✓";
    box.append(tick, "Turnstile");
    container.append(box);
    queueMicrotask(() => options.callback("fixture-token"));
    return "fixture";
  },
  reset() {},
  remove() {},
};

// -------------------------------------------------------------- the table

const SEATS = {
  teeya: { playerId: ME.id, name: ME.name, isBot: false, connected: true },
  chauka: { playerId: "bot:t:1", name: "Bishnu (bot)", isBot: true, connected: true },
  panja: { playerId: "guest:hari", name: "हरि", isBot: false, connected: true },
  chakka: { playerId: "bot:t:2", name: "Ganga (bot)", isBot: true, connected: true },
} as const;
const CHYAKHE = [
  { playerId: "guest:maya", name: "माया", isBot: false, connected: true },
  { playerId: "bot:t:3", name: "Kamal (bot)", isBot: true, connected: true },
];
const RULES = DEFAULT_HOUSE_RULES;
const occupants = Object.fromEntries(Object.entries(SEATS).map(([seat, p]) => [seat, p.playerId])) as Record<SeatId, string>;

/** A fixed seed: 32 bytes from a counter, no randomness. Shell i is up when byte i is odd. */
function seedFor(n: number): Uint8Array {
  const bytes = new Uint8Array(32);
  let x = (n * 2654435761) >>> 0;
  for (let i = 0; i < 32; i += 1) {
    x = (Math.imul(x ^ (x >>> 15), 2246822519) + 3266489917) >>> 0;
    bytes[i] = x & 0xff;
  }
  return bytes;
}
const facesOf = (seed: Uint8Array) => Array.from({ length: SHELL_COUNT }, (_, i) => ((seed[i] ?? 0) & 1) === 1);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256(b: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>)));
}

async function playTable(): Promise<void> {
  const chips: Record<string, number> = { [ME.id]: 2_000, "bot:t:1": 2_000, "guest:hari": 2_000, "bot:t:2": 2_000, "guest:maya": 2_000, "bot:t:3": 2_000 };
  const rounds = [];
  let thrower: SeatId = "panja";
  let streak = 0;
  let n = 1;
  // Six rounds as they fall, then a seventh that is a hit, so the board shows one.
  for (let r = 1; r <= 7; r += 1) {
    let seed = seedFor(n++);
    if (r === 7) while (seatForFaceCount(facesOf(seed).filter(Boolean).length) !== thrower) seed = seedFor(n++);
    const chyakhe = r === 3 ? [{ playerId: "guest:maya", seat: thrower === "chakka" ? "teeya" : ("chakka" as SeatId), chips: 30 }] : [];
    const faces = facesOf(seed);
    const outcome = settleRound({ thrower, occupants, chyakhe, streak, rules: RULES, faces });
    for (const [id, d] of Object.entries(outcome.deltas)) chips[id] = (chips[id] ?? 0) + d;
    rounds.push({
      roundId: `fixture:${r}`,
      seed: hex(seed),
      commitHash: await sha256(seed),
      faces,
      faceUp: outcome.faceUp,
      winningSeat: outcome.winningSeat,
      hit: outcome.hit,
      stake: outcome.stake,
      multiplier: outcome.stakeMultiplier,
      deltas: outcome.deltas,
      at: 1_700_000_000_000 + r * 20_000,
      thrower,
      streak,
      occupants,
      chyakhe,
      rules: RULES,
    });
    thrower = outcome.nextThrower;
    streak = outcome.nextStreak;
  }

  // The page saw each commitment published before its reveal.
  useTable.setState({
    conn: "connected",
    tableId: "Hx7Kq2mPa",
    published: Object.fromEntries(rounds.map((r) => [r.roundId, r.commitHash])),
  });
  ingest("welcome", { playerId: ME.id, name: ME.name, minChipsToSit: 80, standardBuyIn: 2_000 });
  for (const r of rounds) ingest("round", r);
  const player = (p: { playerId: string; name: string; isBot: boolean; connected: boolean }) => ({ ...p, chips: chips[p.playerId] ?? 0 });
  ingest("view", {
    tableId: "Hx7Kq2mPa",
    phase: "revealing",
    roundId: "fixture:7",
    thrower,
    streak,
    stake: RULES.thini * Math.min(2 ** streak, RULES.maxStakeMultiplier),
    commitHash: null,
    seats: Object.fromEntries(Object.entries(SEATS).map(([seat, p]) => [seat, player(p)])),
    chyakhe: CHYAKHE.map(player),
    bets: [],
    phaseEndsAt: Date.now() + 3_000,
    reservations: [],
    lastRound: rounds.at(-1),
    rules: RULES,
  });
  // Let the browser finish checking every seed before the page says it is ready.
  for (let i = 0; i < 100 && Object.keys(useTable.getState().fairness).length < rounds.length; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------- render

async function main(): Promise<void> {
  initI18n("ne");
  if (screen === "table") await playTable();
  const root = document.getElementById("root");
  if (root === null) throw new Error("no #root");
  createRoot(root).render(
    <StrictMode>
      <MemoryRouter initialEntries={[screen === "table" ? "/table/Hx7Kq2mPa" : "/"]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  );
  await document.fonts.ready;
  document.documentElement.dataset.ready = "true";
}

void main();
