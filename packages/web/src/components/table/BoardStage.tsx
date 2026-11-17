import { numberFormat } from "../../lib/format";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BoardStatus } from "./board3d/Stage3D";
import { Shells2D, Stage, type StageProps } from "./Stage";
import { StageResultText } from "./StageResult";

/**
 * The centre of the table: the 3D board when the device can draw it, the 2D
 * stage when it cannot. Same props either way.
 *
 * three.js lives only in the lazily loaded board3d chunk, so sign-in and the
 * lobby never download it (the build fails if it reaches the entry chunk;
 * see vite.config.ts). Without WebGL, or if the 3D stage throws or loses its
 * GPU context, the 2D stage takes over: never a blank board, never a crash.
 * While the 3D chunk downloads, the 2D shells hold its place, and fade out
 * once the 3D board's first frame is on screen.
 */

const Stage3D = lazy(() => import("./board3d/Stage3D"));

/** Can this browser give us a WebGL context at all? Checked once, before any three.js is fetched. */
export function webglAvailable(): boolean {
  if (typeof window === "undefined" || typeof WebGLRenderingContext === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl === null) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

const REDUCED = "(prefers-reduced-motion: reduce)";
function subscribeReduced(onChange: () => void): () => void {
  const mq = window.matchMedia?.(REDUCED);
  mq?.addEventListener("change", onChange);
  return () => mq?.removeEventListener("change", onChange);
}
const reducedMotion = () => window.matchMedia?.(REDUCED).matches ?? true;
/** Driven by a test browser (Playwright sets navigator.webdriver): no decorative motion, so nothing on screen depends on timing. */
const automated = () => typeof navigator !== "undefined" && navigator.webdriver === true;

class StageBoundary extends Component<{ readonly onError: (e: unknown) => void; readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function BoardStage(props: StageProps) {
  const { result, pending, mySeat = null, glow = null, counting = null, lit = null, round = null, reveal = null, pressed = false, onRevealed, onAnimator, onSound } = props;
  const { t, i18n } = useTranslation();
  const [renderer, setRenderer] = useState<"webgl" | "2d">(() => (webglAvailable() ? "webgl" : "2d"));
  const [ready, setReady] = useState(false);
  // The 2D shells hold the board until the 3D board's first frame, then fade out and go.
  const [loaderGone, setLoaderGone] = useState(false);
  const reduced = useSyncExternalStore(subscribeReduced, reducedMotion, () => true);
  const fallBack = useCallback((e?: unknown) => {
    if (e !== undefined) console.warn("3D board unavailable, showing the 2D board:", e);
    setRenderer("2d");
  }, []);
  const onReady = useCallback(() => setReady(true), []);
  const [status, setStatus] = useState<BoardStatus>({ layout: "heap", phase: "still", hand: "none", handAnchored: false });
  const revealed = useCallback((id: string) => onRevealed?.(id), [onRevealed]);

  // Only a 3D board that is on screen can play a throw: the page holds a result back only then.
  const animating = renderer === "webgl" && ready;
  useEffect(() => {
    onAnimator?.(animating);
    return () => onAnimator?.(false);
  }, [animating, onAnimator]);

  // The text says "still to be thrown" while a round waits for its throw...
  const show = pending ? null : result;
  // ...but the shells lie where the last throw left them until they are gathered for the next.
  const shownKey = result === null ? "" : `${result.roundId}:${result.thrower}:${result.faces.map((f) => (f ? 1 : 0)).join("")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- shownKey captures everything
  const shown = useMemo(() => (result === null ? null : { roundId: result.roundId, faces: result.faces, thrower: result.thrower }), [shownKey]);
  const revealKey = reveal === null ? "" : `${reveal.roundId}:${reveal.thrower}:${reveal.faces.map((f) => (f ? 1 : 0)).join("")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- revealKey captures everything
  const playing = useMemo(() => (reveal === null ? null : { roundId: reveal.roundId, faces: reveal.faces, thrower: reveal.thrower }), [revealKey]);
  const roundKey = round === null ? "" : `${round.roundId}:${round.thrower}:${round.phase}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- roundKey captures everything
  const current = useMemo(() => round, [roundKey]);

  if (renderer === "2d") return <Stage {...props} />;

  const n = numberFormat(i18n.language).format(show?.faceUp ?? 0);
  const flicker = !reduced && !automated();
  return (
    <div
      className="relative flex h-full min-h-0 flex-col items-stretch gap-1"
      data-testid="stage"
      data-renderer="webgl"
      data-ready={ready ? "true" : "false"}
      data-shells={16}
      data-shells-up={result === null ? 0 : result.faces.filter(Boolean).length}
      data-layout={status.layout}
      data-glow-seat={glow?.seat ?? "none"}
      data-glow-kind={glow?.kind ?? "none"}
      data-throw={status.phase}
      data-hand={status.hand}
      data-hand-anchored={status.handAnchored ? "true" : "false"}
    >
      <div className="relative min-h-0 flex-1" role="img" aria-label={show === null ? t("play.stageWaiting") : t("play.stageLabel", { n })}>
        <div className="diyo-glow pointer-events-none absolute inset-0" aria-hidden="true" />
        {!loaderGone && (
          <div
            className={`pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${ready ? "opacity-0" : "opacity-100"}`}
            data-testid="stage-loading"
            onTransitionEnd={() => setLoaderGone(true)}
          >
            <Shells2D show={show} lit={lit} className="h-full max-h-[24rem] w-full max-w-[26rem]" />
          </div>
        )}
        <div className={`absolute inset-0 transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-0"}`}>
          <StageBoundary onError={fallBack}>
            <Suspense fallback={null}>
              <Stage3D
                current={current}
                shown={shown}
                reveal={playing}
                pressed={pressed}
                reduced={reduced}
                quiet={automated()}
                onRevealed={revealed}
                {...(onSound === undefined ? {} : { onSound })}
                onStatus={setStatus}
                mySeat={mySeat}
                glow={glow}
                lit={lit}
                onReady={onReady}
                onLost={fallBack}
              />
            </Suspense>
          </StageBoundary>
        </div>
        {/* The diyo's flicker: an opacity animation on a warm overlay, run by the compositor, never by WebGL. */}
        {flicker && <div className="lamp-flicker animate-flame pointer-events-none absolute inset-0" aria-hidden="true" data-testid="lamp-flicker" />}
      </div>
      {/* Over the canvas and the floor alike, so it has no edge of its own; the header, seats, result and sheet sit above it. */}
      <div className="board-vignette pointer-events-none fixed inset-0 z-10" aria-hidden="true" />
      <div className="relative z-20">
        <StageResultText show={show} counting={counting} />
      </div>
    </div>
  );
}
