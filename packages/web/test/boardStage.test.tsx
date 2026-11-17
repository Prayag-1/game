import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { BoardStage, webglAvailable } from "../src/components/table/BoardStage";

/**
 * The 3D board must never leave a blank screen or crash the table: with
 * WebGL off, or when the 3D stage throws, the 2D stage takes its place; and
 * while the 3D chunk downloads, the 2D shells hold the board.
 */

// Stands in for the 3D chunk. "throw": as a broken driver or shader would.
// "load": still downloading, never drawn. "ready": draws its first frame.
const chunk = vi.hoisted(() => ({ mode: "throw" as "throw" | "load" | "ready" }));
vi.mock("../src/components/table/board3d/Stage3D", () => ({
  default: function FakeStage3D({ onReady }: { onReady: () => void }) {
    if (chunk.mode === "throw") throw new Error("WebGL exploded");
    useEffect(() => {
      if (chunk.mode === "ready") onReady();
    }, [onReady]);
    return <canvas data-testid="canvas-3d" />;
  },
}));

const RESULT = { roundId: "t:1", faces: Array.from({ length: 16 }, (_, i) => i < 5), faceUp: 5, winningSeat: "panja", hit: true, thrower: "panja", push: false } as const;

/** Pretends the browser has WebGL, or that it has the API but refuses a context (blocklisted GPU, WebGL disabled). */
function fakeWebGL(context: boolean): void {
  vi.stubGlobal("WebGLRenderingContext", function WebGLRenderingContext() {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
    context && kind.startsWith("webgl") ? { getExtension: () => ({ loseContext: () => {} }) } : null) as typeof HTMLCanvasElement.prototype.getContext);
}

/** A browser that does not ask for reduced motion (jsdom has no matchMedia, which the board reads as "reduce"). */
function motionAllowed(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
}

describe("board stage fallback", () => {
  it("draws the 2D stage when WebGL is switched off", () => {
    chunk.mode = "throw";
    fakeWebGL(false);
    expect(webglAvailable()).toBe(false);
    render(<BoardStage result={RESULT} pending={false} mySeat="teeya" glow={{ seat: "panja", kind: "thrower" }} />);
    const stage = screen.getByTestId("stage");
    expect(stage).toHaveAttribute("data-renderer", "2d");
    expect(stage.querySelectorAll("[data-shell]")).toHaveLength(16);
    expect(stage.querySelectorAll('[data-shell="up"]')).toHaveLength(5);
    expect(screen.getByTestId("winning-seat")).toHaveTextContent("पञ्जा");
    // No hand on the 2D board.
    expect(stage).not.toHaveAttribute("data-hand");
  });

  it("draws the 2D stage when the browser has no WebGL at all", () => {
    expect(webglAvailable()).toBe(false); // jsdom has none
    render(<BoardStage result={null} pending={false} />);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-renderer", "2d");
    expect(screen.getByTestId("stage").querySelectorAll("[data-shell]")).toHaveLength(16);
  });

  it("falls back to the 2D stage when the 3D stage throws, without crashing the table", async () => {
    chunk.mode = "throw";
    fakeWebGL(true);
    expect(webglAvailable()).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<BoardStage result={RESULT} pending={false} mySeat="chauka" glow={null} />);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-renderer", "webgl");
    expect(screen.getByTestId("stage")).toHaveAttribute("data-shells-up", "5");
    await waitFor(() => expect(screen.getByTestId("stage")).toHaveAttribute("data-renderer", "2d"));
    expect(screen.getByTestId("stage").querySelectorAll('[data-shell="up"]')).toHaveLength(5);
    expect(screen.getByTestId("stage-result")).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2D board"), expect.any(Error));
  });
});

describe("board stage while the 3D chunk loads", () => {
  it("shows the 2D shells in the board area until the 3D board's first frame", async () => {
    chunk.mode = "load";
    fakeWebGL(true);
    render(<BoardStage result={RESULT} pending={false} mySeat="teeya" glow={{ seat: "panja", kind: "thrower" }} />);
    const stage = screen.getByTestId("stage");
    expect(stage).toHaveAttribute("data-renderer", "webgl");
    expect(stage).toHaveAttribute("data-ready", "false");
    const loading = screen.getByTestId("stage-loading");
    expect(loading.querySelectorAll("[data-shell]")).toHaveLength(16);
    expect(loading.querySelectorAll('[data-shell="up"]')).toHaveLength(5);
    expect(loading).toHaveClass("opacity-100");
    // The result is on screen while the board loads; it is not held for the 3D board.
    expect(screen.getByTestId("winning-seat")).toBeInTheDocument();
    // The board keeps a single label: the placeholder drawing is decorative.
    expect(screen.getAllByRole("img")).toHaveLength(1);
    await screen.findByTestId("canvas-3d");
  });

  it("fades the 2D shells out once the 3D board is drawn, then removes them", async () => {
    chunk.mode = "ready";
    fakeWebGL(true);
    render(<BoardStage result={RESULT} pending={false} mySeat="teeya" glow={{ seat: "panja", kind: "thrower" }} />);
    await waitFor(() => expect(screen.getByTestId("stage")).toHaveAttribute("data-ready", "true"));
    const loading = screen.getByTestId("stage-loading");
    expect(loading).toHaveClass("opacity-0");
    fireEvent.transitionEnd(loading);
    expect(screen.queryByTestId("stage-loading")).toBeNull();
  });
});

describe("the lamp's flicker", () => {
  it("is a CSS overlay above the canvas when motion is allowed", async () => {
    chunk.mode = "ready";
    fakeWebGL(true);
    motionAllowed();
    render(<BoardStage result={RESULT} pending={false} mySeat="teeya" glow={null} />);
    const overlay = screen.getByTestId("lamp-flicker");
    expect(overlay).toHaveClass("animate-flame");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    // Painted after (above) the canvas.
    const canvas = await screen.findByTestId("canvas-3d");
    expect(canvas.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is off under prefers-reduced-motion", () => {
    chunk.mode = "ready";
    fakeWebGL(true);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }));
    render(<BoardStage result={RESULT} pending={false} />);
    expect(screen.queryByTestId("lamp-flicker")).toBeNull();
  });

  it("is off in an automated test browser", () => {
    chunk.mode = "ready";
    fakeWebGL(true);
    motionAllowed();
    Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
    try {
      render(<BoardStage result={RESULT} pending={false} />);
      expect(screen.queryByTestId("lamp-flicker")).toBeNull();
    } finally {
      delete (navigator as { webdriver?: boolean }).webdriver;
    }
  });
});
