import { expect, test } from "@playwright/test";
import {
  EXPECTED,
  GENE_TOTAL,
  TRIAL_SHOWN,
  TRIAL_TOTAL,
} from "../fixtures/expected-data.ts";
import { choice } from "../helpers.ts";

/**
 * The density readout sits above each table: three stat tiles plus a bar per
 * bucket, each bar drawn to its unfiltered count and filled to the part still
 * showing. Every count is derived from the committed data; the tests that
 * name a cSVD trait or gene are in csvd/readout.spec.ts.
 */
const fillHeights = (page: import("@playwright/test").Page) =>
  page.locator(".readout-bar-fill").evaluateAll((els) =>
    els.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
  );

const ratio = (shown: number, total: number) =>
  new RegExp(`${shown}\\s*/\\s*${total}`);

test("the genes readout buckets by chromosome and drains as you filter", async ({ page }) => {
  await page.goto("/genes");

  const bars = page.locator(".readout-bar");
  // One bar per chromosome the dataset actually uses, not all 24.
  await expect(bars).toHaveCount(EXPECTED.chromosomesWithGenes);

  const shown = page.locator(".readout-stat-value").first();
  await expect(shown).toHaveText(ratio(GENE_TOTAL, GENE_TOTAL));

  const [top] = EXPECTED.genes.topTraits;
  test.skip(!top || top.count === GENE_TOTAL, "no trait narrows the table");
  const full = await fillHeights(page);
  await choice(page, "GWAS Traits", top.label).check();

  await expect(shown).toHaveText(ratio(top.count, GENE_TOTAL));
  // The fills animate, so this has to settle rather than be sampled once.
  await expect.poll(() => fillHeights(page)).toBeLessThan(full);
});

test("the trials readout buckets by phase", async ({ page }) => {
  await page.goto("/trials");

  // Completed trials are hidden by default, so the readout starts at the
  // default-visible count, not the full total.
  await expect(page.locator(".readout-stat-value").first())
    .toHaveText(ratio(TRIAL_SHOWN, TRIAL_TOTAL));
  // PHASE_ORDER first, then anything it does not name, and only those
  // present are drawn -- so a seamless design sits between the two
  // phases it spans, as it does on the radar.
  await expect(page.locator(".readout-bar-label")).toHaveText(
    EXPECTED.trials.phasesPresent,
  );
});

test("global search updates the genes readout as well as the table", async ({ page }) => {
  test.skip(GENE_TOTAL < 2, "too few committed genes to narrow");
  await page.goto("/genes");
  const full = await fillHeights(page);

  await page.getByRole("searchbox", { name: "Search genes" }).fill(
    EXPECTED.firstGeneAsc!,
  );

  await expect(page.locator(".readout-stat-value").first())
    .not.toHaveText(ratio(GENE_TOTAL, GENE_TOTAL));
  await expect.poll(() => fillHeights(page)).toBeLessThan(full);
});

test("the bars are not announced twice to assistive technology", async ({ page }) => {
  await page.goto("/genes");
  // Every number in the bars is already in the stat tiles and the table, so
  // the columns are hidden rather than read out once per chromosome.
  await expect(page.locator(".readout-bars")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(page.getByRole("region", { name: "Genes by chromosome" }))
    .toBeVisible();
});

// F20: below 600px the bars are dropped, but only past
// COMPACT_BUCKET_CEILING (components/DensityReadout.tsx) -- this is the one
// place that runs against the live committed data rather than a synthetic
// bucket count, so it is what would fail if trial phases ever grow past the
// ceiling and the histogram silently started hiding again. aria-hidden is
// unconditional in the markup either way, so CSS display is the only signal
// that actually distinguishes hidden from shown here.
test("below 600px the bars hide only past the compact ceiling", async ({ page }) => {
  const CEILING = 10;
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/genes");
  await expect(page.locator(".readout-bars")).toHaveCSS(
    "display",
    EXPECTED.chromosomesWithGenes > CEILING ? "none" : "flex",
  );
  const geneBuckets = page.locator(".readout-dist ul.visually-hidden li");
  await expect(geneBuckets).toHaveCount(EXPECTED.chromosomesWithGenes);
  if (EXPECTED.chromosomesWithGenes > 0) {
    await expect(geneBuckets.first()).toHaveText(/^\S+: \d+ of \d+$/);
  }

  await page.goto("/trials");
  await expect(page.locator(".readout-bars")).toHaveCSS(
    "display",
    EXPECTED.trials.phasesPresent.length > CEILING ? "none" : "flex",
  );
  await expect(page.locator(".readout-bar-label")).toHaveText(
    EXPECTED.trials.phasesPresent,
  );
});
