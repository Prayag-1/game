import { numberFormat } from "../../lib/format";
import type { SeatId } from "@kauda/rules";
import type { SoundCue, ThrowEvent } from "../../lib/throw/director";
import { useTranslation } from "react-i18next";
import { Shell } from "../Shell";
import { StageResultText, type Counting } from "./StageResult";

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
  /** Who threw: the throw comes from their side of the 3D board. */
  readonly thrower: SeatId;
  /** Nobody sits on the winning seat: no chips move. */
  readonly push: boolean;
}

/** The board's edge lit for a seat: the thrower while a round is played, then the result's side. */
export interface EdgeGlow {
  readonly seat: SeatId;
  /** thrower: steady. hit: pulses brass on the thrower's side. win: a soft glow on the winning seat's side (a miss). */
  readonly kind: "thrower" | "hit" | "win";
}

export interface StageProps {
  /** The throw to show, or null before the first one. */
  readonly result: StageResult | null;
  /** A new round is waiting for its throw: the shells are not down yet. */
  readonly pending: boolean;
  /** My seat, drawn nearest me; null for a chyakhe. The 2D stage ignores it. */
  readonly mySeat?: SeatId | null;
  /** Which side of the board's edge glows, and how. The 2D stage ignores it (the seat panels glow). */
  readonly glow?: EdgeGlow | null;
  /** The count after the shells rest, while it plays; null once over (or never played). */
  readonly counting?: Counting | null;
  /** Face-up shells lit so far (all of them once counted); null: none lit, none dimmed. */
  readonly lit?: number | null;
  /** THE THROW, on the 3D board only; the 2D stage ignores all of these. */
  /** The round being played and its phase: its throw is simulated ahead, and the thrower's hand comes for the shells when throwing opens. */
  readonly round?: { readonly roundId: string; readonly thrower: SeatId; readonly phase: "betting" | "throwing" } | null;
  /** A result the page is holding back: the board plays its throw, then calls onRevealed. */
  readonly reveal?: StageResult | null;
  /** I pressed Throw this round: the hand throws as soon as it holds the shells. */
  readonly pressed?: boolean;
  /** The revealed round's shells are at rest. */
  readonly onRevealed?: (roundId: string) => void;
  /** Whether a board that can play a throw is on screen. */
  readonly onAnimator?: (on: boolean) => void;
  /** Hooks for sound (no audio yet): the scoop, each shake, the release. */
  readonly onSound?: (cue: SoundCue, e: ThrowEvent) => void;
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

export function Stage({ result, pending, counting = null, lit = null }: StageProps) {
  const { t, i18n } = useTranslation();
  const show = pending ? null : result;
  const n = numberFormat(i18n.language).format(show?.faceUp ?? 0);
  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-center gap-1" data-testid="stage" data-renderer="2d">
      <div className="diyo-glow animate-flicker pointer-events-none absolute -inset-x-16 -inset-y-6" aria-hidden="true" />
      <Shells2D
        show={show}
        lit={lit}
        className="relative min-h-0 w-full max-w-[26rem] flex-1 lg:max-h-[24rem]"
        label={show === null ? t("play.stageWaiting") : t("play.stageLabel", { n })}
      />
      <StageResultText show={show} counting={counting} />
    </div>
  );
}

/**
 * The sixteen cowries in SVG. The 2D stage draws them, and so does the 3D
 * board while its chunk is still downloading, so the board is never empty.
 * Without a label the drawing is decorative (the caller labels the board).
 */
export function Shells2D({ show, className, label, lit = null }: { readonly show: StageResult | null; readonly className: string; readonly label?: string; readonly lit?: number | null }) {
  // A new throw re-mounts the shells, so they settle in afresh.
  const throwKey = show === null ? "heap" : show.faces.map((f) => (f ? 1 : 0)).join("");
  // The count lights face-up shells near to far: from the bottom of the drawing up.
  const order = show === null ? [] : THROWN.map((p, i) => [i, p[1]] as const).filter(([i]) => show.faces[i] === true).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i);
  const rank = new Map(order.map((i, r) => [i, r]));
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
          const glow = show === null || lit === null ? undefined : up ? ((rank.get(i) ?? 99) < lit ? "shell-lit" : undefined) : "shell-dim";
          return (
            <Shell
              key={i}
              up={up}
              x={x}
              y={y}
              angle={angle}
              state={show === null ? "pending" : up ? "up" : "down"}
              className={show === null ? "opacity-70" : glow}
            />
          );
        })}
      </g>
    </svg>
  );
}
