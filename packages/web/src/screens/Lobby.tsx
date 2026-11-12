import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Notice, errorNotice } from "../components/Notice";
import { Term } from "../components/Term";
import { api, normaliseCode, type Preset, type Result, type SeatGrant, type TableInfo } from "../lib/api";
import { useSession, type Notice as NoticeValue } from "../lib/session";
import { takeSeat } from "../lib/table";

const POLL_MS = 3000;

/** The public tables, polled while the lobby is open. */
function usePublicTables(): TableInfo[] | null {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const res = await api.tables();
      if (live && res.ok) setTables(res.value);
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return tables;
}

export function Lobby() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tables = usePublicTables();
  const notice = useSession((s) => s.notice);
  const [error, setError] = useState<NoticeValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<Preset>("default");
  const [code, setCode] = useState("");

  const go = useCallback(
    async (request: () => Promise<Result<SeatGrant>>) => {
      setBusy(true);
      setError(null);
      useSession.getState().setNotice(null);
      const result = await takeSeat(request);
      setBusy(false);
      if (result.ok) void navigate(`/table/${encodeURIComponent(result.value)}`);
      else setError(errorNotice(result.error));
    },
    [navigate],
  );

  // Back in the lobby: the balance may have moved at a table.
  useEffect(() => {
    void useSession.getState().load();
  }, []);

  // A shared /?code= link: straight to that table, once.
  useEffect(() => {
    const pending = useSession.getState().takePendingCode();
    if (pending !== null) void go(() => api.joinByCode(pending));
  }, [go]);

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    const c = normaliseCode(code);
    if (c.length === 6) void go(() => api.joinByCode(c));
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
      <h2 className="sr-only">{t("lobby.title")}</h2>
      <Notice notice={notice} />
      <Notice notice={error} tone="error" />

      <section className="flex flex-col gap-3 md:flex-row">
        <button
          type="button"
          disabled={busy}
          onClick={() => void go(() => api.quickPlay())}
          className="flex flex-1 flex-col items-start rounded-2xl bg-orange-800 px-4 py-4 text-left text-white shadow disabled:opacity-60"
        >
          <span className="text-xl font-semibold">{busy ? t("lobby.busy") : t("lobby.quickPlay")}</span>
          <span className="text-sm text-orange-100">{t("lobby.quickPlayHint")}</span>
        </button>

        <div className="flex flex-1 flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm">
          <div>
            <h3 className="font-semibold">{t("lobby.createPrivate")}</h3>
            <p className="text-sm text-stone-600">{t("lobby.createPrivateHint")}</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t("lobby.presetLabel")}</legend>
            {(["default", "simple"] as const).map((p) => (
              <label key={p} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="preset"
                  value={p}
                  checked={preset === p}
                  onChange={() => setPreset(p)}
                  className="mt-1.5 accent-orange-800"
                />
                <span>
                  <span className="font-semibold">{t(p === "default" ? "lobby.presetDefault" : "lobby.presetSimple")}</span>
                  <span className="block text-sm text-stone-600">
                    {t(p === "default" ? "lobby.presetDefaultHint" : "lobby.presetSimpleHint")}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={busy}
            onClick={() => void go(() => api.createPrivate(preset))}
            className="rounded-xl border-2 border-orange-800 px-4 py-2 font-semibold text-orange-900 disabled:opacity-60"
          >
            {t("lobby.create")}
          </button>
        </div>
      </section>

      <form onSubmit={submitCode} className="flex flex-col gap-2 rounded-2xl bg-white p-4 shadow-sm">
        <label htmlFor="table-code" className="font-semibold">
          {t("lobby.joinByCode")}
        </label>
        <div className="flex gap-2">
          <input
            id="table-code"
            value={code}
            onChange={(e) => setCode(normaliseCode(e.target.value))}
            placeholder={t("lobby.codePlaceholder")}
            aria-label={t("lobby.codeLabel")}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 font-mono text-lg tracking-widest uppercase"
          />
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="rounded-xl bg-stone-800 px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            {t("lobby.join")}
          </button>
        </div>
      </form>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">{t("lobby.publicTables")}</h3>
        {tables !== null && tables.length === 0 && <p className="text-stone-600">{t("lobby.noTables")}</p>}
        <ul className="flex flex-col gap-2" aria-label={t("lobby.publicTables")}>
          {(tables ?? []).map((table) => (
            <TableRow key={table.id} table={table} busy={busy} onJoin={() => void go(() => api.joinPublic(table.id))} />
          ))}
        </ul>
      </section>
    </main>
  );
}

function TableRow({ table, busy, onJoin }: { readonly table: TableInfo; readonly busy: boolean; readonly onJoin: () => void }) {
  const { t } = useTranslation();
  const full = table.room <= 0;
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-sm" data-testid="table-row">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate font-semibold">{t("lobby.table", { id: table.id.slice(0, 6) })}</span>
          <span className="text-xs text-stone-600">
            {t(`preset.${table.preset}`)} · {t(`phase.${table.phase}`)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-stone-700">
          <span>
            <Term id="hate" />: {table.humans} {t("lobby.humans")} + {table.bots} {t("lobby.bots")}
          </span>
          <span>
            <Term id="chyakhe" />: {table.chyakhe}
          </span>
          <span title={t("lobby.stakeTip")}>
            {t("lobby.stake")}: {table.stake}
          </span>
        </div>
      </div>
      <button
        type="button"
        disabled={busy || full}
        onClick={onJoin}
        className="rounded-xl bg-orange-800 px-4 py-2 font-semibold text-white disabled:bg-stone-400"
      >
        {full ? t("lobby.full") : t("lobby.join")}
      </button>
    </li>
  );
}
