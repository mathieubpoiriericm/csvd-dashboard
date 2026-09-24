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

test("the pager walks eight pages of ten and lands on the nine-row remainder", async ({ page }) => {
  // 79 rows at 10 per page = 8 pages, one more than the pager's seven
  // buttons.
  await page.getByRole("button", { name: "Page 7", exact: true }).click();
  await page.getByRole("button", { name: "Page 8", exact: true }).click();
  await expect(rows(page)).toHaveCount(9);
  await expect(page.locator(".pagination span").first())
    .toHaveText("Showing 71–79 of 79");
});
