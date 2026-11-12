/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/** Cloudflare's documented always-pass test site key. Public, and useless in production. */
const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
const GAME_SERVER = process.env.KAUDA_GAME_SERVER ?? "http://127.0.0.1:3000";
const DEV_PORT = 5173;

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  // SECURITY.md rule 7: everything VITE_* ends up in the bundle, so nothing
  // that looks like a secret may be named VITE_* (SECURITY.md, "Secrets in the
  // client"). The Turnstile site key is the one public key, by design.
  for (const name of Object.keys(env)) {
    if (name !== "VITE_TURNSTILE_SITE_KEY" && /SECRET|PASSWORD|DATABASE|PRIVATE|TOKEN|KEY/i.test(name)) {
      throw new Error(`${name} looks like a secret, and every VITE_* variable is shipped to browsers`);
    }
  }
  // The public Turnstile site key, fixed at build time. The secret key lives
  // only on the game server and never enters this package.
  let siteKey = env.VITE_TURNSTILE_SITE_KEY ?? "";
  if (siteKey === "") {
    if (command === "build") {
      console.warn(`\n  VITE_TURNSTILE_SITE_KEY is unset: building with Cloudflare's TEST site key (always passes).\n`);
    }
    siteKey = TURNSTILE_TEST_SITE_KEY;
  }

  return {
    plugins: [react(), tailwindcss()],
    define: { "import.meta.env.VITE_TURNSTILE_SITE_KEY": JSON.stringify(siteKey) },
    // An inline PostCSS config stops Vite searching parent directories for
    // one (see packages/server/vitest.config.ts). Tailwind runs as a Vite
    // plugin, so PostCSS has nothing to do.
    css: { postcss: {} },
    build: {
      // Never inline assets as data: URIs, so the production CSP can stay at
      // font-src 'self' and img-src 'self' (no data:).
      assetsInlineLimit: 0,
      sourcemap: false,
    },
    server: {
      host: "127.0.0.1",
      port: DEV_PORT,
      strictPort: true,
      // ONE ORIGIN, ON PURPOSE. The session cookie is host-only and
      // SameSite=Lax, and the browser sends it on the WebSocket upgrade only
      // when the upgrade goes to the page's own origin. So in dev the page,
      // the HTTP routes and the Colyseus socket must all appear to live on
      // this Vite server: it proxies them to the game server. Production has
      // no proxy because the game server serves the built dist/ itself. No
      // CORS anywhere. The game server is told to accept this server's
      // Origin through KAUDA_PROXY_ORIGINS (scripts/dev.mjs sets it); the
      // Origin header is passed through untouched, so its CSRF and
      // cross-origin WebSocket checks still apply.
      proxy: {
        "/session": { target: GAME_SERVER, changeOrigin: true },
        "/tables": { target: GAME_SERVER, changeOrigin: true },
        // The Colyseus client connects to /ws/<processId>/<roomId>; the
        // server's transport reads only the last two path segments.
        "/ws": { target: GAME_SERVER, changeOrigin: true, ws: true },
      },
      // Vite's HMR and React Fast Refresh need inline scripts and injected
      // <style> tags, so dev relaxes the CSP. The production build is served
      // by the game server under the strict policy (no unsafe-inline, no
      // unsafe-eval) in packages/server/src/webClient.ts, and the Playwright
      // test runs against that build under that policy.
      headers: {
        "Content-Security-Policy": [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
          "style-src 'self' 'unsafe-inline'",
          `connect-src 'self' ws://127.0.0.1:${DEV_PORT} ws://localhost:${DEV_PORT}`,
          "frame-src https://challenges.cloudflare.com",
          "img-src 'self' data:",
          "font-src 'self' data:",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      },
    },
    test: {
      environment: "jsdom",
      include: ["test/**/*.test.{ts,tsx}"],
      setupFiles: ["test/setup.ts"],
      css: false,
    },
  };
});
