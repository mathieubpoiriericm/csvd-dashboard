import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Where the wizard puts what the researcher has to see: the page itself at
 * a phone's width, the current step in the stepper, the heading or field
 * that takes focus, and the page's own messages, all against the sticky
 * navbar. What the wizard does is adapt.spec.ts's.
 */

/** Every step, as the stepper names it. */
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
  await page.goto("/adapt");
  await page.evaluate(() => localStorage.removeItem("svd-adapt-draft"));
  await page.reload();
  await expect(page.locator("fieldset.adapt:enabled")).toBeAttached();
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
    await page.getByRole("button", { name, exact: true }).click();
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

test("on a phone a focused segment's ring is drawn whole", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openWizard(page);
  // Tab walks the segments in order, scrolling the row as it goes; the row
  // clips whatever of the ring falls outside its padding box.
  await page.getByRole("button", { name: "Identity", exact: true }).focus();
  for (const name of STEPS) {
    if (name !== "Identity") await page.keyboard.press("Tab");
    const segment = page.getByRole("button", { name, exact: true });
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
    await page.getByRole("button", { name: "Review", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await centre(page.getByRole("button", { name: "Start over" }));
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
  expect(await topOf(key)).toBeGreaterThanOrEqual(bar);
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
