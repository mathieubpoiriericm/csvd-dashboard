import { expect, test } from "@playwright/test";
import { banner, pageSizeSelect, rows } from "../helpers.ts";

const TOTAL = 102;
/** Default-visible rows: every status but Completed (35 of 102 hidden). */
const SHOWN = 67;

/**
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
  await expect(rows(page)).toHaveCount(10);
  await expect(banner(page)).toHaveText(
    `Active Filters: Study status: Recruiting, Enrolling by Invitation, Active (not recruiting), Not Yet Recruiting, Suspended, Unknown — showing ${SHOWN} of ${TOTAL} rows`,
  );
  await expect(page.locator(".pagination span").first())
    .toHaveText(`Showing 1–10 of ${SHOWN}`);
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
  // 67 default-visible rows at 10 per page is seven pages -- pageWindow()'s
  // seven-button cap and the actual page count coincide, so all seven show.
  await expect(pageSizeSelect(page)).toHaveValue("10");
  await expect(page.locator(".pagination-buttons button")).toHaveText([
    "Previous",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "Next",
  ]);
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("a larger page size removes pages", async ({ page }) => {
  // Three pages at 25 per page (67 default-visible rows), so pageWindow()
  // lists all three.
  await pageSizeSelect(page).selectOption("25");
  await expect(rows(page)).toHaveCount(25);
  await expect(page.locator(".pagination-buttons button")).toHaveText(
    ["Previous", "1", "2", "3", "Next"],
  );
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("opens sorted ascending by drug", async ({ page }) => {
  await expect(page.getByRole("columnheader", { name: "Drug", exact: true }))
    .toHaveAttribute("aria-sort", "ascending");
  // Acetylcysteine's only trial is Completed and hidden by default, so the
  // first default-visible drug alphabetically is Acetylsalicyclic acid.
  await expect(rows(page).first().locator("td").first())
    .toHaveText("Acetylsalicyclic acid");
});

test("merges rows within each drug", async ({ page }) => {
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

test("sorting by another column ungroups the rows", async ({ page }) => {
  await expect(page.locator("td.group-cell").first()).toBeVisible();

  await page.getByRole("columnheader", { name: "Registry ID", exact: true })
    .click();
  await expect(
    page.getByRole("columnheader", { name: "Registry ID", exact: true }),
  )
    .toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("td.group-cell")).toHaveCount(0);
  await expect(page.locator("td[rowspan]")).toHaveCount(0);
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
  // All 67 default-visible rows on one page guarantees .table-scroll has
  // more content than its bounded height.
  await pageSizeSelect(page).selectOption("100");
  await expect(rows(page)).toHaveCount(SHOWN);

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

test("search narrows the trials table", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search trials" });

  // The global filter spans every column and runs over the default-visible
  // (non-Completed) set, so "CADASIL" catches three of the five trials that
  // name it in their title and population details -- Palm tocotrienols
  // complex and Adrenomedullin are both Completed and hidden by default.
  await search.fill("CADASIL");
  await expect(banner(page)).toHaveText(
    `Active Filters: Study status: Recruiting, Enrolling by Invitation, Active (not recruiting), Not Yet Recruiting, Suspended, Unknown | Search: “CADASIL” — showing 3 of ${TOTAL} rows`,
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

test("a query matching nothing shows the empty state", async ({ page }) => {
  await page.getByRole("searchbox", { name: "Search trials" }).fill("HTRA1");
  await expect(page.locator(".empty-state"))
    .toContainText("No rows match the current filters.");
});

test("target sample size sorts numerically, not as text", async ({ page }) => {
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
  // The one trial with no stated enrolment (Donepezil) is Completed and so
  // hidden by the default status filter -- every default-visible row here
  // reads a real number, with no "(unknown)" sentinel to sort ahead of them.
  const numbers = sizes.map((size) => Number(size.trim()));

  expect(numbers).not.toContain(NaN);
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  expect(numbers[0]).toBe(15);
});

test("estimated completion dates sort chronologically", async ({ page }) => {
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
  expect(ascending.length).toBeGreaterThan(1);
  expect(ascending).toEqual([...ascending].sort((a, b) => a - b));

  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  const descending = asMonths(
    await rows(page).locator("td:nth-child(12)").allInnerTexts(),
  );
  expect(descending.length).toBeGreaterThan(1);
  expect(descending).toEqual([...descending].sort((a, b) => b - a));
});

test("global search matches the formatted completion date, not the raw M/YYYY value", async ({ page }) => {
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
  expect(formatted).toMatch(/^[A-Za-z]{3} \d{4}$/);

  const search = page.getByRole("searchbox", { name: "Search trials" });
  await search.fill(formatted);
  await expect(rows(page).locator("td:nth-child(12)").first())
    .toHaveText(formatted, { useInnerText: true });
  expect(await rows(page).count()).toBeGreaterThanOrEqual(1);
});

test("the sticky treatment stays on Drug through a merged block, and stays opaque scrolled right", async ({ page }) => {
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
  const scroller = page.locator(".table-scroll");
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });

  const result = await page.evaluate(() => {
    // Atorvastatin is the widest merge on page 1 (rowspan 3) under the
    // default ascending-by-drug sort now that Completed trials are hidden by
    // default, per the "merges rows within each drug" test above.
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

    const oddGroupIdentityCell = document.querySelector(
      "tr.group-odd td.col-identity",
    );
    if (!oddGroupIdentityCell) {
      throw new Error("no group-odd row with a pinned identity cell found");
    }

    return {
      continuationFirstCells,
      pinnedPosition: pinnedStyle.position,
      pinnedBackground: pinnedStyle.backgroundColor,
      oddBackground: getComputedStyle(oddGroupIdentityCell).backgroundColor,
    };
  });

  for (const cell of result.continuationFirstCells) {
    expect(cell.className).not.toContain("col-identity");
    expect(cell.position).not.toBe("sticky");
  }
  expect(result.pinnedPosition).toBe("sticky");
  expect(alphaOf(result.pinnedBackground)).toBe(1);
  expect(alphaOf(result.oddBackground)).toBe(1);

  // F15 also came back on :hover, on both parities: --svd-bg-hover-accent
  // (transparent-mixed, like --svd-bg-row-stripe) applied straight to
  // td.col-identity, so hovering any row -- including the plain rest state
  // above, since TrialsView's landing sort already groups every row by drug
  // -- measured 90% transparent (alpha 0.1) even with the rest-state fix in
  // place. Real mouse hover, not a class toggle, so :hover genuinely engages.
  const oddIdentityCell = page.locator("tr.group-odd td.col-identity").first();
  const evenIdentityCell = page.locator("tr.group-even td.col-identity")
    .first();

  await oddIdentityCell.hover();
  const oddHoverBackground = await oddIdentityCell.evaluate((el) =>
    getComputedStyle(el).backgroundColor
  );
  expect(alphaOf(oddHoverBackground)).toBe(1);

  await evenIdentityCell.hover();
  const evenHoverBackground = await evenIdentityCell.evaluate((el) =>
    getComputedStyle(el).backgroundColor
  );
  expect(alphaOf(evenHoverBackground)).toBe(1);
});
