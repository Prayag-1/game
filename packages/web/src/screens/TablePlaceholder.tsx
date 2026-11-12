import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { errorNotice, Notice } from "../components/Notice";
import { Term, type TermId } from "../components/Term";
import { useSession } from "../lib/session";
import { leaveTable, resume, useTable } from "../lib/table";

/**
 * A stand-in for the real table screen: it joins the room and shows what
 * the server sends, as JSON text, to prove the connection end to end.
 */

const SEATS = ["teeya", "chauka", "panja", "chakka"] as const satisfies readonly TermId[];

export function TablePlaceholder() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const conn = useTable((s) => s.conn);
  const attempt = useTable((s) => s.attempt);
  const tableId = useTable((s) => s.tableId);
  const view = useTable((s) => s.view);
  const welcome = useTable((s) => s.welcome);
  const lastRound = useTable((s) => s.lastRound);
  const refusal = useTable((s) => s.refusal);
  const pausedReason = useTable((s) => s.pausedReason);
  const shareUrl = useTable((s) => s.shareUrl);
  const code = useTable((s) => s.code);
  const me = useSession((s) => s.me);
  const wasAtTable = useRef(false);

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
    if (tableId !== null) wasAtTable.current = true;
    else if (wasAtTable.current && conn === "idle") void navigate("/", { replace: true });
  }, [conn, tableId, navigate]);

  const status =
    conn === "reconnecting"
      ? t("table.status.reconnecting", { attempt })
      : conn === "paused"
        ? t("notices.paused", { reason: pausedReason ?? "" })
        : t(`table.status.${conn}`);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold">
          {t("table.title")} {tableId === null ? "" : tableId.slice(0, 6)}
        </h2>
        <span
          data-testid="conn"
          data-conn={conn}
          className={
            conn === "connected"
              ? "rounded-full bg-green-100 px-2 py-0.5 text-sm text-green-900"
              : "rounded-full bg-amber-100 px-2 py-0.5 text-sm text-amber-900"
          }
        >
          {status}
        </span>
        <button
          type="button"
          onClick={() => void leaveTable().then(() => navigate("/"))}
          className="ml-auto rounded-xl border-2 border-orange-800 px-3 py-1 font-semibold text-orange-900"
        >
          {t("table.leave")}
        </button>
      </div>

      {conn === "replaced" && (
        <div className="flex items-center gap-2 rounded-lg bg-red-100 px-3 py-2 text-red-900">
          <span>{t("table.status.replaced")}</span>
          <button type="button" onClick={() => void resume()} className="ml-auto rounded-lg bg-red-900 px-3 py-1 text-white">
            {t("table.reconnect")}
          </button>
        </div>
      )}
      {refusal !== null && <Notice notice={{ key: "errors.unknown", params: { code: refusal } }} tone="error" />}
      {shareUrl !== null && code !== null && <Share url={shareUrl} code={code} />}

      <SeatSummary view={view} myId={me?.id ?? null} />
      <LastRound round={lastRound} />

      <p className="text-sm text-stone-600">{t("table.placeholderNote")}</p>
      <section>
        <h3 className="font-semibold">{t("table.rawState")}</h3>
        {view === null ? (
          <p className="text-stone-600">{t("table.waitingForState")}</p>
        ) : (
          // Text only: JSON.stringify output as a React child, never as HTML.
          <pre data-testid="raw-state" className="mt-1 max-h-[60dvh] overflow-auto rounded-xl bg-stone-900 p-3 text-xs text-green-200">
            {JSON.stringify({ welcome, view }, null, 2)}
          </pre>
        )}
      </section>
    </main>
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
    <section className="flex flex-col gap-2 rounded-2xl bg-white p-4 shadow-sm" data-testid="share">
      <h3 className="font-semibold">{t("table.shareTitle")}</h3>
      <p className="text-sm text-stone-600">{t("table.shareHint")}</p>
      <p>
        {t("table.code")}: <span className="font-mono text-xl tracking-widest">{code}</span>
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} aria-label={t("table.shareTitle")} className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1 text-sm" />
        <button type="button" onClick={() => void copy()} className="rounded-lg bg-orange-800 px-3 py-1 text-sm font-semibold text-white">
          {copied ? t("table.copied") : t("table.copy")}
        </button>
      </div>
    </section>
  );
}

interface SeatLike {
  readonly playerId: string;
  readonly name: string;
  readonly isBot: boolean;
}

function seatOf(view: unknown, seat: string): SeatLike | null {
  if (typeof view !== "object" || view === null) return null;
  const seats = (view as { seats?: unknown }).seats;
  if (typeof seats !== "object" || seats === null) return null;
  const p = (seats as Record<string, unknown>)[seat];
  if (typeof p !== "object" || p === null) return null;
  const { playerId, name, isBot } = p as Record<string, unknown>;
  return typeof playerId === "string" && typeof name === "string" ? { playerId, name, isBot: isBot === true } : null;
}

function SeatSummary({ view, myId }: { readonly view: unknown; readonly myId: string | null }) {
  const { t } = useTranslation();
  if (view === null) return null;
  const chyakhe = (view as { chyakhe?: unknown }).chyakhe;
  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm">
      <h3 className="font-semibold">
        <Term id="hate" />
      </h3>
      <ul className="mt-2 grid grid-cols-2 gap-2">
        {SEATS.map((seat) => {
          const p = seatOf(view, seat);
          return (
            <li key={seat} className="rounded-lg bg-amber-50 px-2 py-1">
              <Term id={seat} />
              <span className="block truncate text-sm">
                {p === null ? t("table.emptySeat") : p.name}
                {p?.isBot === true && ` (${t("table.bot")})`}
                {p !== null && p.playerId === myId && ` (${t("table.you")})`}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-sm">
        <Term id="chyakhe" />: {t("table.chyakheCount", { count: Array.isArray(chyakhe) ? chyakhe.length : 0 })}
      </p>
    </section>
  );
}

function LastRound({ round }: { readonly round: unknown }) {
  const { t } = useTranslation();
  if (typeof round !== "object" || round === null) return null;
  const { hit, winningSeat, faceUp } = round as Record<string, unknown>;
  if (typeof hit !== "boolean" || typeof faceUp !== "number" || !SEATS.includes(winningSeat as never)) return null;
  return (
    <p className="rounded-2xl bg-white p-3 text-sm shadow-sm" data-testid="last-round">
      {t("table.lastRound")}: <Term id={hit ? "maryo" : "tiryo"} /> · <Term id={winningSeat as TermId} /> ·{" "}
      {t("table.faceUp", { count: faceUp })}
    </p>
  );
}
