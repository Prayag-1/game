import { devices, expect, test } from "@playwright/test";
import { chips, collectErrors, expectAtTable, expectCleanPage, mySeat, quickPlay, signIn, UI, watchPage } from "./helpers";

/**
 * Against the real game server, serving the production build under its
 * strict CSP, with short rounds (KAUDA_FAST_ROUNDS). Every page in every
 * test fails on any CSP violation or uncaught error.
 */

test.beforeEach(async ({ context }) => {
  await watchPage(context);
});

test("signs in under the strict CSP with an httpOnly cookie, reaches a table, logs out to a fresh account", async ({ page, context }) => {
  const errors = collectErrors(page);
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  await expect(page.locator("html")).toHaveAttribute("lang", "ne");

  await signIn(page, "E2E खेलाडी");
  // The session cookie is httpOnly: in the browser, invisible to the page.
  const cookie = (await context.cookies()).find((c) => c.name === "kauda_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const startingChips = (await page.getByTestId("my-chips").textContent()) ?? "";

  await quickPlay(page);
  // Four seats with their Nepali names, in a round that is going on.
  for (const seat of ["teeya", "chauka", "panja", "chakka"]) await expect(page.getByTestId(`seat-${seat}`)).toBeVisible();
  await expect(page.getByTestId("seat-teeya")).toContainText("तीया");
  await expect(page.getByTestId("stage").locator("circle")).toHaveCount(16);
  await expect(page.getByTestId("chyakhe-list")).toContainText("E2E खेलाडी");

  // Rounds settle into the log, and the browser checks every seed.
  const log = page.getByTestId("round-log");
  await expect(log.getByTestId("log-row").first()).toBeVisible({ timeout: 30_000 });
  await expect(log.locator('[data-check="ok"]').first()).toBeVisible();
  await expect(log).toContainText(/मा-र्यो|ति-र्यो/);
  expect(await log.locator('[data-check="bad"]').count()).toBe(0);
  await page.getByTestId("fairness").locator("summary").click();
  await expect(page.getByTestId("seed")).toHaveText(/^[0-9a-f]{64}$/);

  // Log out, and a new guest is a new account with a fresh buy-in.
  await page.getByRole("button", { name: UI.logout }).click();
  await expect(page.getByRole("heading", { name: UI.signInHeading })).toBeVisible();
  expect((await page.request.get("/session/me")).status()).toBe(401);
  expect((await context.cookies()).find((c) => c.name === "kauda_session")).toBeUndefined();
  await signIn(page, "E2E Fresh");
  await expect(page.getByTestId("my-chips")).toHaveText(startingChips);

  await expectCleanPage(page, errors);
});

test("sits, throws on their turn, chips move by the stake, a refresh keeps the seat, others see them", async ({ page, context, browser }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto("/");
  await signIn(page, "E2E Sita");
  await quickPlay(page);

  // Sit on a seat a human may take: a reservation mid-round, the seat at the next.
  await page.getByRole("button", { name: UI.sit }).first().click();
  const seat = await mySeat(page);
  await expect(page.getByTestId(`seat-${seat}`)).toContainText("तपाईं");

  // Throw, enabled only when it is mine.
  const throwButton = page.getByRole("button", { name: UI.throw });
  await expect(throwButton).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId(`seat-${seat}`)).toHaveAttribute("data-thrower", "true");
  const seen = new Set(await page.getByTestId("log-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-round-id"))));
  const before = await chips(page);
  const ghanti = Number(await page.getByTestId("house-rules").getAttribute("data-ghanti"));
  await throwButton.click();

  // My round settles. My chips move by exactly what the rules give for it.
  const mine = page.locator('[data-testid="log-row"][data-my-throw="true"]').first();
  await expect(mine).toBeVisible({ timeout: 20_000 });
  expect(seen.has(await mine.getAttribute("data-round-id"))).toBe(false);
  const n = async (attr: string) => Number(await mine.getAttribute(attr));
  const stake = await n("data-stake");
  const delta = await n("data-my-delta");
  const expected =
    (await mine.getAttribute("data-hit")) === "true"
      ? 3 * stake + (await n("data-chyakhe-total")) - ((await n("data-streak")) === 0 ? ghanti : 0)
      : -(stake + (await n("data-chyakhe-on-winner")));
  expect(stake).toBeGreaterThan(0);
  expect(delta).toBe(expected);
  await expect.poll(() => chips(page)).toBe(before + delta);
  expect(await mine.locator('[data-check="bad"]').count()).toBe(0);

  // Refresh: the same player, straight back to the same seat, no sign-in.
  await page.reload();
  await expectAtTable(page);
  expect(await mySeat(page)).toBe(seat);
  await expect(page.getByTestId("my-name")).toHaveText("E2E Sita");

  // A second guest in another browser joins by Quick Play: both see each other.
  const other = await browser.newContext({ ...devices["Pixel 7"] });
  await watchPage(other);
  const guest = await other.newPage();
  const guestErrors = collectErrors(guest);
  await guest.goto("/");
  await signIn(guest, "E2E Hari");
  await quickPlay(guest);
  await expect(guest.getByTestId(`seat-${seat}`)).toContainText("E2E Sita");
  await expect(page.getByTestId("chyakhe-list")).toContainText("E2E Hari");
  await expect(guest.getByTestId("chyakhe-list")).toContainText("E2E Hari");

  // A second tab of the same player takes over; the first says so, and can take it back.
  const tab = await context.newPage();
  const tabErrors = collectErrors(tab);
  await tab.goto(page.url());
  await expectAtTable(tab);
  await expect(page.getByTestId("conn-banner")).toHaveAttribute("data-conn", "replaced");
  await page.getByRole("button", { name: UI.reconnect }).click();
  await expectAtTable(page);
  await expect(tab.getByTestId("conn-banner")).toHaveAttribute("data-conn", "replaced");
  expect(await mySeat(page)).toBe(seat);

  await expectCleanPage(page, errors);
  await expectCleanPage(tab, tabErrors);
  await expectCleanPage(guest, guestErrors);
  await other.close();
});

test("a private table's link takes a friend straight to it; it is not listed; Leave Table returns to the lobby", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await signIn(page, "E2E Host");
  await page.getByRole("radio", { name: UI.simple }).check();
  await page.getByRole("button", { name: UI.createPrivate }).click();
  await expectAtTable(page);
  const code = (await page.getByTestId("share-code").textContent()) ?? "";
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  const shareUrl = await page.getByTestId("share-url").inputValue();
  expect(shareUrl).toBe(new URL(`/?code=${code}`, page.url()).toString());
  const tableId = page.url().split("/table/")[1] ?? "";
  const listed = (await (await page.request.get("/tables")).json()) as { tables: { id: string }[] };
  expect(listed.tables.map((t) => t.id)).not.toContain(tableId);

  // A friend opens the link, signs in, and lands at that table with no lobby in between.
  const other = await browser.newContext({ ...devices["Pixel 7"] });
  await watchPage(other);
  const friend = await other.newPage();
  const friendErrors = collectErrors(friend);
  await friend.goto(shareUrl);
  await expect(friend).toHaveURL((u) => u.search === ""); // the code is used once, not kept in the address
  await signIn(friend, "E2E Friend");
  await expect(friend).toHaveURL(new RegExp(`/table/${tableId}$`));
  await expectAtTable(friend);
  await expect(friend.getByTestId("share-code")).toHaveText(code);
  await expect(page.getByTestId("chyakhe-list")).toContainText("E2E Friend");

  // Leave Table: back to the lobby, and off the table.
  await friend.getByRole("button", { name: UI.leave }).click();
  await expect(friend).toHaveURL(/\/$/);
  await expect(friend.getByRole("button", { name: UI.quickPlay })).toBeVisible();
  await expect(page.getByTestId("chyakhe-list")).not.toContainText("E2E Friend");

  await expectCleanPage(page, errors);
  await expectCleanPage(friend, friendErrors);
  await other.close();
});
