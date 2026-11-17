import * as RAPIER from "@dimforge/rapier3d";
import { act, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Header } from "../src/components/Header";
import type { Stage3DProps } from "../src/components/table/board3d/Stage3D";
import { BoardDirector, PLAYBACK_RATE } from "../src/lib/throw/director";
import { SEQ } from "../src/lib/throw/handSequence";
import { flightSeconds } from "../src/lib/throw/playback";
import { simulateRound } from "../src/lib/throw/simulate";
import { useSession } from "../src/lib/session";
import { ingest, MAX_HOLD_MS, pressThrow, releaseThrow, setThrowAnimator, useTable } from "../src/lib/tableStore";
import { TableScreen } from "../src/screens/Table";
import { renderAt } from "./helpers";

/**
 * NOT SPOILING THE THROW. The server sends a round's result the moment it
 * settles; the page must not give it away (the result word, the count,
 * mā-ryo / ti-ryo, chips, the round log) until the board's shells are at
 * rest.
 */

// The recording every round plays, made once by the real physics.
const physics = vi.hoisted(() => ({ rec: null as ReturnType<typeof simulateRound> | null }));
beforeAll(() => {
  physics.rec = simulateRound(RAPIER, "hold:r1");
});

// The 3D board without WebGL: the real director (hand and all), on the page's clock, at full motion.
vi.mock("../src/components/table/board3d/Stage3D", () => ({
  default: function BoardWithoutWebGL(props: Stage3DProps) {
    const latest = useRef(props);
    latest.current = props;
    useEffect(() => {
      const rec = physics.rec;
      if (rec === null) throw new Error("no recording");
      const director = new BoardDirector({ get: () => rec, request: () => {} }, { onRevealed: (id) => latest.current.onRevealed(id) });
      latest.current.onReady();
      const tick = setInterval(() => {
        const p = latest.current;
        director.update({ now: Date.now(), current: p.current, shown: p.shown, reveal: p.reveal, pressed: p.pressed, reduced: false, hidden: false });
      }, 16);
      return () => clearInterval(tick);
    }, []);
    return null;
  },
}));

const RULES = { thini: 10, doubling: true, maxStakeMultiplier: 8, ghantiChips: 10, chyakheEnabled: true, maxChyakhe: 8 };
const HASH = "a".repeat(64);
const FACES = Array.from({ length: 16 }, (_, i) => i < 5); // 5 up: panja
const player = (id: string, chips: number) => ({ playerId: id, name: id, isBot: false, connected: true, chips });

function view(over: Record<string, unknown> = {}) {
  return {
    tableId: "t1",
    phase: "throwing",
    roundId: "r1",
    thrower: "panja",
    streak: 0,
    stake: 10,
    commitHash: HASH,
    seats: { teeya: player("me", 100), chauka: player("b", 100), panja: player("c", 100), chakka: player("d", 100) },
    chyakhe: [],
    bets: [],
    phaseEndsAt: null,
    reservations: [],
    lastRound: null,
    rules: RULES,
    ...over,
  };
}

function round(roundId = "r1") {
  return {
    roundId,
    seed: "0".repeat(64),
    commitHash: HASH,
    faces: FACES,
    faceUp: 5,
    winningSeat: "panja",
    hit: true,
    stake: 10,
    multiplier: 1,
    deltas: { c: 30, me: -10, b: -10, d: -10 },
    at: 1,
    thrower: "panja",
    streak: 0,
    occupants: { teeya: "me", chauka: "b", panja: "c", chakka: "d" },
    chyakhe: [],
  };
}

/** The view the server sends when round r1 settles: the result, and the chips already moved. */
const revealed = () =>
  view({
    phase: "revealing",
    commitHash: null,
    seats: { teeya: player("me", 90), chauka: player("b", 90), panja: player("c", 130), chakka: player("d", 90) },
    lastRound: round(),
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("holding a revealed round in the store", () => {
  it("holds the result, chips and log entry while a board plays the throw, and shows them all on release", () => {
    ingest("view", view());
    setThrowAnimator(true);
    ingest("view", revealed());
    ingest("round", round());
    const s = useTable.getState();
    expect(s.view?.phase).toBe("throwing");
    expect(s.view?.lastRound).toBeNull();
    expect(s.view?.seats.teeya?.chips).toBe(100);
    expect(s.rounds).toEqual([]);
    expect(s.held?.roundId).toBe("r1");

    releaseThrow("r1");
    const after = useTable.getState();
    expect(after.held).toBeNull();
    expect(after.view?.phase).toBe("revealing");
    expect(after.view?.seats.teeya?.chips).toBe(90);
    expect(after.rounds.map((r) => r.roundId)).toEqual(["r1"]);
  });

  it("keeps the newest view while holding, and ignores a release for another round", () => {
    ingest("view", view());
    setThrowAnimator(true);
    ingest("view", revealed());
    ingest("view", { ...revealed(), chyakhe: [player("late", 50)] });
    releaseThrow("r0");
    expect(useTable.getState().held).not.toBeNull();
    releaseThrow("r1");
    expect(useTable.getState().view?.chyakhe.map((p) => p.playerId)).toEqual(["late"]);
  });

  it("shows everything at once when the server moves on to the next round first", () => {
    ingest("view", view());
    setThrowAnimator(true);
    ingest("view", revealed());
    ingest("view", { ...revealed(), phase: "betting", roundId: "r2" });
    const s = useTable.getState();
    expect(s.held).toBeNull();
    expect(s.view?.roundId).toBe("r2");
    expect(s.rounds.map((r) => r.roundId)).toEqual(["r1"]);
  });

  it("shows the result at once with no board to play it (2D, or not drawn yet)", () => {
    ingest("view", view());
    ingest("view", revealed());
    expect(useTable.getState().held).toBeNull();
    expect(useTable.getState().view?.phase).toBe("revealing");
  });

  it("shows the result at once to a page that arrives after the throw", () => {
    setThrowAnimator(true);
    ingest("view", revealed());
    expect(useTable.getState().held).toBeNull();
    expect(useTable.getState().view?.lastRound?.roundId).toBe("r1");
  });

  it("ends a hold when the board goes away, and after MAX_HOLD_MS whatever happens", () => {
    ingest("view", view());
    setThrowAnimator(true);
    ingest("view", revealed());
    setThrowAnimator(false);
    expect(useTable.getState().held).toBeNull();

    vi.useFakeTimers();
    ingest("view", view({ roundId: "r2", lastRound: round() }));
    setThrowAnimator(true);
    ingest("view", { ...revealed(), roundId: "r2", lastRound: round("r2") });
    expect(useTable.getState().held?.roundId).toBe("r2");
    vi.advanceTimersByTime(MAX_HOLD_MS - 1);
    expect(useTable.getState().held).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useTable.getState().held).toBeNull();
  });

  it("forgets my press when the server refuses it", () => {
    ingest("view", view());
    pressThrow("r1");
    expect(useTable.getState().pressed).toBe("r1");
    ingest("error", { reason: "not-your-turn" });
    expect(useTable.getState().pressed).toBeNull();
  });
});

describe("the table while the shells are in the air", () => {
  /** The 3D board's path needs a WebGL context to exist; the mock above never touches it. */
  function fakeWebGL(): void {
    vi.stubGlobal("WebGLRenderingContext", function WebGLRenderingContext() {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
      kind.startsWith("webgl") ? { getExtension: () => ({ loseContext: () => {} }) } : null) as typeof HTMLCanvasElement.prototype.getContext);
  }

  it("changes nothing that gives the result away until the playback has finished", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    fakeWebGL();
    useSession.setState({ status: "signedIn", me: { id: "me", name: "me", balance: 500 } });
    useTable.setState({ conn: "connected", tableId: "t1", welcome: { playerId: "me", name: "me", minChipsToSit: 10, standardBuyIn: 100 } });
    ingest("view", view());
    renderAt(
      <>
        <Header />
        <TableScreen />
      </>,
      "/table/t1",
    );
    // The board is on screen and can play a throw.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId("stage")).toHaveAttribute("data-ready", "true");

    // The server settles round r1: result, chips and log entry all arrive now.
    act(() => {
      ingest("view", revealed());
      ingest("round", round());
    });
    const rec = physics.rec as NonNullable<typeof physics.rec>;
    // The page joined in the throwing phase, so the hand already holds the shells: shakes, the swing, then the throw.
    const playMs = SEQ.minShakes * SEQ.shakeMs + SEQ.swingMs + (flightSeconds(rec) / PLAYBACK_RATE) * 1000;
    const nothingGivenAway = () => {
      expect(screen.queryByTestId("winning-seat")).toBeNull();
      expect(screen.queryByTestId("stage-result")).toBeNull();
      expect(document.querySelector('[data-result="hit"], [data-result="miss"]')).toBeNull();
      expect(screen.getByTestId("table-chips")).toHaveAttribute("data-chips", "100");
      expect(screen.getByTestId("my-chips")).toHaveTextContent("१००");
      expect(screen.queryAllByTestId("log-row")).toHaveLength(0);
      for (const [seat, chips] of [["teeya", "१००"], ["panja", "१००"]] as const) expect(screen.getByTestId(`seat-${seat}`)).toHaveTextContent(chips);
    };
    // Through the shakes, the swing and the whole tumble, checking every 100 ms, to just short of rest.
    let elapsed = 0;
    nothingGivenAway();
    while (elapsed + 100 < playMs - 50) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      elapsed += 100;
      nothingGivenAway();
    }
    expect(elapsed).toBeGreaterThan(playMs - 200);

    // The shells come to rest: everything appears together.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(playMs - elapsed + 100);
    });
    expect(screen.getByTestId("winning-seat")).toHaveAttribute("data-seat", "panja");
    expect(document.querySelector('[data-result="hit"]')).not.toBeNull();
    expect(screen.getByTestId("table-chips")).toHaveAttribute("data-chips", "90");
    expect(screen.getByTestId("my-chips")).toHaveTextContent("९०");
    expect(screen.getByTestId("seat-panja")).toHaveTextContent("१३०");
    expect(screen.getAllByTestId("log-row")).toHaveLength(1);
  });
});
