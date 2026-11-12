import { useTranslation } from "react-i18next";
import type { FairnessResult } from "../../lib/fairness";
import type { RoundRecord } from "../../lib/protocol";

export function Check({ ok }: { readonly ok: boolean | undefined }) {
  const { t } = useTranslation();
  if (ok === undefined) return <span className="text-ink-muted">…</span>;
  return ok ? (
    <span className="font-bold text-ok" role="img" aria-label={t("play.checkOk")} data-check="ok">
      ✓
    </span>
  ) : (
    <span className="font-bold text-bad" role="img" aria-label={t("play.checkBad")} data-check="bad">
      ✗
    </span>
  );
}

export interface FairnessProps {
  /** The commitment published for the round in play (betting and throwing), else null. */
  readonly commitHash: string | null;
  /** The last revealed round. */
  readonly round: RoundRecord | null;
  /** The browser's check of it; undefined while it runs. */
  readonly result: FairnessResult | undefined;
}

const hash = "block break-all rounded-control bg-bg/60 px-2 py-1 font-mono text-[0.7rem] leading-relaxed text-ink-muted";
const label = "text-xs font-semibold text-ink";

/** Commit-reveal, one tap away: the hash during betting, then the seed and the browser's check. */
export function Fairness({ commitHash, round, result }: FairnessProps) {
  const { t } = useTranslation();
  return (
    <details className="group text-sm" data-testid="fairness">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-brass transition-transform duration-200 group-open:rotate-90">
          ›
        </span>
        {t("play.fairness")} {round !== null && <Check ok={result?.ok} />}
      </summary>
      <div className="animate-rise mt-2 flex flex-col gap-2">
        <p className="text-xs text-ink-muted">{t("play.fairnessHint")}</p>
        <div className="flex flex-col gap-1">
          <div className={label}>{t("play.commitHash")}</div>
          {commitHash === null ? (
            <p className="text-xs text-ink-muted">{t("play.noCommit")}</p>
          ) : (
            <code className={hash} data-testid="commit-hash">
              {commitHash}
            </code>
          )}
        </div>
        {round === null ? (
          <p className="text-xs text-ink-muted">{t("play.noRound")}</p>
        ) : (
          <div className="flex flex-col gap-1" data-testid="reveal">
            <div className={label}>{t("play.seed")}</div>
            <code className={hash} data-testid="seed">
              {round.seed}
            </code>
            {result === undefined ? (
              <p className="text-xs text-ink-muted">{t("play.checking")}</p>
            ) : (
              <>
                <div className={label}>{t("play.computed")}</div>
                <code className={hash}>{result.computed}</code>
                <ul className="flex flex-col gap-0.5 text-xs text-ink">
                  <li>
                    <Check ok={result.hashMatches} /> {t("play.checkHash")}
                  </li>
                  <li>
                    <Check ok={result.matchesPublished ?? undefined} /> {t("play.checkPublished")}{" "}
                    {result.matchesPublished === null && <span className="text-ink-muted">{t("play.notSeenPublished")}</span>}
                  </li>
                  <li>
                    <Check ok={result.facesMatch && result.seatMatches} /> {t("play.checkFaces")}
                  </li>
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
