import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Notice, errorNotice } from "../components/Notice";
import { ShellRow } from "../components/Shell";
import { Turnstile } from "../components/Turnstile";
import { buttonPrimary, input, panel } from "../components/ui";
import { useSession, type Notice as NoticeValue } from "../lib/session";

/** A guest: a name and a Turnstile token, posted to /session/guest. */
export function SignIn({ siteKey }: { readonly siteKey?: string }) {
  const { t } = useTranslation();
  const signIn = useSession((s) => s.signIn);
  const notice = useSession((s) => s.notice);
  const pendingCode = useSession((s) => s.pendingCode);
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NoticeValue | null>(null);

  const trimmed = [...name.trim()].length;
  const canSubmit = !busy && token !== null && trimmed >= 3 && trimmed <= 20;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || token === null) return;
    setBusy(true);
    setError(null);
    const failure = await signIn(name, token);
    if (failure !== null) {
      setError(errorNotice(failure));
      // A Turnstile token is good for one request: get a fresh one.
      setResetKey((k) => k + 1);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-md flex-col justify-center gap-5 px-4 py-8">
      <div className="diyo-glow -mx-8 flex flex-col items-center gap-2 px-8 py-6 text-center">
        <ShellRow className="h-7" />
        <p className="text-sm tracking-wide text-ink-muted">{t("app.tagline")}</p>
        <h2 className="text-3xl font-semibold text-ink">{t("signIn.title")}</h2>
        <p className="text-ink-muted">{t("signIn.intro")}</p>
      </div>
      <Notice notice={notice} />
      {pendingCode !== null && <Notice notice={{ key: "signIn.pendingCode", params: { code: pendingCode } }} />}
      <form onSubmit={(e) => void submit(e)} className={`${panel} flex flex-col gap-4 p-5`} noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="guest-name" className="font-semibold text-ink">
            {t("signIn.nameLabel")}
          </label>
          <input
            id="guest-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            autoComplete="nickname"
            autoCapitalize="words"
            enterKeyHint="go"
            aria-describedby="name-hint"
            className={`${input} py-3 text-lg`}
          />
          <span id="name-hint" className="text-sm text-ink-muted">
            {t("signIn.nameHint")}
          </span>
        </div>
        <Turnstile onToken={setToken} resetKey={resetKey} {...(siteKey === undefined ? {} : { siteKey })} />
        <Notice notice={error} tone="error" />
        <button type="submit" disabled={!canSubmit} className={`${buttonPrimary} py-3 text-lg`}>
          {busy ? t("signIn.submitting") : t("signIn.submit")}
        </button>
        <p className="text-xs text-ink-muted">{t("signIn.guestNote")}</p>
      </form>
    </main>
  );
}
