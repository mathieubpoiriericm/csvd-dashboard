import { expect, test } from "@playwright/test";
import { GENE_TOTAL } from "../../fixtures/expected-data.ts";
import { banner, rows } from "../../helpers.ts";

/**
 * The genes table over the committed cSVD rows, by gene name. The table's
 * behaviour is tested over derived rows in ../genes-table.spec.ts; a fork
 * deletes the whole e2e/tests/csvd/ tree.
 */
test.beforeEach(async ({ page }) => {
  await page.goto("/genes");
});

test("search narrows the table to HTRA1 and clearing restores it", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search genes" });

  // HTRA1 alone: the search covers every column, and the one other row
  // naming HTRA1 names it in its source quote, which the gold-only table
  // does not show.
  await search.fill("  HTRA1  ");
  await expect(search).toHaveValue("  HTRA1  ");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator("td").first())
    .toHaveText("HTRA1", { useInnerText: true });
  await expect(banner(page)).toHaveText(
    `Active Filters: Search: “HTRA1” — showing 1 of ${GENE_TOTAL} rows`,
  );
  await expect(page.locator(".pagination span").first())
    .toHaveText("Showing 1–1 of 1");

  await search.fill("");
  await expect(rows(page)).toHaveCount(10);
});

test("the pager walks twelve pages of ten and lands on the five-row remainder", async ({ page }) => {
  // 115 rows at 10 per page = 12 pages, five more than the pager's seven
  // buttons; the window centres on the current page, so each click reaches
  // two pages further.
  await page.getByRole("button", { name: "Page 7", exact: true }).click();
  await page.getByRole("button", { name: "Page 9", exact: true }).click();
  await page.getByRole("button", { name: "Page 11", exact: true }).click();
  await page.getByRole("button", { name: "Page 12", exact: true }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator(".pagination span").first())
    .toHaveText("Showing 111–115 of 115");
});
