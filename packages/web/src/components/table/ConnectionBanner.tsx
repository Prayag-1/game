import { useTranslation } from "react-i18next";
import type { Connection } from "../../lib/tableStore";
import { buttonPrimary } from "../ui";

export interface ConnectionBannerProps {
  readonly conn: Connection;
  readonly attempt: number;
  readonly pausedReason: string | null;
  readonly onReconnect: () => void;
}

/** Shown only when something is wrong with the connection. */
export function ConnectionBanner({ conn, attempt, pausedReason, onReconnect }: ConnectionBannerProps) {
  const { t } = useTranslation();
  if (conn === "connected" || conn === "idle") return null;
  const tone = conn === "connecting" || conn === "reconnecting" ? "border-brass/50 text-brass" : "border-sindoor/70 text-sindoor-ink";
  return (
    <div
      role="status"
      data-testid="conn-banner"
      data-conn={conn}
      className={`animate-rise flex items-center gap-2 rounded-panel border bg-panel-strong px-3 py-2 text-sm shadow-panel backdrop-blur-md ${tone}`}
    >
      <span>
        {conn === "reconnecting"
          ? t("table.status.reconnecting", { attempt })
          : conn === "paused"
            ? t("notices.paused", { reason: pausedReason ?? "" })
            : t(`table.status.${conn}`)}
      </span>
      {conn === "replaced" && (
        <button type="button" onClick={onReconnect} className={`${buttonPrimary} ml-auto px-3 py-1 text-sm`}>
          {t("table.reconnect")}
        </button>
      )}
    </div>
  );
}
