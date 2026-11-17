import * as RAPIER from "@dimforge/rapier3d";
import { DEFAULT_HOUSE_RULES, seatForFaceCount, settleRound, TURN_ORDER, type SeatId } from "@kauda/rules";
import { act, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Header } from "../src/components/Header";
import type { Stage3DProps } from "../src/components/table/board3d/Stage3D";
import { BetTokens } from "../src/components/table/BetTokens";
import { seatSides } from "../src/lib/board";
import { COUNT, highlightOf, schedule, transfers } from "../src/lib/ceremony";
import type { RoundRecord } from "../src/lib/protocol";
import { useSession } from "../src/lib/session";
import { BoardDirector, PLAYBACK_RATE } from "../src/lib/throw/director";
import { SEQ } from "../src/lib/throw/handSequence";
import { flightSeconds } from "../src/lib/throw/playback";
import { simulateRound } from "../src/lib/throw/simulate";
import { finishCeremony, ingest, releaseThrow, subscribeCeremony, useTable } from "../src/lib/tableStore";
import { TableScreen } from "../src/screens/Table";
import { renderAt } from "./helpers";

/**
 * THE MOMENT AFTER THE SHELLS LAND: the count, the result, the chips, then
 * the log, in that order and none before the shells rest; every number the
 * server's; and the final state at once for a page that was not watching.
 */

// ------------------------------------------------------------------ setup

const physics = vi.hoisted(() => ({ rec: null as ReturnType<typeof simulateRound> | null, webgl: false }));
beforeAll(() => {
  physics.rec = simulateRound(RAPIER, "ceremony:r1");
});

// The 3D board without WebGL: the real director (hand and all) on the page's clock, at full motion.
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

function fakeWebGL(): void {
  vi.stubGlobal("WebGLRenderingContext", function WebGLRenderingContext() {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
    kind.startsWith("webgl") ? { getExtension: () => ({ loseContext: () => {} }) } : null) as typeof HTMLCanvasElement.prototype.getContext);
}
function motion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce, media: query, addEventListener() {}, removeEventListener() {} }));
}

afterEach(() => {
  vi.useRealTimers();
});

const RULES = DEFAULT_HOUSE_RULES;
const HASH = "a".repeat(64);
const BUY_IN = 1000;
type Players = Partial<Record<SeatId, string>>;
const FULL: Players = { teeya: "me", chauka: "b", panja: "c", chakka: "d" };

/** A settled round from the real rules, as the server sends it. */
function settled(opts: { thrower: SeatId; faceUp: number; occupants?: Players; chyakhe?: { playerId: string; seat: SeatId; chips: number }[]; streak?: number; roundId?: string }) {
  const occupants = (opts.occupants ?? FULL) as Record<SeatId, string>;
  const faces = Array.from({ length: 16 }, (_, i) => i < opts.faceUp);
  const chyakhe = opts.chyakhe ?? [];
  const streak = opts.streak ?? 0;
  const o = settleRound({ thrower: opts.thrower, occupants, chyakhe, streak, rules: RULES, faces });
  const round: RoundRecord = {
    roundId: opts.roundId ?? "ceremony:r1",
    seed: "0".repeat(64),
    commitHash: HASH,
    faces,
    faceUp: o.faceUp,
    winningSeat: o.winningSeat,
    hit: o.hit,
    stake: o.stake,
    multiplier: o.stakeMultiplier,
    deltas: o.deltas,
    at: 1,
    thrower: opts.thrower,
    streak,
    occupants,
    chyakhe,
  };
  return { round, outcome: o };
}

const player = (id: string, chips: number) => ({ playerId: id, name: id, isBot: false, connected: true, chips });

/** The view in the throwing phase, and the view the server sends once the round has settled. */
function views(round: RoundRecord, opts: { occupants?: Players; bettors?: string[]; streak?: number } = {}) {
  const occupants = opts.occupants ?? FULL;
  const bettors = opts.bettors ?? [];
  const seats = (after: boolean) =>
    Object.fromEntries(TURN_ORDER.map((seat) => [seat, occupants[seat] === undefined ? null : player(occupants[seat] as string, BUY_IN + (after ? (round.deltas[occupants[seat] as string] ?? 0) : 0))]));
  const chyakhe = (after: boolean) => bettors.map((id) => player(id, BUY_IN + (after ? (round.deltas[id] ?? 0) : 0)));
  const base = { tableId: "t1", roundId: round.roundId, thrower: round.thrower, streak: opts.streak ?? round.streak, stake: round.stake, phaseEndsAt: null, reservations: [], rules: RULES };
  return {
    throwing: { ...base, phase: "throwing", commitHash: HASH, seats: seats(false), chyakhe: chyakhe(false), bets: round.chyakhe, lastRound: null },
    revealed: { ...base, phase: "revealing", commitHash: null, seats: seats(true), chyakhe: chyakhe(true), bets: [], lastRound: round },
  };
}

function seatAt(seat: SeatId, me = "me") {
  useSession.setState({ status: "signedIn", me: { id: me, name: me, balance: 0 } });
  useTable.setState({ conn: "connected", tableId: "t1", welcome: { playerId: me, name: me, minChipsToSit: 10, standardBuyIn: BUY_IN } });
  void seat;
}

function renderTable() {
  return renderAt(
    <>
      <Header />
      <TableScreen />
    </>,
    "/table/t1",
  );
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

// ------------------------------------------------------------- the schedule

describe("the schedule", () => {
  it("never counts for more than 2 seconds: 0, 1, 8 and 16 shells up", () => {
    for (const up of [0, 1, 8, 16]) {
      const s = schedule(up, 1000);
      expect(s.resultAt - s.start, `${up} up`).toBeLessThanOrEqual(COUNT.maxMs);
      expect(s.resultAt).toBeLessThan(s.chipsAt);
      expect(s.chipsAt).toBeLessThan(s.arriveAt);
      expect(s.arriveAt).toBeLessThan(s.logAt);
    }
    // About a quarter of a second each with few up; faster with many; a brief "0" beat with none.
    expect(schedule(3, 0).interval).toBe(COUNT.perShellMs);
    expect(schedule(16, 0).interval).toBe(COUNT.maxMs / 16);
    expect(schedule(0, 0).resultAt).toBe(COUNT.zeroBeatMs);
  });

  it("happens all at once under reduced motion", () => {
    const s = schedule(9, 500, true);
    expect([s.resultAt, s.chipsAt, s.arriveAt, s.logAt]).toEqual([500, 500, 500, 500]);
  });
});

describe("who pays whom", () => {
  it("on a hit: the three others pay the thrower, every outside bet goes to the thrower, and on the first hit the ghanti goes out", () => {
    const { round } = settled({ thrower: "teeya", faceUp: 3, chyakhe: [{ playerId: "x", seat: "panja", chips: 20 }] });
    const t = transfers(round, RULES.ghantiChips);
    expect(t.filter((x) => x.kind === "stake").map((x) => [x.from, x.to])).toEqual([
      [{ seat: "chauka" }, { seat: "teeya" }],
      [{ seat: "panja" }, { seat: "teeya" }],
      [{ seat: "chakka" }, { seat: "teeya" }],
    ]);
    expect(t.filter((x) => x.kind === "bet")).toEqual([{ kind: "bet", from: { bet: "x", seat: "panja" }, to: { seat: "teeya" } }]);
    expect(t.filter((x) => x.kind === "ghanti").map((x) => x.to)).toEqual([{ seat: "chauka" }, { seat: "panja" }, { seat: "chakka" }]);
    // No ghanti after the first hit of a turn.
    expect(transfers(settled({ thrower: "teeya", faceUp: 3, streak: 1 }).round, RULES.ghantiChips).some((x) => x.kind === "ghanti")).toBe(false);
  });

  it("on a miss: the thrower pays the winning seat and the bets on it; the other bets go back", () => {
    const { round } = settled({
      thrower: "teeya",
      faceUp: 4, // chauka
      chyakhe: [
        { playerId: "x", seat: "chauka", chips: 20 },
        { playerId: "y", seat: "panja", chips: 30 },
      ],
    });
    expect(transfers(round, RULES.ghantiChips)).toEqual([
      { kind: "stake", from: { seat: "teeya" }, to: { seat: "chauka" } },
      { kind: "bet", from: { seat: "teeya" }, to: { bet: "x", seat: "chauka" } },
      { kind: "return", from: { bet: "y", seat: "panja" }, to: { bet: "y", seat: "panja" } },
    ]);
  });

  it("on a push (the winning seat empty): nothing moves, the bets go back", () => {
    const { round } = settled({ thrower: "teeya", faceUp: 6, occupants: { teeya: "me", chauka: "b", panja: "c" }, chyakhe: [{ playerId: "x", seat: "chakka", chips: 20 }] });
    expect(highlightOf(round)).toEqual({ kind: "push", seat: null });
    expect(transfers(round, RULES.ghantiChips)).toEqual([{ kind: "return", from: { bet: "x", seat: "chakka" }, to: { bet: "x", seat: "chakka" } }]);
  });
});

// --------------------------------------------------------------- the order

describe("the order of events", () => {
  it("counts, then shows the result, then moves the chips, then the log: and nothing before the shells rest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    fakeWebGL();
    motion(false);
    seatAt("teeya");
    const { round } = settled({ thrower: "teeya", faceUp: 3 }); // a hit for teeya
    const v = views(round);
    const counted: number[] = [];
    subscribeCeremony((e) => {
      if (e.type === "count") counted.push(e.n);
    });
    ingest("view", v.throwing);
    renderTable();
    await advance(50);
    expect(screen.getByTestId("stage")).toHaveAttribute("data-ready", "true");

    act(() => {
      ingest("view", v.revealed);
      ingest("round", round);
    });
    const rec = physics.rec as NonNullable<typeof physics.rec>;
    const restMs = SEQ.minShakes * SEQ.shakeMs + SEQ.swingMs + (flightSeconds(rec) / PLAYBACK_RATE) * 1000;
    const nothingYet = () => {
      expect(screen.queryByTestId("stage-count")).toBeNull();
      expect(screen.queryByTestId("winning-seat")).toBeNull();
      expect(screen.getByTestId("table-chips")).toHaveAttribute("data-chips", String(BUY_IN));
      expect(screen.queryAllByTestId("log-row")).toHaveLength(0);
    };
    // In the air: nothing.
    for (let t = 0; t + 100 < restMs - 50; t += 100) {
      nothingYet();
      await advance(100);
    }
    nothingYet();
    // At rest: the count begins. From here, step to each boundary of the real schedule.
    await advance(150);
    const sched = useTable.getState().ceremony?.sched;
    if (sched === undefined) throw new Error("the steps did not begin at rest");
    const to = (when: number) => advance(Math.max(0, when - Date.now()));
    const count = () => Number(screen.getByTestId("stage-count").getAttribute("data-count"));
    const chips = () => screen.getByTestId("table-chips").getAttribute("data-chips");
    await to(sched.start);
    expect(count()).toBe(1);
    await to(sched.start + sched.interval);
    expect(count()).toBe(2);
    await to(sched.start + 2 * sched.interval);
    expect(count()).toBe(3);
    // The count: no result, no chips, no log.
    await to(sched.resultAt - 1);
    expect(screen.queryByTestId("winning-seat")).toBeNull();
    expect(chips()).toBe(String(BUY_IN));
    // The result, straight after the count; still the old chips, no log.
    await to(sched.resultAt);
    expect(screen.queryByTestId("stage-count")).toBeNull();
    expect(screen.getByTestId("winning-seat")).toHaveAttribute("data-seat", "teeya");
    expect(screen.getByTestId("seat-teeya")).toHaveAttribute("data-highlight", "hit");
    expect(screen.queryByTestId("chip-flights")).toBeNull();
    expect(chips()).toBe(String(BUY_IN));
    // The chips: tokens in the air...
    await to(sched.chipsAt);
    expect(screen.getByTestId("chip-flights").querySelectorAll("[data-chip-token]").length).toBeGreaterThanOrEqual(3);
    expect(chips()).toBe(String(BUY_IN));
    // ...landing: the server's delta floats up, the total ticks to the server's figure.
    await to(sched.arriveAt);
    expect(screen.getByTestId("seat-teeya").querySelector("[data-testid='chip-float']")).toHaveAttribute("data-delta", String(round.deltas.me));
    await to(sched.arriveAt + COUNT.tickMs);
    expect(chips()).toBe(String(BUY_IN + (round.deltas.me ?? 0)));
    // The log entry (and its fairness check) last of all.
    await to(sched.logAt - 1);
    expect(screen.queryAllByTestId("log-row")).toHaveLength(0);
    await to(sched.logAt);
    expect(screen.getAllByTestId("log-row")).toHaveLength(1);
    expect(counted).toEqual([1, 2, 3]);
  });
});

// ----------------------------------------------------------- the numbers

describe("the numbers shown are the server's", () => {
  async function play(round: RoundRecord, opts: { occupants?: Players; bettors?: string[]; me?: string } = {}) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    motion(false); // the 2D board: no WebGL, and the steps play as soon as the result is in
    seatAt("teeya", opts.me ?? "me");
    const v = views(round, opts);
    ingest("view", v.throwing);
    renderTable();
    act(() => {
      ingest("view", v.revealed);
      ingest("round", round);
    });
    const s = schedule(round.faceUp, 0);
    await advance(s.arriveAt - s.start + 20);
    const floats = Object.fromEntries(screen.queryAllByTestId("chip-float").map((el) => [el.closest("[data-testid^='seat-'], li")?.textContent ?? "", Number(el.getAttribute("data-delta"))]));
    const seatFloat = (seat: SeatId) => {
      const el = screen.getByTestId(`seat-${seat}`).querySelector("[data-testid='chip-float']");
      return el === null ? 0 : Number(el.getAttribute("data-delta"));
    };
    const myFloat = () => {
      const el = screen.queryByTestId("my-chips-float");
      return el === null ? 0 : Number(el.getAttribute("data-delta"));
    };
    await advance(COUNT.tickMs + 20);
    const seatChips = (seat: SeatId) => Number(screen.getByTestId(`seat-${seat}`).querySelector("[data-testid='seat-chips']")?.getAttribute("data-chips"));
    return { floats, seatFloat, myFloat, seatChips, revealed: v.revealed };
  }

  const expectSeats = (r: Awaited<ReturnType<typeof play>>, round: RoundRecord, occupants: Players = FULL) => {
    for (const seat of TURN_ORDER) {
      const id = occupants[seat];
      if (id === undefined) continue;
      expect(r.seatFloat(seat), `${seat}'s float`).toBe(round.deltas[id] ?? 0);
      expect(r.seatChips(seat), `${seat}'s chips`).toBe(BUY_IN + (round.deltas[id] ?? 0));
    }
  };

  it("a hit, on the first hit of a turn (with ghanti)", async () => {
    const { round } = settled({ thrower: "teeya", faceUp: 3 });
    expect(round.deltas.me).toBe(3 * round.stake - RULES.ghantiChips);
    const r = await play(round);
    expectSeats(r, round);
    expect(r.myFloat()).toBe(round.deltas.me);
  });

  it("a hit later in a turn (no ghanti)", async () => {
    const { round } = settled({ thrower: "teeya", faceUp: 3, streak: 1 });
    expect(round.deltas.me).toBe(3 * round.stake);
    expectSeats(await play(round), round);
  });

  it("a miss, with an outside bet won and one returned", async () => {
    const { round } = settled({
      thrower: "teeya",
      faceUp: 4,
      chyakhe: [
        { playerId: "x", seat: "chauka", chips: 20 },
        { playerId: "y", seat: "panja", chips: 30 },
      ],
    });
    const r = await play(round, { bettors: ["x", "y"] });
    expectSeats(r, round);
    expect(r.floats).toMatchObject({});
    const bettorFloat = (id: string) => {
      const row = screen.getByTestId("chyakhe-list").querySelectorAll("li");
      const li = [...row].find((l) => l.textContent?.startsWith(id));
      const el = li?.querySelector("[data-testid='chip-float']");
      return el === null || el === undefined ? 0 : Number(el.getAttribute("data-delta"));
    };
    expect(bettorFloat("x")).toBe(round.deltas.x);
    expect(round.deltas.x).toBe(20);
    expect(bettorFloat("y")).toBe(0);
  });

  it("a hit with outside bets lost to the thrower", async () => {
    const { round } = settled({
      thrower: "teeya",
      faceUp: 3,
      streak: 1,
      chyakhe: [
        { playerId: "x", seat: "chauka", chips: 20 },
        { playerId: "y", seat: "panja", chips: 30 },
      ],
    });
    const r = await play(round, { bettors: ["x", "y"] });
    expectSeats(r, round);
    expect(round.deltas.me).toBe(3 * round.stake + 50);
  });

  it("a push: a plain line, and no chips move", async () => {
    const occupants: Players = { teeya: "me", chauka: "b", panja: "c" };
    const { round } = settled({ thrower: "teeya", faceUp: 6, occupants });
    const r = await play(round, { occupants });
    expect(screen.getByTestId("stage-result")).toHaveAttribute("data-result", "push");
    expect(screen.queryAllByTestId("chip-float")).toHaveLength(0);
    expectSeats(r, round, occupants);
  });
});

// -------------------------------------------------------- the right side

describe("the result's side, from every seat", () => {
  async function shown(viewer: SeatId, faceUp: number) {
    fakeWebGL();
    motion(true); // reduced: the result at once
    const occupants = Object.fromEntries(TURN_ORDER.map((seat) => [seat, seat === viewer ? "me" : `p-${seat}`])) as Players;
    seatAt(viewer);
    const { round } = settled({ thrower: "panja", faceUp, occupants });
    const v = views(round, { occupants });
    ingest("view", v.throwing);
    const view = renderTable();
    act(() => {
      ingest("view", v.revealed);
      ingest("round", round);
      // The board says the shells are at rest.
      releaseThrow(round.roundId);
    });
    await act(async () => {});
    return { view, round };
  }

  for (const viewer of TURN_ORDER) {
    it(`lights the thrower's side on a hit and the winner's side on a miss, seen from ${viewer}`, async () => {
      // A hit for panja (5 up).
      let r = await shown(viewer, 5);
      let stage = screen.getByTestId("stage");
      expect(stage).toHaveAttribute("data-glow-seat", "panja");
      expect(stage).toHaveAttribute("data-glow-kind", "hit");
      let lit = screen.getByTestId("seat-panja");
      expect(lit).toHaveAttribute("data-highlight", "hit");
      expect(lit.parentElement).toHaveAttribute("data-side", seatSides(viewer).panja);
      r.view.unmount();
      useTable.setState({ view: null, rounds: [], ceremony: null });

      // A miss: 6 up, chakka wins.
      r = await shown(viewer, 6);
      expect(r.round.winningSeat).toBe(seatForFaceCount(6));
      stage = screen.getByTestId("stage");
      expect(stage).toHaveAttribute("data-glow-seat", "chakka");
      expect(stage).toHaveAttribute("data-glow-kind", "win");
      lit = screen.getByTestId("seat-chakka");
      expect(lit).toHaveAttribute("data-highlight", "win");
      expect(lit.parentElement).toHaveAttribute("data-side", seatSides(viewer).chakka);
      expect(screen.getByTestId("seat-panja")).not.toHaveAttribute("data-highlight");
    });
  }
});

// ---------------------------------------------------- straight to the end

describe("a page that was not watching gets the final state at once", () => {
  const finalState = (round: RoundRecord) => {
    expect(screen.getByTestId("winning-seat")).toBeInTheDocument();
    expect(screen.queryByTestId("stage-count")).toBeNull();
    expect(screen.getByTestId("table-chips")).toHaveAttribute("data-chips", String(BUY_IN + (round.deltas.me ?? 0)));
    expect(screen.getAllByTestId("log-row")).toHaveLength(1);
    expect(useTable.getState().ceremony).toBeNull();
  };

  it("when it joins (or comes back) after the throw", async () => {
    motion(false);
    seatAt("teeya");
    const { round } = settled({ thrower: "teeya", faceUp: 3 });
    ingest("view", views(round).revealed);
    renderTable();
    finalState(round);
  });

  it("when its tab is hidden as the result arrives, and when it is hidden part-way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    motion(false);
    seatAt("teeya");
    const { round } = settled({ thrower: "teeya", faceUp: 3 });
    const v = views(round);
    ingest("view", v.throwing);
    renderTable();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => ingest("view", v.revealed));
    finalState(round);

    // Part-way: the steps have begun, then the tab goes.
    visibility.mockReturnValue("visible");
    useTable.setState({ rounds: [] });
    const next = settled({ thrower: "teeya", faceUp: 3, roundId: "ceremony:r2" });
    const v2 = views(next.round);
    act(() => ingest("view", v2.throwing));
    act(() => ingest("view", v2.revealed));
    expect(useTable.getState().ceremony).not.toBeNull();
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(useTable.getState().ceremony).toBeNull();
    expect(screen.getAllByTestId("log-row").map((r) => r.getAttribute("data-round-id"))).toContain("ceremony:r2");
  });

  it("under reduced motion: no tokens and no count to wait for, the changed numbers highlighted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    motion(true);
    seatAt("teeya");
    const { round } = settled({ thrower: "teeya", faceUp: 3 });
    const v = views(round);
    ingest("view", v.throwing);
    renderTable();
    act(() => ingest("view", v.revealed));
    await advance(0);
    finalState(round);
    expect(screen.queryByTestId("chip-flights")).toBeNull();
    expect(screen.queryAllByTestId("chip-float")).toHaveLength(0);
    expect(screen.getByTestId("seat-teeya").querySelector("[data-testid='seat-chips']")?.className).toContain("bg-brass/25");
  });

  it("finishes one round's steps at once when the next round's result arrives", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    motion(false);
    seatAt("teeya");
    const first = settled({ thrower: "teeya", faceUp: 3 });
    const v1 = views(first.round);
    ingest("view", v1.throwing);
    ingest("view", v1.revealed);
    expect(useTable.getState().ceremony?.round.roundId).toBe("ceremony:r1");
    const second = settled({ thrower: "teeya", faceUp: 3, roundId: "ceremony:r2" });
    const v2 = views(second.round);
    ingest("view", v2.throwing);
    expect(useTable.getState().rounds.map((r) => r.roundId)).toContain("ceremony:r1");
    ingest("view", v2.revealed);
    expect(useTable.getState().ceremony?.round.roundId).toBe("ceremony:r2");
    finishCeremony();
  });
});

// ---------------------------------------------------------------- the rest

describe("around the result", () => {
  it("keeps my Throw shut until my hand is holding the shells", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    seatAt("teeya");
    const { round } = settled({ thrower: "teeya", faceUp: 3 });
    ingest("view", views(round).throwing);
    renderTable();
    const button = screen.getByRole("button", { name: "कौडा फाल्नुहोस्" });
    expect(button).toBeDisabled();
    expect(screen.getByTestId("picking-up")).toBeInTheDocument();
    await advance(SEQ.holdAt - 1);
    expect(button).toBeDisabled();
    await advance(1);
    expect(button).toBeEnabled();
  });

  it("shows a thrower's streak on their panel and the stake bar, and says when the stake is capped", () => {
    seatAt("teeya");
    const { round } = settled({ thrower: "teeya", faceUp: 3 });
    const v = views(round, { streak: 2 });
    ingest("view", { ...v.throwing, streak: 2, stake: RULES.thini * 4 });
    const view = renderTable();
    expect(screen.getByTestId("streak")).toHaveAttribute("data-multiplier", "4");
    expect(screen.getByTestId("multiplier")).toHaveAttribute("data-multiplier", "4");
    expect(screen.queryByTestId("stake-cap")).toBeNull();
    view.unmount();
    act(() => ingest("view", { ...v.throwing, streak: 5, stake: RULES.thini * RULES.maxStakeMultiplier }));
    renderTable();
    expect(screen.getByTestId("stake-cap")).toBeInTheDocument();
    expect(screen.getByTestId("streak")).toHaveTextContent("सीमा");
  });

  it("shows the outside bets at the board's edge by the seat they back, mine marked, the bettor named", () => {
    const sides = seatSides("teeya");
    render(
      <BetTokens
        bets={[
          { playerId: "me", seat: "panja", chips: 20 },
          { playerId: "x", seat: "chakka", chips: 30 },
        ]}
        sides={sides}
        names={{ x: "हरि" }}
        myId="me"
      />,
    );
    const mine = document.querySelector("[data-bet-token='me']");
    expect(mine).toHaveAttribute("data-mine", "true");
    expect(mine).toHaveTextContent("२०");
    const theirs = document.querySelector("[data-bet-token='x']");
    expect(theirs).toHaveAttribute("title", expect.stringContaining("हरि"));
    expect(theirs).toHaveAttribute("data-seat", "chakka");
  });
});
