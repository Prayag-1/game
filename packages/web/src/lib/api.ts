/**
 * The game server's HTTP routes, on this page's own origin (in dev through
 * the Vite proxy). The session cookie rides along because the request is
 * same-origin; nothing here ever sees or stores it (it is httpOnly).
 *
 * Every response is untrusted data: it is shape-checked here, and rendered
 * only as text.
 */

export interface Me {
  readonly id: string;
  readonly name: string;
  readonly balance: number;
}

export type Phase = "waiting" | "betting" | "throwing" | "revealing";
export type Preset = "default" | "simple";

export interface TableInfo {
  readonly id: string;
  readonly visibility: "public" | "private";
  readonly preset: Preset;
  readonly humans: number;
  readonly bots: number;
  readonly chyakhe: number;
  readonly phase: Phase;
  readonly stake: number;
  readonly room: number;
}

/** What a seat request returns. The reservation goes straight to the Colyseus client. */
export interface SeatGrant {
  readonly reservation: { readonly roomId: string; readonly sessionId: string; readonly [key: string]: unknown };
  readonly table: TableInfo;
  readonly code?: string;
  readonly shareUrl?: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string; readonly status: number };

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: unknown = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

function errorOf(status: number, json: unknown): string {
  if (status === 0) return "network";
  if (isRecord(json) && typeof json.error === "string" && /^[a-z0-9-]{1,40}$/.test(json.error)) return json.error;
  return `http-${status}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export function parseMe(v: unknown): Me | null {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.name) || !isInt(v.balance)) return null;
  return { id: v.id, name: v.name, balance: v.balance };
}

const PHASES: readonly string[] = ["waiting", "betting", "throwing", "revealing"];
export function parseTableInfo(v: unknown): TableInfo | null {
  if (!isRecord(v)) return null;
  const { id, visibility, preset, humans, bots, chyakhe, phase, stake, room } = v;
  if (!isStr(id) || (visibility !== "public" && visibility !== "private") || (preset !== "default" && preset !== "simple")) return null;
  if (!isInt(humans) || !isInt(bots) || !isInt(chyakhe) || !isInt(stake) || !isInt(room)) return null;
  if (!isStr(phase) || !PHASES.includes(phase)) return null;
  return { id, visibility, preset, humans, bots, chyakhe, phase: phase as Phase, stake, room };
}

function parseGrant(v: unknown): SeatGrant | null {
  if (!isRecord(v) || !isRecord(v.reservation)) return null;
  const table = parseTableInfo(v.table);
  const r = v.reservation;
  if (table === null || !isStr(r.roomId) || !isStr(r.sessionId)) return null;
  return {
    reservation: r as SeatGrant["reservation"],
    table,
    ...(isStr(v.code) ? { code: v.code } : {}),
    ...(isStr(v.shareUrl) ? { shareUrl: v.shareUrl } : {}),
  };
}

function wrap<T>(res: { status: number; json: unknown }, okStatus: readonly number[], parse: (v: unknown) => T | null): Result<T> {
  if (!okStatus.includes(res.status)) return { ok: false, error: errorOf(res.status, res.json), status: res.status };
  const value = parse(res.json);
  return value === null ? { ok: false, error: "malformed", status: res.status } : { ok: true, value };
}

export const api = {
  async me(): Promise<Result<Me>> {
    return wrap(await request("GET", "/session/me"), [200], parseMe);
  },
  async createGuest(name: string, turnstileToken: string): Promise<Result<Me>> {
    return wrap(await request("POST", "/session/guest", { name, turnstileToken }), [201], parseMe);
  },
  async logout(): Promise<Result<true>> {
    return wrap(await request("POST", "/session/logout", {}), [204], () => true);
  },
  async tables(): Promise<Result<TableInfo[]>> {
    return wrap(await request("GET", "/tables"), [200], (v) => {
      if (!isRecord(v) || !Array.isArray(v.tables)) return null;
      return v.tables.map(parseTableInfo).filter((t): t is TableInfo => t !== null);
    });
  },
  async quickPlay(): Promise<Result<SeatGrant>> {
    return wrap(await request("POST", "/tables/quickplay", {}), [200], parseGrant);
  },
  async joinPublic(tableId: string): Promise<Result<SeatGrant>> {
    return wrap(await request("POST", "/tables/public/join", { tableId }), [200], parseGrant);
  },
  async createPrivate(preset: Preset): Promise<Result<SeatGrant>> {
    return wrap(await request("POST", "/tables/private", { preset }), [201], parseGrant);
  },
  async joinByCode(code: string): Promise<Result<SeatGrant>> {
    return wrap(await request("POST", "/tables/join", { code }), [200], parseGrant);
  },
  async rejoin(): Promise<Result<SeatGrant>> {
    return wrap(await request("POST", "/tables/rejoin", {}), [200], parseGrant);
  },
};

/** The table code alphabet and length, as the server parses them (lobby/directory.ts). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normaliseCode(raw: string): string {
  return [...raw.trim().toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).join("").slice(0, 6);
}
