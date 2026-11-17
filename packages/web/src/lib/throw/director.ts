import { SHELL_COUNT, type SeatId } from "@kauda/rules";
import { heap, scatter } from "../board";
import { POSES, blendPose, type HandFrame, type HandPose, type Quat, type Vec3 } from "./hand";
import {
  add,
  entryPoint,
  followPath,
  frame as handFrame,
  GROW_FROM,
  holdPoint,
  holdRotation,
  holdShake,
  lerp3,
  nominalRelease,
  nominalThrow,
  norm,
  reachRotation,
  releaseRotation,
  scale,
  SCOOPED_SIZE,
  scoopPose,
  seatDirection,
  SEQ,
  slerpQ,
  smooth,
  swingPath,
  throwShake,
} from "./handSequence";
import { flightSeconds, flipsFor, lyingFrame, MESH, meshFrame, releasePoint, releaseVelocities, restingFrame, sampleRecording, type MeshFrame } from "./playback";
import type { Recording } from "./simulate";

/**
 * THE BOARD'S DIRECTOR: where the sixteen shells and the thrower's hand are
 * at any moment. Pure and time-driven (no three.js, no timers), so the tests
 * drive it with a fake clock: the 3D stage calls update() every frame it
 * draws, and draws what it returns.
 *
 * Between throws the shells lie where the last throw left them (the heap
 * before the first). When a round's throwing phase opens, the thrower's
 * hand plays its sequence (handSequence.ts): it reaches in, scoops the
 * shells into its fist, lifts them and holds, shaking gently. The throw
 * happens (I press Throw, or the result arrives because a bot threw or the
 * timer ran out): quick shakes, then a swing that flings the shells out at
 * exactly the physics' release point and moment, and the recorded throw
 * plays. The shells' meshes are turned for the server's faces while they
 * are hidden in the fist, so nothing visibly flips. When they are at rest
 * the page may show the result (onRevealed).
 *
 * The throw never depends on the faces, so each round's throw is simulated
 * ahead from its round id, and is ready before anyone throws.
 *
 * Not every throw can be played. Under reduced motion there is no hand and
 * no tumble: the shells fade to their resting layout. When the recording is
 * not ready within RAPIER_WAIT_MS of the result, the hand opens and goes,
 * and the shells fade in; when the physics never loads, or every attempt
 * failed, they fade into the seeded scatter. A hidden tab, or a page that
 * arrives after the throw, goes straight to rest; a page that arrives
 * during the throwing phase finds the shells already in the fist.
 */

/** Recorded seconds per shown second: the throw is shown at 0.8x, like a world with 0.64x the gravity. */
export const PLAYBACK_RATE = 0.8;
/** How long a result waits for its recording before falling back to a fade. */
export const RAPIER_WAIT_MS = 1500;
/** The reduced-motion fade, and the fallback fade: out, then in. */
export const FADE_MS = 300;
/** When the physics answers after the hand is already lifting, its hold eases over to the real release point over this long. */
const ANCHOR_BLEND_MS = 400;

/** What the simulation has for a round. */
export type Sim = Recording | "pending" | "failed";

export interface SimSource {
  get(roundId: string): Sim;
  /** Asks for a round's throw to be simulated (idempotent). */
  request(roundId: string): void;
}

export interface Shown {
  readonly roundId: string;
  readonly faces: readonly boolean[];
  readonly thrower: SeatId;
}

export interface DirectorInput {
  /** Milliseconds, from any steady clock. */
  readonly now: number;
  /** The round being played, and its phase. Null outside betting and throwing. */
  readonly current: { readonly roundId: string; readonly thrower: SeatId; readonly phase: "betting" | "throwing" } | null;
  /** The settled round the page shows: its shells lie where it left them. Null before the first. */
  readonly shown: Shown | null;
  /** A result the page is holding back until the shells rest: play it. */
  readonly reveal: Shown | null;
  /** I pressed Throw for the current round and the server has not refused. */
  readonly pressed: boolean;
  readonly reduced: boolean;
  readonly hidden: boolean;
  /** No idle motion (automated test browsers): the held hand keeps still while it waits. */
  readonly quiet?: boolean;
}

export type Layout = "heap" | "sim" | "scatter" | "pending";
export type Phase = "still" | "hand" | "flight" | "fade";

export interface DirectorOutput {
  /** The director's own buffer: draw it (or copy it) before the next update. */
  readonly frame: MeshFrame;
  /** 0 to 1, for every shell. */
  readonly opacity: number;
  /** Something is moving: draw every frame. */
  readonly moving: boolean;
  readonly phase: Phase;
  /** What lies on the board when still. */
  readonly layout: Layout;
  /** The thrower's hand, or null when there is none on screen. */
  readonly hand: HandFrame | null;
  /** The hand holds at the physics' own release point (not a guess while the physics loads). */
  readonly handAnchored: boolean;
}

/** For the hand and for sound: where and when. */
export interface ThrowEvent {
  readonly roundId: string;
  /** In the board's frame. */
  readonly point: readonly [number, number, number];
  readonly at: number;
}

export type SoundCue = "scoop" | "shake" | "release";

export interface DirectorEvents {
  /** The shells of this round are at rest: the page may show its result. */
  onRevealed(roundId: string): void;
  /** The shells leave the hand: the physics' first frame. */
  onRelease?(e: ThrowEvent): void;
  /** Hooks for sound, with no audio yet: the scoop, each shake, the release. */
  onSound?(cue: SoundCue, e: ThrowEvent): void;
  /** Logged when a throw falls back to a fade. */
  onFallback?(roundId: string, why: string): void;
}

interface Anchors {
  readonly release: Vec3;
  /** The throw's direction, and its velocity as shown (units per second). */
  readonly dir: Vec3;
  readonly vel: Vec3;
  readonly hold: Vec3;
}

interface Withdraw {
  readonly at: number;
  readonly anchor: Vec3;
  readonly rotation: Quat;
  readonly pose: HandPose;
}

/** One round's hand, from the throwing phase opening to the hand gone. */
interface Sequence {
  readonly roundId: string;
  readonly thrower: SeatId;
  /** The shells where they lay when the hand came, and each one's turn in the scoop. */
  readonly from: MeshFrame;
  readonly fromVisible: boolean;
  readonly rank: readonly number[];
  readonly centre: Vec3;
  /** Sequence time, ms. */
  clock: number;
  last: number;
  triggered: boolean;
  revealSeen: boolean;
  shakeStart: number | null;
  shakesHeard: number;
  swingStart: number | null;
  releaseAt: number | null;
  released: boolean;
  rec: Recording | null;
  recAt: number;
  flips: boolean[] | null;
  waitingSince: number | null;
  withdraw: Withdraw | null;
  scoopHeard: boolean;
  /** The hand has gone; the sequence ends once its throw is also over. */
  gone: boolean;
}

interface Flight {
  readonly roundId: string;
  readonly rec: Recording;
  readonly flips: boolean[];
  readonly thrower: SeatId;
  readonly start: number;
}

interface Fade {
  readonly start: number;
  /** Faded out from this; null when nothing was showing. */
  readonly from: MeshFrame | null;
  /** The layout to fade in. */
  key: string;
  /** Set when the fade-in begins: when the fade-out ends, or later, once a pending layout is known. */
  inAt: number | null;
  /** The layout was not known when the fade-out ended. */
  waited: boolean;
  /** Report this round revealed when the fade completes. */
  readonly reveals: string | null;
}

export class BoardDirector {
  private lying: MeshFrame;
  private lyingKey = "heap";
  private visible = true;
  private seq: Sequence | null = null;
  private flight: Flight | null = null;
  private fade: Fade | null = null;
  /** The last round reported revealed. */
  private done: string | null = null;
  /** The last round seen in its betting phase: a throwing phase seen without it is one we joined mid-way. */
  private bettingSeen: string | null = null;
  private waitingSince: { roundId: string; at: number } | null = null;
  private readonly out = meshFrame();

  constructor(
    private readonly sims: SimSource,
    private readonly events: DirectorEvents,
  ) {
    this.lying = lyingFrame(heap());
  }

  update(input: DirectorInput): DirectorOutput {
    const { now, current, shown, reveal } = input;
    if (current !== null) this.sims.request(current.roundId);
    if (shown !== null) this.sims.request(shown.roundId);
    if (reveal !== null) this.sims.request(reveal.roundId);
    if (current?.phase === "betting") this.bettingSeen = current.roundId;

    // A throw being played that the page no longer holds back (the server
    // moved on, or the page gave up waiting): skip to its rest.
    if (this.flight !== null && reveal?.roundId !== this.flight.roundId) {
      this.land(this.flight.roundId);
      this.seq = null;
    }

    if (this.seq !== null && !this.seqStillWanted(input)) this.dropSequence(input);
    if (!input.reduced && !input.hidden && this.seq === null) this.maybeStartSequence(input);

    if (this.seq !== null) {
      const out = this.runSequence(input);
      if (out !== null) return out;
    }

    // Without a hand: reduced motion, a hidden tab, a fallback, or a result with no sequence.
    if (reveal !== null && reveal.roundId !== this.done) this.revealWithoutHand(input, reveal);
    else this.waitingSince = null;

    if (this.flight !== null) return this.drawFlight(now, null);

    // Still: the layout of the round on show, faded in when it changes. A
    // round that has come to rest counts as on show while the page catches up.
    const display = reveal !== null && this.done === reveal.roundId ? reveal : shown;
    if (this.fade === null) {
      const want = display === null ? "heap" : this.keyFor(display);
      if (want !== this.lyingKey) this.startFade(now, want, null);
    }
    if (this.fade !== null) return this.drawFade(now, display, reveal);
    // Waiting for the physics: keep drawing, so the wait can run out.
    return this.output(this.lying, this.visible ? 1 : 0, this.waitingSince !== null, "still", null);
  }

  // ------------------------------------------------------------ the hand

  private maybeStartSequence(input: DirectorInput): void {
    const { now, current, reveal } = input;
    let round: { roundId: string; thrower: SeatId } | null = null;
    // The throwing phase opens: the thrower's hand comes for the shells.
    if (current?.phase === "throwing" && current.roundId !== this.done && this.fade?.reveals !== current.roundId) round = current;
    // A result for a round whose throwing phase this page never saw.
    else if (reveal !== null && reveal.roundId !== this.done && this.flight === null && this.fade?.reveals !== reveal.roundId) round = reveal;
    // Its shells are already in the air (the hand has gone, the throw plays on): never a second hand.
    if (round === null || this.flight?.roundId === round.roundId) return;
    const sim = this.sims.get(round.roundId);
    // A result with no throw to play: the fade handles it, without a hand.
    if (reveal?.roundId === round.roundId && (sim === "failed" || (typeof sim === "object" && sim.fallback))) return;

    // Joined mid-way (no betting phase seen for it): the shells are already in the fist.
    const joined = this.bettingSeen !== round.roundId;
    const from = this.lying.slice();
    const fromVisible = this.visible && this.fade === null;
    this.fade = null;
    const centre = centroid(from);
    this.seq = {
      roundId: round.roundId,
      thrower: round.thrower,
      from,
      fromVisible,
      rank: scoopOrder(from, centre),
      centre,
      clock: joined ? SEQ.holdAt : 0,
      last: now,
      triggered: false,
      revealSeen: false,
      shakeStart: null,
      shakesHeard: 0,
      swingStart: null,
      releaseAt: null,
      released: false,
      // Ready already (the usual case: simulated during betting): the hold is at the real point from the start.
      rec: typeof sim === "object" && !sim.fallback ? sim : null,
      recAt: -Infinity,
      flips: null,
      waitingSince: null,
      withdraw: null,
      scoopHeard: joined,
      gone: false,
    };
    // The shells are the hand's now.
    this.visible = false;
  }

  /** Should the sequence carry on? */
  private seqStillWanted(input: DirectorInput): boolean {
    const s = this.seq as Sequence;
    if (input.reduced || input.hidden) return false;
    if (s.released) return true;
    // The page stopped holding a result it had shown us: the server moved on.
    if (s.revealSeen && input.reveal?.roundId !== s.roundId) return false;
    // The round moved on without a throw.
    if (!s.revealSeen && input.current?.roundId !== s.roundId && input.reveal?.roundId !== s.roundId) return false;
    return true;
  }

  /** Ends the sequence at once: the shells go where they belong, with no hand. */
  private dropSequence(input: DirectorInput): void {
    const s = this.seq as Sequence;
    this.seq = null;
    if (this.flight !== null) return;
    const { shown, reveal } = input;
    if (shown?.roundId === s.roundId) this.setLying(this.keyFor(shown), shown);
    else if (reveal?.roundId === s.roundId) {
      // Hidden or reduced with the result in hand: straight to rest.
      this.setLying(this.keyFor(reveal), reveal);
      this.reveal(reveal.roundId);
    } else {
      // Put back where they lay.
      this.lying = s.from;
      this.visible = s.fromVisible;
    }
  }

  private runSequence(input: DirectorInput): DirectorOutput | null {
    const s = this.seq as Sequence;
    const { now, reveal } = input;

    // The throw happens: my press, or the result arriving.
    const revealHere = reveal !== null && reveal.roundId === s.roundId;
    if (revealHere) s.revealSeen = true;
    const pressedHere = input.pressed && input.current?.roundId === s.roundId;
    if (!s.released && s.swingStart === null && s.withdraw === null) {
      const triggered = revealHere || pressedHere;
      // Refused: back to holding still.
      if (!triggered) s.shakeStart = null;
      s.triggered = triggered;
    }

    // Sequence time. (A throw that comes before the hold, which the server prevents, simply waits for it.)
    const dt = Math.max(0, now - s.last);
    s.last = now;
    if (s.clock < SEQ.holdAt) s.clock = Math.min(SEQ.holdAt, s.clock + dt);
    if (!s.scoopHeard && s.clock >= SEQ.reachEnd) {
      s.scoopHeard = true;
      this.events.onSound?.("scoop", { roundId: s.roundId, point: s.centre, at: now });
    }

    // The physics, once it answers.
    const sim = this.sims.get(s.roundId);
    if (s.rec === null && typeof sim === "object" && !sim.fallback) {
      s.rec = sim;
      // Answered before the lift began: the hold goes straight to the real point.
      s.recAt = s.clock < SEQ.scoopEnd ? -Infinity : now;
    }

    // The result.
    if (revealHere && !s.released && s.withdraw === null) {
      if (sim === "failed" || (typeof sim === "object" && sim.fallback)) {
        this.events.onFallback?.(s.roundId, sim === "failed" ? "the physics could not load" : "every attempt at a clean landing failed");
        this.abort(now, input, reveal, true);
      } else if (sim === "pending") {
        s.waitingSince ??= now;
        if (now - s.waitingSince >= RAPIER_WAIT_MS) {
          this.events.onFallback?.(s.roundId, "the physics was not ready in time");
          this.abort(now, input, reveal, false);
        }
      } else if (s.flips === null) {
        // The meshes to turn over. They are turned only while hidden in the fist: they are drawn
        // with these flips from the release on, and the release only comes after the scoop has hidden them.
        s.flips = flipsFor(sim.colliderUp, reveal.faces);
      }
    }

    // Shaking, once holding and triggered.
    if (s.triggered && s.clock >= SEQ.holdAt && s.shakeStart === null && s.swingStart === null && s.withdraw === null) s.shakeStart = now;
    if (s.shakeStart !== null && s.swingStart === null && s.withdraw === null) {
      const started = Math.floor((now - s.shakeStart) / SEQ.shakeMs) + 1;
      for (; s.shakesHeard < started; s.shakesHeard += 1) {
        this.events.onSound?.("shake", { roundId: s.roundId, point: this.anchors(s, now).hold, at: s.shakeStart + s.shakesHeard * SEQ.shakeMs });
      }
      // Two shakes at least; then the swing, as soon as the result and its throw are here.
      const completed = Math.floor((now - s.shakeStart) / SEQ.shakeMs);
      if (completed >= SEQ.minShakes && s.flips !== null && s.rec !== null) {
        s.swingStart = s.shakeStart + completed * SEQ.shakeMs;
        s.releaseAt = s.swingStart + SEQ.swingMs;
      }
    }

    // The release: the recorded throw starts, from the hand.
    if (s.releaseAt !== null && !s.released && now >= s.releaseAt && s.rec !== null && s.flips !== null) {
      s.released = true;
      this.flight = { roundId: s.roundId, rec: s.rec, flips: s.flips, thrower: s.thrower, start: s.releaseAt };
      const e = { roundId: s.roundId, point: releasePoint(s.rec, s.thrower), at: s.releaseAt };
      this.events.onRelease?.(e);
      this.events.onSound?.("release", e);
    }

    const hand = this.handFrame(s, now, input.quiet === true);
    if (hand === null) s.gone = true;
    const anchored = s.rec !== null && now - s.recAt >= ANCHOR_BLEND_MS;

    if (this.flight !== null) {
      const out = this.drawFlight(now, hand);
      if (s.gone) this.seq = null;
      return { ...out, moving: out.moving || hand !== null, hand, handAnchored: anchored };
    }
    if (s.withdraw !== null && !s.released) {
      // Aborted: the hand goes; the shells are the fade's.
      if (s.gone) this.seq = null;
      const rest = this.restWithHand(input, hand);
      return rest;
    }
    this.drawScoop(s, hand);
    const idle = input.quiet === true && s.clock >= SEQ.holdAt && s.shakeStart === null && s.rec !== null && now - s.recAt >= ANCHOR_BLEND_MS;
    return { frame: this.out, opacity: 1, moving: !idle, phase: "hand", layout: this.layoutOf(this.lyingKey), hand, handAnchored: anchored };
  }

  /** After an abort: the fade (or the still board) as usual, with the hand withdrawing over it. */
  private restWithHand(input: DirectorInput, hand: HandFrame | null): DirectorOutput {
    const display = input.reveal !== null && this.done === input.reveal.roundId ? input.reveal : input.shown;
    const out = this.fade !== null ? this.drawFade(input.now, display, input.reveal) : this.output(this.lying, this.visible ? 1 : 0, false, "still", null);
    return { ...out, moving: out.moving || hand !== null, hand, handAnchored: false };
  }

  /** The hand opens and goes; the shells fade to where they belong. */
  private abort(now: number, input: DirectorInput, reveal: Shown, revealsAfterFade: boolean): void {
    const s = this.seq as Sequence;
    const hand = this.handFrame(s, now, input.quiet === true);
    s.withdraw =
      hand === null
        ? { at: now - SEQ.withdrawMs, anchor: entryPoint(s.thrower), rotation: reachRotation(s.thrower), pose: POSES.open }
        : { at: now, anchor: hand.anchor, rotation: hand.rotation, pose: hand.pose };
    // Shells still on the board (or mid-scoop) fade out from there; hidden in the fist, they only fade in.
    this.drawScoop(s, hand);
    this.lying = this.out.slice();
    this.visible = s.clock < SEQ.fistClosed && s.fromVisible;
    this.startFade(now, this.keyFor(reveal), revealsAfterFade ? reveal.roundId : null);
    if (!revealsAfterFade) this.reveal(reveal.roundId);
  }

  private anchors(s: Sequence, now: number): Anchors {
    const nominal = { release: nominalRelease(s.thrower), dir: nominalThrow(s.thrower) };
    if (s.rec === null) return { ...nominal, vel: scale(nominal.dir, 2.5), hold: holdPoint(nominal.release, nominal.dir) };
    const v = releaseVelocities(s.rec, s.thrower);
    let mean: Vec3 = [0, 0, 0];
    for (let i = 0; i < SHELL_COUNT; i += 1) mean = add(mean, [v[i * 3] ?? 0, v[i * 3 + 1] ?? 0, v[i * 3 + 2] ?? 0]);
    const vel = scale(mean, PLAYBACK_RATE / SHELL_COUNT);
    const real = { release: releasePoint(s.rec, s.thrower), dir: norm(vel) };
    const k = smooth((now - s.recAt) / ANCHOR_BLEND_MS);
    const release = lerp3(nominal.release, real.release, k);
    const dir = norm(lerp3(nominal.dir, real.dir, k));
    return { release, dir, vel, hold: holdPoint(release, dir) };
  }

  /** Where the hand is now, or null once it has gone. */
  private handFrame(s: Sequence, now: number, quiet: boolean): HandFrame | null {
    const seat = s.thrower;
    if (s.withdraw === null && s.releaseAt !== null && now >= s.releaseAt + SEQ.followMs) {
      const a = this.anchors(s, now);
      s.withdraw = { at: s.releaseAt + SEQ.followMs, anchor: followPath(a.release, a.vel, SEQ.followMs), rotation: releaseRotation(seat), pose: POSES.flung };
    }
    if (s.withdraw !== null) {
      const w = (now - s.withdraw.at) / SEQ.withdrawMs;
      if (w >= 1) return null;
      const k = smooth(w);
      return handFrame(
        seat,
        "withdraw",
        w,
        lerp3(s.withdraw.anchor, entryPoint(seat), k),
        slerpQ(s.withdraw.rotation, reachRotation(seat), k),
        blendPose(s.withdraw.pose, POSES.open, k),
        1 - smooth((w - 0.35) / 0.65),
      );
    }
    const a = this.anchors(s, now);
    if (s.releaseAt !== null && now >= s.releaseAt) {
      const ms = now - s.releaseAt;
      return handFrame(seat, "follow", ms / SEQ.followMs, followPath(a.release, a.vel, ms), releaseRotation(seat), blendPose(POSES.fist, POSES.flung, smooth(0.5 + ms / (2 * SEQ.flungMs))));
    }
    if (s.swingStart !== null && now >= s.swingStart) {
      const u = Math.min(1, (now - s.swingStart) / SEQ.swingMs);
      const openFrom = (s.releaseAt as number) - SEQ.flungMs;
      return handFrame(
        seat,
        "swing",
        u,
        swingPath(a.hold, a.release, a.vel, u, SEQ.swingMs / 1000),
        slerpQ(holdRotation(seat), releaseRotation(seat), smooth(u)),
        blendPose(POSES.fist, POSES.flung, smooth((now - openFrom) / (2 * SEQ.flungMs))),
      );
    }
    const c = s.clock;
    const entry = entryPoint(seat);
    const d = seatDirection(seat);
    // Over the shells: in from the far side of their middle, sweeping back towards the thrower.
    const scoopIn = add(add(s.centre, [0, 0.16, 0]), scale(d, -0.16));
    const scoopOut = add(add(s.centre, [0, 0.14, 0]), scale(d, 0.1));
    if (c < SEQ.reachEnd) {
      const k = smooth(c / SEQ.reachEnd);
      return handFrame(seat, "reach", c / SEQ.reachEnd, add(lerp3(entry, scoopIn, k), [0, 0.12 * Math.sin(Math.PI * k), 0]), reachRotation(seat), POSES.open);
    }
    if (c < SEQ.scoopEnd) {
      const u = (c - SEQ.reachEnd) / (SEQ.scoopEnd - SEQ.reachEnd);
      return handFrame(seat, "scoop", u, lerp3(scoopIn, scoopOut, smooth(u)), reachRotation(seat), scoopPose(c));
    }
    if (c < SEQ.holdAt) {
      const u = (c - SEQ.scoopEnd) / (SEQ.holdAt - SEQ.scoopEnd);
      const k = smooth(u);
      return handFrame(seat, "lift", u, add(lerp3(scoopOut, a.hold, k), [0, 0.08 * Math.sin(Math.PI * k), 0]), slerpQ(reachRotation(seat), holdRotation(seat), k), POSES.fist);
    }
    if (s.shakeStart !== null) {
      const since = now - s.shakeStart;
      return handFrame(seat, "shake", (since % SEQ.shakeMs) / SEQ.shakeMs, add(a.hold, throwShake(since, a.dir)), holdRotation(seat), POSES.fist);
    }
    return handFrame(seat, "hold", ((now / 1000) * 1.7) % 1, add(a.hold, holdShake(now, a.dir, quiet)), holdRotation(seat), POSES.fist);
  }

  /** The shells while the hand has them: drawn into the palm, shrinking, then hidden in the fist. */
  private drawScoop(s: Sequence, hand: HandFrame | null): void {
    const c = s.clock;
    for (let i = 0; i < SHELL_COUNT; i += 1) {
      const o = i * MESH;
      this.out.set(s.from.subarray(o, o + MESH), o);
      const size = s.from[o + 7] ?? 1;
      if (!s.fromVisible || c >= SEQ.fistClosed || hand === null) {
        // Hidden: in the fist (or nowhere, with no hand).
        if (hand !== null) this.out.set(hand.anchor, o);
        this.out[o + 7] = 0;
        continue;
      }
      const start = SEQ.scoopFirst + (SEQ.scoopSpread * (s.rank[i] ?? 0)) / (SHELL_COUNT - 1);
      const k = (c - start) / SEQ.scoopEach;
      if (k <= 0) continue;
      const e = smooth(k);
      const p = add(lerp3([s.from[o] ?? 0, s.from[o + 1] ?? 0, s.from[o + 2] ?? 0], hand.anchor, e), [0, 0.06 * Math.sin(Math.PI * e), 0]);
      this.out.set(p, o);
      this.out[o + 7] = size * (1 - (1 - SCOOPED_SIZE) * e);
    }
  }

  // ------------------------------------------------- results without a hand

  private revealWithoutHand(input: DirectorInput, reveal: Shown): void {
    const { now } = input;
    if (input.hidden) {
      // Nobody is watching (the tab is hidden, now or mid-throw): straight to rest.
      if (this.flight?.roundId === reveal.roundId) this.land(reveal.roundId);
      else this.setLying(this.keyFor(reveal), reveal);
      this.fade = null;
      this.reveal(reveal.roundId);
      return;
    }
    if (this.flight?.roundId === reveal.roundId) return;
    if (this.fade?.reveals === reveal.roundId) return;
    const sim = this.sims.get(reveal.roundId);
    if (sim === "pending") {
      if (this.waitingSince?.roundId !== reveal.roundId) this.waitingSince = { roundId: reveal.roundId, at: now };
      if (now - this.waitingSince.at < RAPIER_WAIT_MS) return;
      this.startFade(now, this.keyFor(reveal), null);
      this.reveal(reveal.roundId);
      return;
    }
    if (sim === "failed") this.events.onFallback?.(reveal.roundId, "the physics could not load");
    else if (sim.fallback) this.events.onFallback?.(reveal.roundId, "every attempt at a clean landing failed");
    // Reduced motion, or no throw to play: fade to the resting layout.
    this.startFade(now, this.keyFor(reveal), reveal.roundId);
  }

  /** The round's shells are at rest: report it, once. */
  private reveal(roundId: string): void {
    if (this.done === roundId) return;
    this.done = roundId;
    this.events.onRevealed(roundId);
  }

  /** Ends a flight at once, on its resting frame. */
  private land(roundId: string): void {
    const f = this.flight;
    this.flight = null;
    if (f === null) return;
    this.lying = restingFrame(f.rec, flipsAsFaces(f), f.thrower);
    this.lyingKey = `sim:${roundId}`;
    this.visible = true;
  }

  // -------------------------------------------------------------- layouts

  private keyFor(s: Shown): string {
    const sim = this.sims.get(s.roundId);
    if (sim === "pending") return `pending:${s.roundId}`;
    if (sim === "failed" || sim.fallback) return `scatter:${s.roundId}`;
    return `sim:${s.roundId}`;
  }

  private frameFor(key: string, s: Shown | null): MeshFrame | null {
    if (key === "heap") return lyingFrame(heap());
    if (s === null || key.startsWith("pending:")) return null;
    if (key.startsWith("scatter:")) return lyingFrame(scatter(s.roundId).map((p, i) => ({ ...p, up: s.faces[i] === true })));
    const sim = this.sims.get(s.roundId);
    return typeof sim === "object" ? restingFrame(sim, s.faces, s.thrower) : null;
  }

  private setLying(key: string, s: Shown): void {
    const frame = this.frameFor(key, s);
    this.lyingKey = key;
    this.visible = frame !== null;
    if (frame !== null) this.lying = frame;
  }

  // -------------------------------------------------------------- fading

  private startFade(now: number, key: string, reveals: string | null): void {
    this.fade = { start: now, from: this.visible ? this.lying.slice() : null, key, inAt: null, waited: false, reveals };
  }

  private drawFade(now: number, shown: Shown | null, reveal: Shown | null): DirectorOutput {
    const f = this.fade as Fade;
    const half = FADE_MS / 2;
    const target = reveal !== null && f.reveals === reveal.roundId ? reveal : shown;
    // The layout may have become known since the fade began (pending -> sim or scatter).
    if (f.key.startsWith("pending:") && target !== null) f.key = this.keyFor(target);
    const outDone = f.from === null || now - f.start >= half;
    if (!outDone && f.from !== null) return this.output(f.from, 1 - (now - f.start) / half, true, "fade", null);
    if (f.inAt === null) {
      const frame = this.frameFor(f.key, target);
      if (frame === null) {
        // Not known yet: nothing on the board until it is.
        f.waited = true;
        this.visible = false;
        return this.output(this.lying, 0, false, "fade", null);
      }
      this.lying = frame;
      this.lyingKey = f.key;
      f.inAt = f.waited ? now : f.start + (f.from === null ? 0 : half);
    }
    const k = (now - f.inAt) / half;
    if (k >= 1) {
      this.fade = null;
      this.visible = true;
      if (f.reveals !== null) this.reveal(f.reveals);
      return this.output(this.lying, 1, false, "still", null);
    }
    return this.output(this.lying, Math.max(0, k), true, "fade", null);
  }

  // ------------------------------------------------------------ drawing

  /** The recorded throw; the shells grow back to full size over the first moments after leaving the hand. */
  private drawFlight(now: number, hand: HandFrame | null): DirectorOutput {
    const f = this.flight as Flight;
    const t = ((now - f.start) / 1000) * PLAYBACK_RATE;
    if (t >= flightSeconds(f.rec)) {
      this.land(f.roundId);
      this.reveal(f.roundId);
      return this.output(this.lying, 1, hand !== null, "still", hand);
    }
    sampleRecording(this.out, f.rec, Math.max(0, t), f.flips, f.thrower);
    const grow = GROW_FROM + (1 - GROW_FROM) * smooth((now - f.start) / SEQ.growMs);
    if (grow < 1) for (let i = 0; i < SHELL_COUNT; i += 1) this.out[i * MESH + 7] = (this.out[i * MESH + 7] ?? 1) * grow;
    return this.output(this.out, 1, true, "flight", hand);
  }

  private layoutOf(key: string): Layout {
    return key === "heap" ? "heap" : (key.split(":")[0] as Layout);
  }

  private output(frame: MeshFrame, opacity: number, moving: boolean, phase: Phase, hand: HandFrame | null): DirectorOutput {
    return { frame, opacity: Math.max(0, Math.min(1, opacity)), moving, phase, layout: this.layoutOf(this.fade?.key ?? this.lyingKey), hand, handAnchored: false };
  }
}

/** The faces a flight lands on: its flips applied to which way its colliders finished. */
function flipsAsFaces(f: Flight): boolean[] {
  return f.rec.colliderUp.map((up, i) => (f.flips[i] === true) === up);
}

function centroid(frame: MeshFrame): Vec3 {
  let x = 0;
  let z = 0;
  for (let i = 0; i < SHELL_COUNT; i += 1) {
    x += frame[i * MESH] ?? 0;
    z += frame[i * MESH + 2] ?? 0;
  }
  return [x / SHELL_COUNT, 0.05, z / SHELL_COUNT];
}

/** Each shell's turn in the scoop: the nearest the middle of the spread first. */
function scoopOrder(frame: MeshFrame, centre: Vec3): number[] {
  const byDistance = Array.from({ length: SHELL_COUNT }, (_, i) => i).sort((a, b) => {
    const da = Math.hypot((frame[a * MESH] ?? 0) - centre[0], (frame[a * MESH + 2] ?? 0) - centre[2]);
    const db = Math.hypot((frame[b * MESH] ?? 0) - centre[0], (frame[b * MESH + 2] ?? 0) - centre[2]);
    return da - db || a - b;
  });
  const rank = Array<number>(SHELL_COUNT).fill(0);
  byDistance.forEach((shell, r) => (rank[shell] = r));
  return rank;
}
