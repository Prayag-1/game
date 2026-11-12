import { useTranslation } from "react-i18next";
import type { FairnessResult } from "../../lib/fairness";
import type { RoundRecord } from "../../lib/protocol";

export function Check({ ok }: { readonly ok: boolean | undefined }) {
  const { t } = useTranslation();
  if (ok === undefined) return <span className="text-stone-500">…</span>;
  return ok ? (
    <span className="font-bold text-green-700" role="img" aria-label={t("play.checkOk")} data-check="ok">
      ✓
    </span>
  ) : (
    <span className="font-bold text-red-700" role="img" aria-label={t("play.checkBad")} data-check="bad">
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

/** Commit-reveal, one tap away: the hash during betting, then the seed and the browser's check. */
export function Fairness({ commitHash, round, result }: FairnessProps) {
  const { t } = useTranslation();
  return (
    <details className="rounded-2xl bg-white p-3 text-sm shadow-sm" data-testid="fairness">
      <summary className="cursor-pointer font-semibold">
        {t("play.fairness")} {round !== null && <Check ok={result?.ok} />}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-xs text-stone-600">{t("play.fairnessHint")}</p>
        <div>
          <div className="text-xs font-semibold">{t("play.commitHash")}</div>
          {commitHash === null ? (
            <p className="text-xs text-stone-500">{t("play.noCommit")}</p>
          ) : (
            <code className="block break-all text-xs" data-testid="commit-hash">
              {commitHash}
            </code>
          )}
        </div>
        {round === null ? (
          <p className="text-xs text-stone-500">{t("play.noRound")}</p>
        ) : (
          <div className="flex flex-col gap-1" data-testid="reveal">
            <div className="text-xs font-semibold">{t("play.seed")}</div>
            <code className="block break-all text-xs" data-testid="seed">
              {round.seed}
            </code>
            {result === undefined ? (
              <p className="text-xs">{t("play.checking")}</p>
            ) : (
              <>
                <div className="text-xs font-semibold">{t("play.computed")}</div>
                <code className="block break-all text-xs">{result.computed}</code>
                <ul className="text-xs">
                  <li>
                    <Check ok={result.hashMatches} /> {t("play.checkHash")}
                  </li>
                  <li>
                    <Check ok={result.matchesPublished ?? undefined} /> {t("play.checkPublished")}{" "}
                    {result.matchesPublished === null && <span className="text-stone-500">{t("play.notSeenPublished")}</span>}
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
