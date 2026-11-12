import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Notice, errorNotice } from "../components/Notice";
import { Turnstile } from "../components/Turnstile";
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
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6">
      <div>
        <h2 className="text-2xl font-semibold">{t("signIn.title")}</h2>
        <p className="mt-1 text-stone-700">{t("signIn.intro")}</p>
      </div>
      <Notice notice={notice} />
      {pendingCode !== null && <Notice notice={{ key: "signIn.pendingCode", params: { code: pendingCode } }} />}
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm" noValidate>
        <div className="flex flex-col gap-1">
          <label htmlFor="guest-name" className="font-semibold">
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
            className="rounded-lg border border-stone-300 px-3 py-3 text-lg focus:border-orange-700 focus:outline-none"
          />
          <span id="name-hint" className="text-sm text-stone-600">
            {t("signIn.nameHint")}
          </span>
        </div>
        <Turnstile onToken={setToken} resetKey={resetKey} {...(siteKey === undefined ? {} : { siteKey })} />
        <Notice notice={error} tone="error" />
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-xl bg-orange-800 px-4 py-3 text-lg font-semibold text-white disabled:opacity-50"
        >
          {busy ? t("signIn.submitting") : t("signIn.submit")}
        </button>
        <p className="text-xs text-stone-600">{t("signIn.guestNote")}</p>
      </form>
    </main>
  );
}
