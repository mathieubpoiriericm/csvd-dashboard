import { expect, type Page, test } from "@playwright/test";
import { EXPECTED } from "../fixtures/expected-data.ts";
import { choice, filterGroup } from "../helpers.ts";
import {
  radarFloor,
  radarMode,
  recordTriggers,
  settleRadar,
  sweepLabelFit,
} from "./helpers/timeline.ts";

/**
 * The radar at every window size: the plate fits the window down to the
 * readable floor the island learns from the labels on screen, and below it
 * the phone views (a small nameless radar and the trials listed by phase)
 * take its place. Nothing here is pinned to the committed data: counts come
 * from EXPECTED, and the floor is found by stepping the window down, never
 * read off a number.
 */
const T = EXPECTED.timeline;
const NO_MARKER = "no trial drawn on the radar";

const LIST_ROWS = ".timeline-list button.timeline-row";
const DRUG_LABELS = 'svg.timeline-figure text[data-label^="drug-"]';

async function load(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/timeline");
  return await settleRadar(page);
}

/** Whether the document scrolls sideways. */
function scrollsSideways(page: Page) {
  return page.evaluate(() =>
    document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  );
}

const CLEAN = {
  misfit: [],
  clipped: [],
  touching: [],
  onBand: [],
  boxes: T.labels,
};

for (
  const [width, height] of [
    [1920, 900],
    [1440, 900],
    [1280, 900],
    [1280, 720],
    [1100, 900],
    [768, 900],
    [393, 900],
    [320, 900],
  ] as const
) {
  test(`at ${width}x${height} the radar reads cleanly or the list stands in`, async ({ page }) => {
    const mode = await load(page, width, height);
    expect(await scrollsSideways(page)).toBe(false);
    expect(["radar", "phone"]).toContain(mode);
    if (mode === "radar") {
      await expect.poll(() => sweepLabelFit(page)).toEqual(CLEAN);
    } else {
      await expect(page.locator(LIST_ROWS)).toHaveCount(T.markers);
      await expect(page.locator(DRUG_LABELS)).toHaveCount(0);
    }
  });
}

test("the layout switches either side of the readable floor, with a margin", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  const height = 900;
  await load(page, 1100, height);
  let w = 1100;
  while (w > 320 && await radarMode(page) !== "phone") {
    w = Math.max(320, w - 40);
    await page.setViewportSize({ width: w, height });
    await settleRadar(page);
  }
  const floor = await radarFloor(page);
  test.skip(
    await radarMode(page) !== "phone" || floor === 0,
    "the radar never faulted above 320px: sparse data can fit everywhere",
  );
  expect(floor).toBeGreaterThan(0);

  // Inside the hysteresis band the list stays, so a window resting at the
  // floor does not flicker between the two.
  await page.setViewportSize({ width: w + T.hysteresis - 8, height });
  expect(await settleRadar(page)).toBe("phone");

  // Past the band, back above the last width that read cleanly, the radar
  // returns and reads cleanly again.
  await page.setViewportSize({ width: w + 40 + T.hysteresis + 8, height });
  expect(await settleRadar(page)).toBe("radar");
  await expect.poll(() => sweepLabelFit(page)).toEqual(CLEAN);
});

test("on a phone a row opens its record and Escape hands focus back", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  expect(await load(page, 393, 852)).toBe("phone");
  const row = page.locator(LIST_ROWS).first();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();

  await expect(page.locator("#timeline-drawer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close trial details" }))
    .toBeFocused();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  // The small radar lifts the open trial's marker.
  await expect(page.locator(".timeline-mini .marker.active")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(page.locator("#timeline-drawer")).toBeHidden();
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".timeline-mini .marker.active")).toHaveCount(0);
});

test("an open record survives a live resize to the list and back", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  expect(await load(page, 1440, 900)).toBe("radar");
  await recordTriggers(page).first().click();
  const drawer = page.locator("#timeline-drawer");
  await expect(drawer).toBeVisible();
  const drug = (await drawer.locator("h2").textContent())!.trim();

  await page.setViewportSize({ width: 393, height: 852 });
  expect(await settleRadar(page)).toBe("phone");
  await expect(drawer).toBeVisible();
  const expanded = page.locator(`${LIST_ROWS}[aria-expanded="true"]`);
  await expect(expanded).toHaveCount(1);
  await expect(expanded).toContainText(drug);
  expect(await page.evaluate(() => document.activeElement?.isConnected))
    .toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await settleRadar(page)).toBe("radar");
  await expect(drawer).toBeVisible();
  const marker = page.locator(
    'svg.timeline-figure g.drug[aria-expanded="true"]',
  );
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-drug", drug);
  expect(await page.evaluate(() => document.activeElement?.isConnected))
    .toBe(true);
});

/**
 * A status selection redraws both phone views from the same rows. Unticking
 * every status falls back to Show All (`components/CheckboxFilter.tsx`), so
 * the empty case ticks a status that draws nothing, when the data has one,
 * and nothing else.
 */
test("a status change in the phone layout redraws both phone views", async ({ page }) => {
  expect(await load(page, 393, 852)).toBe("phone");
  const group = filterGroup(page, "Study status");

  if (T.emptyStatus !== null) {
    const empty = choice(page, "Study status", T.emptyStatus);
    await empty.check();
    // Every other ticked status, read off its label's own text.
    const others = group.locator("label.filter-option")
      .filter({ has: page.locator("input:checked") })
      .filter({ hasNotText: T.emptyStatus });
    while (await others.count() > 0) {
      await others.first().locator("input").uncheck();
    }
    await expect(empty).toBeChecked();
    await expect(page.locator(".timeline-list-empty")).toBeVisible();
    await expect(page.locator(LIST_ROWS)).toHaveCount(0);
    await expect(page.locator(".timeline-mini .marker")).toHaveCount(0);
  }

  await choice(page, "Study status", "Show All").check();
  expect(await settleRadar(page)).toBe("phone");
  await expect(page.locator(LIST_ROWS)).toHaveCount(T.allMarkers);
  await expect(page.locator(".timeline-mini .marker")).toHaveCount(
    T.allMarkers,
  );
});

test("a short, wide window keeps the radar and scrolls down, not sideways", async ({ page }) => {
  expect(await load(page, 1280, 520)).toBe("radar");
  expect(await scrollsSideways(page)).toBe(false);
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= globalThis.innerWidth
    ),
  ).toBe(true);
});

test("opening a record beside the plate never swaps the radar for the list", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  expect(await load(page, 1366, 900)).toBe("radar");
  await recordTriggers(page).first().click();
  await expect(page.locator("#timeline-drawer")).toBeVisible();
  expect(await settleRadar(page)).toBe("radar");
  const stacked = await page.locator(".timeline-main").getAttribute(
    "data-stack",
  );
  if (stacked === "true") {
    const drawer = await page.locator("#timeline-drawer").boundingBox();
    const plate = await page.locator(".timeline-main > .blueprint-frame")
      .boundingBox();
    expect(drawer!.y).toBeLessThan(plate!.y);
  }
});
