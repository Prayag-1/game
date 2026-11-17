import * as RAPIER from "@dimforge/rapier3d";
import { SHELL_COUNT, TURN_ORDER, type SeatId } from "@kauda/rules";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { boardTurn, heap, scatter, seatSides } from "../src/lib/board";
import { BoardDirector, FADE_MS, PLAYBACK_RATE, RAPIER_WAIT_MS, type DirectorInput, type DirectorOutput, type Shown, type Sim } from "../src/lib/throw/director";
import type { HandFrame } from "../src/lib/throw/hand";
import { clearOfBoard, GROW_FROM, SEQ } from "../src/lib/throw/handSequence";
import { flightSeconds, flipsFor, lyingFrame, MESH, meshFrame, releasePoint, restingFrame, sampleRecording, visibleFaceUp } from "../src/lib/throw/playback";
import { simulateRound, type Recording } from "../src/lib/throw/simulate";

/**
 * The board's director, on a fake clock: the thrower's hand, when the
 * shells are scooped, hidden, released and rest, when the result may be
 * shown, and every way a throw falls back.
 */

let REC: Recording;
beforeAll(() => {
  REC = simulateRound(RAPIER, "director:1");
});

const ROUND = "director:1";
const FACES = Array.from({ length: SHELL_COUNT }, (_, i) => i % 4 === 1);
const RESULT: Shown = { roundId: ROUND, faces: FACES, thrower: "panja" };
const BEFORE: Shown = { roundId: "director:0", faces: Array(SHELL_COUNT).fill(false), thrower: "teeya" };
const betting = { roundId: ROUND, thrower: "panja" as SeatId, phase: "betting" as const };
const throwing = { ...betting, phase: "throwing" as const };

/** A simulation source whose answers the test sets. */
function source(initial: (id: string) => Sim) {
  let answer = initial;
  const requested: string[] = [];
  return {
    sims: {
      get: (id: string) => answer(id),
      request: (id: string) => {
        if (!requested.includes(id)) requested.push(id);
      },
    },
    requested,
    set(next: (id: string) => Sim) {
      answer = next;
    },
  };
}

function director(sim: (id: string) => Sim = () => REC) {
  const src = source(sim);
  const events = { onRevealed: vi.fn(), onRelease: vi.fn(), onSound: vi.fn(), onFallback: vi.fn() };
  const d = new BoardDirector(src.sims, events);
  const base: DirectorInput = { now: 0, current: null, shown: BEFORE, reveal: null, pressed: false, reduced: false, hidden: false };
  const at = (now: number, over: Partial<DirectorInput> = {}) => d.update({ ...base, ...over, now });
  return { d, src, events, at };
}

interface Snap {
  readonly now: number;
  readonly out: DirectorOutput;
  readonly frame: number[];
  readonly hand: HandFrame | null;
}
/** Updates every 16 ms from `from` to `to`, keeping a copy of every frame. */
function play(at: (now: number, over?: Partial<DirectorInput>) => DirectorOutput, from: number, to: number, over: (now: number) => Partial<DirectorInput>): Snap[] {
  const snaps: Snap[] = [];
  for (let now = from; now <= to; now += 16) {
    const out = at(now, over(now));
    snaps.push({ now, out, frame: Array.from(out.frame), hand: out.hand });
  }
  return snaps;
}

/** Settles the board on BEFORE's layout, then opens round ROUND's throwing phase at t = 100. */
function opened(sim?: (id: string) => Sim) {
  const t = director(sim);
  t.at(0, { current: betting });
  t.at(FADE_MS + 10, { current: betting });
  return t;
}
const T0 = 100;

describe("the hand", () => {
  it("reaches in when the throwing phase opens, scoops the shells into its fist, lifts them and holds", () => {
    const { at } = opened();
    const snaps = play(at, T0, T0 + SEQ.holdAt + 300, () => ({ current: throwing }));
    const phaseAt = (ms: number) => snaps.find((s) => s.now >= T0 + ms)?.hand?.phase;
    expect(phaseAt(0)).toBe("reach");
    expect(phaseAt(SEQ.reachEnd + 50)).toBe("scoop");
    expect(phaseAt(SEQ.scoopEnd + 50)).toBe("lift");
    expect(phaseAt(SEQ.holdAt + 50)).toBe("hold");
    // On the board until scooped; in the fist (hidden) from the moment it closes.
    const sizes = (s: Snap) => Array.from({ length: SHELL_COUNT }, (_, i) => s.frame[i * MESH + 7] ?? 0);
    expect(sizes(snaps[0] as Snap).every((v) => v > 0.9)).toBe(true);
    for (const s of snaps.filter((x) => x.now >= T0 + SEQ.fistClosed + 16)) expect(sizes(s).every((v) => v === 0)).toBe(true);
    // Shrinking as they are drawn in, never growing.
    const mid = snaps.find((s) => s.now >= T0 + 1000) as Snap;
    expect(sizes(mid).some((v) => v > 0 && v < 0.9)).toBe(true);
  });

  it("releases the shells at exactly the physics' release point and moment", () => {
    const { at, events } = opened();
    play(at, T0, T0 + SEQ.holdAt + 100, () => ({ current: throwing }));
    play(at, T0 + SEQ.holdAt + 116, T0 + SEQ.holdAt + 900, () => ({ current: throwing, reveal: RESULT }));
    expect(events.onRelease).toHaveBeenCalledOnce();
    const e = events.onRelease.mock.calls[0]?.[0] as { at: number; point: number[] };
    expect(e.point).toEqual(releasePoint(REC, "panja"));
    // At that instant: the palm's anchor is on the release point, and the shells are the recording's first frame.
    const out = at(e.at, { current: throwing, reveal: RESULT });
    const hand = out.hand as HandFrame;
    for (let k = 0; k < 3; k += 1) expect(Math.abs((hand.anchor[k] ?? 0) - (e.point[k] ?? 0))).toBeLessThan(1e-9);
    expect(out.phase).toBe("flight");
    const first = meshFrame();
    sampleRecording(first, REC, 0, flipsFor(REC.colliderUp, FACES), "panja");
    for (let i = 0; i < SHELL_COUNT; i += 1) {
      for (let k = 0; k < 7; k += 1) expect(out.frame[i * MESH + k]).toBeCloseTo(first[i * MESH + k] ?? 0, 6);
      // ...shown small, growing back to full size.
      expect(out.frame[i * MESH + 7]).toBeCloseTo((first[i * MESH + 7] ?? 0) * GROW_FROM, 6);
    }
    const grown = at(e.at + SEQ.growMs + 1, { current: throwing, reveal: RESULT });
    expect(grown.frame[7]).toBeGreaterThan((first[7] ?? 0) * 0.99);
  });

  it("turns every mesh that must flip while it is hidden in the fist: nothing visibly flips", () => {
    const { at, events } = opened();
    const snaps = [
      ...play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing })),
      ...play(at, T0 + SEQ.holdAt + 16, T0 + SEQ.holdAt + 6000, () => ({ current: throwing, reveal: RESULT })),
    ];
    expect(events.onRevealed).toHaveBeenCalledOnce();
    // A shell's rotation, visible frame to visible frame, never jumps (a flip is half a turn).
    for (let i = 0; i < SHELL_COUNT; i += 1) {
      let prev: number[] | null = null;
      for (const s of snaps) {
        const o = i * MESH;
        if ((s.frame[o + 7] ?? 0) === 0) {
          prev = null;
          continue;
        }
        const q = s.frame.slice(o + 3, o + 7);
        if (prev !== null) {
          const dot = Math.abs(q.reduce((sum, v, k) => sum + v * (prev?.[k] ?? 0), 0));
          expect(2 * Math.acos(Math.min(1, dot)), `shell ${i} at ${s.now}`).toBeLessThan((60 * Math.PI) / 180);
        }
        prev = q;
      }
    }
    // Every shell was hidden from the fist closing until the release...
    const release = (events.onRelease.mock.calls[0]?.[0] as { at: number }).at;
    for (const s of snaps.filter((x) => x.now >= T0 + SEQ.fistClosed + 16 && x.now < release)) {
      for (let i = 0; i < SHELL_COUNT; i += 1) expect(s.frame[i * MESH + 7]).toBe(0);
    }
    // ...and they land on the server's faces.
    const rest = snaps.at(-1) as Snap;
    for (let i = 0; i < SHELL_COUNT; i += 1) expect(visibleFaceUp(Float32Array.from(rest.frame), i)).toBe(FACES[i]);
  });

  it("is clear of the board, and gone, before the shells come to rest", () => {
    const { at, events } = opened();
    play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    const snaps = play(at, T0 + SEQ.holdAt + 16, T0 + SEQ.holdAt + 6000, () => ({ current: throwing, reveal: RESULT }));
    const release = (events.onRelease.mock.calls[0]?.[0] as { at: number }).at;
    const restAt = release + (flightSeconds(REC) / PLAYBACK_RATE) * 1000;
    const gone = snaps.find((s) => s.now > release && s.hand === null) as Snap;
    expect(gone.now).toBeLessThan(restAt);
    expect(gone.now - release).toBeLessThanOrEqual(SEQ.followMs + SEQ.withdrawMs + 16);
    for (const s of snaps.filter((x) => x.now >= restAt)) expect(s.hand).toBeNull();
    // Out past the rim before it fades away.
    const clear = snaps.find((s) => s.now > release && clearOfBoard(s.hand)) as Snap;
    expect(clear.now).toBeLessThan(restAt);
  });

  it("enters from its own seat's side, for every thrower, seen from every seat", () => {
    for (const thrower of TURN_ORDER) {
      for (const viewer of TURN_ORDER) {
        const { at } = director();
        at(0, { current: { roundId: "x", thrower, phase: "betting" } });
        const hand = at(10, { current: { roundId: "x", thrower, phase: "throwing" } }).hand as HandFrame;
        expect(hand.phase).toBe("reach");
        // Where it appears on my screen: the board turns so my seat is at the bottom (+z), +x to my right.
        const a = boardTurn(viewer);
        const x = hand.anchor[0] * Math.cos(a) + hand.anchor[2] * Math.sin(a);
        const z = -hand.anchor[0] * Math.sin(a) + hand.anchor[2] * Math.cos(a);
        const side = seatSides(viewer)[thrower];
        const where = side === "bottom" ? z : side === "top" ? -z : side === "right" ? x : -x;
        expect(where, `${thrower}'s hand seen from ${viewer} (${side})`).toBeGreaterThan(1.5);
        // And withdraws the same way.
        expect(Math.hypot(x, z)).toBeGreaterThan(1.5);
      }
    }
  });

  it("keeps shaking while the result is late after I press Throw, and never releases early", () => {
    const { at, events } = opened();
    play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    const waiting = play(at, T0 + SEQ.holdAt + 16, T0 + SEQ.holdAt + 3000, () => ({ current: throwing, pressed: true }));
    expect(waiting.slice(2).every((s) => s.hand?.phase === "shake")).toBe(true);
    expect(events.onRelease).not.toHaveBeenCalled();
    const shakes = events.onSound.mock.calls.filter(([cue]) => cue === "shake").length;
    expect(shakes).toBeGreaterThanOrEqual(Math.floor(3000 / SEQ.shakeMs));
    // The result arrives: a swing at the next shake's end, then the release.
    const t = T0 + SEQ.holdAt + 3016;
    play(at, t, t + 600, () => ({ current: throwing, pressed: true, reveal: RESULT }));
    expect(events.onRelease).toHaveBeenCalledOnce();
    const released = (events.onRelease.mock.calls[0]?.[0] as { at: number }).at;
    expect(released).toBeGreaterThan(t);
    expect(released - t).toBeLessThanOrEqual(SEQ.shakeMs + SEQ.swingMs + 16);
  });

  it("goes back to holding still if my Throw is refused", () => {
    const { at } = opened();
    play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    expect(at(T0 + SEQ.holdAt + 100, { current: throwing, pressed: true }).hand?.phase).toBe("shake");
    expect(at(T0 + SEQ.holdAt + 200, { current: throwing, pressed: false }).hand?.phase).toBe("hold");
  });

  it("lets a throw that comes before the hold wait for it, then shakes at least twice before the release", () => {
    const { at, events } = opened();
    const early = T0 + 200;
    play(at, T0, early, () => ({ current: throwing }));
    play(at, early + 16, early + 3000, () => ({ current: throwing, reveal: RESULT }));
    const released = (events.onRelease.mock.calls[0]?.[0] as { at: number }).at;
    // Never rushed: the scoop plays out, then the shakes and the swing.
    expect(released - T0).toBeGreaterThanOrEqual(SEQ.holdAt + SEQ.minShakes * SEQ.shakeMs + SEQ.swingMs - 16);
    expect(released - T0).toBeLessThanOrEqual(SEQ.holdAt + (SEQ.minShakes + 1) * SEQ.shakeMs + SEQ.swingMs + 32);
  });

  it("raises its sound cues: one scoop, each shake, one release", () => {
    const { at, events } = opened();
    play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    play(at, T0 + SEQ.holdAt + 16, T0 + SEQ.holdAt + 900, () => ({ current: throwing, reveal: RESULT }));
    const cues = events.onSound.mock.calls.map(([cue]) => cue as string);
    expect(cues.filter((c) => c === "scoop")).toHaveLength(1);
    expect(cues.filter((c) => c === "shake").length).toBeGreaterThanOrEqual(SEQ.minShakes);
    expect(cues.filter((c) => c === "release")).toHaveLength(1);
    expect(cues.indexOf("scoop")).toBeLessThan(cues.indexOf("shake"));
    expect(cues.lastIndexOf("shake")).toBeLessThan(cues.indexOf("release"));
  });

  it("shows a page that joins in the throwing phase the shells already in the fist, without replaying the reach", () => {
    const { at } = director();
    const out = at(0, { current: throwing });
    expect(out.hand?.phase).toBe("hold");
    for (let i = 0; i < SHELL_COUNT; i += 1) expect(out.frame[i * MESH + 7]).toBe(0);
  });

  it("keeps the held hand still in an automated browser, so a screenshot is stable", () => {
    const { at } = director();
    const a = at(0, { current: throwing, quiet: true });
    const b = at(777, { current: throwing, quiet: true });
    expect(b.hand?.anchor).toEqual(a.hand?.anchor);
    expect(b.moving).toBe(false);
  });
});

describe("no hand", () => {
  it("under reduced motion: the shells fade in about 0.3 s, and no hand ever appears", () => {
    const { at, events } = director();
    at(0, { reduced: true, current: betting });
    const snaps = [
      ...play(at, 10, 2000, () => ({ reduced: true, current: throwing, pressed: true })),
      ...play(at, 2016, 2016 + FADE_MS + 40, () => ({ reduced: true, current: throwing, reveal: RESULT })),
    ];
    expect(snaps.every((s) => s.hand === null)).toBe(true);
    expect(events.onRevealed).toHaveBeenCalledOnce();
    expect(snaps.at(-1)?.out.phase).toBe("still");
  });

  it("skips to rest when the tab is hidden, and when it is hidden mid-throw", () => {
    const hidden = director();
    hidden.at(0);
    const out = hidden.at(10, { reveal: RESULT, hidden: true });
    expect(out.phase).toBe("still");
    expect(out.hand).toBeNull();
    expect(hidden.events.onRevealed).toHaveBeenCalledOnce();

    const mid = opened();
    play(mid.at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    play(mid.at, T0 + SEQ.holdAt + 16, T0 + SEQ.holdAt + 800, () => ({ current: throwing, reveal: RESULT }));
    expect(mid.events.onRelease).toHaveBeenCalledOnce();
    const skipped = mid.at(T0 + SEQ.holdAt + 820, { current: throwing, reveal: RESULT, hidden: true });
    expect(mid.events.onRevealed).toHaveBeenCalledOnce();
    expect(skipped.hand).toBeNull();
    expect(Array.from(skipped.frame)).toEqual(Array.from(restingFrame(REC, FACES, "panja")));
  });
});

describe("when the throw cannot be played", () => {
  it("shakes up to 1.5 s for the physics, then the hand goes and the shells fade into the resting layout", () => {
    const { at, src, events } = opened(() => "pending");
    play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    const t = T0 + SEQ.holdAt + 16;
    const waiting = play(at, t, t + RAPIER_WAIT_MS - 32, () => ({ current: throwing, reveal: RESULT }));
    expect(waiting.slice(2).every((s) => s.hand?.phase === "shake")).toBe(true);
    expect(events.onRevealed).not.toHaveBeenCalled();
    const gaveUp = play(at, t + RAPIER_WAIT_MS, t + RAPIER_WAIT_MS + 600, () => ({ current: throwing, reveal: RESULT }));
    expect(events.onRevealed).toHaveBeenCalledExactlyOnceWith(ROUND);
    expect(events.onFallback).toHaveBeenCalledWith(ROUND, expect.stringContaining("not ready"));
    expect(gaveUp[1]?.hand?.phase).toBe("withdraw");
    expect(gaveUp.at(-1)?.hand).toBeNull();
    expect(events.onRelease).not.toHaveBeenCalled();
    // The layout is not known yet: nothing on the board until it is, then the shells fade in.
    expect(gaveUp.at(-1)?.out.opacity).toBe(0);
    src.set(() => REC);
    const u = t + RAPIER_WAIT_MS + 700;
    play(at, u, u + FADE_MS + 40, () => ({ shown: RESULT }));
    const settled = at(u + FADE_MS + 60, { shown: RESULT });
    expect(settled.layout).toBe("sim");
    expect(Array.from(settled.frame)).toEqual(Array.from(restingFrame(REC, FACES, "panja")));
  });

  it("fades into the seeded scatter, and logs it, when the physics never loads", () => {
    const { at, events } = opened(() => "failed");
    play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    const t = T0 + SEQ.holdAt + 16;
    const snaps = play(at, t, t + 700, () => ({ current: throwing, reveal: RESULT }));
    expect(events.onFallback).toHaveBeenCalledWith(ROUND, expect.stringContaining("could not load"));
    expect(events.onRevealed).toHaveBeenCalledExactlyOnceWith(ROUND);
    const done = snaps.at(-1)?.out as DirectorOutput;
    expect(done.layout).toBe("scatter");
    expect(done.opacity).toBe(1);
    const expected = lyingFrame(scatter(ROUND).map((p, i) => ({ ...p, up: FACES[i] === true })));
    expect(Array.from(done.frame)).toEqual(Array.from(expected));
  });

  it("fades into the seeded scatter, and logs it, when every attempt at a clean landing failed", () => {
    const fallback = simulateRound(RAPIER, ROUND, () => false);
    const { at, events } = opened((id) => (id === ROUND ? fallback : REC));
    play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    const t = T0 + SEQ.holdAt + 16;
    const snaps = play(at, t, t + 700, () => ({ current: throwing, reveal: RESULT }));
    expect(events.onFallback).toHaveBeenCalledWith(ROUND, expect.stringContaining("every attempt"));
    expect(snaps.at(-1)?.out.layout).toBe("scatter");
    expect(events.onRevealed).toHaveBeenCalledOnce();
    for (let i = 0; i < SHELL_COUNT; i += 1) expect(visibleFaceUp(snaps.at(-1)?.out.frame as Float32Array, i)).toBe(FACES[i]);
  });

  it("skips to rest when the page stops holding the result (the server moved on)", () => {
    const { at } = opened();
    play(at, T0, T0 + SEQ.holdAt, () => ({ current: throwing }));
    play(at, T0 + SEQ.holdAt + 16, T0 + SEQ.holdAt + 900, () => ({ current: throwing, reveal: RESULT }));
    const out = at(T0 + SEQ.holdAt + 920, { shown: RESULT });
    expect(out.phase).toBe("still");
    expect(out.hand).toBeNull();
    expect(Array.from(out.frame)).toEqual(Array.from(restingFrame(REC, FACES, "panja")));
  });

  it("shows a page that arrives after the throw the shells at rest, with no hand", () => {
    const { at, events } = director();
    at(0, { shown: RESULT });
    const out = at(FADE_MS + 5, { shown: RESULT });
    expect(out.layout).toBe("sim");
    expect(out.hand).toBeNull();
    expect(events.onRelease).not.toHaveBeenCalled();
    expect(Array.from(out.frame)).toEqual(Array.from(restingFrame(REC, FACES, "panja")));
  });

  it("lies in the heap before the first throw, and simulates each round ahead", () => {
    const { at, src } = director();
    const out = at(0, { shown: null, current: { roundId: "next", thrower: "chakka", phase: "betting" } });
    expect(out.layout).toBe("heap");
    expect(Array.from(out.frame)).toEqual(Array.from(lyingFrame(heap())));
    expect(src.requested).toEqual(["next"]);
  });
});
