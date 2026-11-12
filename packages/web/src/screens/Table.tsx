import { numberFormat } from "../lib/format";
import { TURN_ORDER, type SeatId } from "@kauda/rules";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { errorNotice } from "../components/Notice";
import { BetControls } from "../components/table/BetControls";
import { ConnectionBanner } from "../components/table/ConnectionBanner";
import { Fairness } from "../components/table/Fairness";
import { PhaseBar } from "../components/table/PhaseBar";
import { RoundLog } from "../components/table/RoundLog";
import { SeatCard } from "../components/table/SeatCard";
import { Stage, type StageResult } from "../components/table/Stage";
import { TopUp } from "../components/table/TopUp";
import { Term } from "../components/Term";
import type { TableView } from "../lib/protocol";
import { useSession } from "../lib/session";
import { claimTopUp, leaveTable, resume, send } from "../lib/table";
import { clearRefusal, myBetIn, myPlayerIn, myReservationIn, mySeatIn, useTable } from "../lib/tableStore";

/**
 * The table, in two layers. The game-state layer (seats, chips, bets,
 * controls, log) reads the store and stays. The centre is <Stage>, which only
 * gets props, so the 3D scene can replace it without touching the rest.
 */

/** Screen slots, going anticlockwise from the bottom: bottom, right, top, left. */
type Slot = "bottom" | "right" | "top" | "left";
const SLOTS: readonly Slot[] = ["bottom", "right", "top", "left"];
const SLOT_CLASS: Record<Slot, string> = {
  bottom: "col-start-2 row-start-3",
  right: "col-start-3 row-start-2 self-center",
  top: "col-start-2 row-start-1",
  left: "col-start-1 row-start-2 self-center",
};

/** The seats in their real anticlockwise order, turned so that `anchor` sits at the bottom. */
export function seatSlots(anchor: SeatId): Record<SeatId, Slot> {
  const start = TURN_ORDER.indexOf(anchor);
  const out = {} as Record<SeatId, Slot>;
  TURN_ORDER.forEach((seat, i) => {
    out[seat] = SLOTS[(i - start + TURN_ORDER.length) % TURN_ORDER.length] as Slot;
  });
  return out;
}

function stageResult(view: TableView): { result: StageResult | null; pending: boolean } {
  const r = view.lastRound;
  return {
    result: r === null ? null : { faces: r.faces, faceUp: r.faceUp, winningSeat: r.winningSeat, hit: r.hit },
    pending: view.phase === "betting" || view.phase === "throwing",
  };
}

export function TableScreen() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const s = useTable();
  const me = useSession((x) => x.me);
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
      <main className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
        {banner}
        <p className="text-stone-600">{t("table.waitingForState")}</p>
      </main>
    );
  }

  const mySeat = mySeatIn(view, myId);
  const myPlayer = myPlayerIn(view, myId);
  const myChips = myPlayer?.chips ?? me?.balance ?? 0;
  const myReservation = myReservationIn(view, myId);
  const myBet = myBetIn(view, myId);
  const minToSit = s.welcome?.minChipsToSit ?? 0;
  const slots = seatSlots(mySeat ?? "teeya");
  const multiplier = Math.max(1, Math.round(view.stake / view.rules.thini));
  const myThrow = mySeat !== null && view.phase === "throwing" && view.thrower === mySeat;
  const latest = s.rounds[0] ?? null;
  const occupied = Object.fromEntries(TURN_ORDER.map((seat) => [seat, view.seats[seat] !== null])) as Record<SeatId, boolean>;
  const refusal =
    s.refusal === null ? null : i18n.exists(`refusals.${s.refusal.reason}`) ? t(`refusals.${s.refusal.reason}`) : t("refusals.unknown", { code: s.refusal.reason });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-3">
      {banner}
      <PhaseBar phase={view.phase} phaseEndsAt={view.phaseEndsAt} stake={view.stake} multiplier={multiplier} />

      {/* Seats around the stage, anticlockwise in turn order. */}
      <section className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)] grid-rows-[auto_auto_auto] gap-2" aria-label={t("table.seats")}>
        {TURN_ORDER.map((seat) => {
          const player = view.seats[seat];
          const reservedBy = view.reservations.find((r) => r.seat === seat)?.playerId;
          const humanHere = player !== null && !player.isBot;
          return (
            <div key={seat} className={SLOT_CLASS[slots[seat]]}>
              <SeatCard
                seat={seat}
                player={player}
                isMe={player !== null && player.playerId === myId}
                isThrower={view.thrower === seat && view.phase !== "waiting"}
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
        <div className="col-start-2 row-start-2 aspect-square">
          <Stage {...stageResult(view)} />
        </div>
      </section>

      {/* Me, and what I can do. */}
      <section className="flex flex-col gap-3 rounded-2xl bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm">
            {mySeat === null ? (
              <>
                <Term id="chyakhe" />
              </>
            ) : (
              t("play.seatedAs", { seat: t(`terms.${mySeat}.label`) })
            )}
          </span>
          <span className="font-semibold tabular-nums" data-testid="table-chips" data-chips={myChips}>
            {t("play.myChips")}: {fmt.format(myChips)}
          </span>
          <button type="button" onClick={() => void leaveTable().then(() => navigate("/"))} className="ml-auto rounded-lg border-2 border-orange-800 px-3 py-1 text-sm font-semibold text-orange-900">
            {t("table.leave")}
          </button>
        </div>

        {mySeat !== null ? (
          <div className="flex flex-col gap-2">
            {myThrow && <p className="font-semibold text-orange-900">{t("play.yourThrow")}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!myThrow}
                onClick={() => command({ type: "throw" })}
                className="flex-1 rounded-xl bg-orange-800 px-4 py-3 text-lg font-semibold text-white disabled:bg-stone-300 disabled:text-stone-600"
              >
                {t("play.throw")}
              </button>
              <button type="button" onClick={() => command({ type: "stand" })} className="rounded-xl border-2 border-stone-500 px-4 py-2 font-semibold">
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
          <p className="text-sm text-sky-900">
            <Term id={myReservation} />: {t("play.reservedForYou")}
          </p>
        )}
        {refusal !== null && (
          <p role="alert" className="rounded-lg bg-red-100 px-3 py-1.5 text-sm text-red-900" data-testid="refusal" data-reason={s.refusal?.reason}>
            {refusal}
          </p>
        )}
      </section>

      {s.welcome !== null && mySeat === null && myChips < minToSit && <TopUp minChipsToSit={minToSit} result={s.topUp} onClaim={claimTopUp} />}

      {s.shareUrl !== null && s.code !== null && <Share url={s.shareUrl} code={s.code} />}

      <RoundLog rounds={s.rounds} names={s.names} fairness={s.fairness} myId={myId} />
      <Fairness
        commitHash={view.phase === "betting" || view.phase === "throwing" ? view.commitHash : null}
        round={latest}
        result={latest === null ? undefined : s.fairness[latest.roundId]}
      />
      <Chyakhe players={view.chyakhe} bets={view.bets} myId={myId} />
      <p className="text-xs text-stone-500" data-testid="house-rules" data-ghanti={view.rules.ghantiChips}>
        <Term id="thini" />: {fmt.format(view.rules.thini)}
      </p>
    </main>
  );
}

/** The outside bettors: who they are, their chips, and their bet this round. */
function Chyakhe({ players, bets, myId }: { readonly players: TableView["chyakhe"]; readonly bets: TableView["bets"]; readonly myId: string | null }) {
  const { t, i18n } = useTranslation();
  const fmt = numberFormat(i18n.language);
  return (
    <section className="rounded-2xl bg-white p-3 text-sm shadow-sm">
      <h3 className="font-semibold">
        <Term id="chyakhe" /> ({fmt.format(players.length)})
      </h3>
      <ul className="mt-1 flex flex-col gap-0.5" data-testid="chyakhe-list">
        {players.map((p) => {
          const bet = bets.find((b) => b.playerId === p.playerId);
          return (
            <li key={p.playerId} className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate font-semibold">{p.name}</span>
              {p.isBot && <span className="rounded bg-stone-200 px-1 text-xs">{t("play.bot")}</span>}
              {p.playerId === myId && <span className="rounded bg-amber-300 px-1 text-xs">{t("play.you")}</span>}
              <span className="text-xs tabular-nums">{t("play.chips", { chips: fmt.format(p.chips) })}</span>
              {bet !== undefined && (
                <span className="text-xs text-emerald-800">
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
    <section className="flex flex-col gap-2 rounded-2xl bg-white p-3 shadow-sm" data-testid="share">
      <h3 className="font-semibold">{t("table.shareTitle")}</h3>
      <p className="text-sm text-stone-600">{t("table.shareHint")}</p>
      <p>
        {t("table.code")}: <span className="font-mono text-xl tracking-widest" data-testid="share-code">{code}</span>
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} aria-label={t("table.shareTitle")} data-testid="share-url" className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1 text-sm" />
        <button type="button" onClick={() => void copy()} className="rounded-lg bg-orange-800 px-3 py-1 text-sm font-semibold text-white">
          {copied ? t("table.copied") : t("table.copy")}
        </button>
      </div>
    </section>
  );
}
