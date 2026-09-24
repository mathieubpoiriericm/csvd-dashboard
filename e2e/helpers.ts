import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Selector helpers for a UI with no test ids.
 *
 * The app ships zero `data-testid` attributes and zero ids on Fresh-rendered
 * elements, so everything here is built on ARIA roles plus scoped CSS classes.
 * One quirk is worth knowing, and is the reason this file exists:
 *
 *   Checkbox accessible names are not unique. "Show All" appears 4x on
 *      /trials and 2x on /genes, so every checkbox lookup must be scoped to
 *      its group first.
 */

/**
 * Matches an accessible name that starts with `text` and then either ends or
 * continues with a comma — the shape a visually-hidden suffix takes (a
 * group's active-count readout, a GWAS trait's long-name description). A bare
 * `exact: false` would do substring matching anywhere in the name, which is
 * unsafe here: "WMH" would also match "PVWMH". Anchoring at the start avoids
 * that while still tolerating the hidden suffix.
 *
 * The browser's accessible-name computation inserts a space at every element
 * boundary, so a visible label followed by a nested `<span>` suffix reads as
 * "SVS , Small vessel stroke", not "SVS, ..." — hence the `\s*` before the
 * comma.
 */
function startsWithName(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(\\s*,|$)`);
}

/** A sidebar filter group, addressed by its visible legend text. */
export function filterGroup(page: Page, label: string): Locator {
  return page.getByRole("group", { name: startsWithName(label) });
}

/** A checkbox inside one filter group. */
export function choice(page: Page, group: string, label: string): Locator {
  return filterGroup(page, group).getByRole("checkbox", {
    name: startsWithName(label),
  });
}

/** The group's count badge: "All" when unconstrained, else the active count. */
export function filterCount(page: Page, group: string): Locator {
  return filterGroup(page, group).locator(".filter-count");
}

/** The "Active Filters: ... — showing N of M rows" line. */
export function banner(page: Page): Locator {
  // `.filter-message` carries `role="status"` too, but the pagination summary
  // beside the table now does as well (both are announced regions), so a bare
  // getByRole("status") is no longer unique.
  //
  // Scoping by class instead of role means this locator no longer proves
  // `.filter-message` still carries role="status" -- that's pinned instead by
  // the explicit toHaveAttribute("role", "status") assertions in the first
  // tests of genes-table.spec.ts and trials-table.spec.ts.
  return page.locator(".filter-message");
}

/** Body rows of the single data table on the page. */
export function rows(page: Page): Locator {
  return page.locator("table.data-table tbody tr");
}

/** The "Show N entries" select. There is exactly one per page. */
export function pageSizeSelect(page: Page): Locator {
  return page.locator(".table-control select");
}

/**
 * The currently visible tooltip panel.
 *
 * Every tooltipped cell renders its own `[popover]` panel, all of them closed
 * and `display: none`, so a bare `.tooltip-pop` would match dozens of elements
 * and never reach 0. `.is-placed` is added by Tooltip.tsx only once Floating UI
 * has positioned an open panel, and removed when it closes — so it is the
 * "shown" flag, and the direct replacement for Tippy's `[data-state=visible]`.
 */
export function tooltip(page: Page): Locator {
  return page.locator(".tooltip-pop.is-placed");
}

/**
 * Asserts the filter banner reports `count` matching rows, and that the table
 * agrees. Row count and banner are driven by the same state but rendered
 * separately, so checking both catches a desync.
 */
export async function expectRowCount(page: Page, count: number, total: number) {
  await expect(banner(page)).toContainText(`showing ${count} of ${total} rows`);
  if (count === 0) {
    await expect(page.locator(".empty-state")).toContainText(
      "No rows match the current filters.",
    );
  } else {
    // The table paginates, so visible rows are capped by the page size.
    const pageSize = Number(await pageSizeSelect(page).inputValue());
    await expect(rows(page)).toHaveCount(Math.min(count, pageSize));
  }
}

/** Asserts the banner's active-filter fragment, or "None". */
export async function expectSummary(page: Page, summary: string) {
  const target = summary === "None" ? ".filter-none" : ".filter-active";
  await expect(banner(page).locator(target)).toHaveText(summary);
}

/**
 * Flips the theme once and waits for `data-theme` to settle on either value.
 *
 * This is what a test wants when its assertion is that *something changed*
 * across a theme flip. It is deliberately not `switchToDarkTheme` below: a
 * test that ends where it started sees no change at all, so "flip once" and
 * "end up dark" cannot be the same helper.
 */
export async function toggleTheme(page: Page) {
  await page.getByRole("button", { name: /Switch to (dark|light) theme/ })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    /dark|light/,
  );
}

/**
 * Flips the theme until `data-theme` reads "dark", tolerating either starting
 * theme -- a page loads light or dark depending on the system's
 * `prefers-color-scheme`, so a single click lands on dark only half the time.
 *
 * For a test that measures something *in* dark mode. A test asserting that a
 * flip changed (or did not change) an observed value wants `toggleTheme`.
 */
export async function switchToDarkTheme(page: Page) {
  // Up to two flips, and the loop is not defensive padding. A page on the
  // default "system" setting stamps no `data-theme` at all -- it renders dark
  // from `prefers-color-scheme` while the attribute reads null -- so a check
  // that clicks only when the attribute is not "dark" flips a dark page to
  // light and stops. Flipping until the attribute actually says "dark" is
  // what covers the unstamped page, whichever way the system points.
  const theme = () => page.locator("html").getAttribute("data-theme");
  for (let flips = 0; flips < 2 && (await theme()) !== "dark"; flips++) {
    await toggleTheme(page);
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
}

/**
 * Blocks OpenStreetMap tiles. The map is the only page that touches the
 * network at runtime; CI must not depend on tile.openstreetmap.org being up.
 */
export async function blockTiles(page: Page) {
  await page.route(/tile\.openstreetmap\.org/, (route) => route.abort());
}

/**
 * A CSS colour string's concrete sRGBA, reconstructed via a throwaway 1x1
 * canvas.
 *
 * Canvas `fillStyle` accepts any CSS colour notation -- hex, `rgb()`,
 * `oklch()`, `color-mix()` -- and always paints back concrete pixel bytes
 * regardless of which one it was given, which is what makes colours authored
 * in different notations comparable. A literal string compare treats an
 * unresolved `oklch()`/`color-mix()` as different from an equivalent
 * `rgb()`, even when they paint the same pixel -- the trap `theme.spec.ts`'s
 * file header describes, and the reason grounds are compared to each other
 * there rather than to a literal.
 *
 * Painting over both black and white and solving for the difference recovers
 * the colour's true alpha and un-premultiplies it, the way compositing a
 * semi-transparent `background-color` (a `color-mix()` into transparent,
 * say) over the page actually would -- not just a flat opaque read of `css`
 * alone, which is wrong the moment the colour has any transparency.
 *
 * Meant to run inside `page.evaluate(resolveCssColor, css)`: it is
 * self-contained (no reference to anything outside itself) because
 * Playwright serialises a function argument by its own source text, not the
 * module graph around it, so both `theme.spec.ts`'s meta-tag check and this
 * file's own dark-mode ring-contrast test call the one copy here instead of
 * each keeping its own.
 */
export function resolveCssColor(
  css: string | null,
): { r: number; g: number; b: number; a: number } | null {
  if (!css || css === "none" || css === "transparent") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const on = (bg: string) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data;
  };
  const black = on("#000");
  const white = on("#fff");
  const a = 1 -
    ((white[0] - black[0]) + (white[1] - black[1]) + (white[2] - black[2])) /
      765;
  if (a <= 0.001) return null;
  return { r: black[0] / a, g: black[1] / a, b: black[2] / a, a };
}
