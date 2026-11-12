import { useTranslation } from "react-i18next";
import type { Connection } from "../../lib/tableStore";

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
  const tone = conn === "connecting" || conn === "reconnecting" ? "bg-amber-200 text-amber-950" : "bg-red-100 text-red-900";
  return (
    <div role="status" data-testid="conn-banner" data-conn={conn} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${tone}`}>
      <span>
        {conn === "reconnecting"
          ? t("table.status.reconnecting", { attempt })
          : conn === "paused"
            ? t("notices.paused", { reason: pausedReason ?? "" })
            : t(`table.status.${conn}`)}
      </span>
      {conn === "replaced" && (
        <button type="button" onClick={onReconnect} className="ml-auto rounded-lg bg-red-900 px-3 py-1 text-white">
          {t("table.reconnect")}
        </button>
      )}
    </div>
  );
}
