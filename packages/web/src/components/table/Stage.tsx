import { numberFormat } from "../../lib/format";
import type { SeatId } from "@kauda/rules";
import { useTranslation } from "react-i18next";
import { Shell } from "../Shell";
import { StageResultText } from "./StageResult";

/**
 * The centre of the table in 2D: the sixteen cowries drawn in SVG, and the
 * result beneath them. The 3D board (BoardStage, board3d/Stage3D) takes the
 * same props and falls back to this one when WebGL is missing or fails.
 *
 * It knows nothing about the room or the store: it renders only its props.
 */

export interface StageResult {
  /** The settled round's id: it fixes where the shells lie on the 3D board. */
  readonly roundId: string;
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
  /** My seat, drawn nearest me; null for a chyakhe. The 2D stage ignores it. */
  readonly mySeat?: SeatId | null;
  /** Whose side of the board glows. The 2D stage ignores it (the seat panel glows). */
  readonly thrower?: SeatId | null;
}

const SHELLS = 16;

/** Where each shell lands: a loose throw, the same every time (the client never uses randomness). [x, y, angle] */
const THROWN: readonly (readonly [number, number, number])[] = [
  [31, 19, -24], [45, 16, 14], [58, 20, -38], [70, 17, 30],
  [35, 31, 40], [48, 29, -8], [61, 33, 22], [72, 30, -50],
  [30, 43, 10], [44, 44, -30], [57, 46, 48], [69, 43, -12],
  [34, 57, -42], [47, 59, 18], [60, 56, -20], [71, 58, 36],
];

/** Before the throw: the shells gathered in a heap, face down. */
const HEAP: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [[51, 38, 8]];
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * 2 * Math.PI + 0.3;
    out.push([51 + 6.2 * Math.cos(a), 38 + 5.4 * Math.sin(a), (i * 61) % 180 - 90]);
  }
  for (let i = 0; i < 9; i += 1) {
    const a = (i / 9) * 2 * Math.PI;
    out.push([51 + 12 * Math.cos(a), 38 + 10 * Math.sin(a), (i * 47) % 180 - 90]);
  }
  return out;
})();

export function Stage({ result, pending }: StageProps) {
  const { t, i18n } = useTranslation();
  const show = pending ? null : result;
  const n = numberFormat(i18n.language).format(show?.faceUp ?? 0);
  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-center gap-1" data-testid="stage" data-renderer="2d">
      <div className="diyo-glow animate-flicker pointer-events-none absolute -inset-x-16 -inset-y-6" aria-hidden="true" />
      <Shells2D
        show={show}
        className="relative min-h-0 w-full max-w-[26rem] flex-1 lg:max-h-[24rem]"
        label={show === null ? t("play.stageWaiting") : t("play.stageLabel", { n })}
      />
      <StageResultText show={show} />
    </div>
  );
}

/**
 * The sixteen cowries in SVG. The 2D stage draws them, and so does the 3D
 * board while its chunk is still downloading, so the board is never empty.
 * Without a label the drawing is decorative (the caller labels the board).
 */
export function Shells2D({ show, className, label }: { readonly show: StageResult | null; readonly className: string; readonly label?: string }) {
  // A new throw re-mounts the shells, so they settle in afresh.
  const throwKey = show === null ? "heap" : show.faces.map((f) => (f ? 1 : 0)).join("");
  return (
    <svg
      viewBox="22 9 58 57"
      preserveAspectRatio="xMidYMax meet"
      className={className}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      <g key={throwKey} className="animate-settle origin-center [transform-box:fill-box]">
        {(show === null ? HEAP : THROWN).slice(0, SHELLS).map(([x, y, angle], i) => {
          const up = show?.faces[i] === true;
          return (
            <Shell
              key={i}
              up={up}
              x={x}
              y={y}
              angle={angle}
              state={show === null ? "pending" : up ? "up" : "down"}
              className={show === null ? "opacity-70" : undefined}
            />
          );
        })}
      </g>
    </svg>
  );
}
