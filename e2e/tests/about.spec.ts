import { expect, test } from "@playwright/test";
import { EXPECTED, MAINTAINER_EMAIL } from "../fixtures/expected-data.ts";

/**
 * Headline counts are derived in lib/data/summary.ts from the committed JSON.
 * Publications counts distinct PMIDs; the "(reference needed)" sentinel is
 * excluded. e2e/fixtures/expected-data.ts derives the same numbers through
 * the same function, so regenerating the data moves both together.
 */
const TOTALS = [
  ["Putative Causal Genes", String(EXPECTED.geneCount)],
  ["Drugs Tested", String(EXPECTED.drugCount)],
  ["Clinical Trials", String(EXPECTED.trialCount)],
  ["Publications", String(EXPECTED.publicationCount)],
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("shows the work-in-progress notice", async ({ page }) => {
  await expect(page.locator(".about-warning")).toContainText(
    "This is a preview of a dashboard that is still a work in progress.",
  );
});

test("the dashboard totals report the committed dataset", async ({ page }) => {
  const summary = page.getByRole("region", { name: "Dashboard totals" });
  await expect(summary.locator(".about-kpi")).toHaveCount(4);

  for (const [label, value] of TOTALS) {
    const kpi = summary.locator(".about-kpi").filter({ hasText: label });
    await expect(kpi.locator(".about-kpi-value")).toHaveText(value);
    await expect(kpi.locator(".about-kpi-label")).toHaveText(label);
  }
});

/**
 * The four figures are required to stay on one line at every width: the row is
 * four equal fractions that shrink rather than wrap, and the figure scales with
 * `clamp()`. This is the assertion that would catch a reflow back to two rows.
 */
test("the totals stay on one line down to a small phone", async ({ page }) => {
  for (const width of [1440, 900, 600, 380]) {
    await page.setViewportSize({ width, height: 900 });

    const tops = await page.locator(".about-kpi").evaluateAll((cells) =>
      cells.map((cell) => Math.round(cell.getBoundingClientRect().top))
    );
    expect(tops, `four cells at ${width}px`).toHaveLength(4);
    expect(new Set(tops).size, `one line at ${width}px`).toBe(1);

    // The row must also fit the hero rather than spilling out of it.
    const fits = await page.locator(".about-kpis").evaluate((row) => {
      const body = row.closest(".card-body") as HTMLElement;
      return row.scrollWidth <= row.clientWidth + 1 &&
        row.getBoundingClientRect().right <=
          body.getBoundingClientRect().right + 0.5;
    });
    expect(fits, `the row fits the hero at ${width}px`).toBe(true);
  }
});

/**
 * The About page reports the last run one of two ways, and never both.
 *
 * The widget (islands/PipelineRun.tsx) renders when data/pipeline_run.json
 * carries a report; the four-number summary card is the fallback until one
 * is recorded, which is the committed state today. Assertions here are
 * structural rather than value-coupled on purpose: the counts change with
 * every run, while the block either renders or it does not.
 */
test("reports the last run exactly once", async ({ page }) => {
  const recorded = EXPECTED.hasPipelineRun || EXPECTED.hasPipelineStatus;
  await expect(page.getByRole("heading", { name: "Last Pipeline Run" }))
    .toHaveCount(recorded ? 1 : 0);

  const widget = page.locator(".pipeline-card");
  const card = page.locator(".pipeline-status-timestamp");
  const hasWidget = await widget.count();

  // Exactly one of the two, never both: two accounts of the same run on
  // one page would invite them to disagree. Neither renders until a run is
  // recorded, which is where a fork starts.
  expect(hasWidget + await card.count()).toBe(recorded ? 1 : 0);
  test.skip(!recorded, "no pipeline run recorded");

  if (hasWidget) {
    await expect(widget.locator(".pipeline-step")).toHaveCount(6);
    await expect(widget.locator(".pipeline-badge").first()).not.toBeEmpty();
  } else {
    await expect(card).not.toBeEmpty();
    await expect(page.locator(".card .value-box-label")).toHaveText([
      "Papers Processed",
      "Full-Text Retrieved",
      "Genes Extracted",
      "Genes Validated",
    ]);
  }
});

/**
 * The widget's interactions, exercised only once a run has recorded a
 * report. `data/pipeline_run.json` carries one today, but it is committed
 * as a bare `null` until a run records one, so these skip rather than
 * assert against a block that may not be on the page.
 */
test("the run drawer opens, takes focus, and closes on Escape", async ({ page }) => {
  const widget = page.locator(".pipeline-card");
  test.skip(
    await widget.count() === 0,
    "no run report recorded (data/pipeline_run.json is null)",
  );

  const drawer = page.locator("#pipeline-run-drawer");
  await expect(drawer).toBeHidden();

  await page.getByRole("button", { name: "View everything this run recorded" })
    .click();
  await expect(drawer).toBeVisible();
  await expect(page.getByRole("button", { name: "Close run details" }))
    .toBeFocused();

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(
    page.getByRole("button", { name: "View everything this run recorded" }),
  ).toBeFocused();
});

test("a step expands by keyboard as well as by click", async ({ page }) => {
  const widget = page.locator(".pipeline-card");
  test.skip(
    await widget.count() === 0,
    "no run report recorded (data/pipeline_run.json is null)",
  );

  const head = widget.locator(".pipeline-step-head:not([disabled])").first();
  await expect(head).toHaveAttribute("aria-expanded", "false");

  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");

  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");

  await head.focus();
  await page.keyboard.press("Enter");
  await expect(head).toHaveAttribute("aria-expanded", "true");
});

/**
 * The page as a whole must not scroll sideways at any width worth supporting.
 *
 * The pipeline widget's step rows used to break this below ~413px: the status
 * badge is `white-space: nowrap`, so "Passed with warnings" held a 190px grid
 * track that could not shrink and pushed the caret past the viewport edge.
 * Only the rows carrying that badge overflowed, which is why it survived --
 * a run whose steps all passed looks fine.
 */
test("no page scrolls sideways, down to the narrowest phone", async ({ page }) => {
  for (const width of [1440, 1100, 900, 600, 480, 420, 380, 320]) {
    await page.setViewportSize({ width, height: 900 });

    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollWidth - de.clientWidth;
    });
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(
      0,
    );
  }
});

test("dates the data from the recorded run, or says none is recorded", async ({ page }) => {
  // data/pipeline_status.json is `null` until the pipeline records its first
  // run -- which is where a fork starts -- so which badge renders is read
  // off the committed file rather than assumed.
  if (EXPECTED.hasPipelineStatus) {
    await expect(page.locator(".date-unavailable")).toHaveCount(0);
    await expect(page.locator(".date-badge")).not.toBeEmpty();
  } else {
    await expect(page.locator(".date-unavailable")).toHaveCount(1);
  }
});

test("lists the five info rows", async ({ page }) => {
  await expect(page.locator(".about-info-label")).toHaveText([
    "How to Cite:",
    "Scientific Board:",
    "Contact Us:",
    "Maintenance:",
    "Acknowledgements:",
  ]);

  await expect(page.getByRole("link", { name: MAINTAINER_EMAIL }))
    .toHaveAttribute("href", `mailto:${MAINTAINER_EMAIL}`);
});

test("attributes the three machine-fetched annotation sources", async ({ page }) => {
  // Orphadata is CC-BY-4.0 and asserts that in every payload, so this block
  // discharges a licence obligation rather than a courtesy. The pipeline logs
  // an error if the asserted licence ever changes.
  await expect(page.locator(".about-source-label")).toHaveText([
    "ClinVar",
    "Orphanet / Orphadata",
    "Open Targets Platform",
  ]);

  await expect(page.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0",
  );
});

/**
 * The reference-data refreshes. Committed as `[]` until a refresh records
 * one, so this skips the same way the drawer tests do -- and starts
 * covering the block the day the first `--sync-annotations` run lands.
 */
test("a recorded refresh names its providers on the page", async ({ page }) => {
  const block = page.locator(".pipeline-sync");
  test.skip(
    await block.count() === 0,
    "no refresh recorded (data/pipeline_syncs.json is empty)",
  );

  // It is a sibling of the run widget, not a replacement for it.
  await expect(page.getByText("Reference Data Refreshes")).toBeVisible();
  await expect(block.first().locator(".pipeline-badge")).not.toBeEmpty();

  // The point of the block: a provider reads as a display name. A bare
  // hostname here means it fell through `SERVICES` to the fallback.
  const names = block.first().locator(".pipeline-api-name");
  for (const name of await names.all()) {
    await expect(name).not.toContainText(/\.(com|org|gov)\b/);
  }
});
