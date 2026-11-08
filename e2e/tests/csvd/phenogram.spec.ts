import { expect, type Page, test } from "@playwright/test";

import { EXPECTED } from "../../fixtures/expected-data.ts";
import { tooltip } from "../../helpers.ts";

/**
 * The karyogram over the committed cSVD genes, by name: 22 chromosomes and
 * 114 blocks, ABO on 9, LAMB1's tooltip, PRDM16 first and CHRDL1 last, WMH's
 * STRIVE-2 definition. The figure's behaviour is tested over derived counts
 * in ../phenogram.spec.ts; a fork deletes the whole e2e/tests/csvd/ tree.
 */

const FIGURE = "svg.phenogram-figure";

async function figureSettled(page: Page) {
  await page.goto("/phenogram");
  await expect(page.locator(FIGURE)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

// The gold table's 115 genes less MSMP, whose "9q13.3" is not an hg38 band.
test("draws 22 chromosomes and 114 gene blocks under eight families", async ({ page }) => {
  await figureSettled(page);
  const figure = page.locator(FIGURE);
  await expect(figure.locator("g.phenogram-chromosome")).toHaveCount(22);
  await expect(figure.locator('g.phenogram-chromosome[data-chromosome="13"]'))
    .toHaveCount(1);
  await expect(figure.locator("g.phenogram-block")).toHaveCount(114);
  await expect(page.locator(".phenogram-legend-family")).toHaveCount(8);
});

test("the raster's errors are gone: ABO on 9, C6orf195 on 6, COL4A1/2 on 13", async ({ page }) => {
  await figureSettled(page);
  for (
    const [symbol, chromosome] of [
      ["ABO", "9"],
      ["APOE", "19"],
      ["C6orf195", "6"],
      ["COL4A1/2", "13"],
    ]
  ) {
    await expect(
      page.locator(`${FIGURE} g.phenogram-block[data-gene="${symbol}"]`),
    ).toHaveAttribute("data-chromosome", chromosome);
  }
});

test("hovering LAMB1 opens its tooltip and the keyboard reaches the NCBI link", async ({ page }) => {
  await figureSettled(page);
  const lamb1 = page.getByRole("button", { name: /^LAMB1, 7q31\.1\./ });
  await lamb1.hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page)).toContainText("Location");
  await expect(tooltip(page)).toContainText("7q31.1");
  await expect(tooltip(page)).toContainText("None found");
  await page.mouse.move(5, 5);
  await expect(tooltip(page)).toHaveCount(0);

  await lamb1.focus();
  await page.keyboard.press("Enter");
  await expect(tooltip(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tooltip(page).getByRole("link", { name: "View on NCBI Gene" }))
    .toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tooltip(page)).toHaveCount(0);
  await expect(lamb1).toBeFocused();
});

const geneButtonNames = (page: Page) =>
  page.locator(".phenogram-genes button").evaluateAll(
    (buttons) => buttons.map((b) => b.textContent?.trim() ?? ""),
  );

test("gene buttons run from PRDM16 to CHRDL1 and name CENPF's evidence", async ({ page }) => {
  await figureSettled(page);
  const names = await geneButtonNames(page);
  expect(names[0]).toMatch(/^PRDM16, 1p36\.32\. GWAS phenotypes: SVS\./);
  // Gold gives CENPF no other-omics entry, so only its monogenic link is
  // named beside the traits.
  expect(names.find((n) => n.startsWith("CENPF,"))).toBe(
    "CENPF, 1q41. GWAS phenotypes: WM-PVS, HIP-PVS, PSMD. " +
      "Other evidence: Monogenic disease.",
  );
  expect(names.at(-1)).toMatch(/^CHRDL1, Xq23\./);
});

test("a gene across a band edge is placed and named whole", async ({ page }) => {
  test.skip(
    EXPECTED.goldOnly,
    "gold-only: no gold gene's location spans a band edge (SLK, 10q24.33-q25.1, is not in the gold table)",
  );
  await figureSettled(page);
  const names = await geneButtonNames(page);
  // NCBI's range for a gene across a band edge is placed, and named whole.
  expect(names.find((n) => n.startsWith("SLK,"))).toMatch(
    /^SLK, 10q24\.33-q25\.1\./,
  );
});

test("the phenotype key explains WMH with its STRIVE-2 definition", async ({ page }) => {
  await figureSettled(page);
  await page.locator("#phenogram-key summary").click();
  const key = page.locator(".phenogram-legend-traits");
  await key.getByRole("button", { name: "WMH", exact: true }).hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page)).toContainText(
    "White matter hyperintensities (of presumed vascular origin)",
  );
  await expect(tooltip(page)).toContainText("hyperintense on T2-weighted");
  await expect(tooltip(page).getByRole("link", { name: /STRIVE-2/ }))
    .toHaveAttribute("href", "https://doi.org/10.1016/S1474-4422(23)00131-X");

  await page.mouse.move(5, 5);
  await expect(tooltip(page)).toHaveCount(0);
  await key.getByRole("button", { name: "PSMD", exact: true }).hover();
  await expect(tooltip(page)).toContainText("Peak width of skeletonized");
  await expect(tooltip(page).getByRole("link")).toHaveCount(0);
});
