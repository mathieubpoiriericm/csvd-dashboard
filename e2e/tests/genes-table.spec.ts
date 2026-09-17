import { expect, test } from "@playwright/test";
import { banner, pageSizeSelect, rows } from "../helpers.ts";

const TOTAL = 79;

test.beforeEach(async ({ page }) => {
  await page.goto("/genes");
});

test("loads one page of the committed gene set", async ({ page }) => {
  await expect(page.getByRole("table", { name: "Putative causal genes" }))
    .toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Putative causal genes pagination" }),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  await expect(banner(page)).toHaveText(
    `Active Filters: None — showing ${TOTAL} of ${TOTAL} rows`,
  );
  await expect(page.locator(".pagination span").first())
    .toHaveText(`Showing 1–10 of ${TOTAL}`);
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

test("renders the grouped two-row header", async ({ page }) => {
  const groupRow = page.locator("thead tr").first();
  await expect(groupRow.locator("th")).toHaveText([
    "Putative Causal Genes",
    "Genetic and Omics Evidence",
    "Expression Context",
    /References/,
    "Extraction Provenance",
  ]);
  for (const [i, span] of [3, 4, 2, 1, 2].entries()) {
    await expect(groupRow.locator("th").nth(i))
      .toHaveAttribute("colspan", String(span));
  }
  await expect(groupRow.locator("th").nth(0)).toHaveAttribute(
    "scope",
    "colgroup",
  );
  // References stands in for a leaf column, so it spans both header rows and
  // is excluded from the leaf row below.
  await expect(groupRow.locator("th").nth(3)).toHaveAttribute("rowspan", "2");
  await expect(groupRow.locator("th").nth(3)).toHaveAttribute("scope", "col");
  await expect(page.locator("thead tr").nth(1).locator("th")).toHaveCount(11);
  await expect(page.locator('thead tr:nth-child(2) th:not([scope="col"])'))
    .toHaveCount(0);
});

/**
 * F18: the CSS-presence contract test (styles_contract_test.ts) pins that
 * `.data-table thead` carries `position: sticky`, but a passing text-level
 * assertion has twice shipped alongside wrong rendered behaviour on this
 * branch (F15's hover regression, Task 11's missing `:focus` rule) -- a
 * class of failure only a real measurement catches. This scrolls the actual
 * `.table-scroll` and reads real `getBoundingClientRect()`s: the thead's top
 * must not move while a body row's does, which is only true if the sticky
 * positioning is actually taking effect and the scrollport is tall enough to
 * scroll at all (both of which the width-vs-height-floor history on this
 * branch could each independently break silently under a CSS-only check).
 */
test("the sticky header stays pinned while the body scrolls, and the two header rows stay adjacent", async ({ page }) => {
  // All 79 rows on one page guarantees .table-scroll has more content than
  // its bounded height, regardless of how tall any individual row's content
  // happens to render.
  await pageSizeSelect(page).selectOption("100");
  await expect(rows(page)).toHaveCount(TOTAL);

  const measure = () =>
    page.evaluate(() => {
      const theadRows = document.querySelectorAll("thead tr");
      return {
        row1Top: theadRows[0].getBoundingClientRect().top,
        row1Bottom: theadRows[0].getBoundingClientRect().bottom,
        row2Top: theadRows[1].getBoundingClientRect().top,
        firstRowTop: document.querySelector("tbody tr")!
          .getBoundingClientRect().top,
      };
    });

  const before = await measure();
  // The two header rows sit adjacent -- row 2 starts exactly where row 1
  // ends -- because sticky lands on <thead> as a whole and the rows keep
  // their normal-flow relationship inside it, not because of any fixed
  // offset between them.
  expect(before.row2Top).toBeCloseTo(before.row1Bottom, 0);

  await page.locator(".table-scroll").evaluate((el) => {
    el.scrollTop = 400;
  });

  const after = await measure();
  expect(Math.abs(after.row1Top - before.row1Top)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.row2Top - before.row2Top)).toBeLessThanOrEqual(1);
  expect(after.row2Top).toBeCloseTo(after.row1Bottom, 0);
  expect(Math.abs(after.firstRowTop - before.firstRowTop))
    .toBeGreaterThan(50);
});

test("every leaf column can be sorted with a keyboard-focusable button", async ({ page }) => {
  const leafHeaders = page.locator("thead tr").nth(1).locator("th");
  await expect(leafHeaders).toHaveCount(11);
  for (let i = 0; i < 11; i++) {
    await expect(leafHeaders.nth(i)).toHaveClass(/sortable/);
    await expect(leafHeaders.nth(i)).toHaveAttribute("aria-sort", "none");
  }

  const references = page.locator("thead tr").first().locator("th").nth(3);
  await expect(references).toHaveClass(/sortable/);
  await expect(references).toHaveAttribute("aria-sort", "none");
  await expect(references.getByRole("button", { name: "References" }))
    .toBeVisible();
});

/*
 * `useInnerText` on the gene cells is load-bearing. Each tooltipped cell holds
 * its `[popover]` panel as a sibling of the trigger, and a closed popover is
 * `display: none` — invisible to the user, to the accessibility tree and to
 * innerText, but still present in textContent, which is what toHaveText reads
 * by default. Asserting on innerText is the one that matches what is rendered.
 */
test("clicking a header cycles the sort and reorders rows", async ({ page }) => {
  const gene = page.getByRole("columnheader", { name: "Gene", exact: true });
  const firstCell = rows(page).first().locator("td").first();

  await expect(gene).toHaveAttribute("aria-sort", "none");

  const sortButton = gene.getByRole("button", { name: "Gene" });
  await sortButton.focus();
  await page.keyboard.press("Enter");
  await expect(gene).toHaveAttribute("aria-sort", "ascending");
  await expect(firstCell).toHaveText("ABCC6", { useInnerText: true });

  await page.keyboard.press("Enter");
  await expect(gene).toHaveAttribute("aria-sort", "descending");
  await expect(firstCell).toHaveText("ZCCHC14", { useInnerText: true });
});

test("the page-size select repaginates", async ({ page }) => {
  await pageSizeSelect(page).selectOption("50");
  await expect(rows(page)).toHaveCount(50);
  await expect(page.locator(".pagination span").first())
    .toHaveText(`Showing 1–50 of ${TOTAL}`);

  await pageSizeSelect(page).selectOption("100");
  await expect(rows(page)).toHaveCount(TOTAL);
  // A single page means no numbered buttons at all.
  await expect(numberedPages(page)).toHaveCount(0);
});

test("pagination walks the pages and tracks the current one", async ({ page }) => {
  const previous = page.getByRole("button", { name: "Previous" });
  const next = page.getByRole("button", { name: "Next" });

  // 79 rows at 10 per page = 8 pages, one more than `pageWindow`'s seven
  // buttons, so page 1 shows 1-7 and the window slides as you walk right.
  await expect(numberedPages(page)).toHaveText([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
  ]);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(currentPage(page)).toHaveText("1");
  // The current page is marked by being the one filled button in the row --
  // the same exception the primary button is -- not by weight alone. The
  // weight assertion this replaced pinned 700, which Barlow Condensed's
  // semibold heading weight changed while the marking stayed intact.
  await expect(currentPage(page)).toHaveAttribute("aria-current", "page");
  const [fill, siblingFill] = await Promise.all([
    currentPage(page).evaluate((el) => getComputedStyle(el).backgroundColor),
    numberedPages(page).nth(1).evaluate((el) =>
      getComputedStyle(el).backgroundColor
    ),
  ]);
  expect(fill).not.toBe(siblingFill);

  await next.click();
  await expect(currentPage(page)).toHaveText("2");
  await expect(page.locator(".pagination span").first())
    .toHaveText(`Showing 11–20 of ${TOTAL}`);
  await expect(previous).toBeEnabled();

  // Page 7 is no longer the last one, so the window slides to reach 8.
  await page.getByRole("button", { name: "Page 7", exact: true }).click();
  await expect(currentPage(page)).toHaveText("7");
  await expect(next).toBeEnabled();

  await page.getByRole("button", { name: "Page 8", exact: true }).click();
  await expect(currentPage(page)).toHaveText("8");
  // The last page holds the remainder: 79 - 70 = 9 rows.
  await expect(rows(page)).toHaveCount(9);
  await expect(page.locator(".pagination span").first())
    .toHaveText(`Showing 71–79 of ${TOTAL}`);
  await expect(next).toBeDisabled();

  await previous.click();
  await expect(currentPage(page)).toHaveText("7");
});

test("search narrows the table and clearing restores it", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search genes" });

  await search.fill("  HTRA1  ");
  await expect(search).toHaveValue("  HTRA1  ");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator("td").first())
    .toHaveText("HTRA1", { useInnerText: true });
  await expect(banner(page)).toHaveText(
    `Active Filters: Search: “HTRA1” — showing 1 of ${TOTAL} rows`,
  );
  await expect(page.locator(".pagination span").first())
    .toHaveText("Showing 1–1 of 1");

  await search.fill("");
  await expect(rows(page)).toHaveCount(10);
});

test("a query matching nothing shows the empty state", async ({ page }) => {
  // A nonsense string, deliberately: every real word tried here (including
  // "CADASIL") turned up somewhere once Source Quote joined the searchable
  // columns -- it names the disease in NOTCH3's real extracted sentence.
  await page.getByRole("searchbox", { name: "Search genes" }).fill(
    "zzznomatch",
  );
  await expect(page.locator(".empty-state"))
    .toContainText("No rows match the current filters.");
  await expect(rows(page)).toHaveCount(1); // the empty-state row itself
  await expect(banner(page)).toContainText(`showing 0 of ${TOTAL} rows`);

  await page.getByRole("button", { name: "Clear all filters" }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("searchbox", { name: "Search genes" }))
    .toHaveValue("");
  // The button that was just clicked unmounts with the empty-state row it
  // lived in; focus has to land somewhere else instead of falling to <body>.
  await expect(page.getByRole("searchbox", { name: "Search genes" }))
    .toBeFocused();
});

/** Numbered page buttons, excluding Previous/Next. */
function numberedPages(page: import("@playwright/test").Page) {
  return page.locator(".pagination-buttons button")
    .filter({ hasNotText: /Previous|Next/ });
}

function currentPage(page: import("@playwright/test").Page) {
  return page.locator('.pagination-buttons button[aria-current="page"]');
}

test("chromosomal location sorts by chromosome number", async ({ page }) => {
  // Under the raw string compare this column used to fall back to, the first
  // page opened at chromosome 10 and chromosome 1 appeared four pages later.
  await page.getByRole("columnheader", { name: "Chromosomal Location" })
    .click();

  const locations = await rows(page).locator("td:nth-child(3)").allInnerTexts();
  // Karyotype order, so X and Y rank after 22 rather than failing to parse.
  // The previous `^\d+` parser returned NaN for "Xq22.1" -- the value the
  // column actually got wrong once GLA arrived.
  const KARYOTYPE = [
    ...Array.from({ length: 22 }, (_, i) => String(i + 1)),
    "X",
    "Y",
  ];
  const chromosomes = locations.map((l) => {
    const token = l.trim().match(/^(\d+|[XY])/i)?.[1];
    return token ? KARYOTYPE.indexOf(token.toUpperCase()) : -1;
  });

  // An unparsed location ranks -1 and would head the column, so check it
  // directly rather than letting it hide inside the ordering assertion.
  expect(chromosomes.filter((n) => n === -1)).toHaveLength(0);
  expect(chromosomes).toEqual([...chromosomes].sort((a, b) => a - b));
  expect(chromosomes[0]).toBe(0);
});
