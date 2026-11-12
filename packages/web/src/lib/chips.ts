import { useSession } from "./session";
import { myPlayerIn, useTable } from "./tableStore";

/**
 * My chips: the table's figure while connected (it moves every round), else
 * the account balance from /session/me. Both come from the server; the
 * client never computes a balance.
 */
export function useMyChips(): number | null {
  const me = useSession((s) => s.me);
  const atTable = useTable((s) => (s.conn === "connected" ? (myPlayerIn(s.view, me?.id ?? null)?.chips ?? null) : null));
  if (me === null) return null;
  return atTable ?? me.balance;
}
