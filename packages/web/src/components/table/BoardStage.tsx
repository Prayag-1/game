import { numberFormat } from "../../lib/format";
import { Component, lazy, Suspense, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { shellPoses } from "../../lib/board";
import { Stage, type StageProps } from "./Stage";
import { StageResultText } from "./StageResult";

/**
 * The centre of the table: the 3D board when the device can draw it, the 2D
 * stage when it cannot. Same props either way.
 *
 * three.js lives only in the lazily loaded board3d chunk, so sign-in and the
 * lobby never download it (the build fails if it reaches the entry chunk;
 * see vite.config.ts). Without WebGL, or if the 3D stage throws or loses its
 * GPU context, the 2D stage takes over: never a blank board, never a crash.
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
  const { result, pending, mySeat = null, thrower = null } = props;
  const { t, i18n } = useTranslation();
  const [renderer, setRenderer] = useState<"webgl" | "2d">(() => (webglAvailable() ? "webgl" : "2d"));
  const [ready, setReady] = useState(false);
  const reduced = useSyncExternalStore(subscribeReduced, reducedMotion, () => true);
  const fallBack = useCallback((e?: unknown) => {
    if (e !== undefined) console.warn("3D board unavailable, showing the 2D board:", e);
    setRenderer("2d");
  }, []);
  const onReady = useCallback(() => setReady(true), []);

  const show = pending ? null : result;
  const throwShown = show === null ? null : { roundId: show.roundId, faces: show.faces };
  const poseKey = throwShown === null ? "heap" : `${throwShown.roundId}:${throwShown.faces.map((f) => (f ? 1 : 0)).join("")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- poseKey captures everything the poses depend on
  const poses = useMemo(() => shellPoses(throwShown), [poseKey]);

  if (renderer === "2d") return <Stage {...props} />;

  const n = numberFormat(i18n.language).format(show?.faceUp ?? 0);
  return (
    <div
      className="relative flex h-full min-h-0 flex-col items-stretch gap-1"
      data-testid="stage"
      data-renderer="webgl"
      data-ready={ready ? "true" : "false"}
      data-shells={poses.length}
      data-shells-up={poses.filter((p) => p.up).length}
    >
      <div className="relative min-h-0 flex-1" role="img" aria-label={show === null ? t("play.stageWaiting") : t("play.stageLabel", { n })}>
        <div className="diyo-glow pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="absolute inset-0">
          <StageBoundary onError={fallBack}>
            <Suspense fallback={null}>
              <Stage3D poses={poses} mySeat={mySeat} thrower={thrower} flicker={!reduced} onReady={onReady} onLost={fallBack} />
            </Suspense>
          </StageBoundary>
        </div>
      </div>
      {/* Over the canvas and the floor alike, so it has no edge of its own; the header, seats, result and sheet sit above it. */}
      <div className="board-vignette pointer-events-none fixed inset-0 z-10" aria-hidden="true" />
      <div className="relative z-20">
        <StageResultText show={show} />
      </div>
    </div>
  );
}
