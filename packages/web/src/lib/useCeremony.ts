import { useEffect, useState } from "react";
import { chipsAt, COUNT } from "./ceremony";
import type { Ceremony } from "./tableStore";

/**
 * The clock the chips tick by: fresh at each step, and every 40 ms while
 * the chips are ticking to their new values, idle otherwise.
 */
export function useCeremonyNow(c: Ceremony | null): number {
  const [now, setNow] = useState(() => Date.now());
  const stage = c?.stage ?? null;
  const tickEnd = c === null ? null : c.sched.arriveAt + COUNT.tickMs;
  useEffect(() => {
    setNow(Date.now());
    if (stage !== "arrived" || tickEnd === null) return;
    const timer = setInterval(() => setNow(Date.now()), 40);
    // And once exactly at the end, so the server's final figure lands on time.
    const last = setTimeout(() => setNow(Date.now()), Math.max(0, tickEnd - Date.now()));
    return () => {
      clearInterval(timer);
      clearTimeout(last);
    };
  }, [stage, tickEnd]);
  return now;
}

/**
 * The chips a panel shows: the server's balance before the round until the
 * tokens arrive, then ticking to the server's balance now (`after`). Outside
 * the steps, simply `after`. Never computed: only ever between two of the
 * server's own numbers.
 */
export function shownChips(c: Ceremony | null, playerId: string, after: number, now: number): number {
  if (c === null) return after;
  const before = c.before[playerId];
  return before === undefined ? after : chipsAt(before, after, c.sched, now);
}

/** "+30" or "−10" (a true minus sign), in the page's digits. */
export function signed(delta: number, format: (n: number) => string): string {
  return `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))}`;
}
