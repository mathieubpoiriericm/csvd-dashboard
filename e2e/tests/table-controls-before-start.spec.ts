import { expect, type Page, test } from "@playwright/test";
import {
  EXPECTED,
  GENE_TOTAL,
  TRIAL_SHOWN,
} from "../fixtures/expected-data.ts";
import { banner, pageSizeSelect, rows } from "../helpers.ts";

/**
 * A search typed, or a page size chosen, in the server's HTML before the
 * table's island has started. The visitor's change must survive the start
 * and reach the table: the box keeps the text and the rows are filtered by
 * it, the select keeps its size and the page shows that many rows.
 *
 * Fresh starts an island with Preact's `render` laid over the server's
 * elements, not with `hydrate`, and `render` writes each controlled `value`
 * as it goes. Both changes used to be overwritten that way, unseen: the box
 * emptied and the select went back to 10, and on a slow device, or a loaded
 * test machine, a search typed straight after the page loaded was lost.
 *
 * Each test holds the island's chunk until the change has landed, so the
 * change always comes first, and checks that it did.
 */

const TABLES = [
  {
    path: "/genes",
    island: "GenesView",
    search: "Search genes",
    query: EXPECTED.firstGeneAsc,
    shown: GENE_TOTAL,
  },
  {
    path: "/trials",
    island: "TrialsView",
    search: "Search trials",
    query: EXPECTED.search.trials,
    shown: TRIAL_SHOWN,
  },
] as const;

/** Holds the island's chunk until `start` releases it. */
async function holdIsland(page: Page, island: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let requests = 0;
  await page.route(
    new RegExp(`/fresh-island__${island}-[^/]+\\.js$`),
    async (route) => {
      requests++;
      await held;
      await route.continue();
    },
  );
  /** Lets the island start, once the change is known to have come first. */
  return async function start() {
    const controls = page.locator(".table-controls");
    // The case under test: no island yet when the change landed.
    await expect(controls).not.toHaveAttribute("data-hydrated", "true");
    release();
    await expect(controls).toHaveAttribute("data-hydrated", "true");
    expect(requests, "the island's chunk was held").toBeGreaterThan(0);
  };
}

for (const { path, island, search, query, shown } of TABLES) {
  test(`${path}: a search typed before the table starts is kept and applied`, async ({ page }) => {
    test.skip(query === null, "no committed row to search for");
    const start = await holdIsland(page, island);
    await page.goto(path, { waitUntil: "commit" });
    const box = page.getByRole("searchbox", { name: search });
    await box.fill(query!);
    await start();

    await expect(box).toHaveValue(query!);
    await expect(banner(page).locator(".filter-active")).toContainText(
      `Search: “${query}”`,
    );
    await expect(rows(page).first()).toContainText(query!);
    const kept = Number(
      /showing (\d+) of/.exec((await banner(page).textContent()) ?? "")?.[1],
    );
    expect(kept, "rows the search kept").toBeGreaterThan(0);
    expect(kept, "rows the search kept").toBeLessThan(shown);
  });

  test(`${path}: a page size chosen before the table starts is kept and applied`, async ({ page }) => {
    test.skip(shown <= 10, "no more than one page of 10 rows to show");
    const start = await holdIsland(page, island);
    await page.goto(path, { waitUntil: "commit" });
    await pageSizeSelect(page).selectOption("25");
    await start();

    await expect(pageSizeSelect(page)).toHaveValue("25");
    await expect(rows(page)).toHaveCount(Math.min(25, shown));
  });
}
