import { expect, type Page, test } from "@playwright/test";

/**
 * The radar over the committed cSVD trials, by drug, registry id and
 * population: Cilostazol's halo, BAC's flagged record, Cerebrolysin's
 * tooltip and drawer, the "Any SVD (including monogenic)" wedge. The
 * figure's behaviour is tested over derived counts in ../timeline.spec.ts; a
 * fork deletes the whole e2e/tests/csvd/ tree.
 */

const FIGURE = "svg.timeline-figure";

async function figureSettled(page: Page) {
  await page.goto("/timeline");
  await expect(page.locator(FIGURE)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("labels are boxless halos and the evidence ring lifts with its marker", async ({ page }) => {
  await figureSettled(page);
  const figure = page.locator(FIGURE);
  // The fit rect stays for measurement; nothing paints it.
  const fills = await figure.locator("rect.label-bg").evaluateAll((
    rects,
  ) => [...new Set(rects.map((rect) => rect.getAttribute("fill")))]);
  expect(fills).toEqual(["none"]);

  // Cilostazol reaches this cell on more than one trial now; any of them
  // carries the same evidence ring.
  const trial = figure.locator(
    'g.drug[data-drug="Cilostazol"][data-pop="Stroke"][data-phase="II"]',
  ).first();
  const ring = trial.locator("circle.evidence");
  await expect(ring).toHaveCount(1);
  const radius = (locator: typeof ring) =>
    locator.evaluate((node) => getComputedStyle(node).r);
  await trial.locator("circle.marker").hover();
  await expect.poll(() => radius(trial.locator("circle.marker"))).toBe("12px");
  await expect.poll(() => radius(ring)).toBe("16px");
});
test("a flagged marker is hollow, and says so in its tooltip and name", async ({ page }) => {
  await figureSettled(page);
  // NCT02886494 (BAC) is COMPLETED, hidden by the default status filter.
  await page.getByRole("group", { name: /^Study status/ }).getByRole(
    "checkbox",
    { name: /^Show All/ },
  ).check();
  const figure = page.locator(FIGURE);
  // NCT02886494, flagged for an uncharacterised mechanism. The row that
  // carried two reasons at once was NCT02467413, which is WITHDRAWN and no
  // longer published; tests/timeline_layout_test.ts pins the multi-reason
  // case on a constructed record instead, so the drawer still has to list.
  const flagged = figure.locator(
    'g.drug[data-drug="BAC"][data-pop="Cognitive Impairment"]',
  ).first();
  const gap = flagged.locator("circle.gap");
  await expect(gap).toHaveCount(1);
  // Not assessed genetically, so no ring competes with the hollow centre.
  await expect(flagged.locator("circle.evidence")).toHaveCount(0);
  await expect(flagged).toHaveAttribute(
    "aria-label",
    /Incomplete record$/,
  );

  // The hole scales with the marker it is cut from.
  const radius = (locator: typeof gap) =>
    locator.evaluate((node) => getComputedStyle(node).r);
  await flagged.locator("circle.marker").hover();
  await expect.poll(() => radius(flagged.locator("circle.marker"))).toBe(
    "12px",
  );
  await expect.poll(() => radius(gap)).toBe("4.8px");

  // The flag leads the tooltip, because it qualifies every field under it.
  const rows = page.locator(".timeline-tooltip .timeline-tooltip-row");
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText(
    "Mechanism of action not characterised",
  );
});
test("trial details are keyboard accessible", async ({ page }) => {
  await figureSettled(page);
  const trial = page.getByRole("button", {
    name: "Cerebrolysin, Phase II, Any SVD (including monogenic)",
  });
  await trial.focus();
  await page.keyboard.press("Enter");
  const drawer = page.locator("#timeline-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText(
    "Cerebrolysin",
  );
  await expect(page.getByRole("button", { name: "Close trial details" }))
    .toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await trial.focus();
  await page.keyboard.press(" ");
  await expect(drawer).toBeVisible();
});

test("hovering a trial shows its tooltip, and its children keep it open", async ({ page }) => {
  await figureSettled(page);
  const trial = page.locator(
    'g.drug[data-drug="Cerebrolysin"][data-pop="SVD"][data-phase="II"]',
  );
  await trial.locator("circle.marker").hover();
  const tooltip = page.locator(".timeline-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("aria-hidden", "true");
  await expect(tooltip).toContainText("Cerebrolysin");
  await expect(tooltip).toContainText("NCT05755997");

  // Five icon-labelled rows, not the drawer's eleven, and no field names: the
  // glyph carries the label, and the drawer is where the words live.
  // The drawer's header, repeated: swatch, title, population-and-phase pill.
  await expect(tooltip.locator(".timeline-tooltip-swatch")).toHaveCount(1);
  await expect(tooltip.locator(".timeline-tooltip-tag")).toHaveText(
    "Any SVD (including monogenic) · Phase II",
  );

  const rows = tooltip.locator(".timeline-tooltip-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.locator("svg.icon")).toHaveCount(5);
  await expect(tooltip).not.toContainText("Mechanism of Action");
  await expect(tooltip.locator(".tooltip-row")).toHaveCount(0);

  await trial.locator("text").hover();
  await expect(tooltip).toBeVisible();

  await page.mouse.move(5, 5);
  await expect(tooltip).toHaveCount(0);
});

test("activating a hovered trial replaces its tooltip with the details drawer", async ({ page }) => {
  await figureSettled(page);
  const trial = page.locator(
    'g.drug[data-drug="Cerebrolysin"][data-pop="SVD"][data-phase="II"]',
  );
  await trial.locator("circle.marker").hover();
  await expect(page.locator(".timeline-tooltip")).toContainText("Cerebrolysin");

  await trial.click();
  await expect(page.locator("#timeline-drawer")).toBeVisible();

  // The drug's own tooltip is what activation replaces, and that is what is
  // asserted here rather than "no tooltip at all". The drawer opens above the
  // plate, so the figure shifts down under a pointer that has not moved, and
  // whatever the pointer now sits over legitimately opens its own tooltip --
  // a population wedge under macOS metrics, empty plate under Linux's, where
  // there is then no panel at all. Both satisfy the claim, so it is written as
  // a count of panels naming this drug: `not.toContainText` on the bare
  // `.timeline-tooltip` fails with "element(s) not found" in the second case,
  // and an empty count asserted outright fails in the first.
  await expect(
    page.locator(".timeline-tooltip", { hasText: "Cerebrolysin" }),
  ).toHaveCount(0);

  // With the pointer off the figure entirely, nothing is hovered and the
  // count does go to zero -- which is the other half of the claim.
  await page.mouse.move(5, 5);
  await expect(page.locator(".timeline-tooltip")).toHaveCount(0);
  await expect(page.locator("#timeline-drawer")).toBeVisible();
});

test("the timeline tooltip stays inside a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await figureSettled(page);
  await page.locator(
    'g.drug[data-drug="Cerebrolysin"][data-pop="SVD"][data-phase="II"] circle.marker',
  ).hover();

  const panel = page.locator(".timeline-tooltip");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(9);
  expect(box!.x + box!.width).toBeLessThanOrEqual(311);
});

test("entering a wedge names its population and phase", async ({ page }) => {
  await figureSettled(page);
  // Dispatched rather than hovered: the wedges lie under their own markers and
  // labels, so any fixed pointer position inside one is a bet on where the
  // separation pass left the labels. The drug test above covers real hover.
  await page.locator('path.wedge[data-pop="SVD"][data-phase="II"]')
    .dispatchEvent("pointerenter", { clientX: 300, clientY: 250 });
  const tooltip = page.locator(".timeline-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(".timeline-tooltip-title")).toHaveText(
    "Any SVD (including monogenic)",
  );
  await expect(tooltip).toContainText("Phase II");
  // No swatch or pill: neither belongs to a wedge.
  await expect(tooltip.locator(".timeline-tooltip-swatch")).toHaveCount(0);
  await expect(tooltip.locator(".timeline-tooltip-tag")).toHaveCount(0);
});
test("hover content is dismissible with Escape without moving the pointer", async ({ page }) => {
  await figureSettled(page);
  await page.locator('g.drug[data-drug="Cerebrolysin"] circle.marker').first()
    .hover();
  await expect(page.locator(".timeline-tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".timeline-tooltip")).toHaveCount(0);
});

test("a timeline tooltip stays still and open while the pointer reads it", async ({ page }) => {
  await figureSettled(page);
  await page.locator('g.drug[data-drug="Cerebrolysin"] circle.marker').first()
    .hover();
  const panel = page.locator(".timeline-tooltip");
  await expect(panel).toBeVisible();
  await panel.hover();
  const before = await panel.boundingBox();
  // Longer than the trigger's close delay: entering the panel cancels it.
  await page.waitForTimeout(300);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Cerebrolysin");
  expect(await panel.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("long timeline hover content scrolls within a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 240 });
  await figureSettled(page);
  await page.locator('g.drug[data-drug="Cerebrolysin"] circle.marker').first()
    .hover();
  const panel = page.locator(".timeline-tooltip");
  await expect(panel).toBeVisible();
  await panel.hover();
  const metrics = await panel.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(metrics.height).toBeLessThanOrEqual(220);
  expect(metrics.scroll).toBeGreaterThan(metrics.client);
  await panel.evaluate((element) => element.scrollTop = element.scrollHeight);
  await page.waitForTimeout(300);
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
});
