import { localeFor } from "../../lib/format";
import { useTranslation } from "react-i18next";
import type { TopUpResult } from "../../lib/protocol";

export interface TopUpProps {
  readonly minChipsToSit: number;
  readonly result: TopUpResult | null;
  readonly onClaim: () => void;
}

/** Shown only when I am too poor to sit. A refusal shows when the cooldown ends. */
export function TopUp({ minChipsToSit, result, onClaim }: TopUpProps) {
  const { t, i18n } = useTranslation();
  const time =
    result !== null && !result.ok && result.availableAt !== null
      ? new Intl.DateTimeFormat(localeFor(i18n.language), { hour: "numeric", minute: "2-digit" }).format(result.availableAt)
      : null;
  return (
    <section className="flex flex-col gap-1 rounded-2xl bg-amber-100 p-3 text-sm" data-testid="topup">
      <p>{t("play.topUpHint", { min: minChipsToSit })}</p>
      <button type="button" onClick={onClaim} className="self-start rounded-lg bg-orange-800 px-3 py-1.5 font-semibold text-white">
        {t("play.topUp")}
      </button>
      {result !== null && result.ok && <p className="text-green-800">{t("play.topUpDone", { chips: result.chips })}</p>}
      {time !== null && (
        <p className="text-red-800" role="alert">
          {t("play.topUpCooldown", { time })}
        </p>
      )}
    </section>
  );
}
