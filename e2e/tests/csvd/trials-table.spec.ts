import { expect, test } from "@playwright/test";
import { STATUS_SUMMARY, TRIAL_TOTAL } from "../../fixtures/expected-data.ts";
import { banner, pageSizeSelect, rows } from "../../helpers.ts";

/**
 * The trials table over the committed cSVD rows, by drug and search term:
 * Butylphthalide first, Cilostazol's three-row merge, the CADASIL and
 * Academic searches, the fifteen-participant trial. The table's
 * behaviour is tested over derived rows in ../trials-table.spec.ts; a fork
 * deletes the whole e2e/tests/csvd/ tree.
 */
const alphaOf = (color: string): number => {
  const match = color.match(/\/\s*([\d.]+)\s*\)$/);
  return match ? Number(match[1]) : 1;
};

test.beforeEach(async ({ page }) => {
  await page.goto("/trials");
});

test("opens on Butylphthalide (NBP)", async ({ page }) => {
  // The first gold drug alphabetically; under gold-only no status is hidden
  // by default, so it is the first row of the whole table.
  await expect(rows(page).first().locator("td").first())
    .toHaveText("Butylphthalide (NBP)");
});

test("merges Cilostazol's three rows", async ({ page }) => {
  // Cilostazol x3 (CVD-Cog, LACI-3 and NCT06530537) is the widest merge on
  // the first page under the default ascending-by-drug sort.
  const merged = page.locator("td.group-cell");
  await expect(merged.first()).toBeVisible();

  const cilostazol = page.locator("td.group-cell", {
    hasText: /^Cilostazol$/,
  });
  await expect(cilostazol).toHaveAttribute("rowspan", "3");

  // Striping alternates per drug block, not per row, so the parity holds
  // across a merged pair rather than flipping inside it.
  const classes = await rows(page).evaluateAll((els) =>
    els.map((e) => e.className)
  );
  expect(classes).toHaveLength(10);
  expect(new Set(classes)).toEqual(new Set(["group-even", "group-odd"]));
  const repeats =
    classes.filter((c, i) => i > 0 && c === classes[i - 1]).length;
  expect(repeats).toBe(3);
});

test("sorting descending by drug keeps repeated rows merged", async ({ page }) => {
  // Widen the page so the whole table is on it and a merged group renders
  // under a descending sort wherever it falls (Isosorbide mononitrate's
  // three rows are the fifth drug group).
  await pageSizeSelect(page).selectOption("100");

  const drug = page.getByRole("columnheader", { name: "Drug", exact: true });
  const sortButton = drug.getByRole("button", { name: "Drug" });

  await sortButton.click();
  await expect(drug).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator("td.group-cell").first()).toBeVisible();

  // An empty sort also counts as grouped, because source data is drug-ordered.
  await sortButton.click();
  await expect(drug).toHaveAttribute("aria-sort", "none");
  await expect(page.locator("td.group-cell").first()).toBeVisible();
});

test("search narrows the trials table to the two CADASIL trials", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search trials" });

  // The global filter spans every column and runs over the default-visible
  // set, so "CADASIL" catches the two gold trials that name it in their
  // title or population details -- Cerebrolysin and Palm tocotrienols
  // complex. Under gold-only no status is hidden by default, so the banner
  // carries the search alone.
  await search.fill("CADASIL");
  const status = STATUS_SUMMARY === null ? "" : `${STATUS_SUMMARY} | `;
  await expect(banner(page)).toHaveText(
    `Active Filters: ${status}Search: “CADASIL” — showing 2 of ${TRIAL_TOTAL} rows`,
  );
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator(".pagination span").first())
    .toHaveText("Showing 1–2 of 2");
  await expect(rows(page).filter({ hasText: "Cerebrolysin" })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: "Palm tocotrienols complex" }))
    .toHaveCount(1);

  await search.fill("");
  await expect(rows(page)).toHaveCount(10);
});

test("search results keep alternating drug-group striping", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.getByRole("searchbox", { name: "Search trials" }).fill(
    "Academic",
  );
  // A page size of 10 no longer guarantees both drugs land on the same page;
  // widen it so the rows being compared are all on screen.
  await pageSizeSelect(page).selectOption("100");
  // The search box debounces, so wait for the filtered set before reading
  // the stripes: read earlier, the rows still carry the unfiltered parity.
  await expect(banner(page)).toContainText(
    `showing 12 of ${TRIAL_TOTAL} rows`,
  );

  await expect(banner(page)).toContainText("Search: “Academic”");
  await expect(rows(page)).toHaveCount(12);
  const group = (drug: string) =>
    rows(page).filter({ has: page.getByText(drug, { exact: true }) }).first();
  // Unsearched, Cerebrolysin sits between Butylphthalide (NBP) (even) and
  // Cilostazol (even after it); it is industry-sponsored and matches no
  // Academic row, so the groups after it shift by one and the stripes have
  // to be recomputed over the filtered set to keep alternating.
  await expect(group("Butylphthalide (NBP)")).toHaveClass("group-even");
  await expect(group("Cilostazol")).toHaveClass("group-odd");
  await expect(group("Colchicine")).toHaveClass("group-even");
});

test("a gene symbol matches no trial", async ({ page }) => {
  await page.getByRole("searchbox", { name: "Search trials" }).fill("HTRA1");
  await expect(page.locator(".empty-state"))
    .toContainText("No rows match the current filters.");
});

test("the smallest stated enrolment is fifteen", async ({ page }) => {
  await page.getByRole("columnheader", { name: "Target Sample Size" }).click();
  await expect(
    page.getByRole("columnheader", { name: "Target Sample Size" }),
  ).toHaveAttribute("aria-sort", "ascending");

  const sizes = await rows(page).locator("td:nth-child(11)").allInnerTexts();
  // Every gold trial states its enrolment, so every row here reads a real
  // number, with no "(unknown)" sentinel to sort ahead of them; THN391's
  // fifteen is the smallest.
  const numbers = sizes.map((size) => Number(size.trim()));
  expect(numbers).not.toContain(NaN);
  expect(numbers[0]).toBe(15);
});

test("the sticky treatment stays on Drug through Cilostazol's merged block", async ({ page }) => {
  const scroller = page.locator(".table-scroll");
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });

  const result = await page.evaluate(() => {
    const mergedCell = [...document.querySelectorAll("td.group-cell")]
      .find((td) => td.textContent?.trim() === "Cilostazol");
    if (!mergedCell) {
      throw new Error("Cilostazol merge cell not found");
    }
    const openingRow = mergedCell.closest("tr")!;
    const continuationRows = [
      openingRow.nextElementSibling as HTMLTableRowElement,
      openingRow.nextElementSibling!.nextElementSibling as HTMLTableRowElement,
    ];
    const continuationFirstCells = continuationRows.map((row) => {
      const firstTd = row.querySelector("td")!;
      return {
        className: firstTd.className,
        position: getComputedStyle(firstTd).position,
      };
    });
    const pinnedStyle = getComputedStyle(mergedCell);
    return {
      continuationFirstCells,
      pinnedPosition: pinnedStyle.position,
      pinnedBackground: pinnedStyle.backgroundColor,
    };
  });

  for (const cell of result.continuationFirstCells) {
    expect(cell.className).not.toContain("col-identity");
    expect(cell.position).not.toBe("sticky");
  }
  expect(result.pinnedPosition).toBe("sticky");
  expect(alphaOf(result.pinnedBackground)).toBe(1);
});
