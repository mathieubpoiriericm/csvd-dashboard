import { expect, type Page, test } from "@playwright/test";
import { REVIEW } from "../fixtures/expected-data.ts";

/**
 * The scientific review area, end to end: the navbar's Review control, its
 * log-in and account-request dialogs, and the three server-rendered pages.
 *
 * Every number and string comes from `REVIEW` (`EXPECTED.review`), derived
 * under Deno from the committed round and the area's own copy, so the spec
 * names no gene and pins no count. With no round under the data `REVIEW` is
 * null, the area does not exist, and only the round-less test runs.
 */

/** The navbar control while signed out of the area. */
const controlOut = (page: Page) =>
  page.getByRole("button", { name: REVIEW!.copy.CONTROL, exact: true });

/** The navbar control after entering as an observer. */
const controlIn = (page: Page) =>
  page.getByRole("button", { name: REVIEW!.copy.CONTROL_ENTERED, exact: true });

const queueRows = (page: Page) => page.locator("table.review-queue tbody tr");

/** Enter as an observer through the menu and the log-in dialog. */
async function enterAsObserver(page: Page) {
  const copy = REVIEW!.copy;
  await page.goto("/");
  await controlOut(page).click();
  await page.getByRole("menuitem", { name: copy.MENU_LOG_IN }).click();
  const dialog = page.getByRole("dialog", { name: copy.LOGIN_TITLE });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(copy.LOGIN_BODY);
  await dialog.getByRole("button", { name: copy.ENTER_OBSERVER }).click();
  await expect(page).toHaveURL("/review");
}

/** Open the account-request dialog from the signed-out menu. */
async function openRequest(page: Page) {
  const copy = REVIEW!.copy;
  await controlOut(page).click();
  await page.getByRole("menuitem", { name: copy.MENU_REQUEST }).click();
  const dialog = page.getByRole("dialog", { name: copy.REQUEST_TITLE });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(copy.REQUEST_DEMO);
  return dialog;
}

interface LogoGeometry {
  left: number;
  width: number;
  height: number;
  /** The viewport's width, less any scrollbar. */
  client: number;
  objectFit: string;
  /** The image's own width over height: its SVG viewBox, else its pixels. */
  ratio: number;
}

/** The navbar logo's box, and the ratio its file is drawn at. */
function logoGeometry(page: Page): Promise<LogoGeometry> {
  return page.locator(".navbar .institute-logo").evaluate(
    async (node) => {
      const img = node as HTMLImageElement;
      await img.decode();
      const box = img.getBoundingClientRect();
      const source = await (await fetch(img.currentSrc)).text();
      const viewBox = new DOMParser().parseFromString(source, "image/svg+xml")
        .documentElement.getAttribute("viewBox")?.trim().split(/[\s,]+/)
        .map(Number);
      return {
        left: box.left,
        width: box.width,
        height: box.height,
        client: document.documentElement.clientWidth,
        objectFit: getComputedStyle(img).objectFit,
        ratio: viewBox?.length === 4
          ? viewBox[2] / viewBox[3]
          : img.naturalWidth / img.naturalHeight,
      };
    },
  );
}

/**
 * The navbar logo is whole, in the viewport and undistorted. Below the
 * width its row needs it gives way: its box narrows and `contain` draws the
 * mark scaled down inside it, so the drawn mark keeps the file's ratio
 * whatever the box's. At 390px it is the size its band gives it where there
 * is room to spare (`roomy`, at 600px): smaller than at 1280px, which is the
 * band above with a taller logo, but never squeezed.
 */
async function expectLogoWhole(
  page: Page,
  at390: LogoGeometry,
  roomy: LogoGeometry,
) {
  expect(at390.width).toBeCloseTo(roomy.width, 1);
  expect(at390.height).toBeCloseTo(roomy.height, 1);
  expect(at390.width / at390.height).toBeCloseTo(at390.ratio, 2);

  const logo = await logoGeometry(page);
  expect(logo.left).toBeGreaterThanOrEqual(0);
  expect(logo.left + logo.width).toBeLessThanOrEqual(logo.client);
  expect(logo.width).toBeLessThanOrEqual(at390.width + 0.01);
  expect(logo.height).toBeCloseTo(at390.height, 1);
  if (logo.width / logo.height < logo.ratio - 0.01) {
    // A narrowed box: only `contain` draws the file at its own ratio in it
    // (the default, `fill`, would stretch it to the box), as the largest
    // box of that ratio that fits, here the box's whole width.
    expect(logo.objectFit).toBe("contain");
    expect(logo.width).toBeGreaterThan(logo.height);
  } else {
    expect(logo.width / logo.height).toBeCloseTo(logo.ratio, 2);
  }
}

/** What the request test types: recognisable, so a leak is found by value. */
const TYPED = {
  "Full name": "Typed Name 7f3a",
  "Email address": "typed.7f3a@example.org",
  Affiliation: "Typed Affiliation 7f3a",
  "Area of expertise": "Typed Expertise 7f3a",
  "Anything the administrator should know (optional)": "Typed note 7f3a",
} as const;

test.describe("with a review round", () => {
  test.skip(REVIEW === null, "no review round under this data");

  test("a visitor enters as an observer and reaches the queue", async ({ page }) => {
    await enterAsObserver(page);
    await expect(page.getByText(REVIEW!.copy.SIMULATED_NOTE)).toBeVisible();
    await expect(queueRows(page)).toHaveCount(REVIEW!.total);
    await expect(controlIn(page)).toBeVisible();
    await expect(controlOut(page)).toHaveCount(0);

    // The control says so on a page outside the area too: the cookie holds.
    await page.goto("/");
    await expect(controlIn(page)).toBeVisible();
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === REVIEW!.cookie)?.value).toBe("1");
  });

  test("the kind filter shows that kind's count", async ({ page }) => {
    await page.goto("/review");
    const filters = page.getByRole("navigation", { name: "Filter by kind" });
    for (const kind of REVIEW!.kinds) {
      const link = filters.getByRole("link", { name: kind.label });
      await expect(link.locator(".review-filter-count")).toHaveText(
        String(kind.count),
      );
      await link.click();
      await expect(page).toHaveURL(`/review?kind=${kind.key}`);
      await expect(link).toHaveAttribute("aria-current", "true");
      if (kind.count === 0) {
        await expect(queueRows(page)).toHaveCount(1);
        await expect(queueRows(page)).toHaveText("No genes match");
      } else {
        await expect(queueRows(page)).toHaveCount(kind.count);
        await expect(queueRows(page).locator(".review-kind")).toHaveText(
          Array(kind.count).fill(kind.label),
        );
      }
    }
    await filters.getByRole("link", { name: "All" }).click();
    await expect(page).toHaveURL("/review");
    await expect(queueRows(page)).toHaveCount(REVIEW!.total);
  });

  test("a gene page shows its diff, findings, votes and history", async ({ page }) => {
    const gene = REVIEW!.gene;
    await page.goto("/review");
    await queueRows(page).getByRole("link", {
      name: REVIEW!.firstGene,
      exact: true,
    }).click();
    await expect(page).toHaveURL(gene.href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      REVIEW!.firstGene,
    );
    const meta = page.locator(".review-gene-meta");
    await expect(meta).toContainText(gene.kind);
    await expect(meta.locator(".review-badge").first()).toHaveText(
      gene.standing,
    );
    await expect(page.getByText(REVIEW!.copy.SIMULATED_NOTE)).toBeVisible();

    // The diff: one row per stored column.
    await expect(page.locator("table.review-diff tbody tr")).toHaveCount(
      gene.fields,
    );
    // The findings, or the line that says there are none.
    if (gene.findings === 0) {
      await expect(page.locator(".review-absent", { hasText: "No findings" }))
        .toBeVisible();
    } else {
      await expect(page.locator(".review-finding")).toHaveCount(gene.findings);
    }
    // One row per voter, and the tally over them.
    await expect(page.locator(".review-votes li")).toHaveCount(gene.voters);
    await expect(page.locator(".review-tally-words")).toHaveText(gene.tally);
    // Every event, newest first, the proposal last.
    const events = page.locator(".review-history .review-event");
    await expect(events).toHaveCount(gene.events);
    await expect(events.last()).toContainText("proposed the change");

    await page.getByRole("link", { name: "Back to the review queue" }).click();
    await expect(page).toHaveURL("/review");
  });

  test("a gene page is titled by its gene, and a gene outside the round is a 404", async ({ page }) => {
    await page.goto(REVIEW!.gene.href);
    expect((await page.title()).startsWith(REVIEW!.firstGene)).toBe(true);

    const missing = await page.goto(REVIEW!.absentGeneHref);
    expect(missing?.status()).toBe(404);
  });

  test("committee progress shows the computed figures", async ({ page }) => {
    await page.goto("/review/progress");
    await expect(page.getByText(REVIEW!.copy.SIMULATED_NOTE)).toBeVisible();
    const totals = page.getByRole("region", { name: "Review totals" });
    const kpi = (label: string) =>
      totals.locator(".review-kpi").filter({
        has: page.locator(".review-kpi-label", { hasText: label }),
      });

    await expect(kpi("Settled").locator(".review-kpi-value")).toHaveText(
      new RegExp(`^${REVIEW!.settled}\\s*of ${REVIEW!.total} genes$`),
    );
    await expect(kpi("In conflict").locator(".review-kpi-value")).toHaveText(
      String(REVIEW!.conflict),
    );
    await expect(kpi("Verdicts in").locator(".review-kpi-value")).toHaveText(
      REVIEW!.verdictsIn,
    );
    await expect(kpi("Verdicts in").locator(".review-kpi-sub")).toHaveText(
      `${REVIEW!.answersIn} of ${REVIEW!.answersOwed}`,
    );
    await expect(page.locator("table.review-members tbody tr")).toHaveCount(
      REVIEW!.accounts,
    );
  });

  test("the request form collects nothing", async ({ page }) => {
    const copy = REVIEW!.copy;
    await page.goto("/");
    const dialog = await openRequest(page);
    for (const [label, value] of Object.entries(TYPED)) {
      await dialog.getByLabel(label, { exact: true }).fill(value);
    }
    await dialog.getByLabel("Account type").selectOption({ label: "Observer" });

    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await dialog.getByRole("button", { name: copy.REQUEST_SUBMIT }).click();

    const notice = dialog.getByRole("status");
    await expect(notice).toHaveText(copy.REQUEST_NOTICE);
    await expect(notice).toBeFocused();
    await expect(dialog.locator("form")).toBeHidden();
    await expect(dialog.getByRole("button", { name: copy.REQUEST_SUBMIT }))
      .toHaveCount(0);
    expect(requests).toEqual([]);
    await expect(page).toHaveURL("/");

    // Cookies from the context, not document.cookie: an HttpOnly one counts.
    const cookies = (await page.context().cookies())
      .map((c) => `${c.name}=${c.value}`).join(";");
    const storages = await page.evaluate(() => {
      const all = (s: Storage) =>
        Array.from({ length: s.length }, (_, i) => {
          const key = s.key(i)!;
          return `${key}=${s.getItem(key)}`;
        }).join(";");
      return [all(localStorage), all(sessionStorage)];
    });
    const stored = [cookies, ...storages];
    for (const value of Object.values(TYPED)) {
      for (const place of stored) expect(place).not.toContain(value);
    }
  });

  test("an empty required field stops the request", async ({ page }) => {
    const copy = REVIEW!.copy;
    await page.goto("/");
    const dialog = await openRequest(page);
    for (const [label, value] of Object.entries(TYPED)) {
      if (label !== "Affiliation") {
        await dialog.getByLabel(label, { exact: true }).fill(value);
      }
    }
    await dialog.getByRole("button", { name: copy.REQUEST_SUBMIT }).click();

    const empty = dialog.getByLabel("Affiliation", { exact: true });
    await expect(empty).toBeFocused();
    expect(await empty.evaluate((el) => (el as HTMLInputElement).validity
      .valueMissing)).toBe(true);
    await expect(dialog.getByRole("status")).toHaveText("");
    await expect(dialog.locator("form")).toBeVisible();
    await expect(dialog.getByRole("button", { name: copy.REQUEST_SUBMIT }))
      .toBeVisible();
  });

  test("leaving restores the signed-out control", async ({ page }) => {
    const copy = REVIEW!.copy;
    await enterAsObserver(page);
    await controlIn(page).click();
    await page.getByRole("menuitem", { name: copy.MENU_LEAVE }).click();
    await expect(page).toHaveURL("/");
    await expect(controlOut(page)).toBeVisible();
    await expect(controlIn(page)).toHaveCount(0);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === REVIEW!.cookie)).toBeUndefined();

    // Signed out again, the menu offers the way in, not the area.
    await controlOut(page).click();
    await expect(page.getByRole("menuitem", { name: copy.MENU_LOG_IN }))
      .toBeVisible();
    await expect(page.getByRole("menuitem", { name: copy.MENU_QUEUE }))
      .toHaveCount(0);
  });

  test("between the breakpoints the navbar logo keeps its own ratio", async ({ page }) => {
    // 601 to 1410px had no measurement: at 1024px the row has room, so the
    // logo's box is drawn at the file's ratio, neither squeezed nor stretched.
    await page.setViewportSize({ width: 1024, height: 800 });
    await enterAsObserver(page);
    const logo = await logoGeometry(page);
    expect(logo.width / logo.height).toBeCloseTo(logo.ratio, 2);
  });

  test("above 600px the entered control carries no marker", async ({ page }) => {
    // The label says "Observer" there, and the amber dot is the navbar's
    // "recently updated" mark: beside the label it reads as a notification.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const marker = page.locator(".navbar .review-button-marker");
    await expect(controlOut(page)).toBeVisible();
    await expect(marker).toHaveCount(0);
    await enterAsObserver(page);
    await expect(controlIn(page)).toBeVisible();
    await expect(marker).toBeHidden();
  });

  for (const width of [390, 320]) {
    test(`no review page scrolls sideways on a ${width}px phone`, async ({ page }) => {
      const copy = REVIEW!.copy;
      // The logo where its band has room to spare, then at this width.
      await page.goto("/");
      await page.setViewportSize({ width: 600, height: 844 });
      const roomy = await logoGeometry(page);
      await page.setViewportSize({ width: 390, height: 844 });
      const at390 = await logoGeometry(page);
      await page.setViewportSize({ width, height: 844 });
      await expectLogoWhole(page, at390, roomy);
      // Signed out, the icon-only control carries no marker.
      const marker = page.locator(".navbar .review-button-marker");
      await expect(controlOut(page)).toBeVisible();
      await expect(marker).toHaveCount(0);

      // Overflow to the left adds no scroll width, so the menu's own box is
      // measured: whole on the screen, and hanging below its button.
      const menuOnScreen = async (where: string) => {
        const box = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          const menu = rect(".navbar .review-menu");
          return {
            left: menu.left,
            right: menu.right,
            top: menu.top,
            buttonBottom: rect(".navbar .review-button").bottom,
            client: document.documentElement.clientWidth,
          };
        });
        expect(box.left, where).toBeGreaterThanOrEqual(0);
        expect(box.right, where).toBeLessThanOrEqual(box.client);
        expect(box.top, where).toBeGreaterThanOrEqual(box.buttonBottom);
      };

      const noSidewaysScroll = async (where: string) => {
        const [scroll, client] = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ]);
        expect(scroll, where).toBeLessThanOrEqual(client);
      };

      for (const path of ["/review", REVIEW!.gene.href, "/review/progress"]) {
        await page.goto(path);
        await expect(page.locator("main")).toBeVisible();
        await noSidewaysScroll(path);
        await expectLogoWhole(page, at390, roomy);
        // Entered, the label is gone at this width and the marker says so.
        await expect(marker).toBeVisible();
      }

      // The open menu, entered: the area's page links and Leave review.
      await controlIn(page).click();
      await expect(page.getByRole("menuitem", { name: copy.MENU_LEAVE }))
        .toBeVisible();
      await noSidewaysScroll("the entered menu");
      await menuOnScreen("the entered menu");
      await page.getByRole("menuitem", { name: copy.MENU_LEAVE }).click();
      await expect(page).toHaveURL("/");

      // The open menu signed out, then the request dialog.
      await noSidewaysScroll("signed out of the review");
      await expectLogoWhole(page, at390, roomy);
      await controlOut(page).click();
      await expect(page.getByRole("menuitem", { name: copy.MENU_REQUEST }))
        .toBeVisible();
      await noSidewaysScroll("the signed-out menu");
      await menuOnScreen("the signed-out menu");
      await page.getByRole("menuitem", { name: copy.MENU_REQUEST }).click();
      await expect(page.getByRole("dialog", { name: copy.REQUEST_TITLE }))
        .toBeVisible();
      await noSidewaysScroll("the request dialog");
    });
  }
});

test.describe("signed out of the dashboard", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the review area is behind the gate, and the login page has no Review control", async ({ page }) => {
    await page.goto("/review");
    await expect(page).toHaveURL("/login?next=%2Freview");
    // Whatever the round, the control's name begins with its plain label.
    await expect(page.getByRole("button", { name: /^Review/ })).toHaveCount(0);
    await expect(page.locator(".review-control")).toHaveCount(0);
  });
});

test("with no review round, there is no Review control and no review page", async ({ page }) => {
  test.skip(REVIEW !== null, "a review round is committed");
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.locator(".review-control")).toHaveCount(0);
  for (const path of ["/review", "/review/progress"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
  }
});
