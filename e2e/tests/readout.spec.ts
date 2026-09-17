import { expect, test } from "@playwright/test";
import { choice } from "../helpers.ts";

/**
 * The density readout sits above each table: three stat tiles plus a bar per
 * bucket, each bar drawn to its unfiltered count and filled to the part still
 * showing. Pinned to the committed data (79 genes, 16 trials), like the rest
 * of the suite.
 */
const fillHeights = (page: import("@playwright/test").Page) =>
  page.locator(".readout-bar-fill").evaluateAll((els) =>
    els.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
  );

test("the genes readout buckets by chromosome and drains as you filter", async ({ page }) => {
  await page.goto("/genes");

  const bars = page.locator(".readout-bar");
  await expect(bars.first()).toBeVisible();
  // One bar per chromosome the dataset actually uses, not all 24.
  expect(await bars.count()).toBeGreaterThan(10);

  const shown = page.locator(".readout-stat-value").first();
  await expect(shown).toHaveText(/79\s*\/\s*79/);
  const full = await fillHeights(page);

  await choice(page, "GWAS Traits", "WMH").check();

  await expect(shown).not.toHaveText(/79\s*\/\s*79/);
  // The fills animate, so this has to settle rather than be sampled once.
  await expect.poll(() => fillHeights(page)).toBeLessThan(full);
});

test("the trials readout buckets by phase", async ({ page }) => {
  await page.goto("/trials");

  // Completed trials are hidden by default, so the readout starts at the
  // default-visible count (67), not the full 102.
  await expect(page.locator(".readout-stat-value").first())
    .toHaveText(/67\s*\/\s*102/);
  // PHASE_ORDER first, then anything it does not name, and only those
  // present are drawn -- so a seamless design sits between the two
  // phases it spans, as it does on the radar.
  await expect(page.locator(".readout-bar-label")).toHaveText([
    "I",
    "I/II",
    "II",
    "II/III",
    "III",
    "IV",
    "(unknown)",
  ]);
});

test("global search updates the genes readout as well as the table", async ({ page }) => {
  await page.goto("/genes");
  const full = await fillHeights(page);

  await page.getByRole("searchbox", { name: "Search genes" }).fill("HTRA1");

  await expect(page.locator(".readout-stat-value").first())
    .toHaveText(/1\s*\/\s*79/);
  await expect.poll(() => fillHeights(page)).toBeLessThan(full);
});

test("global search updates the trials readout", async ({ page }) => {
  await page.goto("/trials");
  await page.getByRole("searchbox", { name: "Search trials" }).fill("CADASIL");

  // Two of the five CADASIL trials (Palm tocotrienols complex,
  // Adrenomedullin) are Completed and hidden by the default status filter.
  await expect(page.locator(".readout-stat-value").first())
    .toHaveText(/3\s*\/\s*102/);
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
test("below 600px, /genes hides its bars but keeps the per-bucket list; /trials keeps both", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/genes");
  await expect(page.locator(".readout-bars")).toHaveCSS("display", "none");
  const geneBuckets = page.locator(".readout-dist ul.visually-hidden li");
  // 21 chromosomes carry a gene in the committed data -- comfortably past
  // COMPACT_BUCKET_CEILING, which is the point.
  expect(await geneBuckets.count()).toBeGreaterThan(10);
  await expect(geneBuckets.first()).toHaveText(/^\d+: \d+ of \d+$/);

  await page.goto("/trials");
  await expect(page.locator(".readout-bars")).toHaveCSS("display", "flex");
  await expect(page.locator(".readout-bar-label")).toHaveText([
    "I",
    "I/II",
    "II",
    "II/III",
    "III",
    "IV",
    "(unknown)",
  ]);
});
