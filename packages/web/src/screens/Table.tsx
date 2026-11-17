import { numberFormat } from "../lib/format";
import { TURN_ORDER, type SeatId } from "@kauda/rules";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SEQ } from "../lib/throw/handSequence";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { errorNotice } from "../components/Notice";
import { BetControls } from "../components/table/BetControls";
import { ConnectionBanner } from "../components/table/ConnectionBanner";
import { Fairness } from "../components/table/Fairness";
import { PhaseBar } from "../components/table/PhaseBar";
import { RoundLog } from "../components/table/RoundLog";
import { SeatCard } from "../components/table/SeatCard";
import { BoardStage } from "../components/table/BoardStage";
import type { EdgeGlow, StageResult } from "../components/table/Stage";
import { BetTokens } from "../components/table/BetTokens";
import { ChipFlights } from "../components/table/ChipFlights";
import { highlightOf, reached } from "../lib/ceremony";
import { shownChips, signed, useCeremonyNow } from "../lib/useCeremony";
import { TopUp } from "../components/table/TopUp";
import { Term } from "../components/Term";
import { buttonPrimary, buttonQuiet, eyebrow, input } from "../components/ui";
import { seatSides, type Side } from "../lib/board";
import type { TableView } from "../lib/protocol";
import { useSession } from "../lib/session";
import { claimTopUp, leaveTable, resume, send } from "../lib/table";
import { clearRefusal, myBetIn, myPlayerIn, myReservationIn, mySeatIn, pressThrow, releaseThrow, setThrowAnimator, useTable } from "../lib/tableStore";
import type { RoundRecord } from "../lib/protocol";

/**
 * The table, in two layers. The board (seats at its edges, the shells in the
 * middle) is the hero and gets the space. Everything I do and read (my
 * actions, the round log, fairness, the chyakhe) sits in one sheet: a
 * collapsible bottom sheet on a phone, a side panel on a wide screen.
 *
 * The centre is <BoardStage>: the 3D board, or the 2D stage where WebGL is
 * missing. It only gets props. It spans the top two rows, edge to edge, and
 * the seats across from me and to either side are DOM panels laid over the
 * board's rim; mine and the result sit below it.
 */

/**
 * Where each seat's panel goes, by its side of the board (lib/board.ts
 * seatSides). On a phone the left and right panels sit at the board's near
 * corners, beside the result, where the round board leaves floor free: level
 * with its middle they would cover the widest part of the scatter. On a wide
 * screen there is room for them level with the middle.
 */
const SIDE_CLASS: Record<Side, string> = {
  bottom: "relative z-20 col-start-2 row-start-3 w-full max-w-44 justify-self-center lg:max-w-52",
  right: "relative z-20 col-start-3 row-span-2 row-start-1 self-end lg:self-center",
  top: "relative z-20 col-start-2 row-start-1 w-full max-w-44 justify-self-center lg:max-w-52",
  left: "relative z-20 col-start-1 row-span-2 row-start-1 self-end lg:self-center",
};

const asStageResult = (r: RoundRecord): StageResult => ({
  roundId: r.roundId,
  faces: r.faces,
  faceUp: r.faceUp,
  winningSeat: r.winningSeat,
  hit: r.hit,
  thrower: r.thrower,
  push: !r.hit && r.occupants[r.winningSeat] === undefined,
});

function stageResult(view: TableView): { result: StageResult | null; pending: boolean; round: { roundId: string; thrower: SeatId; phase: "betting" | "throwing" } | null } {
  const r = view.lastRound;
  const pending = view.phase === "betting" || view.phase === "throwing";
  return {
    result: r === null ? null : asStageResult(r),
    pending,
    // The round in play: the board simulates its throw ahead, from the start of betting.
    round:
      pending && view.roundId !== null && view.thrower !== null ? { roundId: view.roundId, thrower: view.thrower, phase: view.phase === "throwing" ? "throwing" : "betting" } : null,
  };
}

/**
 * My Throw opens once my hand is holding the shells: SEQ.holdAt after this
 * page saw the throwing phase begin, which is always later than the 1.5 s
 * the server holds every throw for (it saw the phase first).
 */
function useHandHolding(roundId: string | null, throwing: boolean): boolean {
  const [readyFor, setReadyFor] = useState<string | null>(null);
  useEffect(() => {
    if (!throwing || roundId === null) return;
    const timer = setTimeout(() => setReadyFor(roundId), SEQ.holdAt);
    return () => clearTimeout(timer);
  }, [roundId, throwing]);
  return throwing && roundId !== null && readyFor === roundId;
}

/** Header is h-14; the table fills the rest of the viewport, inside the safe area. */
const FILL_VIEWPORT = "h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))]";

export function TableScreen() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const s = useTable();
  const me = useSession((x) => x.me);
  const ceremonyNow = useCeremonyNow(s.ceremony);
  const handHolding = useHandHolding(s.view?.roundId ?? null, s.view?.phase === "throwing");
  const wasAtTable = useRef(false);
  const myId = s.welcome?.playerId ?? me?.id ?? null;

  // After a refresh there is no connection yet: go back to our table.
  useEffect(() => {
    if (useTable.getState().conn !== "idle") return;
    void resume().then((result) => {
      if (result.ok) return;
      if (result.error !== "no-session") {
        useSession.getState().setNotice(result.error === "not-at-a-table" ? null : errorNotice(result.error));
      }
      void navigate("/", { replace: true });
    });
  }, [navigate]);

  // Left the table (on purpose, or moved elsewhere): back to the lobby.
  useEffect(() => {
    if (s.tableId !== null) wasAtTable.current = true;
    else if (wasAtTable.current && s.conn === "idle") void navigate("/", { replace: true });
  }, [s.conn, s.tableId, navigate]);

  const view = s.view;
  const fmt = numberFormat(i18n.language);
  const command = (c: Parameters<typeof send>[0]) => {
    clearRefusal();
    send(c);
  };

  const banner = <ConnectionBanner conn={s.conn} attempt={s.attempt} pausedReason={s.pausedReason} onReconnect={() => void resume()} />;
  if (view === null) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
        {banner}
        <p className="text-ink-muted">{t("table.waitingForState")}</p>
      </main>
    );
  }

  const mySeat = mySeatIn(view, myId);
  const myPlayer = myPlayerIn(view, myId);
  // After a round, everything shown steps through the moment after (lib/ceremony.ts): until the
  // count is done, the round's own thrower and stake; until the tokens land, the chips before it.
  const ceremony = s.ceremony;
  const changed = s.changed;
  const resultShown = ceremony === null || reached(ceremony, "result");
  const myChips = myPlayer === null ? (me?.balance ?? 0) : shownChips(ceremony, myPlayer.playerId, myPlayer.chips, ceremonyNow);
  const myReservation = myReservationIn(view, myId);
  const myBet = myBetIn(view, myId);
  const minToSit = s.welcome?.minChipsToSit ?? 0;
  const sides = seatSides(mySeat);
  const thrower = view.phase === "waiting" ? null : ceremony !== null ? ceremony.round.thrower : view.thrower;
  const multiplier = Math.max(1, Math.round(view.stake / view.rules.thini));
  // The stake bar keeps the round's stake until the result is out (the next stake would give a hit away).
  const stakeShown = ceremony !== null && !resultShown ? { stake: ceremony.round.stake, multiplier: ceremony.round.multiplier, atCap: false } : { stake: view.stake, multiplier, atCap: view.streak > 0 && multiplier >= view.rules.maxStakeMultiplier };
  // The result's side: the thrower's on a hit, the winner's on a miss, once the result is out.
  const lastRound = view.lastRound;
  const result = view.phase === "revealing" && lastRound !== null && resultShown ? highlightOf(lastRound) : null;
  const glow: EdgeGlow | null =
    view.phase === "betting" || view.phase === "throwing"
      ? view.thrower === null
        ? null
        : { seat: view.thrower, kind: "thrower" }
      : result !== null && result.seat !== null
        ? { seat: result.seat, kind: result.kind === "hit" ? "hit" : "win" }
        : null;
  // The count lights the face-up shells; once counted, they stay lit until the next round's hand takes them.
  const lit = ceremony !== null ? ceremony.counted : lastRound === null ? null : lastRound.faceUp;
  const counting = ceremony === null ? null : { counted: ceremony.counted, resultShown };
  // The outside bets at the board's edge: the round's own until its chips land, then the next round's.
  const boardBets = ceremony !== null ? (reached(ceremony, "arrived") ? [] : ceremony.round.chyakhe) : view.bets;
  const floatOf = (playerId: string | undefined): number | null => (playerId === undefined || changed === null || changed.reduced ? null : (changed.deltas[playerId] ?? null));
  const flashOf = (playerId: string | undefined): boolean => playerId !== undefined && changed !== null && changed.reduced && (changed.deltas[playerId] ?? 0) !== 0;
  const myTurn = mySeat !== null && view.phase === "throwing" && view.thrower === mySeat;
  const myThrow = myTurn && handHolding;
  const latest = s.rounds[0] ?? null;
  const occupied = Object.fromEntries(TURN_ORDER.map((seat) => [seat, view.seats[seat] !== null])) as Record<SeatId, boolean>;
  const refusal =
    s.refusal === null ? null : i18n.exists(`refusals.${s.refusal.reason}`) ? t(`refusals.${s.refusal.reason}`) : t("refusals.unknown", { code: s.refusal.reason });

  const actions = (
    <>
      {mySeat !== null ? (
        <div className="flex flex-col gap-2">
          {myThrow && <p className="animate-rise font-semibold text-brass">{t("play.yourThrow")}</p>}
          {myTurn && !myThrow && (
            <p className="text-sm text-ink-muted" data-testid="picking-up">
              {t("play.pickingUp")}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!myThrow}
              onClick={() => {
                command({ type: "throw" });
                // The hand throws as soon as it holds the shells, while the request is in flight.
                if (view.roundId !== null) pressThrow(view.roundId);
              }}
              className={`${buttonPrimary} flex-1 py-3 text-lg ${myThrow ? "ring-2 ring-brass/70" : ""}`}
            >
              {t("play.throw")}
            </button>
            <button type="button" onClick={() => command({ type: "stand" })} className={buttonQuiet}>
              {t("play.stand")}
            </button>
          </div>
        </div>
      ) : (
        <BetControls
          phase={view.phase}
          thrower={view.thrower}
          occupied={occupied}
          thini={view.rules.thini}
          myChips={myChips}
          myBet={myBet}
          chyakheEnabled={view.rules.chyakheEnabled}
          onBet={(seat, chips) => command({ type: "placeBet", seat, chips })}
          onClear={() => command({ type: "clearBet" })}
        />
      )}
      {myReservation !== null && mySeat === null && (
        <p className="text-sm text-brass">
          <Term id={myReservation} />: {t("play.reservedForYou")}
        </p>
      )}
      {refusal !== null && (
        <p
          role="alert"
          className="animate-rise rounded-control border border-sindoor/60 bg-sindoor/15 px-3 py-1.5 text-sm text-sindoor-ink"
          data-testid="refusal"
          data-reason={s.refusal?.reason}
        >
          {refusal}
        </p>
      )}
      {s.welcome !== null && mySeat === null && myChips < minToSit && <TopUp minChipsToSit={minToSit} result={s.topUp} onClaim={claimTopUp} />}
    </>
  );

  return (
    <main className={`relative mx-auto flex ${FILL_VIEWPORT} w-full max-w-7xl flex-col lg:flex-row lg:gap-6 lg:px-6 lg:py-4`}>
      {/* The board. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pt-2 pb-2 lg:p-0">
        <div className="relative z-20 flex flex-col gap-2">
          {banner}
          <PhaseBar phase={view.phase} phaseEndsAt={view.phaseEndsAt} stake={stakeShown.stake} multiplier={stakeShown.multiplier} atCap={stakeShown.atCap} />
        </div>
        <section
          className="mx-auto grid min-h-0 w-full max-w-4xl flex-1 grid-cols-[5.5rem_minmax(0,1fr)_5.5rem] grid-rows-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-3 pt-2 sm:grid-cols-[7.5rem_minmax(0,1fr)_7.5rem] lg:grid-cols-[10rem_minmax(0,1fr)_10rem]"
          aria-label={t("table.seats")}
        >
          {TURN_ORDER.map((seat) => {
            const player = view.seats[seat];
            const reservedBy = view.reservations.find((r) => r.seat === seat)?.playerId;
            const humanHere = player !== null && !player.isBot;
            return (
              <div key={seat} className={`min-w-0 ${SIDE_CLASS[sides[seat]]}`} data-side={sides[seat]}>
                <SeatCard
                  seat={seat}
                  player={player}
                  {...(player === null ? {} : { chips: shownChips(ceremony, player.playerId, player.chips, ceremonyNow) })}
                  float={floatOf(player?.playerId)}
                  flash={flashOf(player?.playerId)}
                  highlight={result !== null && result.seat === seat ? (result.kind === "hit" ? "hit" : "win") : null}
                  streak={(view.phase === "betting" || view.phase === "throwing") && view.thrower === seat && view.streak > 0 ? { multiplier, atCap: stakeShown.atCap } : null}
                  isMe={player !== null && player.playerId === myId}
                  isThrower={thrower === seat}
                  reservation={reservedBy === undefined ? null : { name: s.names[reservedBy] ?? "?", mine: reservedBy === myId }}
                  betsTotal={view.bets.filter((b) => b.seat === seat).reduce((sum, b) => sum + b.chips, 0)}
                  canSit={mySeat === null && !humanHere && (reservedBy === undefined || reservedBy === myId)}
                  sitDisabled={myChips < minToSit}
                  onSit={() => command({ type: "sit", seat })}
                  onCancelReservation={() => command({ type: "stand" })}
                />
              </div>
            );
          })}
          {/* On a phone the board bleeds to the screen's edges, past the column's padding. */}
          <div className="relative col-span-3 col-start-1 row-span-2 row-start-1 -mx-3 min-h-0 lg:mx-0">
            <BetTokens bets={boardBets} sides={sides} names={s.names} myId={myId} />
            <BoardStage
              {...stageResult(view)}
              mySeat={mySeat}
              glow={glow}
              counting={counting}
              lit={lit}
              reveal={s.held?.view.lastRound ? asStageResult(s.held.view.lastRound) : null}
              pressed={s.pressed !== null && s.pressed === view.roundId}
              onRevealed={releaseThrow}
              onAnimator={setThrowAnimator}
            />
          </div>
        </section>
      </div>
      <ChipFlights ceremony={ceremony} />

      {/* Me, and what I can do. */}
      <Sheet
        summary={
          <>
            <span className="min-w-0 truncate text-sm text-ink-muted">
              {mySeat === null ? <Term id="chyakhe" /> : t("play.seatedAs", { seat: t(`terms.${mySeat}.label`) })}
            </span>
            <span className="font-semibold text-brass tabular-nums" data-testid="table-chips" data-chips={myChips}>
              <span className="sr-only">{t("play.myChips")}: </span>
              {fmt.format(myChips)} <span className="text-xs font-normal text-ink-muted">{t("header.chips")}</span>
            </span>
            <button type="button" onClick={() => void leaveTable().then(() => navigate("/"))} className={`${buttonQuiet} ml-auto px-2.5 py-1 text-sm`}>
              {t("table.leave")}
            </button>
          </>
        }
        actions={actions}
      >
        {s.shareUrl !== null && s.code !== null && <Share url={s.shareUrl} code={s.code} />}
        <RoundLog rounds={s.rounds} names={s.names} fairness={s.fairness} myId={myId} />
        <Fairness
          commitHash={view.phase === "betting" || view.phase === "throwing" ? view.commitHash : null}
          round={latest}
          result={latest === null ? undefined : s.fairness[latest.roundId]}
        />
        <Chyakhe
          players={view.chyakhe.map((p) => ({ ...p, chips: shownChips(ceremony, p.playerId, p.chips, ceremonyNow) }))}
          bets={view.bets}
          myId={myId}
          floats={changed === null || changed.reduced ? {} : changed.deltas}
        />
        <p className="text-xs text-ink-muted" data-testid="house-rules" data-ghanti={view.rules.ghantiChips}>
          <Term id="thini" />: <span className="tabular-nums">{fmt.format(view.rules.thini)}</span>
        </p>
      </Sheet>
    </main>
  );
}

/**
 * On a phone: a bottom sheet. The summary row and my actions always show;
 * the rest opens with the handle, and the open sheet slides up over the
 * board (never squashing it) until it is closed again: the handle, a tap on
 * the dimmed board, or Escape. On a wide screen: a side panel, all open.
 */
function Sheet({ summary, actions, children }: { readonly summary: ReactNode; readonly actions: ReactNode; readonly children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      {open && <div aria-hidden="true" onClick={() => setOpen(false)} className="animate-rise absolute inset-0 z-[25] bg-bg/55 lg:hidden" />}
      <aside
        className={`z-30 flex shrink-0 flex-col rounded-t-[1.25rem] border-t border-line-strong bg-panel-strong shadow-panel backdrop-blur-md lg:max-h-none lg:w-[22rem] lg:rounded-panel lg:border lg:border-line lg:bg-panel xl:w-[24rem] ${
          open ? "absolute inset-x-0 bottom-0 max-h-[82%] lg:relative" : "relative"
        }`}
        data-testid="sheet"
        data-open={open ? "true" : "false"}
      >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={detailsId}
        className="flex flex-col items-center gap-0.5 pt-1.5 pb-0.5 text-xs text-ink-muted transition-colors hover:text-ink lg:hidden"
        data-testid="sheet-toggle"
      >
        <span aria-hidden="true" className="h-1 w-10 rounded-full bg-line-strong" />
        <span>
          {t("table.details")} <span aria-hidden="true">{open ? "▾" : "▴"}</span>
        </span>
      </button>
      <div className="flex flex-col gap-3 px-3 pt-1 pb-3 lg:px-4 lg:pt-4">
        <div className="flex items-center gap-x-3">{summary}</div>
        {actions}
      </div>
      <div
        id={detailsId}
        className={`${open ? "flex" : "hidden"} animate-rise min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-line px-3 py-3 lg:flex lg:px-4`}
      >
        {children}
      </div>
      </aside>
    </>
  );
}

/** The outside bettors: who they are, their chips, and their bet this round. */
function Chyakhe({
  players,
  bets,
  myId,
  floats,
}: {
  readonly players: TableView["chyakhe"];
  readonly bets: TableView["bets"];
  readonly myId: string | null;
  /** The chips each bettor just won or lost (the server's deltas), floating by their name. */
  readonly floats: Readonly<Record<string, number>>;
}) {
  const { t, i18n } = useTranslation();
  const fmt = numberFormat(i18n.language);
  return (
    <section className="flex flex-col gap-1 text-sm">
      <h3 className={eyebrow}>
        <Term id="chyakhe" /> <span className="tabular-nums">({fmt.format(players.length)})</span>
      </h3>
      <ul className="flex flex-col gap-0.5" data-testid="chyakhe-list">
        {players.map((p) => {
          const bet = bets.find((b) => b.playerId === p.playerId);
          return (
            <li key={p.playerId} className="flex flex-wrap items-baseline gap-x-2 text-ink">
              <span className="truncate">{p.name}</span>
              {p.isBot && <span className="text-[0.7rem] text-ink-muted">{t("play.bot")}</span>}
              {p.playerId === myId && <span className="rounded-full border border-brass/50 px-1.5 text-[0.7rem] text-brass">{t("play.you")}</span>}
              <span className="relative text-xs text-ink-muted tabular-nums">
                {t("play.chips", { chips: fmt.format(p.chips) })}
                {(floats[p.playerId] ?? 0) !== 0 && (
                  <span className={`animate-float absolute -top-3 right-0 font-bold ${(floats[p.playerId] ?? 0) > 0 ? "text-ok" : "text-sindoor-ink"}`} data-testid="chip-float" data-delta={floats[p.playerId]}>
                    {signed(floats[p.playerId] ?? 0, (n) => fmt.format(n))}
                  </span>
                )}
              </span>
              {bet !== undefined && (
                <span className="text-xs text-brass tabular-nums">
                  {fmt.format(bet.chips)} → <Term id={bet.seat} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Share({ url, code }: { readonly url: string; readonly code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access: the link is on screen to copy by hand.
    }
  };
  return (
    <section className="flex flex-col gap-2 rounded-control border border-brass/35 bg-brass/5 p-3" data-testid="share">
      <h3 className="font-semibold text-ink">{t("table.shareTitle")}</h3>
      <p className="text-sm text-ink-muted">{t("table.shareHint")}</p>
      <p className="text-ink">
        {t("table.code")}:{" "}
        <span className="font-mono text-xl tracking-[0.25em] text-brass" data-testid="share-code">
          {code}
        </span>
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} aria-label={t("table.shareTitle")} data-testid="share-url" className={`${input} min-w-0 flex-1 py-1 text-sm`} />
        <button type="button" onClick={() => void copy()} className={`${buttonQuiet} text-sm`}>
          {copied ? t("table.copied") : t("table.copy")}
        </button>
      </div>
    </section>
  );
}
