import { expect, test } from "@playwright/test";
import { EXPECTED } from "../fixtures/expected-data.ts";
import { resolveCssColor } from "../helpers.ts";

/**
 * The theme has three states, not two. With no stored choice nothing is
 * stamped on <html> and prefers-color-scheme decides; an explicit choice
 * stamps data-theme and must beat the OS in both directions.
 *
 * Grounds are authored in oklch, so getComputedStyle reports them in that
 * colour space rather than as rgb(). These assertions compare the two themes
 * against each other instead of against a literal.
 */
const ground = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/**
 * Resolves a `--svd-` custom property to the rgb() the browser actually
 * paints, via a throwaway probe element -- reading the property directly
 * (`getPropertyValue`) would return its unresolved source text (e.g.
 * `var(--svd-indigo-900)`), not the colour var() and color-mix() ultimately
 * produce, which is what a `toHaveCSS` comparison needs.
 */
const resolvedToken = (page: import("@playwright/test").Page, token: string) =>
  page.evaluate((t) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${t})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, token);

/**
 * Confirms every `<meta name="theme-color">` tag's `content` resolves to the
 * same colour as `--svd-nav` on the page as it stands right now.
 *
 * A `<meta>` tag genuinely cannot read a custom property, so `THEME_COLORS`
 * in routes/_app.tsx is a literal hex baked into the SSR markup and the
 * no-flash script -- this is the check that the copy hasn't drifted from the
 * token it exists to mirror. Comparing the two literal hex copies to each
 * other (or to a hard-coded `#0f1220`) would pass just as happily if both
 * drifted from `--svd-nav` together, which is what the assertion this
 * replaces did.
 *
 * Reuses `resolvedToken` for the `--svd-nav` side rather than writing a
 * second token-resolving helper. `--svd-nav`'s chain ends in an oklch() ramp
 * step and computes back as `oklch(...)` (see the file header above), while
 * the meta tag's plain hex computes back as `rgb(...)` -- two correct,
 * differently-notated serialisations of the same colour, which a raw string
 * compare would read as a mismatch. `resolveCssColor` (e2e/helpers.ts) is
 * what reconciles them: the shared canvas-compositing resolver
 * `timeline.spec.ts`'s dark-mode ring-contrast test also imports, so there
 * is exactly one copy of that trick, not one per spec.
 */
const themeColorMatchesNav = async (page: import("@playwright/test").Page) => {
  const contents = await page.locator('meta[name="theme-color"]').evaluateAll(
    (metas) => metas.map((meta) => meta.getAttribute("content")),
  );
  // Both tags are the explicit choice's colour by this point (see the two
  // call sites below), so they must already agree with each other.
  expect(new Set(contents).size).toBe(1);
  const hex = contents[0];
  expect(hex).toBeTruthy();

  const nav = await resolvedToken(page, "--svd-nav");
  expect(await page.evaluate(resolveCssColor, hex)).toEqual(
    await page.evaluate(resolveCssColor, nav),
  );
};

test.describe("light OS", () => {
  test.use({ colorScheme: "light" });

  test("follows the OS until a choice is made", async ({ page }) => {
    await page.goto("/genes");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    await expect(page.getByRole("button", { name: "Switch to dark theme" }))
      .toBeVisible();
  });

  test("an explicit dark choice beats a light OS and persists", async ({ page }) => {
    await page.goto("/genes");
    const light = await ground(page);

    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await ground(page)).not.toBe(light);

    // The stamp is applied by the inline script before first paint, so it is
    // already present when the document commits — no flash of the old theme.
    await page.reload({ waitUntil: "commit" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // The no-flash script must restore browser-chrome colours too, not only
    // the document theme. Both media-qualified tags represent the explicit
    // choice once it overrides the OS, and must still name the dark
    // theme's actual --svd-nav, not merely agree with each other.
    await page.waitForLoadState("domcontentloaded");
    await themeColorMatchesNav(page);
  });

  test("an explicit choice propagates to another open tab", async ({ page, context }) => {
    await page.goto("/genes");
    const other = await context.newPage();
    try {
      await other.goto("/trials");
      await expect(other.locator("html")).not.toHaveAttribute("data-theme");

      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(
        other.getByRole("button", { name: "Switch to light theme" }),
      ).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test("an invalid stored value does not stop following the OS", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("svd-theme", "sepia"));
    await page.goto("/genes");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.getByRole("button", { name: "Switch to light theme" }))
      .toBeVisible();
  });

  test("a choice stays coherent when storage is blocked", async ({ page }) => {
    await page.addInitScript(() => {
      const blocked = () => {
        throw new DOMException("Site data is blocked", "SecurityError");
      };
      Object.defineProperties(Storage.prototype, {
        getItem: { configurable: true, value: blocked },
        setItem: { configurable: true, value: blocked },
      });
    });
    await page.goto("/genes");

    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // A system change must not update only the toggle while the explicit
    // document stamp continues to hold the page in the chosen theme.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.getByRole("button", { name: "Switch to light theme" }))
      .toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test.describe("dark OS", () => {
  test.use({ colorScheme: "dark" });

  test("an explicit light choice beats a dark OS", async ({ page }) => {
    await page.goto("/genes");
    const dark = await ground(page);

    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const light = await ground(page);
    expect(light).not.toBe(dark);

    await page.reload();
    expect(await ground(page)).toBe(light);

    // The light-theme counterpart of the dark-choice check above: the
    // no-flash script's restored meta tags must still name the light
    // theme's actual --svd-nav.
    await page.waitForLoadState("domcontentloaded");
    await themeColorMatchesNav(page);
  });

  test("the map filters its tiles and recolours its markers", async ({ page }) => {
    test.skip(EXPECTED.map.sitesShown === 0, "no facility marker to recolour");
    await page.goto("/map");
    await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();
    const tiles = page.locator(".leaflet-tile-pane");
    const marker = page.locator(".leaflet-overlay-pane path").first();

    // Only the raster tile pane is filtered; the vector markers drawn over it
    // keep their own colours, which is why they are checked separately.
    await expect(tiles).toHaveCSS("filter", /invert/);
    const darkFill = await marker.getAttribute("fill");

    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(tiles).toHaveCSS("filter", "none");
    // circleMarker options are plain JS and cannot read a CSS variable, so the
    // island re-applies them on a theme change.
    await expect(marker).not.toHaveAttribute("fill", darkFill ?? "");
  });

  test("Leaflet chrome follows the theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/map");

    const surface = await resolvedToken(page, "--svd-surface");
    const mapGround = page.locator(".map-container .leaflet-container");
    await expect(mapGround).toHaveCSS("background-color", surface);

    const zoom = page.locator("a.leaflet-control-zoom-in");
    await expect(zoom).toHaveCSS("background-color", surface);

    // leaflet.css pairs :hover and :focus as two independent selectors; a
    // rule reaching only :hover leaves a clicked-or-tabbed-to button on
    // Leaflet's own #f4f4f4 -- a near-white plate on the dark page, with the
    // themed focus-visible ring drawn around it reading as deliberate.
    const hoverBg = await resolvedToken(page, "--svd-bg-tooltip-hover");
    await zoom.focus();
    await expect(zoom).toHaveCSS("background-color", hoverBg);
  });
});
