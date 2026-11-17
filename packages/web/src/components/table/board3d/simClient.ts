import type { Sim, SimSource } from "../../../lib/throw/director";
import type { Recording } from "../../../lib/throw/simulate";

/**
 * The main thread's side of the physics worker (throw.worker.ts). Asks for
 * each round's throw once, keeps the last few recordings, and tells the
 * board when one arrives. The worker, and Rapier with it, is started on the
 * first request, which the 3D board makes only once it is on screen.
 *
 * Requests wait until the worker says it is ready. A module worker that is
 * still loading its WebAssembly (top-level await) has not yet set its
 * message handler, and a message delivered then is lost.
 *
 * If the worker cannot start (no Worker, the wasm refused, a load error) or
 * says nothing for LOAD_TIMEOUT_MS, every round is "failed" from then on and
 * the board shows the seeded scatter.
 */

const KEEP = 8;
const LOAD_TIMEOUT_MS = 20_000;

export interface SimClient extends SimSource {
  dispose(): void;
}

export function createSimClient(onChange: () => void, makeWorker: () => Worker = defaultWorker): SimClient {
  const sims = new Map<string, Sim>();
  let worker: Worker | null = null;
  let broken = false;
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Rounds asked for before the worker was ready. */
  const queued: string[] = [];

  const fail = (why: string) => {
    if (broken) return;
    broken = true;
    console.warn("The throw physics could not load; the board will show the shells without the throw:", why);
    for (const [id, s] of sims) if (s === "pending") sims.set(id, "failed");
    worker?.terminate();
    worker = null;
    if (timer !== null) clearTimeout(timer);
    onChange();
  };

  const start = (): Worker | null => {
    if (worker !== null || broken) return worker;
    try {
      worker = makeWorker();
    } catch (e) {
      fail(String(e));
      return null;
    }
    timer = setTimeout(() => {
      if (!ready) fail("the physics did not load in time");
    }, LOAD_TIMEOUT_MS);
    worker.onerror = (e) => {
      e.preventDefault();
      fail(e.message || "the physics worker failed");
    };
    worker.onmessage = (e: MessageEvent<{ type: string; roundId?: string; rec?: Recording; message?: string }>) => {
      const m = e.data;
      if (m.type === "ready") {
        ready = true;
        if (timer !== null) clearTimeout(timer);
        for (const roundId of queued.splice(0)) worker?.postMessage({ roundId });
        return;
      }
      if (typeof m.roundId !== "string" || !sims.has(m.roundId)) return;
      if (m.type === "done" && m.rec !== undefined) sims.set(m.roundId, m.rec);
      else {
        console.warn(`The throw for round ${m.roundId} could not be simulated:`, m.message);
        sims.set(m.roundId, "failed");
      }
      onChange();
    };
    return worker;
  };

  return {
    get: (roundId) => sims.get(roundId) ?? "pending",
    request(roundId) {
      if (sims.has(roundId)) return;
      sims.set(roundId, broken ? "failed" : "pending");
      // Forget the oldest; a round that comes back is simulated again (the same throw).
      while (sims.size > KEEP) sims.delete(sims.keys().next().value as string);
      const w = start();
      if (w !== null && ready) w.postMessage({ roundId });
      else if (w !== null) queued.push(roundId);
      if (broken) onChange();
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      worker?.terminate();
      worker = null;
    },
  };
}

function defaultWorker(): Worker {
  return new Worker(new URL("./throw.worker.ts", import.meta.url), { type: "module" });
}
