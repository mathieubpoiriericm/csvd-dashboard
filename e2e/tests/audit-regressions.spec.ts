import { expect, type Page, test } from "@playwright/test";
import { EXPECTED, GENE_TOTAL } from "../fixtures/expected-data.ts";
import { blockTiles, pageSizeSelect, wholePage } from "../helpers.ts";

test("gene search finds a displayed gene symbol", async ({ page }) => {
  test.skip(GENE_TOTAL === 0, "no committed genes to search");
  const query = EXPECTED.firstGeneAsc!;
  await page.goto("/genes");
  await expect(page.locator(".table-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.getByRole("searchbox").fill(query);
  await expect(page.locator(".filter-active")).toContainText(query);
  await expect(page.locator(".empty-state")).toHaveCount(0);
  await expect(page.locator("tbody .col-gene").first()).toContainText(query);
});

test("confidence sorts numerically with missing scores last in both directions", async ({ page }) => {
  test.skip(GENE_TOTAL === 0, "no committed genes to sort");
  await page.goto("/genes");
  await pageSizeSelect(page).selectOption("100");
  await wholePage(page);
  const header = page.getByRole("columnheader", { name: "Confidence" });
  for (let i = 0; i < 2; i++) {
    await header.getByRole("button").click();
    const direction = await header.getAttribute("aria-sort");
    const values = await page.locator("tbody .col-confidence").allInnerTexts();
    const scores = values.filter((value) => value !== "—").map(Number);
    expect(values.slice(scores.length).every((value) => value === "—")).toBe(
      true,
    );
    expect(scores).toEqual(
      [...scores].sort((a, b) => direction === "ascending" ? a - b : b - a),
    );
  }
});

test("changing table page returns its scrollport to the first row", async ({ page }) => {
  test.skip(GENE_TOTAL <= 25, "a second page needs more than 25 rows");
  await page.goto("/genes");
  await pageSizeSelect(page).selectOption("25");
  const scroller = page.locator(".table-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = 1000;
  });
  expect(await scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".pagination [role=status]")).toContainText(
    "26–50",
  );
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(0);
});

test("map load failure exposes a readable facility list", async ({ page }) => {
  await blockTiles(page);
  await page.route(/\/leaflet-src-[^/]+\.js$/, (route) => route.abort());
  await page.goto("/map");
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  const heading = page.getByRole("heading", {
    name: "Trial facility locations",
  });
  await expect(heading).toBeVisible();
  const box = await heading.boundingBox();
  expect(box!.width).toBeGreaterThan(100);
  await expect(heading.locator("..")).not.toHaveClass(/visually-hidden/);
});

/** The `col-<id>` class each sortable leaf header shares with its cells. */
function sortableColumns(page: Page): Promise<string[]> {
  return page.locator("thead th.sortable").evaluateAll((headers) =>
    headers
      .map((th) => [...th.classList].find((name) => name.startsWith("col-")))
      .filter((name): name is string => name !== undefined)
  );
}

for (const path of ["/genes", "/trials"]) {
  test(`absent values sort after recorded ones on every ${path} column`, async ({ page }) => {
    // The sentinels are parenthesised, and "(" sorts before every letter: a
    // first click on most headers opened on a page of nothing but dashes.
    await page.goto(path);
    await expect(page.locator(".table-controls")).toHaveAttribute(
      "data-hydrated",
      "true",
    );
    test.skip(
      await page.locator("tbody tr").count() <= 1,
      "no committed rows to sort",
    );
    await pageSizeSelect(page).selectOption("100");
    await wholePage(page);
    for (const column of await sortableColumns(page)) {
      const header = page.locator(`thead th.sortable.${column}`);
      for (let click = 0; click < 2; click++) {
        await header.getByRole("button").click();
        const direction = await header.getAttribute("aria-sort");
        const absent = await page.locator(`tbody td.${column}`).evaluateAll(
          (cells) =>
            cells.map((cell) =>
              cell.querySelector(".cell-absent") !== null &&
              (cell.textContent ?? "").replace("not recorded", "")
                  .replace("—", "").trim() === ""
            ),
        );
        const first = absent.indexOf(true);
        expect(
          first === -1 || absent.slice(first).every(Boolean),
          `${path} ${column} ${direction}`,
        ).toBe(true);
      }
    }
  });
}

test("a search finds a study status as the table prints it", async ({ page }) => {
  // The status column was searched by its stored code (NOT_YET_RECRUITING),
  // so "Not Yet Recruiting" found nothing though rows said exactly that.
  await page.goto("/trials");
  await expect(page.locator(".table-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  const statuses = page.locator("tbody td.col-overallStatus");
  const label = (await statuses.allInnerTexts())
    .map((text) => text.trim())
    .find((text) => text.includes(" ") && !text.includes("not recorded"));
  test.skip(label === undefined, "no multi-word status on the first page");
  await page.getByRole("searchbox", { name: "Search trials" }).fill(label!);
  // The search's own entry: the status filter's summary already names the
  // label, so waiting on the label alone passed before the search applied.
  await expect(page.locator(".filter-active")).toContainText(
    `Search: “${label}”`,
  );
  await expect(page.locator(".empty-state")).toHaveCount(0);
  await expect(statuses.filter({ hasText: label! }).first()).toBeVisible();
});

test("a search does not match a sentinel the cells print as a dash", async ({ page }) => {
  test.skip(GENE_TOTAL === 0, "no committed genes to search");
  await page.goto("/genes");
  await expect(page.locator(".table-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.getByRole("searchbox", { name: "Search genes" }).fill(
    "(none found)",
  );
  await expect(page.locator(".filter-active")).toContainText(
    "Search: “(none found)”",
  );
  // Every row left says it in so many words, or none is left.
  for (const text of await page.locator("tbody tr").allInnerTexts()) {
    if (text.includes("No rows match")) continue;
    expect(text).toContain("(none found)");
  }
});
