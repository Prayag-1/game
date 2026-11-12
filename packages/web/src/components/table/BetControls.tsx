import { TURN_ORDER, type SeatId } from "@kauda/rules";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Phase } from "../../lib/protocol";
import { input } from "../ui";

export interface BetControlsProps {
  readonly phase: Phase;
  readonly thrower: SeatId | null;
  /** Seats with someone in them; a bet on an empty seat is refused. */
  readonly occupied: Readonly<Record<SeatId, boolean>>;
  readonly thini: number;
  readonly myChips: number;
  readonly myBet: { readonly seat: SeatId; readonly chips: number } | null;
  readonly chyakheEnabled: boolean;
  readonly onBet: (seat: SeatId, chips: number) => void;
  readonly onClear: () => void;
}

/**
 * Whether the Bet button for a seat is enabled. The server decides in the
 * end; this only keeps buttons it would refuse from looking pressable.
 */
export function betEnabled(p: Pick<BetControlsProps, "phase" | "thrower" | "occupied" | "chyakheEnabled">, seat: SeatId, amount: number, myChips: number): boolean {
  return (
    p.chyakheEnabled &&
    p.phase === "betting" &&
    p.thrower !== null &&
    seat !== p.thrower &&
    p.occupied[seat] &&
    Number.isSafeInteger(amount) &&
    amount >= 1 &&
    amount <= myChips
  );
}

/** For a chyakhe (unseated): an amount, and a Bet button per seat. */
export function BetControls(props: BetControlsProps) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(String(props.thini));
  const amount = /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  const open = props.phase === "betting";
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor="bet-amount" className="text-sm text-ink-muted">
          {t("play.betAmount")}
        </label>
        <input
          id="bet-amount"
          inputMode="numeric"
          pattern="[0-9]*"
          value={raw}
          onChange={(e) => setRaw(e.target.value.replace(/\D/g, "").slice(0, 12))}
          className={`${input} w-24 py-1 font-semibold text-brass tabular-nums`}
        />
        {!open && <span className="text-xs text-ink-muted">{t("play.betsClosed")}</span>}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {TURN_ORDER.map((seat) => (
          <button
            key={seat}
            type="button"
            data-testid={`bet-${seat}`}
            disabled={!betEnabled(props, seat, amount, props.myChips)}
            onClick={() => props.onBet(seat, amount)}
            className="rounded-control border border-brass/55 bg-brass/10 px-1 py-2 text-sm font-semibold text-brass transition-colors duration-200 hover:border-brass-bright hover:bg-brass/20 hover:text-brass-bright disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-muted disabled:opacity-60"
          >
            {t("play.betOn", { seat: t(`terms.${seat}.label`) })}
          </button>
        ))}
      </div>
      {props.myBet !== null && (
        <div className="flex items-center gap-2 text-sm text-ink" data-testid="my-bet">
          <span>{t("play.yourBet", { chips: props.myBet.chips, seat: t(`terms.${props.myBet.seat}.label`) })}</span>
          <button
            type="button"
            onClick={props.onClear}
            disabled={!open}
            className="rounded-control border border-line-strong px-2 py-0.5 text-xs text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            {t("play.clearBet")}
          </button>
        </div>
      )}
    </section>
  );
}
