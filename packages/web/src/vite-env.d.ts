/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloudflare Turnstile's PUBLIC site key. Never put a secret in a VITE_* variable. */
  readonly VITE_TURNSTILE_SITE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
