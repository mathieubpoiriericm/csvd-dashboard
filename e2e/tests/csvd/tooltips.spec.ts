import { expect, type Locator, type Page, test } from "@playwright/test";
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

/**
 * LAMB1's "Morel, H., et al. (2023)" reference, whose panel is too tall for a
 * 320×320 viewport at any width, with the page reloaded at that size. The
 * panel is addressed by id, not by `.is-placed`, so it can be asked about
 * closed.
 */
async function longPanelAt320(page: Page) {
  await page.setViewportSize({ width: 320, height: 320 });
  await page.reload();
  await page.getByRole("searchbox", { name: "Search genes" }).fill("LAMB1");
  await expect(rows(page)).toHaveCount(1);
  const trigger = rows(page).first().locator(".tooltip-box").filter({
    hasText: "Morel",
  });
  const panel = page.locator(
    `[popover][id="${await trigger.getAttribute("popovertarget")}"]`,
  );
  return { trigger, panel };
}

/**
 * Keeps the `source` of the panel's latest `beforetoggle`: its trigger when
 * native activation (a click, a tap, Enter or Space) opened it, null when the
 * hover route's `showPopover()` did.
 */
async function recordOpener(panel: Locator) {
  await panel.evaluate((pop) => {
    pop.addEventListener("beforetoggle", (event) => {
      const { source } = event as Event & { source?: Element | null };
      (pop as HTMLElement & { lastSource?: Element | null }).lastSource =
        source ?? null;
    });
  });
}

async function openedByActivation(panel: Locator, trigger: Locator) {
  return panel.evaluate(
    (pop, button) =>
      (pop as HTMLElement & { lastSource?: Element | null }).lastSource ===
        button,
    await trigger.elementHandle(),
  );
}

function isOpen(panel: Locator) {
  return panel.evaluate((element) => element.matches(":popover-open"));
}

/** The trigger text of every open panel on the page. */
function openPanels(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".tooltip-pop")]
      .filter((pop) => pop.matches(":popover-open"))
      .map((pop) => pop.previousElementSibling?.textContent ?? pop.id)
  );
}

/**
 * Waits out the page's own hover delay: it opens a hovered panel 120ms after
 * the pointer enters its trigger (OPEN_DELAY_MS in components/Tooltip.tsx).
 * Well past it, a panel a hover would have opened is open.
 */
async function pastHoverDelay(page: Page) {
  await page.waitForTimeout(500);
}

/**
 * A point inside the open `panel` (no link there) under which, beneath the
 * panel, lies another tooltip's trigger S, and one pixel to its right too:
 * where the pointer can rest on the panel over S, and then move by a pixel
 * and still be over S once the panel has gone. Null if the panel covers no
 * other trigger.
 */
async function pointOverAnotherTrigger(panel: Locator) {
  return await panel.evaluate((pop) => {
    const beneath = (x: number, y: number) => {
      const [topmost, ...under] = document.elementsFromPoint(x, y);
      if (!topmost || !pop.contains(topmost) || topmost.closest("a")) {
        return null;
      }
      const box = under.find((element) => !pop.contains(element))
        ?.closest(".tooltip-box");
      return box && box.getAttribute("popovertarget") !== pop.id ? box : null;
    };
    const { left, top, right, bottom } = pop.getBoundingClientRect();
    for (let y = Math.ceil(top) + 1; y < bottom - 1; y += 2) {
      for (let x = Math.ceil(left) + 1; x < right - 2; x += 2) {
        const box = beneath(x, y);
        if (box && beneath(x + 1, y) === box) {
          return {
            x,
            y,
            id: box.getAttribute("popovertarget")!,
            name: box.textContent!,
          };
        }
      }
    }
    return null;
  });
}

/** Whether the topmost element at (x, y) lies in `trigger`. */
function topmostIn(trigger: Locator, x: number, y: number) {
  return trigger.evaluate(
    (button, [x, y]) => button.contains(document.elementFromPoint(x, y)),
    [x, y],
  );
}

/** A point in the viewport on no tooltip, to move the pointer away to. */
async function pointOnNoTooltip(page: Page) {
  return await page.evaluate(() => {
    for (let y = 4; y < innerHeight; y += 8) {
      for (let x = 4; x < innerWidth; x += 8) {
        const top = document.elementFromPoint(x, y);
        if (top && !top.closest(".tooltip-box, .tooltip-pop")) return { x, y };
      }
    }
    return null;
  });
}

/**
 * The long panel fitted to 320×320: inside the viewport, and, too tall at
 * any width, its body scaled down with every line inside the panel and
 * nothing scrolled. Returns its size and scale, to compare two routes.
 */
async function expectFitted(panel: Locator) {
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(7);
  expect(box!.x + box!.width).toBeLessThanOrEqual(313);
  expect(box!.y).toBeGreaterThanOrEqual(7);
  expect(box!.y + box!.height).toBeLessThanOrEqual(313);

  const body = await panel.locator(".tooltip-pop-body").evaluate((
    element,
  ) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
    overflowWrap: getComputedStyle(element).overflowWrap,
    zoom: Number(getComputedStyle(element).zoom),
  }));
  expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight);
  expect(body.overflowY).toBe("visible");
  expect(body.overflowWrap).toBe("anywhere");
  expect(body.zoom).toBeLessThan(1);

  const linkBox = await panel.getByRole("link", { name: "View on PubMed" })
    .boundingBox();
  expect(linkBox).not.toBeNull();
  expect(linkBox!.y + linkBox!.height).toBeLessThanOrEqual(
    box!.y + box!.height,
  );
  return { width: box!.width, height: box!.height, zoom: body.zoom };
}

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

  test("a popover taller than the space beside its trigger fits without scrolling", async ({ page }) => {
    // COL4A1/2's panel lists two member genes: taller than a 600px window
    // allows above or below the row, so it used to scroll there. Columns
    // fit it at full size.
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.reload();
    await page.getByRole("searchbox", { name: "Search genes" }).fill("COL4A1");
    // The search is debounced: wait for the narrowed row, or the hover lands
    // on the unsearched first row (STN1) and measures its short panel.
    await expect(rows(page)).toHaveCount(1);
    const trigger = rows(page).first().locator("td").first().locator(
      ".tooltip-box",
    );
    await trigger.hover();
    const panel = tooltip(page);
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(7);
    expect(box!.y + box!.height).toBeLessThanOrEqual(593);
    const body = await panel.locator(".tooltip-pop-body").evaluate((
      element,
    ) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      zoom: Number(getComputedStyle(element).zoom),
    }));
    expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight);
    expect(body.zoom).toBe(1);
  });

  /**
   * Both routes into a long panel at 320×320. Fitted, the panel covers its
   * trigger's centre, where the pointer rests after hovering it, so Escape
   * closes it from under the pointer. That departure is not a fresh hover:
   * the panel stays closed, and Enter opens it by the keyboard route, fitted
   * exactly as the hover route fitted it.
   */
  test("a long popover fits whole inside a 320px viewport, scaled rather than cut off", async ({ page }) => {
    const { trigger, panel } = await longPanelAt320(page);
    const link = panel.getByRole("link", { name: "View on PubMed" });

    await trigger.hover();
    await expect(panel).toHaveClass(/\bis-placed\b/);
    const byHover = await expectFitted(panel);

    // What makes the rest a test: the panel lies over the trigger's centre,
    // where hover() left the pointer.
    const centre = await trigger.evaluate((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      const point = [Math.round(x + width / 2), Math.round(y + height / 2)];
      const top = document.elementFromPoint(point[0], point[1]);
      const name = top
        ? `<${top.tagName.toLowerCase()} class="${top.className}">`
        : "nothing";
      return {
        covered: button.nextElementSibling!.contains(top),
        found: `${name} at ${point.join(",")}`,
      };
    });
    expect(centre.covered, `the trigger's centre: ${centre.found}`).toBe(true);

    // Tab reaches the link in DOM order whichever route opened the panel, so
    // the route is checked by `ToggleEvent.source`.
    await recordOpener(panel);

    // Focus the trigger first: Escape in the search box clears the field
    // instead, and the re-filter replaces the rows under the pointer.
    await trigger.focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen(panel)).toBe(false);
    // Had the panel's departure from under the pointer counted as a hover,
    // it would be open again by now.
    await pastHoverDelay(page);
    expect(await isOpen(panel)).toBe(false);

    await page.keyboard.press("Enter");
    await expect(panel).toHaveClass(/\bis-placed\b/);
    expect(await openedByActivation(panel, trigger)).toBe(true);
    expect(await expectFitted(panel)).toEqual(byHover);

    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();

    // Closed again, it opens on hover once the pointer has left the tooltip
    // and come back.
    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen(panel)).toBe(false);
    await page.getByRole("heading", { level: 1 }).hover();
    await trigger.hover();
    await expect(panel).toHaveClass(/\bis-placed\b/);
  });

  /**
   * Fitted to 320×320, the long panel covers other tooltips' triggers as
   * well as its own. Escape closing it from over another trigger S uncovers
   * S under the resting pointer: the panel left, the pointer did not arrive,
   * so S stays closed. Once the pointer really moves, hover is hover again.
   */
  test("a panel closed from over another trigger does not open that trigger", async ({ page }) => {
    const { trigger, panel } = await longPanelAt320(page);
    await trigger.hover();
    await expect(panel).toHaveClass(/\bis-placed\b/);

    const point = await pointOverAnotherTrigger(panel);
    expect(point, "a point of the long panel over another trigger").not
      .toBeNull();
    const { x, y, id, name } = point!;
    const other = page.locator(`.tooltip-box[popovertarget="${id}"]`);
    const otherPanel = page.locator(`[popover][id="${id}"]`);
    await recordOpener(otherPanel);

    // From the trigger's centre, which the panel covers, to the point: the
    // pointer stays on the panel all the way.
    await page.mouse.move(x, y, { steps: 5 });
    // Focus the trigger first: Escape in the search box clears the field
    // instead, and the re-filter replaces the rows under the pointer.
    await trigger.focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen(panel)).toBe(false);
    await pastHoverDelay(page);
    expect(await isOpen(otherPanel), `${name}, uncovered at ${x},${y}`).toBe(
      false,
    );

    // A move by one pixel, still over S, which nothing covers now: a hover.
    expect(await topmostIn(other, x + 1, y), `${name} at ${x + 1},${y}`)
      .toBe(true);
    await page.mouse.move(x + 1, y);
    await expect.poll(() => isOpen(otherPanel)).toBe(true);
    expect(await openedByActivation(otherPanel, other)).toBe(false);

    // Closed at the point, then the pointer leaves and comes back to that
    // very pixel: a hover, since it moved in between.
    await page.mouse.move(x, y);
    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen(otherPanel)).toBe(false);
    const away = await pointOnNoTooltip(page);
    expect(away, "a point on no tooltip").not.toBeNull();
    await page.mouse.move(away!.x, away!.y);
    await page.mouse.move(x, y);
    await expect.poll(() => isOpen(otherPanel)).toBe(true);
    expect(await openedByActivation(otherPanel, other)).toBe(false);

    // Dismissed again at the same point, it opens by the keyboard route.
    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen(otherPanel)).toBe(false);
    await other.focus();
    await page.keyboard.press("Enter");
    await expect(otherPanel).toHaveClass(/\bis-placed\b/);
    expect(await openedByActivation(otherPanel, other)).toBe(true);
  });

  /**
   * The same rest, with focus left in the search box as after typing. There
   * Chromium and Firefox used to give Escape to the field: it was cleared,
   * and the re-filter took the panel's row with it, while the panel itself
   * was never dismissed (WCAG 1.4.13). On every engine Escape now closes the
   * panel the pointer opened and nothing else: the search keeps its text,
   * and the trigger the panel uncovered stays closed until the pointer
   * moves.
   */
  test("Escape in the search box closes a hover panel and keeps the search", async ({ page }) => {
    const { trigger, panel } = await longPanelAt320(page);
    const search = page.getByRole("searchbox", { name: "Search genes" });
    await trigger.hover();
    await expect(panel).toHaveClass(/\bis-placed\b/);
    const point = await pointOverAnotherTrigger(panel);
    expect(point, "a point of the long panel over another trigger").not
      .toBeNull();
    const { x, y } = point!;
    await page.mouse.move(x, y, { steps: 5 });
    await expect(search).toBeFocused();

    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen(panel)).toBe(false);
    expect(await panel.evaluate((element) => element.isConnected)).toBe(true);
    await expect(search).toHaveValue("LAMB1");
    await expect(rows(page)).toHaveCount(1);
    await expect(search).toBeFocused();
    await pastHoverDelay(page);
    expect(await openPanels(page), `uncovered at ${x},${y}`).toEqual([]);
  });

  /**
   * The Escape the panel took was one only: the next reaches the field,
   * uncancelled, and does there what the engine does. Chromium and Firefox
   * clear a search field on Escape; WebKit leaves it alone, panel or no
   * panel (measured on a bare `<input type="search">`).
   */
  test("a second Escape clears the search", async ({ page, browserName }) => {
    const { trigger, panel } = await longPanelAt320(page);
    const search = page.getByRole("searchbox", { name: "Search genes" });
    await search.evaluate((field) => {
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        const log = field as HTMLElement & { escapes?: boolean[] };
        (log.escapes ??= []).push(event.defaultPrevented);
      });
    });
    await trigger.hover();
    await expect(panel).toHaveClass(/\bis-placed\b/);
    await expect(search).toBeFocused();

    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen(panel)).toBe(false);
    await expect(search).toHaveValue("LAMB1");
    await page.keyboard.press("Escape");
    // The first never reached the field; the second did, not cancelled.
    expect(
      await search.evaluate((field) =>
        (field as HTMLElement & { escapes?: boolean[] }).escapes
      ),
    ).toEqual([false]);
    await expect(search).toHaveValue(browserName === "webkit" ? "LAMB1" : "");
  });

  // A panel the keyboard opened is the browser's to close: Escape returns
  // focus to its trigger and the search is not touched.
  test("Escape leaves a keyboard-opened panel to the browser", async ({ page }) => {
    const { trigger, panel } = await longPanelAt320(page);
    const search = page.getByRole("searchbox", { name: "Search genes" });
    await recordOpener(panel);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveClass(/\bis-placed\b/);
    expect(await openedByActivation(panel, trigger)).toBe(true);

    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen(panel)).toBe(false);
    await expect(trigger).toBeFocused();
    await expect(search).toHaveValue("LAMB1");
  });

  /**
   * The same rest, and the search cleared without moving the pointer or the
   * page, as Escape in the field used to do. The re-filter keeps no row of the old
   * page, so it removes every row, the panel's with it and with no
   * `beforetoggle` at all, before it draws the new ones: for a moment no
   * tooltip is left on the page. The departure's record must outlive that,
   * or the controller goes with it. The trigger drawn under the resting
   * pointer stays closed, and the pointer's first move over it opens it, by
   * hover.
   */
  test("a panel removed by a re-filter does not open the trigger it uncovers", async ({ page }) => {
    const { trigger, panel } = await longPanelAt320(page);
    const search = page.getByRole("searchbox", { name: "Search genes" });
    await trigger.hover();
    await expect(panel).toHaveClass(/\bis-placed\b/);
    const point = await pointOverAnotherTrigger(panel);
    expect(point, "a point of the long panel over another trigger").not
      .toBeNull();
    const { x, y } = point!;
    const pop = (await panel.elementHandle())!;

    await page.mouse.move(x, y, { steps: 5 });
    // In place: `fill()` scrolls the field into view, and select-all and
    // Backspace scroll the page to the caret, either of which moves the
    // page under the resting pointer. Escape cleared it without either.
    await search.evaluate((field: HTMLInputElement) => {
      field.value = "";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect.poll(() => pop.evaluate((element) => element.isConnected))
      .toBe(false);

    // The trigger now under the pointer, beneath any panel open over it.
    const id = await page.evaluate(
      ([x, y]) =>
        document.elementsFromPoint(x, y)
          .find((element) => !element.closest(".tooltip-pop"))
          ?.closest(".tooltip-box")?.getAttribute("popovertarget"),
      [x, y],
    );
    expect(id, `a trigger under ${x},${y} once the panel left`)
      .toBeTruthy();
    const uncovered = page.locator(`.tooltip-box[popovertarget="${id}"]`);
    const uncoveredPanel = page.locator(`[popover][id="${id}"]`);
    await recordOpener(uncoveredPanel);

    await pastHoverDelay(page);
    expect(await openPanels(page), `uncovered at ${x},${y}`).toEqual([]);

    // A move by one pixel, still over it: a hover.
    expect(await topmostIn(uncovered, x + 1, y), `${x + 1},${y}`).toBe(true);
    await page.mouse.move(x + 1, y);
    await expect.poll(() => isOpen(uncoveredPanel)).toBe(true);
    expect(await openedByActivation(uncoveredPanel, uncovered)).toBe(false);
  });

  // A click opens the panel by native activation, as Enter does, and it is
  // fitted once shown.
  test("a click fits a long popover inside a 320px viewport", async ({ page }) => {
    const { trigger, panel } = await longPanelAt320(page);
    await recordOpener(panel);
    await trigger.click();
    await expect(panel).toHaveClass(/\bis-placed\b/);
    expect(await openedByActivation(panel, trigger)).toBe(true);
    await expectFitted(panel);
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true });

    // On a phone a tap is the only way in, and it too is native activation.
    test("a tap fits a long popover inside a 320px viewport", async ({ page }) => {
      const { trigger, panel } = await longPanelAt320(page);
      await recordOpener(panel);
      await trigger.tap();
      await expect(panel).toHaveClass(/\bis-placed\b/);
      expect(await openedByActivation(panel, trigger)).toBe(true);
      await expectFitted(panel);
    });

    // A guard. Where a panel closed is a question for hover alone: a tap
    // there on the trigger the panel uncovered opens it, by activation. On
    // touch no record is ever taken (every tap ends with a `pointerout` out
    // of the document, which clears the tooltip the pointer is in), so this
    // pins that a tap never meets one.
    test("a tap where a panel closed opens the uncovered trigger", async ({ page }) => {
      const { trigger, panel } = await longPanelAt320(page);
      await trigger.tap();
      await expect(panel).toHaveClass(/\bis-placed\b/);

      const point = await pointOverAnotherTrigger(panel);
      expect(point, "a point of the long panel over another trigger").not
        .toBeNull();
      const { x, y, id, name } = point!;
      const other = page.locator(`.tooltip-box[popovertarget="${id}"]`);
      const otherPanel = page.locator(`[popover][id="${id}"]`);
      await recordOpener(otherPanel);

      // Touched there on the panel, which then closes.
      await page.touchscreen.tap(x, y);
      await trigger.focus();
      await page.keyboard.press("Escape");
      await expect.poll(() => isOpen(panel)).toBe(false);
      expect(await topmostIn(other, x, y), `${name} at ${x},${y}`).toBe(true);

      // At that exact point: an offset from the trigger's box, as
      // Locator.tap() takes, can land a fraction of a pixel off it.
      await page.touchscreen.tap(x, y);
      await expect(otherPanel).toHaveClass(/\bis-placed\b/);
      expect(await openedByActivation(otherPanel, other)).toBe(true);
    });
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

// LOX's protein reads "LYOX", not its gene symbol, and it has a UniProt
// lookup record, which is what this needs. The search is debounced, so the
// hover waits for the narrowed row: under gold-only every first-page row has
// a protein trigger, and hovering the unsearched first row would open a
// tooltip the re-render then removes.
test("hovering the protein shows its UniProt record", async ({ page }) => {
  await page.goto("/genes");
  await page.getByRole("searchbox", { name: "Search genes" }).fill("LOX");
  await expect(rows(page)).toHaveCount(1);
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
    // Wait for the debounced search, so the re-render cannot remove the panel.
    await expect(rows(page)).toHaveCount(1);
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
  // References is the 10th column (Source Quote and Confidence follow it
  // unless gold-only leaves them out), so it is addressed by position rather
  // than .last().
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
 * COL4A1/2 is the curators' label for the collagen IV pair, which no NCBI or
 * UniProt record carries; sent literally, both lookups came back empty and
 * neither cell had a tooltip. The refresh now asks for each gene, and both
 * tooltips show both, each with its own link. The rule that a key with no
 * record renders unwrapped is pinned on synthetic rows in tooltips_test.ts.
 */
test("COL4A1/2's gene and protein tooltips show both collagen genes", async ({ page }) => {
  await page.goto("/genes");
  await page.getByRole("searchbox", { name: "Search genes" }).fill("COL4A1/2");
  // The search is debounced: wait for it to narrow the table to one row, or
  // the hover lands on the unsearched third row's trigger and the re-filter
  // then moves COL4A1/2 out from under the pointer. Only COL4A1/2 matches in
  // the committed data; the row is still picked out by its gene cell.
  await expect(rows(page)).toHaveCount(1);
  const row = rows(page).filter({
    has: page.locator("td").first().getByText("COL4A1/2", { exact: true }),
  });
  await expect(row).toHaveCount(1);

  await row.locator("td").nth(0).locator(".tooltip-box").hover();
  await expect(
    tooltip(page).getByRole("link", { name: "View COL4A1 on NCBI Gene" }),
  ).toHaveAttribute("href", "https://www.ncbi.nlm.nih.gov/gene/1282");
  await expect(
    tooltip(page).getByRole("link", { name: "View COL4A2 on NCBI Gene" }),
  ).toHaveAttribute("href", "https://www.ncbi.nlm.nih.gov/gene/1284");

  await page.getByRole("heading", { level: 1 }).hover();
  await row.locator("td").nth(1).locator(".tooltip-box").hover();
  await expect(tooltip(page)).toContainText("P02462");
  await expect(tooltip(page)).toContainText("P08572");
  await expect(
    tooltip(page).getByRole("link", { name: "View COL4A1 on UniProt" }),
  ).toHaveAttribute("href", /uniprot\.org.*P02462/);
  await expect(
    tooltip(page).getByRole("link", { name: "View COL4A2 on UniProt" }),
  ).toHaveAttribute("href", /uniprot\.org.*P08572/);
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
 * paginates now, so each is searched for rather than counted on page one,
 * and over every status (the run default hides PLG's one trial, Tranexamic
 * acid, ACTRN12624001477516, which has no ClinicalTrials.gov record). PDE3A
 * and APP are labelled in the gold table ("GWAS for ischemic stroke: PDE3A",
 * "monogenic disease: APP"); the tooltip holds the symbol alone. */
test("single-symbol genetic targets get tooltips", async ({ page }) => {
  await page.goto("/trials");
  await page.getByRole("group", { name: /^Study status/ }).getByRole(
    "checkbox",
    { name: /^Show All/ },
  ).check();
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

// The gold table names THN391's target as FGA alone, so the soluble
// guanylate cyclase subunits of the isosorbide mononitrate rows stand in for
// the fibrinogen chains.
test("every symbol in a multi-gene target gets its own tooltip", async ({ page }) => {
  await page.goto("/trials");
  await page.getByRole("searchbox", { name: "Search trials" }).fill(
    "GUCY1B1, GUCY1B2, GUCY1A2, GUCY1A1",
  );

  const targets = rows(page).first().locator(".tooltip-box").filter({
    hasText: /^GUCY1[AB][12]$/,
  });
  await expect(targets).toHaveText([
    "GUCY1B1",
    "GUCY1B2",
    "GUCY1A2",
    "GUCY1A1",
  ]);

  await targets.nth(1).hover();
  await expect(tooltip(page)).toContainText(
    "guanylate cyclase 1 soluble subunit beta 2",
  );
});
