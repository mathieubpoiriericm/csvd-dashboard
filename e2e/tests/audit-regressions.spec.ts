import { expect, test } from "@playwright/test";
import { blockTiles, pageSizeSelect } from "../helpers.ts";

for (const query of ["TWAS (cross tissue)", "0.70"]) {
  test(`gene search finds displayed values: ${query}`, async ({ page }) => {
    await page.goto("/genes");
    await expect(page.locator(".table-controls")).toHaveAttribute(
      "data-hydrated",
      "true",
    );
    await page.getByRole("searchbox").fill(query);
    await expect(page.locator(".filter-active")).toContainText(query);
    await expect(page.locator(".empty-state")).toHaveCount(0);
    const column = query.startsWith("TWAS")
      ? "evidenceFromOtherOmicsStudies"
      : "confidence";
    await expect(page.locator(`tbody .col-${column}`).first()).toContainText(
      query,
    );
  });
}

test("confidence sorts numerically with missing scores last in both directions", async ({ page }) => {
  await page.goto("/genes");
  await pageSizeSelect(page).selectOption("100");
  const header = page.getByRole("columnheader", { name: "Confidence" });
  for (let i = 0; i < 2; i++) {
    await header.getByRole("button").click();
    const direction = await header.getAttribute("aria-sort");
    const values = await page.locator("tbody .col-confidence").allInnerTexts();
    const scores = values.filter((value) => value !== "—").map(Number);
    expect(scores.length).toBeGreaterThan(0);
    expect(values.slice(scores.length).every((value) => value === "—")).toBe(
      true,
    );
    expect(scores).toEqual(
      [...scores].sort((a, b) => direction === "ascending" ? a - b : b - a),
    );
  }
});

test("changing table page returns its scrollport to the first row", async ({ page }) => {
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
