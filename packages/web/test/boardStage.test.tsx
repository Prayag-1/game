import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoardStage, webglAvailable } from "../src/components/table/BoardStage";

/**
 * The 3D board must never leave a blank screen or crash the table: with
 * WebGL off, or when the 3D stage throws, the 2D stage takes its place.
 */

// Stands in for the 3D chunk: it throws, as a broken driver or shader would.
vi.mock("../src/components/table/board3d/Stage3D", () => ({
  default: () => {
    throw new Error("WebGL exploded");
  },
}));

const RESULT = { roundId: "t:1", faces: Array.from({ length: 16 }, (_, i) => i < 5), faceUp: 5, winningSeat: "panja", hit: true } as const;

/** Pretends the browser has WebGL, or that it has the API but refuses a context (blocklisted GPU, WebGL disabled). */
function fakeWebGL(context: boolean): void {
  vi.stubGlobal("WebGLRenderingContext", function WebGLRenderingContext() {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
    context && kind.startsWith("webgl") ? { getExtension: () => ({ loseContext: () => {} }) } : null) as typeof HTMLCanvasElement.prototype.getContext);
}

describe("board stage fallback", () => {
  it("draws the 2D stage when WebGL is switched off", () => {
    fakeWebGL(false);
    expect(webglAvailable()).toBe(false);
    render(<BoardStage result={RESULT} pending={false} mySeat="teeya" thrower="panja" />);
    const stage = screen.getByTestId("stage");
    expect(stage).toHaveAttribute("data-renderer", "2d");
    expect(stage.querySelectorAll("[data-shell]")).toHaveLength(16);
    expect(stage.querySelectorAll('[data-shell="up"]')).toHaveLength(5);
    expect(screen.getByTestId("winning-seat")).toHaveTextContent("पञ्जा");
  });

  it("draws the 2D stage when the browser has no WebGL at all", () => {
    expect(webglAvailable()).toBe(false); // jsdom has none
    render(<BoardStage result={null} pending={false} />);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-renderer", "2d");
    expect(screen.getByTestId("stage").querySelectorAll("[data-shell]")).toHaveLength(16);
  });

  it("falls back to the 2D stage when the 3D stage throws, without crashing the table", async () => {
    fakeWebGL(true);
    expect(webglAvailable()).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<BoardStage result={RESULT} pending={false} mySeat="chauka" thrower={null} />);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-renderer", "webgl");
    expect(screen.getByTestId("stage")).toHaveAttribute("data-shells-up", "5");
    await waitFor(() => expect(screen.getByTestId("stage")).toHaveAttribute("data-renderer", "2d"));
    expect(screen.getByTestId("stage").querySelectorAll('[data-shell="up"]')).toHaveLength(5);
    expect(screen.getByTestId("stage-result")).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2D board"), expect.any(Error));
  });
});
