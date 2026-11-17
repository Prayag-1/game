import { numberFormat } from "../../lib/format";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Phase } from "../../lib/protocol";

/** Seconds left until `endsAt` (server ms since epoch), ticking. */
export function useCountdown(endsAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [endsAt]);
  return endsAt === null ? null : Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export interface PhaseBarProps {
  readonly phase: Phase;
  readonly phaseEndsAt: number | null;
  readonly stake: number;
  readonly multiplier: number;
  /** The stake has doubled as far as the house rules let it. */
  readonly atCap?: boolean;
}

/** A quiet strip over the board: the phase, its countdown, and the stake. */
export function PhaseBar({ phase, phaseEndsAt, stake, multiplier, atCap = false }: PhaseBarProps) {
  const { t, i18n } = useTranslation();
  const seconds = useCountdown(phaseEndsAt);
  const fmt = numberFormat(i18n.language);
  return (
    <div className="flex items-center gap-3 rounded-full border border-line bg-panel px-4 py-1.5 text-sm shadow-panel backdrop-blur-md">
      <span className="font-semibold text-ink" data-testid="phase" data-phase={phase}>
        {t(`phase.${phase}`)}
      </span>
      {seconds !== null && (
        <span className="text-brass tabular-nums" data-testid="countdown">
          {t("play.phaseEnds", { seconds: fmt.format(seconds) })}
        </span>
      )}
      <span className="ml-auto text-ink tabular-nums" title={t("play.stakeTip")} data-testid="stake">
        <span className="text-ink-muted">{t("play.stake")}</span> <span className="font-semibold">{fmt.format(stake)}</span>{" "}
        {/* A short pulse each time the stake doubles. */}
        <span key={multiplier} className={`inline-block font-semibold text-brass ${multiplier > 1 ? "animate-pulse-once" : ""}`} data-testid="multiplier" data-multiplier={multiplier}>
          {t("play.multiplier", { n: fmt.format(multiplier) })}
        </span>
        {atCap && (
          <span className="ml-1 rounded-full border border-brass/50 px-1.5 text-xs text-brass" title={t("play.stakeCapTip")} data-testid="stake-cap">
            {t("play.stakeCap")}
          </span>
        )}
      </span>
    </div>
  );
}
