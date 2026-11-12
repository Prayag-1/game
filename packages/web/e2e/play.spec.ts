import { expect, test } from "@playwright/test";

/**
 * Sign in, Quick Play, reach the placeholder table, see state arrive, log
 * out: against the real game server, on the production build, under the
 * strict CSP. Any CSP violation fails the test.
 */
test("guest signs in, quick-plays to a table, sees state, logs out", async ({ page }) => {
  // Init scripts run outside the page's CSP, so this listener sees every block.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.effectiveDirective} blocked ${e.blockedURI || "(inline)"} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");

  // Nepali by default.
  await expect(page.locator("html")).toHaveAttribute("lang", "ne");
  await expect(page.getByRole("heading", { name: "खेल्न सुरु गर्नुहोस्" })).toBeVisible();

  // Sign in. Cloudflare's test site key passes on its own; the button
  // enables once the widget hands over its token.
  await page.getByLabel("तपाईंको नाम").fill("E2E खेलाडी");
  const play = page.getByRole("button", { name: "खेल्न जानुहोस्" });
  await expect(play).toBeEnabled({ timeout: 30_000 });
  await play.click();

  // Lobby, with my name and chips in the header.
  await expect(page.getByTestId("my-name")).toHaveText("E2E खेलाडी");
  await expect(page.getByTestId("my-chips")).toContainText(/\d|[०-९]/);
  await page.getByRole("button", { name: /छिटो खेल/ }).click();

  // The placeholder table: connected, and the server's state arrives.
  await expect(page).toHaveURL(/\/table\/[A-Za-z0-9_-]+$/);
  await expect(page.getByTestId("conn")).toHaveAttribute("data-conn", "connected");
  const raw = page.getByTestId("raw-state");
  await expect(raw).toContainText('"tableId"');
  await expect(raw).toContainText('"seats"');
  await expect(raw).toContainText('"E2E खेलाडी"');
  // The view keeps arriving: the phase moves on as bots play.
  const first = await raw.textContent();
  await expect.poll(async () => (await raw.textContent()) !== first, { timeout: 30_000 }).toBe(true);

  // Log out: back to sign-in, and the session is gone on the server.
  await page.getByRole("button", { name: "बाहिर निस्कनुहोस्" }).click();
  await expect(page.getByRole("heading", { name: "खेल्न सुरु गर्नुहोस्" })).toBeVisible();
  const me = await page.request.get("/session/me");
  expect(me.status()).toBe(401);

  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(pageErrors).toEqual([]);
});
