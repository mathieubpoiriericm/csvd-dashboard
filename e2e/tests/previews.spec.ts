import { expect, type Page, test } from "@playwright/test";
import { EXPECTED, PREVIEWS, REVIEW } from "../fixtures/expected-data.ts";
import { dismissGreeting } from "../helpers.ts";

/**
 * The previews hub and the strip that moves between its features, end to end.
 *
 * Which features exist is read from `PREVIEWS` (`EXPECTED.previews`), derived
 * under Deno from the committed data: the adaptation guide always, the
 * pipeline run only under gold-only with a run recorded, the review only with
 * a round. So the spec pins no number of cards, and on the empty export it
 * walks the guide alone.
 */

/** The navbar's previews entry. */
const entry = (page: Page) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("link", {
    name: EXPECTED.previewsLabel,
    exact: true,
  });

/** The strip on a feature page. */
const strip = (page: Page) =>
  page.getByRole("navigation", { name: "Feature previews" });

const FIRST_ROW =
  ".preview-switcher-row:not(.preview-switcher-sub) .preview-switcher-link";

/** The strip's first row: back to the hub, then every feature. */
const firstRow = (page: Page) => strip(page).locator(FIRST_ROW);

/** The first row's link for the feature the page belongs to. */
const currentFeature = (page: Page) =>
  strip(page).locator(`${FIRST_ROW}.is-current`);

/** The strip's second row, inside the current feature. */
const subRow = (page: Page) =>
  strip(page).locator(".preview-switcher-sub .preview-switcher-link");

const pipeline = PREVIEWS.find((p) => p.key === "pipeline");

/** The run report's chunk and the widget's. */
const REPORT = /protected-data-pipeline_run|fresh-island__PipelineRun/;

test("the hub lists the features that exist, in order", async ({ page }) => {
  const response = await page.goto("/previews");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    EXPECTED.previewsLabel,
  );
  // The card's own heading: the review card's request dialog has one too.
  await expect(page.locator(".preview-card h2.card-title")).toHaveText(
    PREVIEWS.map((p) => p.title),
  );
  await expect(entry(page)).toHaveAttribute("aria-current", "page");
  // The hub is where the strip leads back to, so it draws none.
  await expect(page.locator(".preview-switcher")).toHaveCount(0);
});

for (const feature of PREVIEWS) {
  test(`the ${feature.key} card opens its page, and the strip leads back`, async ({ page }) => {
    await page.goto("/previews");
    await page.locator(
      `.preview-card:has(#preview-card-${feature.key}) a.review-action-primary`,
    ).click();
    await expect(page).toHaveURL(feature.href);

    // The page sits behind the previews entry, and nothing else is current.
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(entry(page)).toHaveAttribute("aria-current", "page");

    await expect(firstRow(page)).toHaveText([
      "All previews",
      ...PREVIEWS.map((p) => p.name),
    ]);
    await expect(currentFeature(page)).toHaveText([feature.name]);
    // Every strip link states its own aria-current, never a boolean's absence.
    for (const link of await strip(page).locator("a").all()) {
      await expect(link).toHaveAttribute("aria-current", /^(page|true|false)$/);
    }

    // The guide greets a first visit with a modal window that makes the
    // page inert; the strip is reachable once it is answered.
    if (feature.key === "adapt") await dismissGreeting(page);
    await strip(page).getByRole("link", { name: "All previews" }).click();
    await expect(page).toHaveURL("/previews");
  });
}

test("the strip moves between features", async ({ page }) => {
  test.skip(PREVIEWS.length < 2, "only one feature is on offer");
  const [from, to] = PREVIEWS;
  await page.goto(from.href);
  if (from.key === "adapt") await dismissGreeting(page);
  await strip(page).getByRole("link", { name: to.name, exact: true }).click();
  await expect(page).toHaveURL(to.href);
  await expect(currentFeature(page)).toHaveText([to.name]);
});

test("the review's second row reaches the progress page and comes back", async ({ page }) => {
  test.skip(REVIEW === null, "no review round under this data");
  await page.goto("/review");
  const queue = subRow(page).filter({ hasText: "Review queue" });
  const progress = subRow(page).filter({ hasText: "Committee progress" });
  await expect(queue).toHaveAttribute("aria-current", "page");

  await progress.click();
  await expect(page).toHaveURL("/review/progress");
  await expect(progress).toHaveAttribute("aria-current", "page");
  await expect(queue).toHaveAttribute("aria-current", "false");

  await queue.click();
  await expect(page).toHaveURL("/review");

  // A gene page is inside the review but is neither of the two.
  await page.locator("table.review-queue tbody tr").first().getByRole("link")
    .first().click();
  await expect(page).toHaveURL(/\/review\/gene\?g=/);
  await expect(subRow(page)).toHaveCount(2);
  for (const link of await subRow(page).all()) {
    await expect(link).not.toHaveAttribute("aria-current", "page");
  }
});

test("the run's page draws the widget as a preview", async ({ page }) => {
  test.skip(!pipeline, "no pipeline run is offered as a preview");
  await page.goto(pipeline!.href);
  await page.waitForSelector('.pipeline-card[data-hydrated="true"]');
  await expect(page.locator(".pipeline-preview-mark")).toHaveText(
    "Technical preview",
  );
  await expect(page.locator(".preview-note")).toContainText(
    EXPECTED.previewNote,
  );

  const dialog = page.getByRole("dialog", { name: "Run details" });
  await page.getByRole("button", { name: "Run details" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the run's page is a 404 when the run is not offered", async ({ page }) => {
  test.skip(!!pipeline, "a pipeline run is offered as a preview");
  const response = await page.goto("/previews/pipeline");
  expect(response?.status()).toBe(404);
});

test("only the run's own page fetches the run report", async ({ page, context }) => {
  test.skip(
    !(EXPECTED.goldOnly && EXPECTED.hasPipelineRun),
    "the run is a preview only under gold-only with a run recorded",
  );
  const fetched: string[] = [];
  page.on("request", (request) => {
    fetched.push(new URL(request.url()).pathname);
  });

  // The cookie the About page's old switch wrote: nothing reads it now, so
  // a visitor who still carries it gets the plain About page, and the server
  // neither renews it nor draws the widget.
  await context.addCookies([{
    name: "pipeline_preview",
    value: "1",
    url: test.info().project.use.baseURL!,
  }]);
  const about = await page.goto("/");
  expect(await about?.headerValue("set-cookie")).toBeNull();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".pipeline-card")).toHaveCount(0);

  await page.goto("/previews");
  await page.waitForLoadState("networkidle");
  expect(fetched.filter((path) => REPORT.test(path))).toEqual([]);

  await page.goto("/previews/pipeline");
  await page.waitForSelector('.pipeline-card[data-hydrated="true"]');
  expect(fetched.some((path) => REPORT.test(path))).toBe(true);
});

test("nothing scrolls sideways on a 320px phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const paths = [
    "/previews",
    ...PREVIEWS.map((p) => p.href),
    ...(REVIEW === null ? [] : ["/review/progress"]),
  ];
  for (const path of paths) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollWidth - de.clientWidth;
    });
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test.describe("signed out of the dashboard", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the hub is behind the gate", async ({ page }) => {
    await page.goto("/previews");
    await expect(page).toHaveURL("/login?next=%2Fpreviews");
  });
});
