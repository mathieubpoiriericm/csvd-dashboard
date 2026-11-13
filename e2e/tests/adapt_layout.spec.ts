import { expect, type Locator, type Page, test } from "@playwright/test";

import { openAdapt } from "../helpers.ts";

/**
 * Where the wizard puts what the researcher has to see: the page itself at
 * a phone's width, the current step in the stepper, the heading or field
 * that takes focus, and the page's own messages, all against the sticky
 * navbar. What the wizard does is adapt.spec.ts's.
 */

/**
 * Every step, as the stepper names it. A step's button is looked up inside
 * `main`: the navbar's Review control shares the last step's name.
 */
const STEPS = [
  "Identity",
  "Search terms",
  "Traits",
  "Trials",
  "Monogenic genes",
  "Prompt",
  "Gold papers",
  "Review",
];

const PHONE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 800 };

/**
 * An empty draft, once the island is live: the wizard is a fieldset
 * disabled until the stored draft has been read, and a key typed before
 * that reaches no state.
 */
async function openWizard(page: Page) {
  // Cleared once the island is live: hydrating, it writes what it holds.
  await openAdapt(page);
  await page.evaluate(() => {
    localStorage.removeItem("svd-adapt-draft");
    localStorage.removeItem("svd-adapt-session");
  });
  await openAdapt(page);
}

/** Open a card of the step on screen, when it is folded. */
async function openCard(page: Page, id: string) {
  const head = page.locator(`[data-card="${id}"] .adapt-card-head`);
  if (await head.getAttribute("aria-expanded") === "false") await head.click();
}

/** Scroll the page so `target` sits mid-screen, where it is pressed. */
const centre = (target: Locator) =>
  target.evaluate((el) => el.scrollIntoView({ block: "center" }));

const topOf = (target: Locator) =>
  target.evaluate((el) => el.getBoundingClientRect().top);

/** The navbar's bottom edge: nothing the wizard shows may sit above it. */
const navbarBottom = (page: Page) =>
  page.locator("header.navbar").evaluate((bar) =>
    bar.getBoundingClientRect().bottom
  );

/** In view, and clear of the navbar that sticks over the page's top. */
async function expectShown(page: Page, target: Locator) {
  await expect(target).toBeInViewport();
  expect(await topOf(target)).toBeGreaterThanOrEqual(await navbarBottom(page));
}

test("the page never scrolls sideways on a phone, on any step", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openWizard(page);
  // A step in progress spells its count out in visually-hidden words. Far
  // down the stepper's scrolling row, they once reported their unscrolled
  // position to the page instead, and widened it past the phone's edge.
  await page.getByRole("button", { name: "Gold papers", exact: true }).click();
  await openCard(page, "rows");
  await page.getByRole("button", { name: "Add PMID" }).click();
  await page.locator('[data-field="rows[0].note"]').fill("A landmark paper.");
  await expect(page.locator(".adapt-stepper .is-progress")).toHaveCount(1);
  for (const name of STEPS) {
    await page.getByRole("main").getByRole("button", { name, exact: true })
      .click();
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(width.scroll, name).toBeLessThanOrEqual(width.client);
  }
});

test("on a phone the stepper keeps the current step in view", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openWizard(page);
  const row = page.locator(".adapt-stepper");
  for (const name of STEPS.slice(1)) {
    await page.getByRole("button", { name: "Next" }).click();
    const current = row.locator('[aria-current="step"]');
    await expect(current).toHaveText(name);
    const box = (await row.boundingBox())!;
    const segment = (await current.boundingBox())!;
    expect(segment.x, name).toBeGreaterThanOrEqual(box.x);
    expect(segment.x + segment.width, name).toBeLessThanOrEqual(
      box.x + box.width,
    );
  }
});

test("on a phone a press on a segment off the row's middle opens its step", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openWizard(page);
  const row = page.locator(".adapt-stepper");
  // A press focuses the segment before its release. Centred on that focus,
  // the row slid the segment out from under the pointer, the release landed
  // on its neighbour and the click reached neither: from Identity, "Traits"
  // is wholly in view and well off the middle, and after it each press is
  // on the current segment's neighbour, up the row and back down it.
  for (const name of [...STEPS.slice(2), ...STEPS.slice(1, 7).reverse()]) {
    await page.getByRole("main").getByRole("button", { name, exact: true })
      .click();
    await expect(row.locator('[aria-current="step"]'), name).toHaveText(name);
  }
});

test("on a phone a focused segment's ring is drawn whole", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openWizard(page);
  // Tab walks the segments in order, scrolling the row as it goes; the row
  // clips whatever of the ring falls outside its padding box.
  await page.getByRole("button", { name: "Identity", exact: true }).focus();
  for (const name of STEPS) {
    if (name !== "Identity") await page.keyboard.press("Tab");
    const segment = page.getByRole("main").getByRole("button", {
      name,
      exact: true,
    });
    await expect(segment).toBeFocused();
    const ring = await segment.evaluate((button) => {
      const style = getComputedStyle(button);
      const reach = parseFloat(style.outlineWidth) +
        parseFloat(style.outlineOffset);
      const at = button.getBoundingClientRect();
      const row = button.closest("ol")!.getBoundingClientRect();
      return {
        reach,
        top: at.top - reach - row.top,
        left: at.left - reach - row.left,
        right: row.right - (at.right + reach),
      };
    });
    expect(ring.reach, `${name} draws no ring`).toBeGreaterThan(0);
    expect(ring.top, name).toBeGreaterThanOrEqual(0);
    expect(ring.left, name).toBeGreaterThanOrEqual(0);
    expect(ring.right, name).toBeGreaterThanOrEqual(0);
  }
});

for (const viewport of [PHONE, DESKTOP]) {
  test(`a step's heading takes focus below the navbar at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openWizard(page);
    const heading = page.locator("h2.adapt-step-title");
    // Next and Back sit under the step, so the page is scrolled down to
    // them when they are pressed; the new step's heading takes focus.
    // A heading is numbered as its step is: "3. Trait vocabulary".
    const numbers = STEPS.map((_, i) => `${i + 1}.`);
    for (
      const [button, names] of [
        ["Next", numbers.slice(1)],
        ["Back", numbers.slice(0, -1).reverse()],
      ] as const
    ) {
      for (const name of names) {
        await page.getByRole("button", { name: button }).press("Enter");
        await expect(heading).toBeFocused();
        await expect(heading).toContainText(name);
        expect(await topOf(heading), `${button} to ${name}`)
          .toBeGreaterThanOrEqual(await navbarBottom(page));
      }
    }
    await page.getByRole("main").getByRole("button", {
      name: "Review",
      exact: true,
    }).click();
    page.once("dialog", (dialog) => dialog.accept());
    // Below 1100px Start over sits in the bar's popover, behind More.
    const more = page.getByRole("button", { name: "More" });
    if (await more.isVisible()) await more.click();
    await page.getByRole("button", { name: "Start over" }).click();
    await expect(page.getByRole("heading", { name: "1. Identity" }))
      .toBeFocused();
    expect(await topOf(heading)).toBeGreaterThanOrEqual(
      await navbarBottom(page),
    );
  });
}

test("reverse Tab onto a field under the navbar brings it out", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openWizard(page);
  // The Key field sits under the bar, the card's Continue below it on
  // screen: in the viewport, so a browser that ignores the bar scrolls
  // nothing and leaves the focused field hidden behind it.
  const key = page.getByLabel("Key", { exact: true });
  const bar = await navbarBottom(page);
  await page.evaluate(
    (by) => globalThis.scrollBy(0, by),
    (await topOf(key)) - bar / 2,
  );
  expect(await topOf(key)).toBeLessThan(bar);
  await page.locator(".adapt-card.is-open").getByRole("button", {
    name: "Continue",
    exact: true,
  }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(key).toBeFocused();
  // Polled: WebKit's scroll for a focus move can land a frame after the
  // focus itself.
  await expect.poll(() => topOf(key)).toBeGreaterThanOrEqual(bar);
});

for (const viewport of [PHONE, DESKTOP]) {
  test(`a lookup's failure shows where its button was pressed at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.route(
      "https://eutils.ncbi.nlm.nih.gov/**",
      (route) => route.fulfill({ status: 500, body: "" }),
    );
    await page.setViewportSize(viewport);
    await openWizard(page);
    await page.getByRole("button", { name: "Search terms", exact: true })
      .click();
    await openCard(page, "phrases");
    await page.getByRole("button", { name: "Add phrase" }).click();
    await page.getByLabel("Phrase 1", { exact: true }).fill("exampleitis");
    const check = page.getByRole("button", { name: "Check MeSH headings" });
    await centre(check);
    await check.click();
    const status = page.locator(".adapt-messages > [role=status]");
    await expect(status).toContainText("Could not resolve");
    await expectShown(page, status);
  });
}

test("a refused logo is said where it was chosen", async ({ page }) => {
  await openWizard(page);
  await openCard(page, "logos");
  const logo = page.locator('input[data-field="logoLight"]');
  await centre(logo);
  await logo.setInputFiles({
    name: "logo-light.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(1_100_000),
  });
  const status = page.locator(".adapt-messages > [role=status]");
  await expect(status).toContainText("larger than 1 MB");
  await expectShown(page, status);
});

test("the refused-save alert stays in view while the researcher types", async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "svd-adapt-draft") {
        throw new DOMException("refused", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  await openWizard(page);
  await openCard(page, "maintainer");
  const name = page.getByLabel("Maintainer name", { exact: true });
  await centre(name);
  await name.pressSequentially("Ada");
  const alert = page.locator(".adapt-messages > [role=alert]");
  await expect(alert).toContainText("refused to save the draft");
  await expectShown(page, alert);
  await expect(name).toBeInViewport();
});

const NARROW = { width: 320, height: 640 };

/** Whether the page scrolls sideways: it never should. */
const overflow = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.scrollWidth -
    document.documentElement.clientWidth
  );

test("a long unbroken value wraps rather than widening the page", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await openWizard(page);
  // A key typed from a long dashed name: its fix button echoes it whole.
  await page.getByLabel("Key", { exact: true }).fill(
    "a-very-long-dashed-disease-name-that-keeps-on-going-past-the-edge",
  );
  await expect(page.locator(".adapt-fix").first()).toBeVisible();
  expect(await overflow(page), "the key's fix").toBeLessThanOrEqual(0);

  // A logo's file name, echoed in its hint.
  await openCard(page, "logos");
  await page.locator('input[data-field="logoLight"]').setInputFiles({
    name: `institute-logo-${"x".repeat(80)}.svg`,
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    ),
  });
  await expect(page.getByText("Uploaded: institute-logo-")).toBeVisible();
  expect(await overflow(page), "the logo's name").toBeLessThanOrEqual(0);

  // A gene list pasted into one symbol's field, echoed with its commas.
  await page.getByRole("button", { name: "Monogenic genes", exact: true })
    .click();
  await openCard(page, "genes");
  await page.getByRole("button", { name: "Add gene" }).click();
  await page.getByLabel("HGNC symbol", { exact: true }).fill(
    "GENEA,GENEB,GENEC,GENED,GENEE,GENEF,GENEG,GENEH,GENEI,GENEJ",
  );
  await page.getByLabel("HGNC symbol", { exact: true }).blur();
  expect(await overflow(page), "the pasted gene list").toBeLessThanOrEqual(0);
});

test("a field's message does not move its neighbour in the row", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openWizard(page);
  await openCard(page, "maintainer");
  const name = page.getByLabel("Maintainer name", { exact: true });
  const email = page.getByLabel("Maintainer email", { exact: true });
  const before = (await name.boundingBox())!;
  expect((await email.boundingBox())!.y).toBe(before.y);
  // Half an address: a note appears under the email field while it is typed.
  await email.pressSequentially("a");
  await expect(
    page.locator('[data-card="maintainer"] .adapt-field-message'),
  ).not.toHaveCount(0);
  expect((await name.boundingBox())!.y).toBe(before.y);
});

for (const width of [1280, 1024]) {
  test(`the Required mark never overlaps its label at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openWizard(page);
    await page.getByRole("button", { name: "Monogenic genes", exact: true })
      .click();
    await openCard(page, "omim");
    await page.getByRole("button", { name: "Add OMIM row" }).click();
    const overlaps = await page.locator('[data-card="omim"] .adapt-field')
      .evaluateAll((fields) =>
        fields.flatMap((field) => {
          const mark = field.querySelector(":scope > .adapt-field-mark");
          const label = field.querySelector(".adapt-field-label");
          if (mark === null || label === null) return [];
          const at = mark.getBoundingClientRect();
          const text = document.createRange();
          text.selectNodeContents(label);
          return [...text.getClientRects()]
            .filter((line) =>
              line.right > at.left && line.left < at.right &&
              line.bottom > at.top && line.top < at.bottom
            )
            .map(() => label.textContent);
        })
      );
    expect(overlaps).toEqual([]);
  });
}

test("on a narrow phone a folded card's summary keeps its width", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await openWizard(page);
  const summary = page.locator(
    ".adapt-card:not(.is-open) .adapt-card-summary",
  ).first();
  // It was 71px, about ten characters; it now has the head's width but the
  // number's and the chevron's, and two lines.
  expect(await summary.evaluate((el) => el.clientWidth))
    .toBeGreaterThanOrEqual(180);
});

test("the action bar stays under the navbar while a long step scrolls", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openWizard(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const bar = page.locator(".adapt-bar");
  await expect(bar).toBeInViewport();
  const box = await bar.boundingBox();
  // Pinned `--svd-space-2` below the navbar, so within a gap of its edge.
  const gap = await page.locator(".adapt-pinned").evaluate((el) =>
    parseFloat(getComputedStyle(el).top) -
    document.querySelector("header.navbar")!.getBoundingClientRect().bottom
  );
  expect(Math.abs(box!.y - (await navbarBottom(page)) - gap)).toBeLessThan(2);
  // At this width the four buttons are in the bar itself, no More.
  await expect(page.getByRole("button", { name: "Export answers" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "More" })).toBeHidden();
});

test("on a phone the bar shows More and no row wraps", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWizard(page);
  const more = page.getByRole("button", { name: "More" });
  await expect(more).toBeVisible();
  await expect(page.getByRole("button", { name: "Export answers" }))
    .toBeHidden();
  const [bar, button] = await Promise.all([
    page.locator(".adapt-bar").boundingBox(),
    more.boundingBox(),
  ]);
  expect(bar!.height).toBeLessThanOrEqual(button!.height + 1);
  await more.click();
  await expect(page.getByRole("button", { name: "Export answers" }))
    .toBeVisible();
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
});

test("on a short phone the opened More panel stays on screen and reaches its last button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await openWizard(page);
  const more = page.getByRole("button", { name: "More" });
  const panel = page.locator(".adapt-bar-more");
  const bottomOf = (target: Locator) =>
    target.evaluate((el) => el.getBoundingClientRect().bottom);
  // Its natural height, opened where it has room.
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await more.click();
  await expect(panel).toBeVisible();
  const natural = (await panel.boundingBox())!.height;
  await page.keyboard.press("Escape");
  for (
    const [height, place] of [
      // The bar low on the page, where the panel cannot fit under it.
      [500, async () => {
        await page.evaluate(() => scrollTo(0, 0));
        await page.evaluate(
          (by) => scrollBy(0, by),
          (await bottomOf(more)) - (500 - natural / 2),
        );
      }],
      // Too short for the panel on either side of the bar, pinned.
      [
        Math.round(natural * 1.2),
        () => page.evaluate(() => scrollTo(0, document.body.scrollHeight)),
      ],
    ] as const
  ) {
    await page.setViewportSize({ width: 390, height });
    await place();
    expect(await bottomOf(more) + 8 + natural).toBeGreaterThan(height);
    await more.click();
    await expect(panel).toHaveClass(/is-placed/);
    const box = (await panel.boundingBox())!;
    expect(box.y, `top at ${height}px`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `bottom at ${height}px`)
      .toBeLessThanOrEqual(height);
    // Download is the last button; disabled on an empty draft, it is
    // brought into view, and Start over above it is pressed.
    const last = panel.getByRole("button").last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport({ ratio: 1 });
    let asked = false;
    page.once("dialog", (dialog) => {
      asked = true;
      return dialog.dismiss();
    });
    await panel.getByRole("button", { name: "Start over" }).click();
    expect(asked, `Start over pressed at ${height}px`).toBe(true);
    if (await panel.isVisible()) await page.keyboard.press("Escape");
  }
});

test("on a phone the opened More panel sits under its button at any bar height", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWizard(page);
  // A taller bar, as a wrapped indicator or a larger text size would make
  // it: the panel has to follow the button, not a height the CSS assumed.
  await page.addStyleTag({ content: ".adapt-bar { padding: 40px 0; }" });
  const more = page.getByRole("button", { name: "More" });
  await more.click();
  const panel = page.locator(".adapt-bar-more");
  await expect(panel).toBeVisible();
  const [button, box] = await Promise.all([
    more.boundingBox(),
    panel.boundingBox(),
  ]);
  const bottom = button!.y + button!.height;
  expect(box!.y).toBeGreaterThanOrEqual(bottom);
  expect(box!.y - bottom).toBeLessThan(16);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
});

/**
 * A session attached with unsaved changes, without asking the server for
 * one: the bar's layout depends on the link in storage and nothing else, and
 * every create counts against the session routes' per-client limit, which
 * the whole suite shares. The code is a well-formed one that names nothing.
 */
async function openAttached(
  page: Page,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize(viewport);
  // Seeded once the island is live: hydrating, it writes the link it holds,
  // none, over whatever was stored before.
  await openAdapt(page);
  await page.evaluate(() => {
    localStorage.removeItem("svd-adapt-draft");
    // lib/adapt/session.ts's SESSION_KEY and SessionLink.
    localStorage.setItem(
      "svd-adapt-session",
      JSON.stringify({
        code: "ABCDEFGHJKMNPQRSTVWX",
        revision: 1,
        savedAt: Date.now(),
        dirty: true,
      }),
    );
  });
  await openAdapt(page);
  await expect(page.locator(".adapt-bar-indicator")).toHaveText(
    "Unsaved changes",
  );
}

for (
  const viewport of [
    { width: 1100, height: 800 },
    { width: 900, height: 800 },
    { width: 390, height: 844 },
  ]
) {
  test(`with a session attached the bar is one row at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await openAttached(page, viewport);
    const save = page.getByRole("button", { name: "Save session" });
    await expect(save).toBeVisible();
    const [bar, button] = await Promise.all([
      page.locator(".adapt-bar").boundingBox(),
      save.boundingBox(),
    ]);
    expect(bar!.height).toBeLessThanOrEqual(button!.height + 1);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
    ).toBe(true);
  });
}

test("the open Session panel sits just under its button, inside the viewport", async ({ page }) => {
  await openAttached(page, DESKTOP);
  const toggle = page.getByRole("button", { name: "Session", exact: true });
  // Mid-screen first, so there is room under the button in every engine: a
  // click scrolls the button only just into view, which in WebKit is the
  // window's bottom edge, and the panel then rightly opens above it.
  await toggle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await toggle.click();
  const panel = page.locator(".adapt-bar-session");
  await expect(panel).toHaveClass(/is-placed/);
  await expect(panel.getByText("ABCDE-FGHJK-MNPQR-STVWX")).toBeVisible();
  const [button, box] = await Promise.all([
    toggle.boundingBox(),
    panel.boundingBox(),
  ]);
  const bottom = button!.y + button!.height;
  expect(box!.y).toBeGreaterThanOrEqual(bottom);
  expect(box!.y - bottom).toBeLessThanOrEqual(16);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(DESKTOP.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(DESKTOP.height);
});

test("on a short phone the More panel, session details and all, scrolls inside the viewport", async ({ page }) => {
  const viewport = { width: 390, height: 500 };
  await openAttached(page, viewport);
  // The Session button belongs to the wide layout only.
  await expect(page.getByRole("button", { name: "Session", exact: true }))
    .toBeHidden();
  await page.getByRole("button", { name: "More" }).click();
  const panel = page.locator(".adapt-bar-more");
  await expect(panel).toHaveClass(/is-placed/);
  await expect(panel.getByText("ABCDE-FGHJK-MNPQR-STVWX")).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(await panel.evaluate((el) => getComputedStyle(el).overflowY))
    .toMatch(/auto|scroll/);
  // Whatever does not fit is reached by scrolling the panel itself.
  const last = panel.getByRole("button").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
});

test("at 1000px the four action buttons are behind More", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openWizard(page);
  // They are inline only from 1100px.
  const more = page.getByRole("button", { name: "More" });
  await expect(more).toBeVisible();
  for (const name of ["Export answers", "Import answers", "Start over"]) {
    await expect(page.getByRole("button", { name })).toBeHidden();
  }
  await expect(page.getByRole("button", { name: /^Download/ })).toBeHidden();
  await more.click();
  await expect(page.getByRole("button", { name: "Export answers" }))
    .toBeVisible();
});
