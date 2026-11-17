import { useSession } from "./session";
import { myPlayerIn, useTable } from "./tableStore";
import { shownChips, useCeremonyNow } from "./useCeremony";

/**
 * My chips: the table's figure while connected (it moves every round), else
 * the account balance from /session/me. Both come from the server; the
 * client never computes a balance. After a round, the figure ticks from the
 * server's balance before it to the server's balance after it, as the
 * chips arrive (lib/ceremony.ts).
 */
export function useMyChips(): number | null {
  const me = useSession((s) => s.me);
  const atTable = useTable((s) => (s.conn === "connected" ? (myPlayerIn(s.view, me?.id ?? null)?.chips ?? null) : null));
  const ceremony = useTable((s) => s.ceremony);
  const now = useCeremonyNow(ceremony);
  if (me === null) return null;
  if (atTable === null) return me.balance;
  return shownChips(ceremony, me.id, atTable, now);
}
