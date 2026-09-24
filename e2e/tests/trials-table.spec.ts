import { expect, test } from "@playwright/test";
import {
  EXPECTED,
  pagesFor,
  STATUS_SUMMARY,
  TRIAL_SHOWN,
  TRIAL_TOTAL,
} from "../fixtures/expected-data.ts";
import { banner, pageSizeSelect, rows } from "../helpers.ts";

const TOTAL = TRIAL_TOTAL;
/** Default-visible rows: every status but Completed. */
const SHOWN = TRIAL_SHOWN;
const HAS_ROWS = SHOWN > 0;

/**
 * Every count is derived from the committed data; the tests that name a
 * cSVD drug, trial or search term are in csvd/trials-table.spec.ts.
 *
 * Chromium reports computed colour-mix() results in oklab(), not rgb() --
 * "oklab(L a b)" when opaque, "oklab(L a b / alpha)" when not -- so this
 * reads the trailing "/ alpha" any colour function may carry rather than
 * assuming an rgba() shape. Shared by every sticky-column alpha check below,
 * on both the rest and :hover states.
 */
const alphaOf = (color: string): number => {
  const match = color.match(/\/\s*([\d.]+)\s*\)$/);
  return match ? Number(match[1]) : 1;
};

test.beforeEach(async ({ page }) => {
  await page.goto("/trials");
});

test("paginates the trial set, reporting the whole of it", async ({ page }) => {
  await expect(page.getByRole("table", { name: "Clinical trials" }))
    .toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Clinical trials pagination" }),
  ).toBeVisible();
  // The banner counts the filtered set; the pagination counts the page.
  if (HAS_ROWS) {
    await expect(rows(page)).toHaveCount(Math.min(10, SHOWN));
    await expect(page.locator(".pagination span").first())
      .toHaveText(`Showing 1–${Math.min(10, SHOWN)} of ${SHOWN}`);
  } else {
    await expect(page.locator(".empty-state")).toBeVisible();
  }
  await expect(banner(page)).toHaveText(
    `Active Filters: ${STATUS_SUMMARY} — showing ${SHOWN} of ${TOTAL} rows`,
  );
  // banner() and the pagination span are both scoped by class now that the
  // page carries two role="status" regions -- pin the role explicitly here
  // so a future edit that drops it from either cannot pass silently.
  await expect(page.locator(".filter-message")).toHaveAttribute(
    "role",
    "status",
  );
  await expect(page.locator(".pagination span").first()).toHaveAttribute(
    "role",
    "status",
  );
});

test("numbered page buttons appear once the set spans pages", async ({ page }) => {
  test.skip(SHOWN <= 10, "one page needs no numbered buttons");
  // pageWindow() caps the numbered buttons at seven.
  const pages = Math.min(pagesFor(SHOWN), 7);
  await expect(pageSizeSelect(page)).toHaveValue("10");
  await expect(page.locator(".pagination-buttons button")).toHaveText([
    "Previous",
    ...Array.from({ length: pages }, (_, i) => String(i + 1)),
    "Next",
  ]);
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("a larger page size removes pages", async ({ page }) => {
  test.skip(SHOWN <= 25, "the page size only matters past 25 rows");
  const pages = Math.min(Math.ceil(SHOWN / 25), 7);
  await pageSizeSelect(page).selectOption("25");
  await expect(rows(page)).toHaveCount(25);
  await expect(page.locator(".pagination-buttons button")).toHaveText([
    "Previous",
    ...Array.from({ length: pages }, (_, i) => String(i + 1)),
    "Next",
  ]);
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("opens sorted ascending by drug", async ({ page }) => {
  await expect(page.getByRole("columnheader", { name: "Drug", exact: true }))
    .toHaveAttribute("aria-sort", "ascending");
  test.skip(SHOWN < 2, "too few rows to order");
  const drugs = await rows(page).locator("td.col-drug").allInnerTexts();
  const lower = drugs.map((d) => d.trim().toLowerCase());
  expect(lower).toEqual([...lower].sort());
});

test("striping alternates per drug block, not per row", async ({ page }) => {
  test.skip(SHOWN < 2, "too few rows to stripe");
  const classes = await rows(page).evaluateAll((els) =>
    els.map((e) => e.className)
  );
  const drugs = await rows(page).evaluateAll((els) =>
    els.map((e) => e.querySelector("td.col-drug")?.textContent?.trim() ?? null)
  );
  expect(new Set(classes).size).toBeLessThanOrEqual(2);
  // A row whose drug cell is covered by a merge keeps its block's parity.
  for (let i = 1; i < classes.length; i++) {
    if (drugs[i] === null) expect(classes[i]).toBe(classes[i - 1]);
    else expect(classes[i]).not.toBe(classes[i - 1]);
  }
});

test("sorting by another column ungroups the rows", async ({ page }) => {
  test.skip(!HAS_ROWS, "no rows to sort");
  await page.getByRole("columnheader", { name: "Registry ID", exact: true })
    .click();
  await expect(
    page.getByRole("columnheader", { name: "Registry ID", exact: true }),
  )
    .toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("td.group-cell")).toHaveCount(0);
  await expect(page.locator("td[rowspan]")).toHaveCount(0);
});

test("renders all fourteen columns in a single header row", async ({ page }) => {
  await expect(page.locator("thead tr")).toHaveCount(1);
  await expect(page.locator("thead th")).toHaveCount(14);
  await expect(page.locator("thead th")).toHaveClass(
    new Array(14).fill(/sortable/),
  );
});

/**
 * F18, the one-row case: /genes' equivalent test
 * ("the sticky header stays pinned...") covers the two-row grouped header
 * and the row-adjacency this table doesn't have to worry about; this is the
 * single-row half of the same rule, and the reason TableShell can share one
 * `.data-table thead { position: sticky; ... }` declaration between both
 * tables rather than branching on header shape.
 */
test("the sticky header stays pinned while the table body scrolls", async ({ page }) => {
  test.skip(SHOWN < 20, "too few rows to scroll the table");
  // Every default-visible row on one page guarantees .table-scroll has
  // more content than its bounded height.
  await pageSizeSelect(page).selectOption("100");
  await expect(rows(page)).toHaveCount(Math.min(SHOWN, 100));

  const measure = () =>
    page.evaluate(() => ({
      theadTop: document.querySelector("thead")!.getBoundingClientRect().top,
      firstRowTop: document.querySelector("tbody tr")!
        .getBoundingClientRect().top,
    }));

  const before = await measure();

  await page.locator(".table-scroll").evaluate((el) => {
    el.scrollTop = 400;
  });

  const after = await measure();
  expect(Math.abs(after.theadTop - before.theadTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.firstRowTop - before.firstRowTop))
    .toBeGreaterThan(50);
});

test("search narrows the trials table to a registry id", async ({ page }) => {
  test.skip(!HAS_ROWS, "no rows to search");
  const search = page.getByRole("searchbox", { name: "Search trials" });
  const id = (await rows(page).locator("td.col-registryId").first()
    .innerText()).trim();

  await search.fill(id);
  await expect(banner(page)).toContainText(`Search: “${id}”`);
  await expect(rows(page).first()).toContainText(id);

  await search.fill("");
  await expect(rows(page)).toHaveCount(Math.min(10, SHOWN));
});

test("a query matching nothing shows the empty state", async ({ page }) => {
  await page.getByRole("searchbox", { name: "Search trials" }).fill(
    "zzznomatch",
  );
  await expect(page.locator(".empty-state"))
    .toContainText("No rows match the current filters.");
});

test("target sample size sorts numerically, not as text", async ({ page }) => {
  test.skip(SHOWN < 2, "too few rows to order");
  // v9 resolves `sortFn: 'auto'` through the `sortFns` registry declared on
  // SHELL_FEATURES. Unregistered, it falls back to a raw string compare and
  // this column reads 110, 1300, 15, 200 ... Sorting by anything other than
  // drug also switches spanning off, so every row carries all 14 cells and a
  // positional selector is safe here.
  await page.getByRole("columnheader", { name: "Target Sample Size" }).click();
  await expect(
    page.getByRole("columnheader", { name: "Target Sample Size" }),
  ).toHaveAttribute("aria-sort", "ascending");

  const sizes = await rows(page).locator("td:nth-child(11)").allInnerTexts();
  const numbers = sizes.map((size) => Number(size.trim()))
    .filter((n) => !Number.isNaN(n));
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
});

test("estimated completion dates sort chronologically", async ({ page }) => {
  test.skip(SHOWN < 2, "too few rows to order");
  const header = page.getByRole("columnheader", {
    name: "Estimated Completion Date",
  });
  await header.getByRole("button").click();

  // The set spans pages now, so this asserts the ordering rather than a
  // literal list: month/year parsed to a comparable number, non-dates (the
  // absent sentinel's em dash) left where the comparator puts them.
  const MONTH_ABBREVIATIONS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const asMonths = (values: string[]) =>
    values.map((value) => {
      const match = /^([A-Za-z]{3}) (\d{4})$/.exec(value.trim());
      if (!match) return null;
      const monthIndex = MONTH_ABBREVIATIONS.indexOf(match[1]);
      return monthIndex === -1 ? null : Number(match[2]) * 12 + monthIndex;
    }).filter((value): value is number => value !== null);

  const dates = await rows(page).locator("td:nth-child(12)").allInnerTexts();
  const ascending = asMonths(dates);
  expect(ascending).toEqual([...ascending].sort((a, b) => a - b));

  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  const descending = asMonths(
    await rows(page).locator("td:nth-child(12)").allInnerTexts(),
  );
  expect(descending).toEqual([...descending].sort((a, b) => b - a));
});

test("global search matches the formatted completion date, not the raw M/YYYY value", async ({ page }) => {
  test.skip(!HAS_ROWS, "no rows to search");
  // Sorting ascending by this column (a) puts a real date, not the
  // sortUndefined: "last" absent sentinel, on the first row, and (b) turns
  // off drug-group spanning, which is what keeps td:nth-child(12) landing on
  // this column instead of drifting with an omitted merged cell.
  const header = page.getByRole("columnheader", {
    name: "Estimated Completion Date",
  });
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");

  const formatted = (await rows(page).locator("td:nth-child(12)").first()
    .innerText()).trim();
  test.skip(
    !/^[A-Za-z]{3} \d{4}$/.test(formatted),
    "no row carries a parseable completion date",
  );

  const search = page.getByRole("searchbox", { name: "Search trials" });
  await search.fill(formatted);
  await expect(rows(page).locator("td:nth-child(12)").first())
    .toHaveText(formatted, { useInnerText: true });
  expect(await rows(page).count()).toBeGreaterThanOrEqual(1);
});

test("the sticky treatment stays on Drug through a merged block, and stays opaque scrolled right", async ({ page }) => {
  test.skip(SHOWN < 2, "too few rows to merge");
  // F14: cellSpanningFeature does not render a covered cell at all, so in a
  // merged block's continuation rows the first *rendered* td is Mechanism of
  // Action -- a plain :first-child selector matched that instead of Drug.
  // F15: the group-odd stripe used to mix into transparent
  // (--svd-bg-row-stripe) even on the sticky cell, instead of the opaque
  // --svd-bg-sticky-even every other sticky background uses, so scrolled
  // columns read through the drug name on every odd-parity block. F15 also
  // came back on :hover -- --svd-bg-hover-accent (also transparent-mixed)
  // applied straight to td.col-identity, so hovering any row measured 90%
  // transparent (alpha 0.1) even after the rest-state fix.
  await pageSizeSelect(page).selectOption("100");
  const scroller = page.locator(".table-scroll");
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });

  const result = await page.evaluate(() => {
    // The widest merge on the page, whichever drug carries it.
    const merges = [...document.querySelectorAll("td.group-cell[rowspan]")]
      .filter((td) => Number(td.getAttribute("rowspan")) > 1)
      .sort((a, b) =>
        Number(b.getAttribute("rowspan")) - Number(a.getAttribute("rowspan"))
      );
    const mergedCell = merges[0] ?? null;
    const openingRow = mergedCell?.closest("tr") ?? null;
    const continuationFirstCells = [];
    let row = openingRow?.nextElementSibling ?? null;
    for (
      let i = 1;
      mergedCell && i < Number(mergedCell.getAttribute("rowspan")) && row;
      i++
    ) {
      const firstTd = row.querySelector("td")!;
      continuationFirstCells.push({
        className: firstTd.className,
        position: getComputedStyle(firstTd).position,
      });
      row = row.nextElementSibling;
    }

    const pinned = mergedCell ?? document.querySelector("td.col-identity");
    const pinnedStyle = pinned ? getComputedStyle(pinned) : null;
    const oddGroupIdentityCell = document.querySelector(
      "tr.group-odd td.col-identity",
    );

    return {
      merged: mergedCell !== null,
      continuationFirstCells,
      pinnedPosition: pinnedStyle?.position ?? null,
      pinnedBackground: pinnedStyle?.backgroundColor ?? null,
      oddBackground: oddGroupIdentityCell
        ? getComputedStyle(oddGroupIdentityCell).backgroundColor
        : null,
    };
  });

  for (const cell of result.continuationFirstCells) {
    expect(cell.className).not.toContain("col-identity");
    expect(cell.position).not.toBe("sticky");
  }
  expect(result.pinnedPosition).toBe("sticky");
  expect(alphaOf(result.pinnedBackground!)).toBe(1);
  if (result.oddBackground !== null) {
    expect(alphaOf(result.oddBackground)).toBe(1);
  }

  // F15 also came back on :hover, on both parities: --svd-bg-hover-accent
  // (transparent-mixed, like --svd-bg-row-stripe) applied straight to
  // td.col-identity, so hovering any row -- including the plain rest state
  // above, since TrialsView's landing sort already groups every row by drug
  // -- measured 90% transparent (alpha 0.1) even with the rest-state fix in
  // place. Real mouse hover, not a class toggle, so :hover genuinely engages.
  for (const parity of ["odd", "even"]) {
    const cell = page.locator(`tr.group-${parity} td.col-identity`).first();
    if (await cell.count() === 0) continue;
    await cell.hover();
    const background = await cell.evaluate((el) =>
      getComputedStyle(el).backgroundColor
    );
    expect(alphaOf(background)).toBe(1);
  }
});
