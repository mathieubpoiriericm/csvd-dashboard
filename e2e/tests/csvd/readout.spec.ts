import { expect, test } from "@playwright/test";
import { choice } from "../../helpers.ts";

/**
 * The density readouts over the committed cSVD rows, by trait and gene name.
 * The readout's behaviour is tested over derived counts in
 * ../readout.spec.ts; a fork deletes the whole e2e/tests/csvd/ tree.
 */
const fillHeights = (page: import("@playwright/test").Page) =>
  page.locator(".readout-bar-fill").evaluateAll((els) =>
    els.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
  );

test("ticking WMH drains the genes readout from 115 to 19", async ({ page }) => {
  await page.goto("/genes");
  const shown = page.locator(".readout-stat-value").first();
  await expect(shown).toHaveText(/115\s*\/\s*115/);
  const full = await fillHeights(page);

  await choice(page, "GWAS Traits", "WMH").check();

  await expect(shown).toHaveText(/19\s*\/\s*115/);
  await expect.poll(() => fillHeights(page)).toBeLessThan(full);
});

test("searching HTRA1 leaves one gene in the readout", async ({ page }) => {
  await page.goto("/genes");
  // HTRA1 alone: GLA names it only in its source quote, which the gold-only
  // table does not show.
  await page.getByRole("searchbox", { name: "Search genes" }).fill("HTRA1");
  await expect(page.locator(".readout-stat-value").first())
    .toHaveText(/1\s*\/\s*115/);
});

test("searching CADASIL leaves the two CADASIL trials in the readout", async ({ page }) => {
  await page.goto("/trials");
  await page.getByRole("searchbox", { name: "Search trials" }).fill("CADASIL");

  // Cerebrolysin (CERICA) and Palm tocotrienols complex. Before gold-only
  // two of five were Completed and hidden by the default status filter; the
  // gold-only default shows every status, so both count.
  await expect(page.locator(".readout-stat-value").first())
    .toHaveText(/2\s*\/\s*16/);
});
