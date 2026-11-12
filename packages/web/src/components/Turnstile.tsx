import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Cloudflare Turnstile, rendered explicitly. The widget hands us a one-use
 * token; the game server checks it with Cloudflare using the secret key,
 * which never enters this package. Only the public site key is here, fixed
 * at build time from VITE_TURNSTILE_SITE_KEY.
 */

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
  language?: string;
  theme?: "light" | "dark" | "auto";
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare's script once. The production CSP allows exactly this origin. */
function loadTurnstile(timeoutMs = 15_000): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    const timer = setTimeout(() => fail(), timeoutMs);
    const fail = () => {
      clearTimeout(timer);
      loading = null;
      script.remove();
      reject(new Error("turnstile did not load"));
    };
    script.addEventListener("load", () => {
      clearTimeout(timer);
      if (window.turnstile === undefined) fail();
      else resolve(window.turnstile);
    });
    script.addEventListener("error", fail);
    document.head.append(script);
  });
  return loading;
}

export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY;

interface Props {
  /** A fresh token, or null when the old one expired or failed. */
  readonly onToken: (token: string | null) => void;
  /** Bump to get a new token (a token is good for one request). */
  readonly resetKey: number;
  readonly siteKey?: string;
}

export function Turnstile({ onToken, resetKey, siteKey = TURNSTILE_SITE_KEY }: Props) {
  const { t, i18n } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const tokenHandler = useRef(onToken);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    tokenHandler.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(
      (ts) => {
        if (cancelled || container.current === null) return;
        widget.current =
          ts.render(container.current, {
            sitekey: siteKey,
            // Cloudflare has no Nepali; "auto" follows the browser.
            language: i18n.language === "en" ? "en" : "auto",
            callback: (token) => tokenHandler.current(token),
            "expired-callback": () => tokenHandler.current(null),
            "error-callback": () => tokenHandler.current(null),
          }) ?? null;
        setState("ready");
      },
      () => {
        if (!cancelled) setState("failed");
      },
    );
    return () => {
      cancelled = true;
      if (widget.current !== null) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
    // The widget is made once; a language switch does not need a new token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || widget.current === null) return;
    tokenHandler.current(null);
    window.turnstile?.reset(widget.current);
  }, [resetKey]);

  return (
    <div aria-label={t("signIn.humanCheck")} className="min-h-[65px]">
      <div ref={container} />
      {state === "loading" && <p className="text-sm text-stone-500">{t("signIn.humanCheckLoading")}</p>}
      {state === "failed" && (
        <p role="alert" className="text-sm text-red-800">
          {t("signIn.humanCheckFailed")}
        </p>
      )}
    </div>
  );
}
