import { expect, test } from "@playwright/test";

/** Several nav links duplicate their page's heading text ("Clinical Trials" is
 * both), so these tests always disambiguate by role rather than using getByText.
 */
const ROUTES = [
  {
    href: "/",
    label: "About",
    heading: "Welcome to the Paris Brain Institute's Cerebral SVD Dashboard",
  },
  { href: "/genes", label: "Genes", heading: "Putative Causal Genes" },
  { href: "/phenogram", label: "Phenogram", heading: "Phenogram" },
  { href: "/trials", label: "Clinical Trials", heading: "Clinical Trials" },
  { href: "/timeline", label: "Trials Radar", heading: "Trials Radar" },
  { href: "/map", label: "Trials Map", heading: "Trials Map" },
] as const;

for (const route of ROUTES) {
  test(`${route.href} renders its heading and marks its nav link active`, async ({ page }) => {
    const response = await page.goto(route.href);
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1, name: route.heading }))
      .toBeVisible();
    await expect(page).toHaveTitle(
      `${route.label} | ICM Cerebral SVD Dashboard`,
    );

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav.getByRole("link", { name: route.label, exact: true }))
      .toHaveAttribute("aria-current", "page");
  });
}

test("the nav lists all six tabs in TABS order", async ({ page }) => {
  await page.goto("/");
  const links = page.getByRole("navigation", { name: "Main" }).getByRole(
    "link",
  );
  await expect(links).toHaveText(ROUTES.map((r) => r.label));
});

test("every tab is reachable by clicking through the nav", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });

  for (const route of ROUTES.slice(1)) {
    await nav.getByRole("link", { name: route.label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${route.href}$`));
    await expect(page.getByRole("heading", { level: 1, name: route.heading }))
      .toBeVisible();
  }
});

test("the brand link returns to the About page", async ({ page }) => {
  await page.goto("/genes");
  await page.locator("a.navbar-brand").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: ROUTES[0].heading }))
    .toBeVisible();
});

test("the shared footer renders on every page", async ({ page }) => {
  await page.goto("/");

  const footer = page.locator("footer.page-footer");
  await expect(footer).toContainText(
    "Paris Brain Institute (ICM). All rights reserved.",
  );
  await expect(footer.getByRole("link", { name: "MIT License" }))
    .toHaveAttribute("href", "https://opensource.org/licenses/MIT");
});

test("the skip link moves keyboard focus to the main content", async ({ page }) => {
  await page.goto("/genes");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });

  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await skipLink.click();
  await expect(page.locator("main#main-content")).toBeFocused();
});

/**
 * One viewport per --svd-navbar-h band that the default 1280x720 run
 * (901-1410px) doesn't reach: the wide single-row bar, the narrower stacked
 * band where the bar peaks at 217px but both sticky panels are already
 * static (so only the skip link reads the taller override), and the mobile
 * band. Together with the default-viewport run elsewhere in this file, every
 * band the token declares gets exercised.
 */
const SKIP_LINK_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 700, height: 800 },
  { width: 390, height: 844 },
];

for (const viewport of SKIP_LINK_VIEWPORTS) {
  test(`the skip link lands the heading below the navbar at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/genes");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const navBottom = await page.locator("header.navbar").evaluate((n) =>
      n.getBoundingClientRect().bottom
    );
    const h1Top = await page.locator("main h1").evaluate((n) =>
      n.getBoundingClientRect().top
    );
    expect(h1Top).toBeGreaterThanOrEqual(navBottom - 1);
  });
}

test("the navbar stays short on a phone and the tabs scroll as one row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/map");
  const bar = page.locator(".navbar");
  const box = await bar.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(120);
  await expect(page.locator(".navbar-title")).toBeHidden();
  const nav = page.locator(".navbar-nav");
  await expect(nav).toHaveCSS("flex-wrap", "nowrap");
  // The active tab is scrolled into view on load.
  await expect(page.locator('.nav-link[aria-current="page"]')).toBeInViewport();
});
