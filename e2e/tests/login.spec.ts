import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { PASSPHRASE } from "../fixtures/auth.ts";
import { preloadedFonts } from "../fixtures/fonts.ts";
import { INSTITUTE_ALT, SITE_TITLE } from "../fixtures/expected-data.ts";

/**
 * The unauthenticated flow. Every other spec starts from the session the
 * setup project saved, so this file opts out of that state to see the gate.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("a gated page redirects to the login page and remembers where to return", async ({ page }) => {
  const response = await page.goto("/genes");
  expect(response).not.toBeNull();
  expect(response!.headers()["cache-control"]).toBe("no-store");
  expect(response!.headers()["content-security-policy"]).toBe(
    "frame-ancestors 'none'",
  );
  expect(response!.headers()["x-frame-options"]).toBe("DENY");
  await expect(page).toHaveURL("/login?next=%2Fgenes");
  await expect(page).toHaveTitle(`Sign in | ${SITE_TITLE}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    SITE_TITLE,
  );
  await expect(page.getByRole("img", { name: INSTITUTE_ALT }))
    .toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.getByLabel("Passphrase")).toBeFocused();
});

test("a wrong passphrase stays on the login page and says so", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Passphrase").fill("not the passphrase");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("alert")).toContainText(
    "That passphrase is not right",
  );
  await expect(page.getByLabel("Passphrase")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("a slashed login URL is canonical and cannot become the return target", async ({ page }) => {
  await page.goto("/login/?next=%2Flogin%2F");
  await expect(page).toHaveURL("/login?next=%2Flogin%2F");
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);

  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("the right passphrase returns to the requested page, and Sign out ends it", async ({ page }) => {
  await page.goto("/trials");
  await expect(page).toHaveURL("/login?next=%2Ftrials");
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/trials");
  await expect(page.getByRole("heading", { level: 1, name: "Clinical Trials" }))
    .toBeVisible();

  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "svd_session");
  expect(session).toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  expect(session?.path).toBe("/");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");

  // A protected document must not survive sign-out in browser history. Back
  // re-requests it, the now-cookie-less request hits the gate, and only the
  // login page is allowed to render.
  await page.goBack();
  await expect(page).toHaveURL("/login?next=%2Ftrials");
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Clinical Trials" }))
    .toHaveCount(0);

  await page.goto("/trials");
  await expect(page).toHaveURL("/login?next=%2Ftrials");
});

/**
 * The host `deno task start` binds to has to be one the cookie is not Secure
 * on. `deno serve` prints its bind address as the URL to open, and a Secure
 * cookie over plain HTTP is one the browser silently drops: the login
 * succeeds, the redirect back arrives without a session, and the gate shows
 * the form again with no error -- which reads as a rejected passphrase. The
 * suite's own server listens on every interface, so the task's host reaches
 * it on the same port.
 */
test("the host the start task prints can hold the session cookie", async ({ page, baseURL }) => {
  const denoJson = JSON.parse(
    readFileSync(path.join(__dirname, "..", "..", "deno.json"), "utf8"),
  );
  const host = /--host[= ](\S+)/.exec(denoJson.tasks.start)?.[1];
  expect(host, "deno task start pins no --host").toBeDefined();
  const origin = new URL(baseURL!);
  origin.hostname = host!;

  await page.goto(new URL("/trials", origin).href);
  await expect(page).toHaveURL(new URL("/login?next=%2Ftrials", origin).href);
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new URL("/trials", origin).href);
  await expect(page.getByRole("heading", { level: 1, name: "Clinical Trials" }))
    .toBeVisible();

  const session = (await page.context().cookies())
    .find((c) => c.name === "svd_session");
  expect(session).toBeDefined();
  expect(session?.secure).toBe(false);
});

// Firefox keeps an icon for a bookmark only if it may store it, and it will not
// store a `no-store` one unless its path is exactly /favicon.ico -- which it
// never requests once the page offers an SVG. Fresh serves a static file
// `no-store` unless its URL carries the build id, so an unversioned icon shows
// on the tab and is missing from every bookmark.
test("the icons are versioned, so a browser may keep them for a bookmark", async ({ page, request }) => {
  await page.goto("/login");
  const icons = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll(
      (links) => links.map((link) => (link as HTMLLinkElement).href),
    );
  expect(icons).toHaveLength(3);
  for (const icon of icons) {
    const response = await request.get(icon);
    expect(response.status(), icon).toBe(200);
    expect(response.headers()["cache-control"], icon).not.toContain("no-store");
    expect(response.headers()["cache-control"], icon).toContain("immutable");
  }
});

test("the login fonts are public, versioned and immutable", async ({ page, request }) => {
  await page.goto("/login");
  const fonts = await page.locator('link[rel="preload"][as="font"]')
    .evaluateAll(
      (links) => links.map((link) => (link as HTMLLinkElement).href),
    );
  // The navbar is not on this page, so its face is not preloaded here: a
  // preload no rule consumes is a wasted request and a console warning.
  expect(fonts).toHaveLength(2);
  for (const font of await preloadedFonts(page)) {
    expect(font.status, font.href).toBe("loaded");
  }
  for (const font of fonts) {
    expect(new URL(font).pathname).toMatch(
      /\/assets\/Barlow.*-[A-Za-z0-9_-]+\.woff2$/,
    );
    const response = await request.get(font);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("immutable");
    expect(response.headers()["content-type"]).toContain("font/woff2");
  }
  await page.evaluate(() => document.fonts.ready);
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  const resources = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname.endsWith(".woff2"))
      .map((entry) => ({
        name: entry.name,
        size: (entry as PerformanceResourceTiming).transferSize,
      }))
  );
  for (const font of fonts) {
    const matches = resources.filter((resource) => resource.name === font);
    expect(matches).toHaveLength(1);
    expect(matches[0].size).toBe(0);
  }
});

// Each lib/data module is its own protected chunk, so the page loads several;
// every one of them must be gated, not only the first a check happens to find.
test("the generated data bundles require a live session and are never cacheable", async ({ page }) => {
  await page.goto("/genes");
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("table.data-table tbody tr").first()).toBeVisible();

  // The rows are server-rendered, so they appear before the chunks finish
  // loading. A hydrated island has evaluated every module it imports, so
  // every protected chunk the page needs is in the resource timeline.
  await page.waitForSelector('.table-controls[data-hydrated="true"]');
  const assetUrls = await page.evaluate(() => [
    ...new Set(
      performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) =>
          /\/assets\/protected-data-[A-Za-z0-9_-]+\.js(?:\?|$)/.test(name)
        ),
    ),
  ]);
  expect(assetUrls.length).toBeGreaterThan(0);

  for (const assetUrl of assetUrls) {
    const authenticated = await page.request.get(assetUrl);
    expect(authenticated.status(), assetUrl).toBe(200);
    expect(authenticated.headers()["cache-control"], assetUrl).toBe(
      "private, no-store",
    );
    expect(authenticated.headers()["vary"], assetUrl).toMatch(
      /(?:^|,\s*)Cookie(?:,|$)/i,
    );
  }

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
  await expect.poll(async () =>
    (await page.context().cookies()).some(({ name }) => name === "svd_session")
  ).toBe(false);

  for (const assetUrl of assetUrls) {
    const anonymous = await page.request.get(assetUrl);
    expect(anonymous.status(), assetUrl).toBe(401);
    expect(anonymous.headers()["cache-control"], assetUrl).toBe(
      "private, no-store",
    );
    expect(await anonymous.text(), assetUrl).toBe("Unauthorized");
  }
});

test("the theme toggle works on the login page", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("img", { name: INSTITUTE_ALT }))
    .toBeVisible();
});
