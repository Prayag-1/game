import { expect, type BrowserContext, type Page } from "@playwright/test";

/** The Nepali UI strings the tests drive by. */
export const UI = {
  signInHeading: "खेल्न सुरु गर्नुहोस्",
  name: "तपाईंको नाम",
  play: "खेल्न जानुहोस्",
  quickPlay: /छिटो खेल/,
  logout: "बाहिर निस्कनुहोस्",
  sit: "बस्नुहोस्",
  throw: "कौडा फाल्नुहोस्",
  leave: "टेबल छोड्नुहोस्",
  reconnect: "फेरि जोडिनुहोस्",
  createPrivate: "बनाउनुहोस्",
  simple: /सरल/,
} as const;

/**
 * Records every CSP violation and page error in this context. Init scripts
 * run outside the page's CSP, so the listener sees every block.
 */
export async function watchPage(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.effectiveDirective} blocked ${e.blockedURI || "(inline)"} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
}

export async function expectCleanPage(page: Page, errors: readonly string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
  expect(errors).toEqual([]);
}

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Signs in as a new guest from the sign-in screen. Cloudflare's test key passes by itself. */
export async function signIn(page: Page, name: string): Promise<void> {
  await expect(page.getByRole("heading", { name: UI.signInHeading })).toBeVisible();
  await page.getByLabel(UI.name).fill(name);
  const play = page.getByRole("button", { name: UI.play });
  await expect(play).toBeEnabled({ timeout: 30_000 });
  await play.click();
  await expect(page.getByTestId("my-name")).toHaveText(name);
}

export async function quickPlay(page: Page): Promise<void> {
  await page.getByRole("button", { name: UI.quickPlay }).click();
  await expect(page).toHaveURL(/\/table\/[A-Za-z0-9_-]+$/);
  await expectAtTable(page);
}

/** Connected, with the table's state on screen. */
export async function expectAtTable(page: Page): Promise<void> {
  await expect(page.getByTestId("phase")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("conn-banner")).toHaveCount(0);
}

export async function chips(page: Page): Promise<number> {
  return Number(await page.getByTestId("table-chips").getAttribute("data-chips"));
}

/** The seat I am in, from the seat card marked as mine. */
export async function mySeat(page: Page): Promise<string> {
  const card = page.locator('[data-testid^="seat-"][data-me="true"]');
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  return ((await card.getAttribute("data-testid")) ?? "").replace("seat-", "");
}
