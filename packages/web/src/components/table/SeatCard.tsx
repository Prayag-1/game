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

/** One inside seat: name and number, occupant, chips, and whose throw it is. */
export function SeatCard(props: SeatCardProps) {
  const { t, i18n } = useTranslation();
  const { seat, player, isMe, isThrower, reservation, betsTotal, canSit, sitDisabled } = props;
  const fmt = numberFormat(i18n.language);
  const ring = isThrower
    ? "ring-4 ring-amber-400"
    : reservation !== null
      ? "outline-2 outline-dashed outline-sky-600"
      : "";
  return (
    <article
      data-testid={`seat-${seat}`}
      data-thrower={isThrower ? "true" : undefined}
      data-me={isMe ? "true" : undefined}
      aria-label={t(`terms.${seat}.label`)}
      className={`relative flex min-w-0 flex-col gap-0.5 rounded-xl p-2 text-sm shadow-sm ${isMe ? "bg-amber-100" : "bg-white"} ${ring}`}
    >
      {isThrower && (
        <span
          title={t("play.throwerMarkTip")}
          className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-amber-400 px-2 text-xs font-semibold text-stone-900"
          data-testid="thrower-mark"
        >
          {t("play.throwerMark")}
        </span>
      )}
      <div className="flex items-baseline justify-between gap-1">
        <Term id={seat} />
        <span className="text-xs text-stone-500">{t("play.seatNumber", { n: fmt.format(SEAT_NUMBER[seat]) })}</span>
      </div>
      <div className="truncate font-semibold" data-testid="occupant">
        {player === null ? <span className="font-normal text-stone-500">{t("play.empty")}</span> : player.name}
      </div>
      <div className="flex flex-wrap gap-1 text-xs">
        {player?.isBot === true && <span className="rounded bg-stone-200 px-1">{t("play.bot")}</span>}
        {isMe && <span className="rounded bg-amber-300 px-1">{t("play.you")}</span>}
        {player !== null && !player.isBot && !player.connected && <span className="rounded bg-red-100 px-1 text-red-900">{t("play.away")}</span>}
      </div>
      {player !== null && (
        <div className="text-xs tabular-nums" data-testid="seat-chips">
          {t("play.chips", { chips: fmt.format(player.chips) })}
        </div>
      )}
      {betsTotal > 0 && <div className="text-xs text-emerald-800">{t("play.betsOnSeat", { chips: fmt.format(betsTotal) })}</div>}
      {reservation !== null && (
        <div className="rounded bg-sky-100 px-1 text-xs text-sky-900" data-testid="reservation">
          {reservation.mine ? t("play.reservedForYou") : t("play.reservedFor", { name: reservation.name })}
        </div>
      )}
      {reservation?.mine === true ? (
        <button type="button" onClick={props.onCancelReservation} className="mt-1 rounded-lg border border-sky-700 px-2 py-1 text-xs text-sky-900">
          {t("play.cancelReservation")}
        </button>
      ) : (
        canSit && (
          <button
            type="button"
            onClick={props.onSit}
            disabled={sitDisabled}
            className="mt-1 rounded-lg bg-orange-800 px-2 py-1 text-xs font-semibold text-white disabled:opacity-40"
          >
            {t("play.sit")}
          </button>
        )
      )}
    </article>
  );
}
