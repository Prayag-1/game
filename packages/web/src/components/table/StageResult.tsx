import { numberFormat } from "../../lib/format";
import { useTranslation } from "react-i18next";
import { Term } from "../Term";
import type { StageResult } from "./Stage";

/**
 * The result, beneath the board, as DOM text (never drawn in WebGL): the
 * winning seat's name large in brass with the face-up count beside it, and
 * the hit or miss word under them, in sindoor for a hit. Before the throw,
 * a quiet line saying the shells are still to be thrown.
 */
export function StageResultText({ show }: { readonly show: StageResult | null }) {
  const { t, i18n } = useTranslation();
  if (show === null) return <p className="relative pb-1 text-center text-sm text-ink">{t("play.stageWaiting")}</p>;
  const n = numberFormat(i18n.language).format(show.faceUp);
  return (
    <div
      key={show.faces.map((f) => (f ? 1 : 0)).join("")}
      className="animate-rise relative flex flex-col items-center pb-1 text-center leading-tight"
      data-testid="stage-result"
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
      <p className={`mt-0.5 text-xl font-semibold ${show.hit ? "text-sindoor-ink" : "text-ink"}`} data-result={show.hit ? "hit" : "miss"}>
        <Term id={show.hit ? "maryo" : "tiryo"} quiet />
      </p>
    </div>
  );
}
