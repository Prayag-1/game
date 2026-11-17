import { useLayoutEffect, useRef } from "react";
import { COUNT, transfers, type Spot, type Transfer } from "../../lib/ceremony";
import type { Ceremony } from "../../lib/tableStore";
import { Term } from "../Term";

/**
 * The chips moving: small brass tokens travelling across the screen between
 * the seat panels (and the outside bets' tokens at the board's edge), in the
 * DOM above the canvas. They carry no amounts: who pays whom is read off the
 * round (ceremony.ts transfers), and the numbers that float by the panels
 * when they land are the server's deltas.
 *
 * Shown only during the chips step, and never under reduced motion.
 */
export function ChipFlights({ ceremony }: { readonly ceremony: Ceremony | null }) {
  if (ceremony === null || ceremony.reduced || ceremony.stage !== "chips") return null;
  const list = transfers(ceremony.round, ceremony.ghantiChips);
  return (
    <div className="pointer-events-none fixed inset-0 z-40" data-testid="chip-flights" aria-hidden="true">
      {list.map((tr, i) => (
        <Token key={i} transfer={tr} delay={tr.kind === "ghanti" ? COUNT.travelMs * 0.35 : 0} />
      ))}
    </div>
  );
}

const describe = (s: Spot) => ("bet" in s ? `bet:${s.bet}` : `seat:${s.seat}`);

/** The middle of a panel or a bet token on screen, if it is there. */
function centreOf(s: Spot): { x: number; y: number } | null {
  const el =
    "bet" in s
      ? [...document.querySelectorAll<HTMLElement>("[data-bet-token]")].find((e) => e.getAttribute("data-bet-token") === s.bet)
      : document.querySelector<HTMLElement>(`[data-testid="seat-${s.seat}"]`);
  if (el === undefined || el === null) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function Token({ transfer, delay }: { readonly transfer: Transfer; readonly delay: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const from = centreOf(transfer.from);
    const to = centreOf(transfer.to);
    if (from === null || to === null) {
      el.style.opacity = "0";
      return;
    }
    el.style.transform = `translate(${from.x}px, ${from.y}px)`;
    // A bet that is not at risk does not travel: it fades where it is, back to its bettor.
    const end = transfer.kind === "return" ? { opacity: "0", transform: el.style.transform } : { opacity: "1", transform: `translate(${to.x}px, ${to.y}px)` };
    const frame = requestAnimationFrame(() => {
      el.style.transition = `transform ${COUNT.travelMs - delay}ms cubic-bezier(.45,.05,.3,1) ${delay}ms, opacity ${COUNT.travelMs}ms ease-out`;
      el.style.transform = end.transform;
      el.style.opacity = end.opacity;
    });
    return () => cancelAnimationFrame(frame);
  }, [transfer, delay]);
  return (
    <div ref={ref} className="absolute top-0 left-0" data-chip-token={transfer.kind} data-from={describe(transfer.from)} data-to={describe(transfer.to)}>
      <span className="-mt-2 -ml-2 block h-4 w-4 rounded-full border border-brass-bright bg-brass shadow-glow-brass" />
      {transfer.kind === "ghanti" && (
        <span className="absolute top-3 -left-4 rounded-full bg-panel-strong px-1.5 text-[0.65rem] text-brass">
          <Term id="ghanti" quiet />
        </span>
      )}
    </div>
  );
}
