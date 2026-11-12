import { useTranslation } from "react-i18next";
import type { Notice as NoticeValue } from "../lib/session";

/** A one-line message. Server error codes arrive as i18n keys; only text is ever rendered. */
export function Notice({ notice, tone = "info" }: { readonly notice: NoticeValue | null; readonly tone?: "info" | "error" }) {
  const { t } = useTranslation();
  if (notice === null) return null;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "animate-rise rounded-control border border-sindoor/60 bg-panel-strong px-3 py-2 text-sm text-sindoor-ink backdrop-blur-md"
          : "animate-rise rounded-control border border-brass/40 bg-panel-strong px-3 py-2 text-sm text-ink backdrop-blur-md"
      }
    >
      {t(notice.key, notice.params ?? {})}
    </p>
  );
}

/** An error code from the server as a notice: known codes have their own string. */
export function errorNotice(code: string): NoticeValue {
  const known = [
    "bad-name",
    "turnstile-failed",
    "too-many-guests",
    "malformed",
    "not-found",
    "too-many-guesses",
    "too-many-tables",
    "table-full",
    "still-leaving-previous-table",
    "table-paused",
    "no-session",
    "not-at-a-table",
    "network",
  ];
  return known.includes(code) ? { key: `errors.${code}` } : { key: "errors.unknown", params: { code } };
}
