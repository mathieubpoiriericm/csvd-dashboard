import { expect, test } from "@playwright/test";

/**
 * Two displayed cSVD cell values the global search must find: an omics
 * study with its tissue in parentheses, and a confidence score. The generic
 * search test in ../audit-regressions.spec.ts uses a derived gene symbol; a
 * fork deletes the whole e2e/tests/csvd/ tree.
 */
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
