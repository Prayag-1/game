import { numberFormat } from "../../lib/format";
import { useTranslation } from "react-i18next";
import type { FairnessResult } from "../../lib/fairness";
import type { RoundRecord } from "../../lib/protocol";
import { Term } from "../Term";
import { eyebrow } from "../ui";
import { Check } from "./Fairness";

export interface RoundLogProps {
  readonly rounds: readonly RoundRecord[];
  readonly names: Readonly<Record<string, string>>;
  readonly fairness: Readonly<Record<string, FairnessResult>>;
  readonly myId: string | null;
}

/** Settled rounds, newest first: hit or miss, stake and multiplier, and who gained or lost. */
export function RoundLog({ rounds, names, fairness, myId }: RoundLogProps) {
  const { t, i18n } = useTranslation();
  const fmt = numberFormat(i18n.language);
  const nameOf = (id: string) => (id === myId ? t("play.you") : (names[id] ?? id.slice(0, 8)));
  return (
    <section className="flex flex-col gap-1">
      <h3 className={eyebrow}>{t("play.log")}</h3>
      {rounds.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("play.logEmpty")}</p>
      ) : (
        <ol className="flex max-h-72 flex-col divide-y divide-line overflow-y-auto text-sm" data-testid="round-log">
          {rounds.map((r) => {
            const changes = Object.entries(r.deltas).filter(([, d]) => d !== 0);
            const mine = myId !== null && r.occupants[r.thrower] === myId;
            return (
              <li
                key={r.roundId}
                className="py-1.5"
                data-testid="log-row"
                data-round-id={r.roundId}
                data-hit={r.hit ? "true" : "false"}
                data-stake={r.stake}
                data-streak={r.streak}
                data-my-throw={mine ? "true" : undefined}
                data-my-delta={myId === null ? undefined : (r.deltas[myId] ?? 0)}
                data-chyakhe-total={r.chyakhe.reduce((sum, b) => sum + b.chips, 0)}
                data-chyakhe-on-winner={r.chyakhe.filter((b) => b.seat === r.winningSeat).reduce((sum, b) => sum + b.chips, 0)}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 text-ink">
                  <span className={r.hit ? "text-sindoor-ink" : "text-ink"}>
                    <Term id={r.hit ? "maryo" : "tiryo"} />
                  </span>
                  <span>
                    <Term id={r.thrower} /> <span className="text-ink-muted">→</span> <Term id={r.winningSeat} />
                  </span>
                  <span className="text-xs text-ink-muted tabular-nums">
                    {t("play.stake")} {fmt.format(r.stake)} {t("play.multiplier", { n: fmt.format(r.multiplier) })}
                  </span>
                  <span className="ml-auto">
                    <Check ok={fairness[r.roundId]?.ok} />
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-2 text-xs tabular-nums">
                  {changes.map(([id, d]) => (
                    <span key={id} className={d > 0 ? "text-brass" : "text-ink-muted"}>
                      {d > 0 ? t("play.gained", { name: nameOf(id), chips: fmt.format(d) }) : t("play.lost", { name: nameOf(id), chips: fmt.format(-d) })}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
