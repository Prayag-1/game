import { afterEach, describe, expect, it, vi } from "vitest";
import { createSimClient } from "../src/components/table/board3d/simClient";

/**
 * The main thread's side of the physics worker. The worker itself (Rapier)
 * is tested through simulate.ts; here, a fake worker that behaves like a
 * module worker still loading its WebAssembly: anything sent before it is
 * ready is lost.
 */

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  ready = false;
  received: string[] = [];
  lost: string[] = [];
  terminated = false;
  postMessage(m: { roundId: string }) {
    (this.ready ? this.received : this.lost).push(m.roundId);
  }
  terminate() {
    this.terminated = true;
  }
  say(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  becomeReady() {
    this.ready = true;
    this.say({ type: "ready" });
  }
}

const fakeRecording = (roundId: string) => ({ roundId, frames: 2 });

afterEach(() => {
  vi.useRealTimers();
});

describe("the physics worker's client", () => {
  it("holds requests until the worker is ready, so none is lost while Rapier loads", () => {
    const w = new FakeWorker();
    const onChange = vi.fn();
    const sims = createSimClient(onChange, () => w as unknown as Worker);
    sims.request("r1");
    sims.request("r2");
    sims.request("r1");
    expect(sims.get("r1")).toBe("pending");
    expect(w.lost).toEqual([]);
    w.becomeReady();
    expect(w.received).toEqual(["r1", "r2"]);
    w.say({ type: "done", roundId: "r1", rec: fakeRecording("r1") });
    expect(sims.get("r1")).toEqual(fakeRecording("r1"));
    expect(onChange).toHaveBeenCalled();
    sims.request("r3");
    expect(w.received).toEqual(["r1", "r2", "r3"]);
  });

  it("starts the worker only on the first request", () => {
    const make = vi.fn(() => new FakeWorker() as unknown as Worker);
    const sims = createSimClient(() => {}, make);
    expect(make).not.toHaveBeenCalled();
    sims.request("r1");
    sims.request("r2");
    expect(make).toHaveBeenCalledOnce();
  });

  it("marks every round failed when the worker errors, and from then on", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = new FakeWorker();
    const sims = createSimClient(() => {}, () => w as unknown as Worker);
    sims.request("r1");
    w.onerror?.({ message: "wasm refused", preventDefault() {} } as ErrorEvent);
    expect(sims.get("r1")).toBe("failed");
    expect(w.terminated).toBe(true);
    sims.request("r2");
    expect(sims.get("r2")).toBe("failed");
  });

  it("gives up when the worker never says it is ready", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = new FakeWorker();
    const sims = createSimClient(() => {}, () => w as unknown as Worker);
    sims.request("r1");
    vi.advanceTimersByTime(19_999);
    expect(sims.get("r1")).toBe("pending");
    vi.advanceTimersByTime(1);
    expect(sims.get("r1")).toBe("failed");
  });

  it("fails cleanly where there is no Worker at all", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sims = createSimClient(
      () => {},
      () => {
        throw new Error("Worker is not defined");
      },
    );
    sims.request("r1");
    expect(sims.get("r1")).toBe("failed");
  });

  it("marks one round failed when its simulation throws, and keeps the worker", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = new FakeWorker();
    const sims = createSimClient(() => {}, () => w as unknown as Worker);
    w.becomeReady();
    sims.request("r1");
    sims.request("r2");
    w.say({ type: "error", roundId: "r1", message: "boom" });
    expect(sims.get("r1")).toBe("failed");
    w.say({ type: "done", roundId: "r2", rec: fakeRecording("r2") });
    expect(sims.get("r2")).toEqual(fakeRecording("r2"));
    expect(w.terminated).toBe(false);
  });
});
