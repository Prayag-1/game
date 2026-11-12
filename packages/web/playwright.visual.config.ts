import { defineConfig } from "@playwright/test";

/**
 * Visual baselines: sign-in, lobby and table, at a 390x844 phone and a
 * 1440x900 desktop, rendered from fixed data (e2e/visual/fixture.tsx) so a
 * screenshot changes only when the UI does.
 *
 *   pnpm --filter @kauda/web visual          compare against the baselines
 *   pnpm --filter @kauda/web visual:update   accept the current look
 *
 * Baselines are per platform (font rendering differs), so the committed
 * ones are named -win32; a Linux CI needs its own, made in the Playwright
 * Docker image.
 */
const PORT = 4317;

export default defineConfig({
  testDir: "e2e/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{platform}{ext}",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  expect: {
    // Tight on purpose: rendering here is deterministic, and a loose ratio
    // let a change of digits (Latin to Devanagari) pass unnoticed.
    toHaveScreenshot: { maxDiffPixels: 20, animations: "disabled", caret: "hide" },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    reducedMotion: "reduce",
    locale: "ne-NP",
    timezoneId: "Asia/Kathmandu",
  },
  webServer: {
    command: `vite build --config vite.visual.config.ts --logLevel warn && vite preview --config vite.visual.config.ts --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/e2e/visual/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
