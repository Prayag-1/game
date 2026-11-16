import { numberFormat } from "../../lib/format";
import { SEAT_NUMBER, type SeatId } from "@kauda/rules";
import { useTranslation } from "react-i18next";
import type { PlayerView } from "../../lib/protocol";
import { Term } from "../Term";

export interface SeatReservation {
  readonly name: string;
  readonly mine: boolean;
}

export interface SeatCardProps {
  readonly seat: SeatId;
  readonly player: PlayerView | null;
  readonly isMe: boolean;
  readonly isThrower: boolean;
  readonly reservation: SeatReservation | null;
  /** Chyakhe chips bet on this seat this round. */
  readonly betsTotal: number;
  /** Show Sit: a human may take this seat, and I am not seated. */
  readonly canSit: boolean;
  /** Sit is shown but I cannot afford it. */
  readonly sitDisabled: boolean;
  readonly onSit: () => void;
  readonly onCancelReservation: () => void;
}

/**
 * One inside seat, as a compact translucent panel at the board's edge: the
 * seat's name, who sits there, their chips. The thrower glows brass.
 */
export function SeatCard(props: SeatCardProps) {
  const { t, i18n } = useTranslation();
  const { seat, player, isMe, isThrower, reservation, betsTotal, canSit, sitDisabled } = props;
  const fmt = numberFormat(i18n.language);
  const edge = isThrower
    ? "border-brass/70 shadow-glow-brass"
    : reservation !== null
      ? "border-transparent outline-1 outline-dashed outline-brass/60 shadow-panel"
      : isMe
        ? "border-line-strong shadow-panel"
        : "border-line shadow-panel";
  return (
    <article
      data-testid={`seat-${seat}`}
      data-thrower={isThrower ? "true" : undefined}
      data-me={isMe ? "true" : undefined}
      aria-label={t(`terms.${seat}.label`)}
      className={`relative flex min-w-0 flex-col gap-0.5 rounded-panel border bg-panel px-2 pb-2 text-sm backdrop-blur-md transition-shadow duration-300 lg:px-3 ${isThrower ? "pt-3.5" : "pt-1.5 lg:pt-2"} ${edge}`}
    >
      {isThrower && (
        <span
          title={t("play.throwerMarkTip")}
          className="animate-rise absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-brass px-2 text-[0.7rem] leading-5 font-semibold text-bg"
          data-testid="thrower-mark"
        >
          {t("play.throwerMark")}
        </span>
      )}
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-base leading-tight text-ink lg:text-lg">
          <Term id={seat} />
        </span>
        <span className="text-xs text-ink-muted tabular-nums">
          <span aria-hidden="true">{fmt.format(SEAT_NUMBER[seat])}</span>
          <span className="sr-only">{t("play.seatNumber", { n: fmt.format(SEAT_NUMBER[seat]) })}</span>
        </span>
      </div>
      <div className="leading-tight [overflow-wrap:anywhere] text-ink" data-testid="occupant">
        {player === null ? <span className="text-ink-muted">{t("play.empty")}</span> : player.name}
      </div>
      {player !== null && (
        <div className="font-semibold text-brass tabular-nums" data-testid="seat-chips">
          {t("play.chips", { chips: fmt.format(player.chips) })}
        </div>
      )}
      {(player?.isBot === true || isMe || (player !== null && !player.isBot && !player.connected)) && (
        <div className="flex flex-wrap gap-1 text-[0.7rem] leading-4">
          {player?.isBot === true && <span className="text-ink-muted">{t("play.bot")}</span>}
          {isMe && <span className="rounded-full border border-brass/50 px-1.5 text-brass">{t("play.you")}</span>}
          {player !== null && !player.isBot && !player.connected && (
            <span className="rounded-full border border-dashed border-line-strong px-1.5 text-ink-muted">{t("play.away")}</span>
          )}
        </div>
      )}
      {betsTotal > 0 && <div className="text-xs text-ink-muted tabular-nums">{t("play.betsOnSeat", { chips: fmt.format(betsTotal) })}</div>}
      {reservation !== null && (
        <div className="text-xs text-brass" data-testid="reservation">
          {reservation.mine ? t("play.reservedForYou") : t("play.reservedFor", { name: reservation.name })}
        </div>
      )}
      {reservation?.mine === true ? (
        <button
          type="button"
          onClick={props.onCancelReservation}
          className="mt-1 rounded-control border border-line-strong px-2 py-1 text-xs text-ink-muted transition-colors hover:text-ink"
        >
          {t("play.cancelReservation")}
        </button>
      ) : (
        canSit && (
          <button
            type="button"
            onClick={props.onSit}
            disabled={sitDisabled}
            className="mt-1 rounded-control border border-brass/60 px-2 py-1 text-xs font-semibold text-brass transition-colors hover:border-brass-bright hover:text-brass-bright disabled:cursor-not-allowed disabled:border-line-strong disabled:text-ink-muted"
          >
            {t("play.sit")}
          </button>
        )
      )}
    </article>
  );
}
