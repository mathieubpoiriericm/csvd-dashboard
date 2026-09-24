import { expect, test } from "@playwright/test";
import { rows, tooltip } from "../../helpers.ts";

/**
 * Tooltips are native `[popover]` panels rendered next to their trigger and
 * promoted to the top layer, so `.table-scroll`'s overflow never clips them —
 * but they are still page-level as far as selectors go, since dozens sit in the
 * DOM at once and only the open one carries `.is-placed`. There is a 120ms open
 * delay, which the web-first assertions absorb.
 *
 * The trigger is a `<button popovertarget>`. That is load-bearing rather than
 * cosmetic: activating it establishes the popover's invoker relationship, which
 * is what puts the panel in the keyboard focus order. Showing a popover
 * imperatively — the hover path — does not, so hover and keyboard deliberately
 * open it by different routes.
 *
 * `Tooltip` renders its children bare when the content builder returns null,
 * so the *absence* of `.tooltip-box` is a meaningful assertion in its own
 * right, and the sharpest test of the lookup maps.
 */

test.describe("gene tooltips", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/genes");
    await page.getByRole("searchbox", { name: "Search genes" }).fill("LAMB1");
    await expect(rows(page)).toHaveCount(1);
  });

  test("hovering a gene shows its NCBI record", async ({ page }) => {
    const trigger = rows(page).first().locator("td").first().locator(
      ".tooltip-box",
    );
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.hover();

    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toContainText("UID");
    await expect(tooltip(page)).toContainText("3912");
    await expect(tooltip(page)).toContainText("laminin subunit beta 1");
    await expect(tooltip(page).getByRole("link", { name: "View on NCBI Gene" }))
      .toHaveAttribute("href", "https://www.ncbi.nlm.nih.gov/gene/3912");
    // The trigger's invoker relationship reports the panel's open state to
    // assistive tech, not just to sighted pointer users.
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Moving away closes it — Escape is not used here because focus is still
    // in the search box from beforeEach, and Escape's native effect there is
    // to clear the field, not dismiss the popover.
    await page.getByRole("heading", { level: 1 }).hover();
    await expect(tooltip(page)).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * The panel sits *inside* its cell, so it inherits whatever the cell sets.
   * The gene column is the sticky first column, which carries `font-weight:
   * 600` — enough to render every value in the panel as bold, since only the
   * labels are meant to stand out. The panel has to state its own body weight.
   *
   * The label's weight is asserted as *heavier than the row*, not as a
   * literal. It was 700 under IBM Plex and is 600 under Barlow Condensed,
   * whose semibold is the design system's heading weight — a change that
   * kept this invariant exactly while failing an equality check on it. What
   * must not drift is the label out-weighing the value beside it.
   */
  test("only the labels in the panel are bold", async ({ page }) => {
    await rows(page).first().locator("td").first().locator(".tooltip-box")
      .hover();
    await expect(tooltip(page)).toBeVisible();

    const row = tooltip(page).locator(".tooltip-row").first();
    await expect(row).toHaveCSS("font-weight", "400");

    const labelWeight = await row.locator("strong").evaluate((el) =>
      Number(getComputedStyle(el).fontWeight)
    );
    const rowWeight = await row.evaluate((el) =>
      Number(getComputedStyle(el).fontWeight)
    );
    expect(labelWeight).toBeGreaterThan(rowWeight);
  });

  test("the keyboard can open the tooltip, reach its link and dismiss it", async ({ page }) => {
    const trigger = rows(page).first().locator("td").first().locator(
      ".tooltip-box",
    );
    await trigger.focus();
    await page.keyboard.press("Enter");

    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toContainText("3912");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // The whole point of the popover: one Tab from the trigger lands on the
    // link, because activation put the panel in the focus order. Under the old
    // Tippy setup the panel was appended to <body> and this Tab reached the
    // next cell instead, leaving the link unreachable without a pointer.
    await page.keyboard.press("Tab");
    await expect(tooltip(page).getByRole("link", { name: "View on NCBI Gene" }))
      .toBeFocused();

    // Escape closes and hands focus back to the trigger — both native.
    await page.keyboard.press("Escape");
    await expect(tooltip(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("a long popover fits and scrolls inside a 320px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 320 });
    await page.reload();
    await page.getByRole("searchbox", { name: "Search genes" }).fill("LAMB1");
    await expect(rows(page)).toHaveCount(1);

    const trigger = rows(page).first().locator(".tooltip-box").filter({
      hasText: "Morel",
    });
    await trigger.hover();
    const panel = tooltip(page);
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(7);
    expect(box!.x + box!.width).toBeLessThanOrEqual(313);
    expect(box!.y).toBeGreaterThanOrEqual(7);
    expect(box!.y + box!.height).toBeLessThanOrEqual(313);

    const scrollport = panel.locator(".tooltip-pop-scroll");
    const dimensions = await scrollport.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      overflowWrap: getComputedStyle(element).overflowWrap,
    }));
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    expect(dimensions.overflowY).toBe("auto");
    expect(dimensions.overflowWrap).toBe("anywhere");

    await page.keyboard.press("Escape");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(
      panel.getByRole("link", { name: "View on PubMed" }),
    ).toBeFocused();
    expect(await scrollport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  });

  test("a rapid close cannot be undone by stale positioning", async ({ page }) => {
    const trigger = rows(page).first().locator("td").first().locator(
      ".tooltip-box",
    );
    const panelId = await trigger.getAttribute("popovertarget");
    const panel = page.locator(`[popover][id="${panelId}"]`);

    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    await expect(panel).not.toHaveClass(/\bis-placed\b/);
    expect(await panel.evaluate((element) => element.matches(":popover-open")))
      .toBe(false);
  });

  test("the tooltip stays open while the pointer moves onto its link", async ({ page }) => {
    await rows(page).first().locator("td").first().locator(".tooltip-box")
      .hover();
    await expect(tooltip(page)).toBeVisible();

    // The panel's own mouseenter cancels the pending close, which is what
    // lets the pointer cross the gap without the panel closing.
    const link = tooltip(page).getByRole("link", { name: "View on NCBI Gene" });
    await link.hover();
    await expect(link).toBeVisible();
  });

  test("clicking a tooltip that already opened on hover keeps it open", async ({ page }) => {
    const trigger = rows(page).first().locator("td").first().locator(
      ".tooltip-box",
    );
    await trigger.hover();
    await expect(tooltip(page)).toBeVisible();

    await trigger.click();
    await expect(tooltip(page)).toBeVisible();
  });

  test("moving away closes the tooltip", async ({ page }) => {
    await rows(page).first().locator("td").first().locator(".tooltip-box")
      .hover();
    await expect(tooltip(page)).toBeVisible();

    await page.getByRole("heading", { level: 1 }).hover();
    await expect(tooltip(page)).toHaveCount(0);
  });

  test("moving the pointer away preserves the focused tooltip link", async ({ page }) => {
    const trigger = rows(page).first().locator("td").first().locator(
      ".tooltip-box",
    );
    await trigger.hover();
    await expect(tooltip(page)).toBeVisible();
    await trigger.click();
    await page.keyboard.press("Tab");
    const link = tooltip(page).getByRole("link", { name: "View on NCBI Gene" });
    await expect(link).toBeFocused();
    await page.getByRole("heading", { level: 1 }).hover();
    // Wait beyond the pointer close delay to detect lost keyboard focus.
    await page.waitForTimeout(250);
    await expect(link).toBeVisible();
    await expect(link).toBeFocused();
  });

  test("tabbing out dismisses a keyboard-opened tooltip", async ({ page }) => {
    const trigger = rows(page).first().locator("td").first().locator(
      ".tooltip-box",
    );
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(tooltip(page)).toBeVisible();
    await page.keyboard.press("Tab");
    const link = tooltip(page).getByRole("link", { name: "View on NCBI Gene" });
    await expect(link).toBeFocused();
    // A queued native toggle may be delivered after the close timer starts.
    // Force that order so this does not depend on the CI runner's speed.
    await link.evaluate((element) => {
      element.addEventListener("focusout", () => {
        element.closest(".tooltip-pop")!.dispatchEvent(
          new ToggleEvent("toggle", { oldState: "closed", newState: "open" }),
        );
      }, { once: true });
    });
    await page.keyboard.press("Tab");
    await expect(tooltip(page)).toHaveCount(0);
  });
});

// LAMB1's curated Protein column is "(unknown)" -- the export sentinel -- so
// its cell renders an em dash with no tooltip trigger at all (see
// components/Absent.tsx). LOX carries a real value ("LYOX") and still has a
// UniProt lookup record, which is what this needs.
test("hovering the protein shows its UniProt record", async ({ page }) => {
  await page.goto("/genes");
  await page.getByRole("searchbox", { name: "Search genes" }).fill("LOX");
  await rows(page).first().locator("td").nth(1).locator(".tooltip-box")
    .hover();

  await expect(tooltip(page)).toContainText("UniProt Accession Number");
  await expect(tooltip(page)).toContainText("P28300");
  await expect(tooltip(page).getByRole("link", { name: "View on UniProt" }))
    .toHaveAttribute("href", /uniprot\.org.*P28300/);
});

test.describe("dark-theme tooltip", () => {
  test.use({ colorScheme: "dark" });

  test("the arrow matches the panel background", async ({ page }) => {
    await page.goto("/genes");
    await page.getByRole("searchbox", { name: "Search genes" }).fill("LAMB1");
    await rows(page).first().locator("td").first().locator(".tooltip-box")
      .hover();

    const panel = tooltip(page);
    await expect(panel).toBeVisible();
    const background = await panel.evaluate((element) =>
      getComputedStyle(element).backgroundColor
    );
    await expect(panel.locator(".tooltip-arrow"))
      .toHaveCSS("background-color", background);
  });
});

test("an OMIM number links to its monogenic disease entry", async ({ page }) => {
  await page.goto("/genes");
  await page.getByRole("searchbox", { name: "Search genes" }).fill("LOX");
  const omim = rows(page).first().locator("td").nth(6).locator(".tooltip-box")
    .filter({ hasText: "617168" });
  await omim.hover();

  await expect(tooltip(page)).toContainText("Inheritance");
  await expect(tooltip(page)).toContainText("AD");
  await expect(tooltip(page)).toContainText("Gene or Locus");
  await expect(tooltip(page).getByRole("link", { name: "View on OMIM" }))
    .toBeVisible();
});

/**
 * `refs.json` stores each citation as an HTML fragment, and tooltip rows render
 * as text nodes — so an unparsed fragment shows its tags literally rather than
 * failing loudly. Assert the citation itself, not just that a tooltip opened.
 */
test("a PMID shows its citation and links to PubMed", async ({ page }) => {
  await page.goto("/genes");
  await page.getByRole("searchbox", { name: "Search genes" }).fill("LAMB1");

  // The cell itself is the short citation now; the panel is the whole record.
  // References is the 10th of 12 columns (Source Quote, Confidence follow
  // it), so it is addressed by position rather than .last().
  const cell = rows(page).first().locator("td").nth(9);
  await expect(cell).toContainText("Morel, H., et al. (2023)");

  await cell.locator(".tooltip-box").first().hover();

  await expect(tooltip(page)).toContainText(
    "Morel H, Bailly L, Urbanczyk C, et al.",
  );
  await expect(tooltip(page)).toContainText("Neurology. Genetics");
  await expect(tooltip(page)).toContainText("2023");
  await expect(tooltip(page)).toContainText("10.1212/NXG.0000000000200069");
  await expect(tooltip(page)).not.toContainText("<b>");
  await expect(tooltip(page)).not.toContainText("<br>");

  await expect(tooltip(page).getByRole("link", { name: "View on PubMed" }))
    .toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/37063705");
});

/**
 * COL4A1/2 is the only gene whose NCBI lookup row is empty in every field and
 * whose UniProt row has no accession, so neither tooltip has anything to show
 * and both cells render unwrapped. The gene cell is the half that used to open
 * onto three "Not available" lines and no link.
 */
test("a gene with no lookup record renders without a tooltip", async ({ page }) => {
  await page.goto("/genes");
  await page.getByRole("searchbox", { name: "Search genes" }).fill("COL4A1/2");
  // The global filter also matches HTRA1, whose source quote names COL4A1/2,
  // so pick the row out by its gene cell rather than assuming a single hit.
  const row = rows(page).filter({
    has: page.locator("td").first().getByText("COL4A1/2", { exact: true }),
  });
  await expect(row).toHaveCount(1);

  for (const column of [0, 1]) {
    await expect(
      row.locator("td").nth(column).locator(".tooltip-box"),
    ).toHaveCount(0);
    await expect(row.locator("td").nth(column)).not.toBeEmpty();
  }
});

test("registry IDs on the trials table carry a registry tooltip", async ({ page }) => {
  await page.goto("/trials");
  await page.getByRole("searchbox", { name: "Search trials" }).fill(
    "NCT05755997",
  );
  await expect(rows(page)).toHaveCount(1);

  await rows(page).first().locator(".tooltip-box").filter({
    hasText: "NCT05755997",
  }).hover();
  await expect(tooltip(page)).toContainText("Registry");
  await expect(tooltip(page)).toContainText("ClinicalTrials.gov");
  await expect(
    tooltip(page).getByRole("link", { name: "View on ClinicalTrials.gov" }),
  )
    .toHaveAttribute("href", "https://clinicaltrials.gov/study/NCT05755997");
});

/** The four single-symbol genetic targets in the curated rows. The table
 * paginates now, so each is searched for rather than counted on page one. */
test("single-symbol genetic targets get tooltips", async ({ page }) => {
  await page.goto("/trials");
  const search = page.getByRole("searchbox", { name: "Search trials" });

  for (const symbol of ["PDE3A", "APP", "GLP1R", "PLG"]) {
    await search.fill(symbol);
    await expect(
      page.locator("table.data-table tbody .tooltip-box")
        .filter({ hasText: new RegExp(`^${symbol}$`) })
        .first(),
    ).toBeVisible();
  }
});

test("every symbol in a multi-gene target gets its own tooltip", async ({ page }) => {
  await page.goto("/trials");
  await page.getByRole("searchbox", { name: "Search trials" }).fill(
    "FGA, FGB, FGG",
  );

  const targets = rows(page).first().locator(".tooltip-box").filter({
    hasText: /^(FGA|FGB|FGG)$/,
  });
  await expect(targets).toHaveText(["FGA", "FGB", "FGG"]);

  await targets.nth(1).hover();
  await expect(tooltip(page)).toContainText("fibrinogen beta chain");
});
