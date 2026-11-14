import { expect, type Page, test } from "@playwright/test";
import { EXPECTED } from "../fixtures/expected-data.ts";
import { choice, filterGroup } from "../helpers.ts";
import {
  cleanSweep,
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
/** The window the phone list opens a record in. */
const DIALOG = "#timeline-dialog";
const DRAWER = "#timeline-drawer";
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

const CLEAN = cleanSweep(T.labels);

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

  // A window over the page, not the drawer stacked above the plot.
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.matches(":modal"))).toBe(true);
  await expect(page.locator(DRAWER)).toBeHidden();
  expect(await row.textContent()).toContain(
    (await dialog.locator("h2").textContent())!.trim(),
  );
  const closeButton = dialog.getByRole("button", {
    name: "Close trial details",
  });
  await expect(closeButton).toBeFocused();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  // The small radar lifts the open trial's marker.
  await expect(page.locator(".timeline-mini .marker.active")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".timeline-mini .marker.active")).toHaveCount(0);

  // The "x" leaves the same way.
  await row.click();
  await expect(dialog).toBeVisible();
  await closeButton.click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("aria-expanded", "false");
});

test("an open record survives a live resize to the list and back", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  expect(await load(page, 1440, 900)).toBe("radar");
  await recordTriggers(page).first().click();
  const drawer = page.locator("#timeline-drawer");
  await expect(drawer).toBeVisible();
  const drug = (await drawer.locator("h2").textContent())!.trim();

  // On the phone the record moves into the window, still open.
  await page.setViewportSize({ width: 393, height: 852 });
  expect(await settleRadar(page)).toBe("phone");
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("h2")).toHaveText(drug);
  await expect(drawer).toBeHidden();
  // Focus follows the record to its new close button, both ways.
  const closeButton = page.getByRole("button", { name: "Close trial details" });
  await expect(closeButton).toBeFocused();
  const expanded = page.locator(`${LIST_ROWS}[aria-expanded="true"]`);
  await expect(expanded).toHaveCount(1);
  await expect(expanded).toContainText(drug);
  expect(await page.evaluate(() => document.activeElement?.isConnected))
    .toBe(true);
  expect(
    await page.evaluate(() => document.activeElement !== document.body),
  ).toBe(true);

  // And back beside the plate.
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await settleRadar(page)).toBe("radar");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("h2")).toHaveText(drug);
  await expect(dialog).toBeHidden();
  await expect(closeButton).toBeFocused();
  const marker = page.locator(
    'svg.timeline-figure g.drug[aria-expanded="true"]',
  );
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-drug", drug);
  expect(await page.evaluate(() => document.activeElement?.isConnected))
    .toBe(true);
});

test("a tap outside the window closes it, a tap inside does not", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  expect(await load(page, 393, 852)).toBe("phone");
  const row = page.locator(LIST_ROWS).first();
  await row.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();

  await dialog.locator("h2").click();
  await dialog.locator(".timeline-drawer-fields dd").first().click();
  await expect(dialog).toBeVisible();

  // A drag that starts on the record and ends outside it -- selecting a
  // registry ID to copy, say -- is not a press on the backdrop, though the
  // browser reports its click on the dialog, the two ends' common ancestor.
  const value = (await dialog.locator(".timeline-drawer-fields dd").first()
    .boundingBox())!;
  await page.mouse.move(value.x + 4, value.y + value.height / 2);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 4 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  // Nor is one that starts outside and ends on the record.
  await page.mouse.move(5, 5);
  await page.mouse.down();
  await page.mouse.move(value.x + 4, value.y + value.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();

  // The backdrop: the corner of the viewport, outside the window's box.
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("aria-expanded", "false");
});

/**
 * A record is longer than a short phone is tall. The window takes the
 * viewport's height and scrolls inside itself; its header, the close button
 * with it, stays put, and the page behind does not move.
 */
test("the window stays inside a short phone and its close stays in reach", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  test.slow();
  const width = 393;
  const height = 500;
  expect(await load(page, width, height)).toBe("phone");
  const dialog = page.locator(DIALOG);
  const closeButton = dialog.getByRole("button", {
    name: "Close trial details",
  });
  const rows = page.locator(LIST_ROWS);
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    await row.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => globalThis.scrollY);
    await row.click();
    await expect(dialog).toBeVisible();
    const name = `row ${i}`;

    const box = (await dialog.boundingBox())!;
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.y, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(width);
    expect(box.y + box.height, name).toBeLessThanOrEqual(height);
    expect(await scrollsSideways(page), name).toBe(false);
    // Nothing inside reaches past the window's own edge sideways.
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      name,
    ).toBe(true);

    await dialog.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(closeButton, name).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => globalThis.scrollY), name).toBe(before);

    await closeButton.click();
    await expect(dialog).toBeHidden();
  }
});

/**
 * With no record open, focus sits on the marker or row itself, which the
 * switch removes. It must land on the same trial in the other layout, not
 * fall to the body: a keyboard user who zooms across the switch keeps their
 * place.
 */
test("a focused trial keeps focus across a live resize to the list and back", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  expect(await load(page, 1440, 900)).toBe("radar");
  const first = page.locator("svg.timeline-figure g.drug").first();
  const drug = (await first.getAttribute("data-drug"))!;
  await first.focus();
  await expect(first).toBeFocused();

  await page.setViewportSize({ width: 393, height: 852 });
  expect(await settleRadar(page)).toBe("phone");
  const row = page.locator(`${LIST_ROWS}:focus`);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(drug);

  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await settleRadar(page)).toBe("radar");
  const marker = page.locator("svg.timeline-figure g.drug:focus");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-drug", drug);
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

/**
 * A status selection resets the floor and the stacking it learnt. Where the
 * plate's scale is the same either side of that reset -- a floor learnt in a
 * short window that a taller one has since outgrown -- the reset must not
 * report the new selection's labels before they have been separated: that
 * report is a fault, and it raised the floor and swapped the radar for the
 * list at a width where the radar reads cleanly. The same two selections
 * made in a fresh tab at the tall size are what the page must end at.
 */
test("a status change after a learnt floor decides as a fresh selection does", async ({ page }) => {
  const busiest = T.busiestStatus;
  test.skip(busiest === null, NO_MARKER);
  const [width, short, tall] = [1280, 720, 1200];
  const pick = (on: Page, label: string) =>
    choice(on, "Study status", label).check();
  const decision = async (on: Page) => ({
    mode: await settleRadar(on),
    floor: await radarFloor(on),
  });

  const fresh = await page.context().newPage();
  await load(fresh, width, tall);
  await pick(fresh, busiest!.label);
  await settleRadar(fresh);
  await pick(fresh, "Show All");
  const expected = await decision(fresh);
  await fresh.close();

  await load(page, width, short);
  await pick(page, busiest!.label);
  await settleRadar(page);
  test.skip(
    await radarFloor(page) === 0,
    "the radar reads cleanly at the height fit: no floor to outgrow",
  );
  await page.setViewportSize({ width, height: tall });
  await settleRadar(page);
  await pick(page, "Show All");
  expect(await decision(page)).toEqual(expected);
  if (expected.mode === "radar") {
    await expect.poll(() => sweepLabelFit(page)).toEqual(
      cleanSweep(T.labelsAll),
    );
  }
});
