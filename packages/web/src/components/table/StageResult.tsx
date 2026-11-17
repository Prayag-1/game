import { numberFormat } from "../../lib/format";
import { useTranslation } from "react-i18next";
import { Term } from "../Term";
import type { StageResult } from "./Stage";

/** How far the count has got, while it plays (lib/ceremony.ts). */
export interface Counting {
  readonly counted: number;
  /** The count is over: the result shows. */
  readonly resultShown: boolean;
}

/**
 * The result, beneath the board, as DOM text (never drawn in WebGL).
 *
 * While the shells are counted, a running number grows as each face-up
 * shell lights. Then the result: the winning seat's name large in brass with
 * the count beside it, and the hit or miss word under them. A hit (मा-र्यो)
 * is in sindoor red; a miss (ति-र्यो) is quieter, in ink. A push (nobody sits
 * on the winning seat) is a plain neutral line. Before the throw, a quiet
 * line saying the shells are still to be thrown.
 */
export function StageResultText({ show, counting = null }: { readonly show: StageResult | null; readonly counting?: Counting | null }) {
  const { t, i18n } = useTranslation();
  const fmt = numberFormat(i18n.language);
  if (show === null) return <p className="relative pb-1 text-center text-sm text-ink">{t("play.stageWaiting")}</p>;

  if (counting !== null && !counting.resultShown) {
    return (
      <p className="relative flex flex-col items-center pb-1 text-center leading-tight" data-testid="stage-count" data-count={counting.counted} aria-live="off">
        <span className="sr-only">{t("play.countLabel")}</span>
        <span className="text-4xl font-semibold text-brass tabular-nums sm:text-5xl" key={counting.counted}>
          <span className="animate-pulse-once inline-block">{fmt.format(counting.counted)}</span>
        </span>
        <span className="text-sm text-ink-muted">{t("play.stageFaceUp", { n: "" }).trim()}</span>
      </p>
    );
  }

  const n = fmt.format(show.faceUp);
  if (show.push) {
    return (
      <div className="animate-rise relative flex flex-col items-center pb-1 text-center leading-tight" data-testid="stage-result" data-result="push" aria-live="polite">
        <p className="text-base text-ink tabular-nums">{t("play.stageFaceUp", { n })}</p>
        <p className="text-base text-ink-muted" data-testid="winning-seat" data-seat={show.winningSeat}>
          {t("play.push", { seat: t(`terms.${show.winningSeat}.label`) })}
        </p>
      </div>
    );
  }
  return (
    <div
      key={show.roundId}
      className="animate-rise relative flex flex-col items-center pb-1 text-center leading-tight"
      data-testid="stage-result"
      data-result={show.hit ? "hit" : "miss"}
      aria-live="polite"
    >
      <p className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-brass sm:text-4xl lg:text-5xl" data-testid="winning-seat" data-seat={show.winningSeat}>
          <Term id={show.winningSeat} quiet />
        </span>
        <span className="text-base text-ink tabular-nums lg:text-lg">
          <span aria-hidden="true">· </span>
          {t("play.stageFaceUp", { n })}
        </span>
      </p>
      <p className={`mt-0.5 font-semibold ${show.hit ? "animate-pulse-once text-2xl text-sindoor-ink" : "text-lg text-ink-muted"}`} data-result={show.hit ? "hit" : "miss"}>
        <Term id={show.hit ? "maryo" : "tiryo"} quiet />
      </p>
    </div>
  );
}
