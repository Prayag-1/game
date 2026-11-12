import { defineConfig, devices } from "@playwright/test";

/**
 * End to end against the real game server, serving the production build of
 * this package under its strict CSP (no unsafe-inline, no unsafe-eval).
 * `pnpm e2e` builds both first. Chromium only, as a mid-range Android phone
 * in portrait: the device floor. Turnstile uses Cloudflare's test keys, so
 * the run needs internet access to challenges.cloudflare.com.
 */
const PORT = Number(process.env.KAUDA_E2E_PORT ?? 3210);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Pixel 7"], browserName: "chromium" } }],
  webServer: {
    command: "node e2e/server.mjs",
    url: `http://127.0.0.1:${PORT}/session/config`,
    env: { KAUDA_E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
  },
});
