/**
 * THE PHYSICS WORKER. Simulates each round's throw off the main thread, so
 * the page never stutters, and sends back the recording. Started by the 3D
 * board (simClient.ts) only once the board is on screen; Rapier's
 * WebAssembly loads with it, as a separate same-origin .wasm file.
 *
 * In:  { roundId }
 * Out: { type: "ready" } once Rapier has loaded,
 *      { type: "done", roundId, rec } per round (the poses' buffer transferred),
 *      { type: "error", roundId, message } if a simulation throws.
 */
import * as RAPIER from "@dimforge/rapier3d";
import { simulateRound } from "../../../lib/throw/simulate";

interface Scope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<{ roundId?: unknown }>) => void) | null;
}
const scope = self as unknown as Scope;

scope.onmessage = (e) => {
  const roundId = e.data.roundId;
  if (typeof roundId !== "string") return;
  try {
    const rec = simulateRound(RAPIER, roundId);
    scope.postMessage({ type: "done", roundId, rec }, [rec.poses.buffer, rec.releaseVelocity.buffer]);
  } catch (err) {
    scope.postMessage({ type: "error", roundId, message: String(err) });
  }
};
scope.postMessage({ type: "ready" });
