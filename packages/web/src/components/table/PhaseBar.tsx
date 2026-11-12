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
}

export function PhaseBar({ phase, phaseEndsAt, stake, multiplier }: PhaseBarProps) {
  const { t, i18n } = useTranslation();
  const seconds = useCountdown(phaseEndsAt);
  const fmt = numberFormat(i18n.language);
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-stone-900 px-3 py-2 text-amber-50">
      <span className="font-semibold" data-testid="phase" data-phase={phase}>
        {t(`phase.${phase}`)}
      </span>
      {seconds !== null && (
        <span className="tabular-nums text-amber-200" data-testid="countdown">
          {t("play.phaseEnds", { seconds: fmt.format(seconds) })}
        </span>
      )}
      <span className="ml-auto tabular-nums" title={t("play.stakeTip")} data-testid="stake">
        {t("play.stake")} {fmt.format(stake)} <span className="text-amber-300">{t("play.multiplier", { n: fmt.format(multiplier) })}</span>
      </span>
    </div>
  );
}
