import { expect, test } from "@playwright/test";
import { filterGroup } from "../helpers.ts";
import { POPULATION_LABEL } from "../fixtures/expected-data.ts";

/**
 * The filter panel folds to a rail so the table gets the freed column.
 *
 * Both data pages render the same `FilterPanel`, so both are driven here with
 * one of their own legends as the thing that has to disappear and come back.
 * The toggle is one button in one place either side of the press -- the rail
 * stays in the grid rather than unmounting -- so the assertions on focus and
 * on the accessible name are what pin that, and the width comparison is what
 * pins the point of the whole feature: the table actually gets wider.
 */
const PAGES = [
  { path: "/genes", group: "Mendelian randomization performed" },
  { path: "/trials", group: POPULATION_LABEL },
];

const HIDE = "Hide filters";
const SHOW = "Show filters";

for (const { path, group } of PAGES) {
  test(`the filter panel collapses and restores on ${path}`, async ({ page }) => {
    await page.goto(path);

    const toggle = page.getByRole("button", { name: HIDE });
    const main = page.locator(".layout-main");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(filterGroup(page, group)).toBeVisible();

    const expanded = (await main.boundingBox())!.width;

    await toggle.click();

    const collapsed = page.getByRole("button", { name: SHOW });
    await expect(collapsed).toHaveAttribute("aria-expanded", "false");
    await expect(filterGroup(page, group)).toBeHidden();
    // The table is what the space is for.
    expect((await main.boundingBox())!.width).toBeGreaterThan(expanded);
    // One button, so the press cannot lose the keyboard.
    await expect(collapsed).toBeFocused();

    await collapsed.click();

    await expect(page.getByRole("button", { name: HIDE })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(filterGroup(page, group)).toBeVisible();
    expect((await main.boundingBox())!.width).toBe(expanded);
  });

  test(`the table stays usable while the filters are folded away on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.getByRole("button", { name: HIDE }).click();

    // The banner keeps reporting the filter state, which is what makes hiding
    // the controls safe: an active filter can never become invisible.
    await expect(page.locator(".filter-message")).toContainText(
      "Active Filters:",
    );
    await expect(page.locator("table.data-table tbody tr").first())
      .toBeVisible();
  });

  test(`mobile filters are page content rather than a clipped scrollport on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(path);

    const section = page.locator(".sidebar-section");
    const layout = await section.evaluate((panel) => {
      const style = getComputedStyle(panel);
      return {
        position: style.position,
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        clientHeight: panel.clientHeight,
        scrollHeight: panel.scrollHeight,
        // The frame's registration marks are an ::after at a negative inset,
        // so every framed panel's scrollHeight runs this far past its
        // clientHeight. That is decoration outside the box, not content
        // hidden inside it.
        markOut: parseFloat(style.getPropertyValue("--svd-mark-out")) || 0,
      };
    });
    // Un-stuck, which is what makes the panel page content rather than a
    // clipped scrollport. `relative`, not `static`: with no offsets the two
    // lay out identically, but the panel's frame draws its registration
    // marks from an absolutely positioned ::after, and `static` would hand
    // them to the initial containing block instead of the panel.
    expect(layout.position).toBe("relative");
    expect(layout.maxHeight).toBe("none");
    expect(layout.overflowY).toBe("visible");
    // No content is clipped: everything past the panel's own height is the
    // frame's corner marks, which sit outside the box by design.
    expect(layout.scrollHeight - layout.clientHeight)
      .toBeLessThanOrEqual(layout.markOut);

    // The source rule reads `top: auto`, but CSSOM resolves a positioned
    // element's offset to its *used* value, and a relative box with no
    // explicit top/bottom resolves that to 0 -- so the computed style reports
    // "0px", not the literal keyword.
    await expect(section).toHaveCSS("top", "0px");
    // The panel starts where its grid slot starts: no leftover sticky offset.
    const [panelTop, slotTop] = await Promise.all([
      section.evaluate((el) => el.getBoundingClientRect().top),
      section.evaluate((el) => el.parentElement!.getBoundingClientRect().top),
    ]);
    expect(Math.abs(panelTop - slotTop)).toBeLessThanOrEqual(1);
  });
}

test("the collapsed rail persists across a navigation between the two data pages", async ({ page }) => {
  await page.goto("/genes");
  await page.getByRole("button", { name: HIDE }).click();
  await expect(page.locator(".layout-sidebar")).toHaveClass(/is-collapsed/);

  await page.goto("/trials");
  await expect(page.locator(".layout-sidebar")).toHaveClass(/is-collapsed/);

  // Restore, so a later test in this file (or a rerun) starts expanded.
  await page.getByRole("button", { name: SHOW }).click();
  await expect(page.locator(".layout-sidebar")).not.toHaveClass(
    /is-collapsed/,
  );
});
