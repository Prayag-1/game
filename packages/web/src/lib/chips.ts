import { useSession } from "./session";
import { useTable } from "./table";

/**
 * My chips: the table's figure while connected (it moves every round), else
 * the account balance from /session/me. Both come from the server; the
 * client never computes a balance.
 */
export function useMyChips(): number | null {
  const me = useSession((s) => s.me);
  const view = useTable((s) => (s.conn === "connected" ? s.view : null));
  if (me === null) return null;
  const atTable = chipsInView(view, me.id);
  return atTable ?? me.balance;
}

function chipsInView(view: unknown, playerId: string): number | null {
  if (typeof view !== "object" || view === null) return null;
  const v = view as { seats?: unknown; chyakhe?: unknown };
  const players: unknown[] = [];
  if (typeof v.seats === "object" && v.seats !== null) players.push(...Object.values(v.seats));
  if (Array.isArray(v.chyakhe)) players.push(...(v.chyakhe as unknown[]));
  for (const p of players) {
    if (typeof p !== "object" || p === null) continue;
    const { playerId: id, chips } = p as { playerId?: unknown; chips?: unknown };
    if (id === playerId && typeof chips === "number" && Number.isSafeInteger(chips)) return chips;
  }
  return null;
}
