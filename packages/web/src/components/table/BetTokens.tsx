import type { SeatId } from "@kauda/rules";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Side } from "../../lib/board";
import { numberFormat } from "../../lib/format";

export interface BoardBet {
  readonly playerId: string;
  readonly seat: SeatId;
  readonly chips: number;
}

/** Where each side's bets sit: at the board's edge, beside the seat they back (DOM over the board). */
const SIDE_SPOT: Record<Side, string> = {
  bottom: "bottom-[20%] left-1/2 -translate-x-1/2 flex-row",
  top: "top-[14%] left-1/2 -translate-x-1/2 flex-row",
  left: "left-[7%] top-[42%] -translate-y-1/2 flex-col",
  right: "right-[7%] top-[42%] -translate-y-1/2 flex-col",
};

/**
 * The outside bets, on the board: a small brass token with its amount at
 * the board's edge beside the seat it backs, for everyone at the table to
 * see. My own is ringed. The bettor's name on hover, or on a tap.
 *
 * These are the tokens the chips step moves (ChipFlights finds them by
 * data-bet-token).
 */
export function BetTokens({
  bets,
  sides,
  names,
  myId,
}: {
  readonly bets: readonly BoardBet[];
  readonly sides: Readonly<Record<SeatId, Side>>;
  readonly names: Readonly<Record<string, string>>;
  readonly myId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const fmt = numberFormat(i18n.language);
  const [open, setOpen] = useState<string | null>(null);
  if (bets.length === 0) return null;
  const bySide = new Map<Side, BoardBet[]>();
  for (const b of bets) bySide.set(sides[b.seat], [...(bySide.get(sides[b.seat]) ?? []), b]);
  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-testid="bet-tokens">
      {[...bySide].map(([side, list]) => (
        <div key={side} className={`absolute flex items-center gap-1 ${SIDE_SPOT[side]}`}>
          {list.map((b) => {
            const mine = b.playerId === myId;
            const name = mine ? t("play.you") : (names[b.playerId] ?? "?");
            const label = t("play.betBy", { name, chips: fmt.format(b.chips) });
            return (
              <span key={b.playerId} className="relative">
                <button
                  type="button"
                  data-bet-token={b.playerId}
                  data-seat={b.seat}
                  data-mine={mine ? "true" : undefined}
                  title={label}
                  aria-label={mine ? `${t("play.myBet")}: ${label}` : label}
                  onClick={() => setOpen((o) => (o === b.playerId ? null : b.playerId))}
                  onBlur={() => setOpen(null)}
                  className={`pointer-events-auto min-w-7 rounded-full bg-brass px-1.5 text-[0.7rem] leading-5 font-semibold text-bg tabular-nums shadow-panel ${
                    mine ? "ring-2 ring-ink ring-offset-1 ring-offset-bg" : ""
                  }`}
                >
                  {fmt.format(b.chips)}
                </button>
                {open === b.playerId && (
                  <span role="tooltip" className="absolute top-full left-1/2 z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded-control bg-panel-strong px-2 py-0.5 text-xs text-ink shadow-panel">
                    {label}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
