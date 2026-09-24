import { expect, test } from "@playwright/test";
import { STATUS_SUMMARY, TRIAL_TOTAL } from "../../fixtures/expected-data.ts";
import { banner, pageSizeSelect, rows } from "../../helpers.ts";

/**
 * The trials table over the committed cSVD rows, by drug and search term:
 * Acetylsalicyclic acid first, Atorvastatin's three-row merge, the CADASIL
 * and Academic searches, the fifteen-participant trial. The table's
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

test("opens on Acetylsalicyclic acid", async ({ page }) => {
  // Acetylcysteine's only trial is Completed and hidden by default, so the
  // first default-visible drug alphabetically is Acetylsalicyclic acid.
  await expect(rows(page).first().locator("td").first())
    .toHaveText("Acetylsalicyclic acid");
});

test("merges Atorvastatin's three rows", async ({ page }) => {
  // Atorvastatin x3 is the widest merge on the first page under the default
  // ascending-by-drug sort now that Completed trials -- Aspirin's third
  // registration among them -- are hidden by default.
  const merged = page.locator("td.group-cell");
  await expect(merged.first()).toBeVisible();

  const atorvastatin = page.locator("td.group-cell", {
    hasText: /^Atorvastatin$/,
  });
  await expect(atorvastatin).toHaveAttribute("rowspan", "3");

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
  // The default-visible set's alphabetically-last drugs (XYWAV, XBD173,
  // Udenafil, ...) happen to be single-trial, so page 1 at the default size
  // carries no merge under a descending sort; widen the page to guarantee one
  // of the six-, four- and three-row groups renders.
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

test("search narrows the trials table to the three visible CADASIL trials", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search trials" });

  // The global filter spans every column and runs over the default-visible
  // (non-Completed) set, so "CADASIL" catches three of the five trials that
  // name it in their title and population details -- Palm tocotrienols
  // complex and Adrenomedullin are both Completed and hidden by default.
  await search.fill("CADASIL");
  await expect(banner(page)).toHaveText(
    `Active Filters: ${STATUS_SUMMARY} | Search: “CADASIL” — showing 3 of ${TRIAL_TOTAL} rows`,
  );
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator(".pagination span").first())
    .toHaveText("Showing 1–3 of 3");
  await expect(rows(page).filter({ hasText: "Cerebrolysin" })).toHaveCount(1);

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
  await expect(banner(page)).toContainText("showing 61 of 102 rows");

  await expect(banner(page)).toContainText("Search: “Academic”");
  await expect(rows(page)).toHaveCount(61);
  const group = (drug: string) =>
    rows(page).filter({ has: page.getByText(drug, { exact: true }) }).first();
  // Unfiltered, BAC sits between Azelnidipine and Butylphthalide; it matches
  // no Academic row, so the groups after it shift by one and the stripes
  // have to be recomputed over the filtered set to keep alternating.
  await expect(group("Azelnidipine")).toHaveClass("group-odd");
  await expect(group("Butylphthalide")).toHaveClass("group-even");
  await expect(group("Calculus bovis sativus")).toHaveClass("group-odd");
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
  // The one trial with no stated enrolment (Donepezil) is Completed and so
  // hidden by the default status filter -- every default-visible row here
  // reads a real number, with no "(unknown)" sentinel to sort ahead of them.
  const numbers = sizes.map((size) => Number(size.trim()));
  expect(numbers).not.toContain(NaN);
  expect(numbers[0]).toBe(15);
});

test("the sticky treatment stays on Drug through Atorvastatin's merged block", async ({ page }) => {
  const scroller = page.locator(".table-scroll");
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });

  const result = await page.evaluate(() => {
    const atorvastatinCell = [...document.querySelectorAll("td.group-cell")]
      .find((td) => td.textContent?.trim() === "Atorvastatin");
    if (!atorvastatinCell) {
      throw new Error("Atorvastatin merge cell not found");
    }
    const openingRow = atorvastatinCell.closest("tr")!;
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
    const pinnedStyle = getComputedStyle(atorvastatinCell);
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
