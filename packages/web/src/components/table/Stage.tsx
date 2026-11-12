import { numberFormat } from "../../lib/format";
import type { SeatId } from "@kauda/rules";
import { useTranslation } from "react-i18next";
import { Term } from "../Term";

/**
 * The centre of the table. For now the sixteen shells are drawn as circles,
 * filled when face up; the 3D scene replaces this component later.
 *
 * It knows nothing about the room or the store: it renders only its props,
 * so the 3D canvas can take its place behind the same interface.
 */

export interface StageResult {
  readonly faces: readonly boolean[];
  readonly faceUp: number;
  readonly winningSeat: SeatId;
  readonly hit: boolean;
}

export interface StageProps {
  /** The throw to show, or null before the first one. */
  readonly result: StageResult | null;
  /** A new round is waiting for its throw: the shells are not down yet. */
  readonly pending: boolean;
}

const SHELLS = 16;
// Positions on a 100x100 board: a loose scatter, the same every time (no randomness on the client).
const SPOTS: readonly (readonly [number, number])[] = [
  [18, 20], [38, 14], [60, 18], [82, 22],
  [12, 42], [32, 36], [55, 40], [78, 44],
  [20, 62], [42, 58], [64, 62], [86, 66],
  [14, 84], [36, 80], [58, 86], [80, 84],
];

export function Stage({ result, pending }: StageProps) {
  const { t, i18n } = useTranslation();
  const show = pending ? null : result;
  const n = numberFormat(i18n.language).format(show?.faceUp ?? 0);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 rounded-full bg-emerald-800 p-2 text-amber-50 shadow-inner" data-testid="stage">
      <svg
        viewBox="0 0 100 100"
        className="aspect-square w-full max-w-64"
        role="img"
        aria-label={show === null ? t("play.stageWaiting") : t("play.stageLabel", { n })}
      >
        {SPOTS.slice(0, SHELLS).map(([x, y], i) => {
          const up = show?.faces[i] === true;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={6.5}
              data-shell={show === null ? "pending" : up ? "up" : "down"}
              className={
                show === null
                  ? "fill-transparent stroke-amber-100/40"
                  : up
                    ? "fill-amber-50 stroke-amber-200"
                    : "fill-emerald-950/60 stroke-amber-100/70"
              }
              strokeWidth={1.2}
              strokeDasharray={show === null ? "2 2" : undefined}
            />
          );
        })}
      </svg>
      {show === null ? (
        <p className="text-center text-xs">{t("play.stageWaiting")}</p>
      ) : (
        <div className="text-center leading-tight" data-testid="stage-result" aria-live="polite">
          <p className="text-xs">{t("play.stageFaceUp", { n })}</p>
          <p className="text-sm font-semibold">
            <Term id={show.winningSeat} /> {t("play.wins")}
          </p>
          <p className="text-xs">
            <Term id={show.hit ? "maryo" : "tiryo"} />
          </p>
        </div>
      )}
    </div>
  );
}
