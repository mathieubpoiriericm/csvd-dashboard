import { expect, test } from "@playwright/test";
import { blockTiles } from "../helpers.ts";
import { EXPECTED } from "../fixtures/expected-data.ts";

/**
 * Leaflet touches `window` at import time, so TrialsMap `await import()`s it
 * inside the effect. Nothing map-shaped exists until the island hydrates and
 * that dynamic chunk lands, which is why every test waits on .leaflet-container
 * rather than on load state.
 *
 * Tiles are blocked throughout: this is the only page that hits the network at
 * runtime, and the suite must not depend on tile.openstreetmap.org being up.
 */
test.beforeEach(async ({ page }) => {
  await blockTiles(page);
  await page.goto("/map");
});

test("reports the geocoded coverage", async ({ page }) => {
  // Each figure is its own stat now, so assert them one at a time rather than
  // as one sentence. The trailing date is generation metadata, not data: it
  // changes on every geocode run even when no coordinate moves, so match its
  // shape and not its value.
  const stats = page.locator(".map-stats .map-stat");
  await expect(stats).toHaveCount(3);
  await expect(stats.nth(0)).toContainText(`${EXPECTED.mapSites}`);
  await expect(stats.nth(0)).toContainText("sites");
  await expect(stats.nth(1)).toContainText(`${EXPECTED.mapCountries}`);
  await expect(stats.nth(1)).toContainText("countries");
  await expect(stats.nth(2)).toContainText(`${EXPECTED.mapTrials}`);
  await expect(stats.nth(2)).toContainText("registered trials");

  await expect(page.locator(".map-stats .date-badge")).toHaveText(
    /^Locations resolved \w+ \d{1,2}, \d{4}$/,
  );
});

test("initialises Leaflet after hydration", async ({ page }) => {
  const container = page.locator(".trials-map.leaflet-container");
  await expect(container).toBeVisible();
  await expect(container.locator(".leaflet-map-pane")).toBeAttached();
});

test("reports a recoverable error when the map runtime cannot load", async ({ page }) => {
  await page.route(/\/leaflet-src-[^/]+\.js$/, (route) => route.abort());
  await page.reload();

  await expect(page.getByRole("alert")).toHaveText(
    /interactive map could not be loaded/i,
  );
  await expect(page.getByRole("heading", { name: "Trial facility locations" }))
    .toBeAttached();
});

test("renders clustered circle markers", async ({ page }) => {
  await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();

  // Markers are L.circleMarker, i.e. SVG paths in the overlay pane, not the
  // default img.leaflet-marker-icon.
  const clusters = page.locator(".marker-cluster");
  const markers = page.locator(
    ".leaflet-overlay-pane path.leaflet-interactive",
  );
  await expect(clusters.or(markers).first()).toBeVisible();

  await expect(page.locator("img.leaflet-marker-icon")).toHaveCount(0);
});

test("cluster badges show a site count", async ({ page }) => {
  const cluster = page.locator(".marker-cluster").first();
  await expect(cluster).toBeVisible();
  await expect(cluster.locator("span")).toHaveText(/^\d+$/);
  await expect(cluster).toHaveClass(/marker-cluster-(small|medium|large)/);
});

test("the zoom controls are wired", async ({ page }) => {
  await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();

  // Keep the page at the top: the navbar is sticky, and scrolling the map into
  // view tucks its top-left zoom controls underneath it, where the nav links
  // intercept the click.
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const zoomOut = page.getByRole("button", { name: "Zoom out" });
  await expect(zoomIn).toBeVisible();
  await expect(zoomOut).toBeVisible();
  await expect(zoomOut).toHaveAttribute("aria-disabled", "false");

  // fitBounds runs on load, so the opening zoom is data-driven rather than the
  // configured default. Instead of pinning a level, drive the control to the
  // minimum and assert Leaflet disables it there.
  //
  // The loop has to re-check before every click: at minimum zoom Leaflet marks
  // the control disabled, and clicking a disabled control blocks until the test
  // times out rather than failing fast. A fixed click count is not safe, since
  // how many steps the starting zoom is above the minimum depends on the data
  // and the viewport.
  for (let i = 0; i < 20; i++) {
    if (await zoomOut.getAttribute("aria-disabled") === "true") break;
    await zoomOut.click();
    // Wait out the zoom animation before re-reading the control. Leaflet flips
    // it to disabled only once the animation lands, so checking too early reads
    // stale state and the next click blocks on a control that just went away.
    await expect(page.locator(".leaflet-zoom-anim")).toHaveCount(0);
  }
  await expect(zoomOut).toHaveAttribute("aria-disabled", "true");
  await expect(zoomIn).toHaveAttribute("aria-disabled", "false");

  await zoomIn.click();
  await expect(zoomOut).toHaveAttribute("aria-disabled", "false");
});

test("clicking a marker opens its trial popup", async ({ page }) => {
  await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();

  // Zoom past the cluster threshold so individual markers are exposed.
  await openAnyMarker(page);

  const popup = page.locator(".leaflet-popup-content .map-popup");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".popup-title")).not.toBeEmpty();
  await expect(popup.locator(".popup-status")).toHaveClass(
    /popup-status-(recruiting|active|completed|terminated|unknown)/,
  );
  await expect(popup.locator(".popup-info-row").first()).toContainText("Drug:");
  await expect(popup.locator(".popup-facility")).not.toBeEmpty();
  await expect(popup.getByRole("link", { name: "View on ClinicalTrials.gov" }))
    .toHaveAttribute("href", /clinicaltrials\.gov\/study\/NCT\d+/);
});

test("an individual site marker opens by keyboard", async ({ page }) => {
  await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();
  await openAnyMarker(page);
  await page.locator("a.leaflet-popup-close-button").click();

  const marker = page.locator(
    ".leaflet-overlay-pane path.leaflet-interactive",
  ).first();
  await expect(marker).toHaveAttribute("tabindex", "0");
  await expect(marker).toHaveAttribute("role", "button");
  await expect(marker).toHaveAttribute(
    "aria-label",
    /^Open facility details: .+NCT\d{8}$/,
  );
  await expect(marker).toHaveAttribute("aria-expanded", "false");

  await marker.focus();
  await expect(marker).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".leaflet-popup-content .map-popup")).toBeVisible();
  await expect(marker).toHaveAttribute("aria-expanded", "true");

  await page.locator("a.leaflet-popup-close-button").click();
  await expect(marker).toHaveAttribute("aria-expanded", "false");
  await marker.focus();
  await page.keyboard.press(" ");
  await expect(page.locator(".leaflet-popup-content .map-popup")).toBeVisible();
});

test("the popup close button dismisses it", async ({ page }) => {
  await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();
  await openAnyMarker(page);

  const popup = page.locator(".leaflet-popup-content .map-popup");
  await expect(popup).toBeVisible();

  await page.locator("a.leaflet-popup-close-button").click();
  await expect(popup).toHaveCount(0);
});

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  test("the trial popup uses a dark surface", async ({ page }) => {
    // Wait for the container as the sibling tests do. Hydrating the 173
    // default-visible facility markers takes long enough that drilling for
    // one beforehand races it.
    await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();
    await openAnyMarker(page);

    const wrapper = page.locator(".leaflet-popup-content-wrapper");
    const tip = page.locator(".leaflet-popup-tip");
    await expect(wrapper).toBeVisible();
    const background = await wrapper.evaluate((element) =>
      getComputedStyle(element).backgroundColor
    );
    expect(background).not.toBe("rgb(255, 255, 255)");
    await expect(tip).toHaveCSS("background-color", background);
  });
});

test("the map container is a named, focusable region", async ({ page }) => {
  // Leaflet's keyboard handler forces tabIndex=0 on the container, so it has to
  // carry a role and an accessible name of its own. Both are server-rendered,
  // so neither waits on hydration.
  const container = page.locator(".trials-map");
  await expect(container).toHaveAttribute("role", "application");
  await expect(container).toHaveAttribute(
    "aria-label",
    "Interactive map of trial facility locations",
  );
});

test("a hidden list carries the map's content for screen readers", async ({ page }) => {
  // The marker paths are augmented for keyboard use after hydration, while
  // this list remains the complete non-spatial alternative for virtual
  // navigation and for the map-load error path. It follows the study-status
  // filter like the markers do, so it is pinned to the default-visible count
  // (Completed sites unticked), not the full committed total.
  const items = page.locator(".visually-hidden li");
  await expect(items).toHaveCount(EXPECTED.mapSitesShown);

  // Assert the shape of a location entry, not one facility's name — the
  // first row depends on source ordering that ClinicalTrials.gov may change.
  await expect(items.first()).toHaveText(
    /^.+ — .+ — .+ — NCT\d{8}$/,
  );

  await expect(page.getByRole("heading", { name: "Trial facility locations" }))
    .toBeAttached();
});

test("the hidden list adds no invisible tab stops", async ({ page }) => {
  // .visually-hidden clips rather than hides, so anchors inside it would stay
  // in the tab order and strand focus off-screen 70 times over. The list is
  // plain text on purpose; this guards that decision.
  await expect(page.locator(".visually-hidden a")).toHaveCount(0);
});

/**
 * Markers start clustered, so reveal one before clicking. Clicking a cluster
 * zooms to its bounds; if the cluster ever disappears without exposing a
 * marker, fall back to the zoom control. Retried rather than timed, because
 * Leaflet's zoom is animated and the number of steps depends on the data.
 */
async function openAnyMarker(page: import("@playwright/test").Page) {
  await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();
  // Leaflet keeps a path in the overlay pane for markers it has not laid out
  // yet, drawn as `d="M0 0"`. With 173 facility sites visible one of those is
  // often first in document order, so the visible ones are what this drills
  // for.
  const marker = page.locator(
    ".leaflet-overlay-pane path.leaflet-interactive:visible",
  );
  const cluster = page.locator(".marker-cluster");
  const markerInView = () =>
    marker.evaluateAll((elements) => {
      const map = document.querySelector(".trials-map")!
        .getBoundingClientRect();
      return elements.findIndex((element) => {
        const box = element.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        return x > map.left && x < map.right && y > map.top && y < map.bottom;
      });
    });

  await expect(async () => {
    if (await markerInView() === -1) {
      if (await cluster.count() > 0) {
        await cluster.first().click();
      } else {
        await page.getByRole("button", { name: "Zoom in" }).click();
      }
    }
    // Let the zoom animation settle so the click lands on a stable target.
    await expect(page.locator(".leaflet-zoom-anim, .leaflet-cluster-anim"))
      .toHaveCount(0);
    expect(await markerInView()).toBeGreaterThanOrEqual(0);
  }).toPass({ timeout: 30_000 });

  await marker.nth(await markerInView()).click();
}

test("facility popups fit a narrow phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/map");
  await openAnyMarker(page);
  const map = await page.locator(".trials-map").boundingBox();
  const popup = await page.locator(".leaflet-popup-content-wrapper")
    .boundingBox();
  expect(popup!.width).toBeLessThanOrEqual(map!.width);
});

test("Space activates a map cluster and keeps keyboard focus on the map", async ({ page }) => {
  const cluster = page.locator(".marker-cluster").first();
  await expect(cluster).toBeVisible();
  const scale = page.locator(".leaflet-control-scale-line");
  const before = await scale.innerText();
  await cluster.focus();
  await page.keyboard.press(" ");
  await expect(scale).not.toHaveText(before);
  await expect(page.locator(".trials-map")).toBeFocused();
});

test("the study-status group hides completed sites by default and shows them on request", async ({ page }) => {
  // The checkbox click below needs the island hydrated -- .map-controls-count
  // itself is server-rendered and would pass with a check that only flips the
  // native checkbox, leaving Preact's state (and so the cluster) untouched.
  await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();

  const count = page.locator(".map-controls-count");
  await expect(count).toContainText(
    `Showing ${EXPECTED.mapSitesShown} of ${EXPECTED.mapSites} sites`,
  );
  await page.getByRole("group", { name: /^Study status/ })
    .getByRole("checkbox", { name: /^Show All/ }).check();
  await expect(count).toContainText(
    `Showing ${EXPECTED.mapSites} of ${EXPECTED.mapSites} sites`,
  );
  await expect(page.locator(".visually-hidden li")).toHaveCount(
    EXPECTED.mapSites,
  );
});

/**
 * The `.tip-row` sits outside `.map-container`, so it is clear of the
 * visually-hidden site list that makes text assertions on that container
 * unsafe. The note explains why the stats line's registered-trial count is
 * lower than the trials table's total row count.
 */
test("the map states its registry coverage and its click affordances", async ({ page }) => {
  await page.goto("/map");

  const tips = page.locator(".tip-row .tip-box");
  await expect(tips).toHaveCount(2);

  const note = tips.first();
  await expect(note.locator("strong").first()).toHaveText("Note:");
  await expect(note).toContainText("ClinicalTrials.gov (NCT IDs only)");
  await expect(note).toContainText("ISRCTN, ACTRN, ChiCTR");

  await expect(tips.nth(1)).toContainText("Click a cluster to zoom in");
});

test("keyboard popup activation reaches its link and dismissal restores the site", async ({ page }) => {
  await openAnyMarker(page);
  await page.getByRole("button", { name: "Close popup", exact: true }).click();
  const name = await page.locator("path.leaflet-interactive:focus")
    .getAttribute("aria-label");
  expect(name).toBeTruthy();
  const marker = page.getByRole("button", { name: name!, exact: true });
  await marker.focus();
  await page.keyboard.press("Enter");
  const link = page.getByRole("link", { name: "View on ClinicalTrials.gov" });
  await expect(link).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".leaflet-popup")).toHaveCount(0);
  await expect(marker).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(link).toBeFocused();
  const close = page.getByRole("button", { name: "Close popup", exact: true });
  await close.focus();
  await page.keyboard.press(" ");
  await expect(page.locator(".leaflet-popup")).toHaveCount(0);
  await expect(marker).toBeFocused();
});
