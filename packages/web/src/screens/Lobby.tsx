import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Notice, errorNotice } from "../components/Notice";
import { Shell } from "../components/Shell";
import { Term } from "../components/Term";
import { buttonBrass, buttonPrimary, input, panel } from "../components/ui";
import { api, normaliseCode, type Preset, type Result, type SeatGrant, type TableInfo } from "../lib/api";
import { numberFormat } from "../lib/format";
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
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-5 lg:px-6 lg:py-8">
      <h2 className="sr-only">{t("lobby.title")}</h2>
      <Notice notice={notice} />
      <Notice notice={error} tone="error" />

      {/* The one loud choice. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => void go(() => api.quickPlay())}
        className={`${buttonPrimary} group flex items-center gap-4 px-5 py-4 text-left`}
      >
        <svg viewBox="22 22 58 46" className="h-12 w-14 shrink-0 transition-transform duration-300 group-hover:-rotate-3" aria-hidden="true">
          <Shell up={false} x={38} y={38} angle={-20} />
          <Shell up x={55} y={34} angle={15} />
          <Shell up={false} x={50} y={52} angle={40} />
          <Shell up x={66} y={50} angle={-35} />
        </svg>
        <span className="flex flex-col">
          <span className="text-2xl font-semibold">{busy ? t("lobby.busy") : t("lobby.quickPlay")}</span>
          <span className="text-sm font-normal text-ink">{t("lobby.quickPlayHint")}</span>
        </span>
      </button>

      <section className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold text-ink">{t("lobby.publicTables")}</h3>
        {tables !== null && tables.length === 0 && <p className={`${panel} px-4 py-3 text-ink-muted`}>{t("lobby.noTables")}</p>}
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("lobby.publicTables")}>
          {(tables ?? []).map((table) => (
            <TableTile key={table.id} table={table} busy={busy} onJoin={() => void go(() => api.joinPublic(table.id))} />
          ))}
        </ul>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <section className={`${panel} flex flex-col gap-3 p-4`}>
          <div>
            <h3 className="font-semibold text-ink">{t("lobby.createPrivate")}</h3>
            <p className="text-sm text-ink-muted">{t("lobby.createPrivateHint")}</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t("lobby.presetLabel")}</legend>
            {(["default", "simple"] as const).map((p) => (
              <label
                key={p}
                className={`flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2 transition-colors ${
                  preset === p ? "border-brass/60 bg-brass/10" : "border-line hover:border-line-strong"
                }`}
              >
                <input
                  type="radio"
                  name="preset"
                  value={p}
                  checked={preset === p}
                  onChange={() => setPreset(p)}
                  className="mt-1.5 accent-brass"
                />
                <span>
                  <span className="font-semibold text-ink">{t(p === "default" ? "lobby.presetDefault" : "lobby.presetSimple")}</span>
                  <span className="block text-sm text-ink-muted">{t(p === "default" ? "lobby.presetDefaultHint" : "lobby.presetSimpleHint")}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <button type="button" disabled={busy} onClick={() => void go(() => api.createPrivate(preset))} className={buttonBrass}>
            {t("lobby.create")}
          </button>
        </section>

        <form onSubmit={submitCode} className={`${panel} flex flex-col gap-3 p-4`}>
          <div>
            <label htmlFor="table-code" className="font-semibold text-ink">
              {t("lobby.joinByCode")}
            </label>
            <p className="text-sm text-ink-muted">{t("lobby.codeHint")}</p>
          </div>
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
              className={`${input} min-w-0 flex-1 font-mono text-lg tracking-[0.25em] uppercase placeholder:font-sans placeholder:tracking-normal placeholder:normal-case`}
            />
            <button type="submit" disabled={busy || code.length !== 6} className={buttonBrass}>
              {t("lobby.join")}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

/** One public table, drawn as a small board with its twelve places around it. */
function TableTile({ table, busy, onJoin }: { readonly table: TableInfo; readonly busy: boolean; readonly onJoin: () => void }) {
  const { t, i18n } = useTranslation();
  const fmt = numberFormat(i18n.language);
  const full = table.room <= 0;
  return (
    <li className={`${panel} flex items-center gap-4 p-3 transition-colors hover:border-line-strong`} data-testid="table-row">
      <MiniBoard humans={table.humans} bots={table.bots} label={t("lobby.places", { humans: fmt.format(table.humans), bots: fmt.format(table.bots), free: fmt.format(Math.max(0, table.room)) })} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-col">
          <span className="truncate font-semibold text-ink">{t("lobby.table", { id: table.id.slice(0, 6) })}</span>
          <span className="text-xs text-ink-muted">
            {t(`preset.${table.preset}`)} · {t(`phase.${table.phase}`)}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 text-sm text-ink">
          <span>
            <Term id="hate" />: <span className="tabular-nums">{fmt.format(table.humans)}</span> {t("lobby.humans")} + <span className="tabular-nums">{fmt.format(table.bots)}</span> {t("lobby.bots")}
          </span>
          <span>
            <Term id="chyakhe" />: <span className="tabular-nums">{fmt.format(table.chyakhe)}</span>
          </span>
          <span title={t("lobby.stakeTip")} className="text-ink-muted">
            {t("lobby.stake")} <span className="font-semibold text-brass tabular-nums">{fmt.format(table.stake)}</span>
          </span>
        </div>
      </div>
      <button type="button" disabled={busy || full} onClick={onJoin} className={`${buttonBrass} shrink-0 self-center`}>
        {full ? t("lobby.full") : t("lobby.join")}
      </button>
    </li>
  );
}

/** Twelve places round a little board: brass for people, dim for bots, open rings for empty places. */
function MiniBoard({ humans, bots, label }: { readonly humans: number; readonly bots: number; readonly label: string }) {
  const places = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * 2 * Math.PI - Math.PI / 2;
    return { x: 30 + 24 * Math.cos(a), y: 30 + 24 * Math.sin(a), kind: i < humans ? "human" : i < humans + bots ? "bot" : "empty" };
  });
  return (
    <svg viewBox="0 0 60 60" className="h-16 w-16 shrink-0" role="img" aria-label={label}>
      <rect x={14} y={14} width={32} height={32} rx={5} className="fill-wood stroke-line-strong" strokeWidth={0.8} />
      <circle cx={30} cy={30} r={13} className="fill-glow/15" />
      <Shell up x={27} y={29} angle={-25} scale={0.55} />
      <Shell up={false} x={34} y={32} angle={30} scale={0.55} />
      {places.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={3}
          className={p.kind === "human" ? "fill-brass" : p.kind === "bot" ? "fill-ink-muted/45" : "fill-transparent stroke-line-strong"}
          strokeWidth={0.8}
        />
      ))}
    </svg>
  );
}
