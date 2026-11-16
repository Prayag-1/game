import { expect, test, type Page } from "@playwright/test";

/** See playwright.visual.config.ts. Each screen at a phone and a desktop size. */

const SIZES = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;

/** The table's board is WebGL: wait until its first full frame is drawn. */
async function boardReady(page: Page): Promise<void> {
  const stage = page.getByTestId("stage");
  await expect(stage).toHaveAttribute("data-renderer", "webgl");
  await expect(stage).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
}

async function open(page: Page, screen: string): Promise<void> {
  // A fixed clock, so countdowns and times read the same on every run.
  await page.clock.setFixedTime(new Date("2026-11-04T18:30:00+05:45"));
  await page.goto(`/e2e/visual/?screen=${screen}`);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
}

for (const [size, viewport] of Object.entries(SIZES)) {
  test.describe(size, () => {
    test.use({ viewport, deviceScaleFactor: 1, hasTouch: size === "phone", isMobile: size === "phone" });

    test("sign-in", async ({ page }) => {
      await open(page, "signin");
      await expect(page.getByRole("heading", { name: "खेल्न सुरु गर्नुहोस्" })).toBeVisible();
      await expect(page.getByRole("button", { name: "खेल्न जानुहोस्" })).toBeDisabled(); // no name yet
      await expect(page).toHaveScreenshot(`signin-${size}.png`);
    });

    test("lobby", async ({ page }) => {
      await open(page, "lobby");
      await expect(page.getByTestId("table-row")).toHaveCount(3);
      await expect(page).toHaveScreenshot(`lobby-${size}.png`);
    });

    test("table", async ({ page }) => {
      await open(page, "table");
      await boardReady(page);
      await expect(page.getByTestId("stage-result")).toBeVisible();
      await expect(page.getByTestId("winning-seat")).toHaveAttribute("data-seat", "chakka");
      await expect(page.getByTestId("seat-teeya")).toHaveAttribute("data-me", "true");
      if (size === "desktop") {
        // The side panel is open on a wide screen, every check a green tick.
        await expect(page.getByTestId("log-row")).toHaveCount(7);
        await expect(page.locator('[data-testid="round-log"] [data-check="ok"]')).toHaveCount(7);
      }
      await expect(page).toHaveScreenshot(`table-${size}.png`);
    });

    if (size === "phone") {
      test("table, sheet open", async ({ page }) => {
        await open(page, "table");
        await boardReady(page);
        await page.getByTestId("sheet-toggle").click();
        await expect(page.getByTestId("log-row")).toHaveCount(7);
        await expect(page.locator('[data-testid="round-log"] [data-check="ok"]')).toHaveCount(7);
        await expect(page).toHaveScreenshot(`table-sheet-open-${size}.png`);
      });

      test("table without WebGL falls back to the 2D board", async ({ page }) => {
        // As a browser with WebGL disabled or blocklisted: the API is there, a context is not.
        await page.addInitScript(() => {
          const real = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
            return kind.startsWith("webgl") || kind === "experimental-webgl" ? null : real.call(this, kind, ...(rest as []));
          } as typeof real;
        });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await open(page, "table");
        const stage = page.getByTestId("stage");
        await expect(stage).toHaveAttribute("data-renderer", "2d");
        await expect(stage.locator("[data-shell]")).toHaveCount(16);
        await expect(page.getByTestId("winning-seat")).toBeVisible();
        expect(errors).toEqual([]);
      });
    }
  });
}
