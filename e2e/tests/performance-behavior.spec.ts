import { expect, test } from "@playwright/test";
import {
  EXPECTED,
  GENE_TOTAL,
  TRIAL_SHOWN,
} from "../fixtures/expected-data.ts";
import { rows, tooltip } from "../helpers.ts";

test("closed tooltip bodies are deferred and an open row can be filtered away", async ({ page }) => {
  test.skip(GENE_TOTAL === 0, "no committed genes to open a tooltip on");
  await page.goto("/genes");
  await page.waitForSelector('.table-controls[data-hydrated="true"]');
  await expect(page.locator(".tooltip-pop").first()).toBeAttached();
  await expect(page.locator(".tooltip-pop-scroll")).toHaveCount(0);
  await page.locator("tbody .tooltip-box").first().press("Enter");
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page).locator(".tooltip-row").first()).toBeVisible();
  await page.getByPlaceholder("Search genes").fill("no-such-gene-xyz");
  await expect(page.locator(".empty-state")).toBeVisible();
  await expect(tooltip(page)).toHaveCount(0);
  await expect(page.locator(".tooltip-pop-scroll")).toHaveCount(0);
  await page.getByPlaceholder("Search genes").fill(EXPECTED.firstGeneAsc!);
  await expect(rows(page).first().locator("td").first()).toHaveText(
    EXPECTED.firstGeneAsc!,
    { useInnerText: true },
  );
  await page.locator("tbody .tooltip-box").first().press("Enter");
  await expect(tooltip(page)).toBeVisible();
});

test("a rapid search burst commits the final text on a large table", async ({ page }) => {
  test.skip(GENE_TOTAL === 0, "no committed genes to search");
  const target = EXPECTED.firstGeneAsc!;
  await page.goto("/genes");
  await page.waitForSelector('.table-controls[data-hydrated="true"]');
  await page.locator(".table-control select").selectOption("100");
  await expect(rows(page)).toHaveCount(Math.min(GENE_TOTAL, 100));
  const search = page.getByPlaceholder("Search genes");
  await search.pressSequentially(` ${target} `, { delay: 5 });
  await expect(search).toHaveValue(` ${target} `);
  await expect(rows(page).first().locator("td").first()).toHaveText(target, {
    useInnerText: true,
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Active Filters:" }),
  ).toContainText(`Search: “${target}”`);
});

test("pipeline details mount on first opening and survive close and step changes", async ({ page }) => {
  test.skip(!EXPECTED.hasPipelineRun, "no pipeline run recorded");
  await page.goto("/");
  await page.waitForSelector('.pipeline-card[data-hydrated="true"]');
  const drawer = page.locator("#pipeline-run-drawer");
  await expect(drawer.locator(".pipeline-record")).toHaveCount(0);
  const trigger = page.getByRole("button", {
    name: "View everything this run recorded",
  });
  await trigger.click();
  await expect(drawer.locator(".pipeline-record").first()).toBeVisible();
  // Identity establishes that reopening retains the memoized body.
  await drawer.locator(".pipeline-record").first().evaluate((el) => {
    (globalThis as unknown as { retainedRecord: Element }).retainedRecord = el;
  });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.locator(".pipeline-step-head:not([disabled])").first().click();
  await trigger.click();
  expect(
    await drawer.locator(".pipeline-record").first().evaluate((el) =>
      el ===
        (globalThis as unknown as { retainedRecord: Element }).retainedRecord
    ),
  ).toBe(true);
  await expect(drawer.getByRole("heading", { name: "External services" }))
    .toBeVisible();
});

for (
  const [route, shown] of [["genes", GENE_TOTAL], ["trials", TRIAL_SHOWN]] as const
) {
  test(`pagination retains stable DOM and listeners on ${route}`, async ({ page }) => {
    test.skip(shown <= 10, "a second page needs more than ten rows");
    await page.goto(`/${route}`);
    await page.waitForSelector('.table-controls[data-hydrated="true"]');
    const cdp = await page.context().newCDPSession(page);
    const cycle = async () => {
      const first = (await rows(page).first().textContent()) ?? "";
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(rows(page).first()).not.toHaveText(first);
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(rows(page).first()).toHaveText(first);
    };
    await cycle();
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await cdp.send("Memory.getDOMCounters");
    for (let i = 0; i < 20; i++) await cycle();
    await cdp.send("HeapProfiler.collectGarbage");
    const after = await cdp.send("Memory.getDOMCounters");
    expect(after.nodes).toBe(before.nodes);
    expect(after.jsEventListeners).toBe(before.jsEventListeners);
  });
}

test("timeline remeasures when delayed web fonts replace fallback glyphs", async ({ page }) => {
  test.skip(EXPECTED.timeline.markers === 0, "no trial to label");
  let release!: () => void;
  const fontsAllowed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\.woff2(?:\?|$)/, async (route) => {
    await fontsAllowed;
    await route.continue();
  });
  try {
    await page.goto("/timeline", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.timeline-layout[data-hydrated="true"]');
    const labels = page.locator("text[data-label]");
    const widths = () =>
      labels.evaluateAll((elements) =>
        elements.map((element) => (element as SVGTextElement).getBBox().width)
      );
    const fallback = await widths();
    // One label per drug, population and ring: Completed trials are hidden
    // by the radar's default status filter.
    expect(fallback).toHaveLength(EXPECTED.timeline.labels);
    release();
    // Not `page.evaluate(() => document.fonts.ready)`: evaluating a bare,
    // already-resolved promise straight back to Playwright is where
    // "Resulting promise was garbage collected" comes from -- a CDP/Chromium
    // timing quirk, reproducible here once the page has fewer nodes to
    // build, not a hang in the app. Polling a plain value sidesteps it.
    await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe(
      "loaded",
    );
    await expect.poll(widths).not.toEqual(fallback);
    await expect(page.locator("g.drug")).toHaveCount(EXPECTED.timeline.markers);
    // The final measurement fits the loaded text; repeated frames do not drift.
    const positions = () =>
      labels.evaluateAll((elements) =>
        elements.map((element) => {
          const box = (element as SVGTextElement).getBBox();
          return [box.x, box.y, box.width, box.height];
        })
      );
    const settled = await positions();
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
    expect(await positions()).toEqual(settled);
  } finally {
    release();
  }
});
