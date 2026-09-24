import { expect, type Page, test } from "@playwright/test";

import { tooltip } from "../../helpers.ts";

/**
 * The karyogram over the committed cSVD genes, by name: 21 chromosomes and
 * 79 blocks, ABO on 9, LAMB1's tooltip, PCSK9 first and GLA last, WMH's
 * STRIVE-2 definition. The figure's behaviour is tested over derived counts
 * in ../phenogram.spec.ts; a fork deletes the whole e2e/tests/csvd/ tree.
 */

const FIGURE = "svg.phenogram-figure";

async function figureSettled(page: Page) {
  await page.goto("/phenogram");
  await expect(page.locator(FIGURE)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("draws 21 chromosomes and 79 gene blocks under seven families", async ({ page }) => {
  await figureSettled(page);
  const figure = page.locator(FIGURE);
  await expect(figure.locator("g.phenogram-chromosome")).toHaveCount(21);
  await expect(figure.locator('g.phenogram-chromosome[data-chromosome="13"]'))
    .toHaveCount(1);
  await expect(figure.locator("g.phenogram-block")).toHaveCount(79);
  await expect(page.locator(".phenogram-legend-family")).toHaveCount(7);
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

test("gene buttons run from PCSK9 to GLA and name CENPF's evidence", async ({ page }) => {
  await figureSettled(page);
  const names = await page.locator(".phenogram-genes button").evaluateAll(
    (buttons) => buttons.map((b) => b.textContent?.trim() ?? ""),
  );
  expect(names[0]).toMatch(/^PCSK9, 1p32\.3\. GWAS phenotypes: none found\./);
  expect(names.find((n) => n.startsWith("CENPF,"))).toBe(
    "CENPF, 1q41. GWAS phenotypes: WM-PVS, HIP-PVS, PSMD. " +
      "Other evidence: Other omics, Monogenic disease.",
  );
  expect(names.at(-1)).toMatch(/^GLA, Xq22\.1\./);
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
