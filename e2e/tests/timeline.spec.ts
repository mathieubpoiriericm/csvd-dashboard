import { expect, type Locator, type Page, test } from "@playwright/test";
import { EXPECTED } from "../fixtures/expected-data.ts";
import { resolveCssColor, switchToDarkTheme, toggleTheme } from "../helpers.ts";
import {
  radarMode,
  recordTriggers,
  settleRadar,
  sweepLabelFit,
} from "./helpers/timeline.ts";

/**
 * Every count below is derived from the committed data through the app's
 * own layout function (e2e/fixtures/expected.deno.ts); the tests that name a
 * cSVD drug, trial or population are in csvd/timeline.spec.ts. The radar's
 * chrome, key and skip link render without a trial; the tests that need one
 * guard on `T.markers`.
 */
const T = EXPECTED.timeline;
const NO_MARKER = "no trial drawn on the radar";

type RGBA = { r: number; g: number; b: number; a: number };

/** Alpha-composites `fg` over `bg`. */
const over = (fg: RGBA, bg: RGBA): RGBA => {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (f: number, k: number) => (f * fg.a + k * bg.a * (1 - fg.a)) / a;
  return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a };
};

/** Relative luminance, WCAG's formula. */
const luminance = ({ r, g, b }: RGBA) => {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

/** WCAG contrast ratio between two opaque colours. */
const contrastRatio = (x: RGBA, y: RGBA) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The radar is drawn in-app by islands/TrialsTimeline.tsx. Label boxes are
 * fitted from getBBox() after the fonts settle, so anything that reads a box
 * polls rather than asserting once.
 */

const FIGURE = "svg.timeline-figure";

/**
 * Loads the page and waits for the island to settle on a layout: the radar,
 * or below its readable floor the phone views, which have no FIGURE.
 */
async function figureSettled(page: Page) {
  await page.goto("/timeline");
  await settleRadar(page);
}

/** The key is a closed `<details>` above the plate; open it before reading it. */
async function openKey(page: Page) {
  await page.locator("#timeline-key summary").click();
}

test("draws one group per visible trial, twenty-eight cells, and both legends", async ({ page }) => {
  await figureSettled(page);
  await openKey(page);
  const figure = page.locator(FIGURE);
  // lib/timeline.ts's CANVAS, and .timeline-figure's min-width in
  // assets/app.css, which is the same number.
  await expect(figure).toHaveAttribute("viewBox", "0 0 1072 940");
  // Completed trials are hidden by default.
  await expect(figure.locator("g.drug")).toHaveCount(T.markers);
  await expect(figure.locator("path.wedge")).toHaveCount(T.cells);
  await expect(figure.locator("path.rim-band")).toHaveCount(T.rimBands);
  // A ring means somebody assessed the drug's genetics; a hollow centre
  // means the record is too thin to read at face value.
  await expect(figure.locator("circle.evidence")).toHaveCount(T.evidenceRings);
  await expect(figure.locator("circle.gap")).toHaveCount(T.gaps);
  await expect(figure.locator("g.pop-label")).toHaveCount(T.populationLabels);
  await expect(figure.locator("g.phase-label")).toHaveCount(T.phaseLabels);
  // Only the families represented among the visible trials' mechanisms.
  await expect(page.locator(".timeline-legend-family")).toHaveCount(
    T.families,
  );
  // 3 evidence states + 1 record-completeness row + the mechanisms among
  // the visible trials.
  await expect(page.locator(".timeline-legend-item")).toHaveCount(
    T.legendEntries + 4,
  );

  // Every legend swatch is a different colour — the old palette cycled 9
  // colours over 11 mechanisms, and tests/timeline_encoding_test.ts holds
  // the same rule over the whole encoding; only the mechanisms among the
  // default-visible trials are drawn.
  const swatches = await page.locator(".timeline-legend-dot").evaluateAll(
    (dots) => dots.map((dot) => getComputedStyle(dot).backgroundColor),
  );
  expect(new Set(swatches).size).toBe(T.swatches);
});

/**
 * All five of these are invariants now, and the last stopped being debt.
 *
 * A label box that does not contain its own text is a measurement failure in
 * the renderer; a label past the edge of the viewBox is a drug name silently
 * cut in half, because the outermost <svg> clips and the plate rect pins
 * every getBBox() to exactly the canvas, so nothing else here would see it;
 * a label lying across a marker — any marker, not just its own — is a
 * label handed to the wrong trial; and a population name lying on a rim band
 * is a name written over the arc it names. Those stay at zero, exactly, on
 * any machine. So does the box count. The marker sweep used to check only a label
 * against its own marker, which is the one pairing the resting layout cannot
 * produce; the relaxed layout put 53 labels on somebody else's.
 *
 * Labels overlapping *each other* used to be a density limit, bounded above
 * zero and under a ceiling of 170 because it was font-dependent: the same
 * build and data measured 144 colliding pairs on macOS and 127 on CI's Linux
 * chromium, and no ceiling below that was reachable while `separateLabels`
 * only relaxed the boxes vertically. It now settles every one of them — the
 * enlarged plate took the committed rows from 123 pairs to 63, and the
 * placement pass takes those to zero — so this is pinned at zero rather than
 * bounded. The count is no longer incidental: a label that cannot be placed
 * keeps its relaxed position, so a non-zero here is the placement pass
 * failing on that machine's metrics, which is worth failing over.
 *
 * Pinning zero costs the canary the old lower bound carried, so the two
 * assertions beside it replace it: `boxes` proves the sweep ran over all 78
 * label boxes rather than an empty list, and `control` runs the same overlap
 * test over a pair that is built to overlap and must report it. The pairs
 * themselves are collected by name, not counted, because the fix for a
 * non-zero is a wider search in `lib/timeline.ts` and that needs to know
 * which cell failed.
 */
test("label boxes fit their text, stay on the plate, and touch no marker or band", async ({ page }) => {
  await figureSettled(page);
  // At the project's 1280x720 the height fit alone would shrink the plate
  // past the scale at which the labels clear its edge; the island's
  // readable floor holds it above that (figureSettled waits it out).
  expect(await radarMode(page)).toBe("radar");
  // One box per drug label, population label and phase label.
  await expect.poll(() => sweepLabelFit(page)).toEqual({
    misfit: [],
    clipped: [],
    touching: [],
    onBand: [],
    boxes: T.labels,
  });

  const measured = await page.evaluate(() => {
    type Rect = { left: number; right: number; top: number; bottom: number };
    const meet = (a: Rect, b: Rect) =>
      !(a.right < b.left || a.left > b.right ||
        a.bottom < b.top || a.top > b.bottom);

    const drugs = [
      ...document.querySelectorAll("svg.timeline-figure g.drug"),
    ];
    const boxes = drugs.map((drug) =>
      drug.querySelector("rect.label-bg")!.getBoundingClientRect()
    );
    const name = (i: number) =>
      `${drugs[i].getAttribute("data-drug")} [${
        drugs[i].getAttribute("data-pop")
      }/${drugs[i].getAttribute("data-phase")}]`;
    // Named, not counted: if another machine's metrics leave a pair touching,
    // the fix is a wider search in lib/timeline.ts, and that needs to know
    // which cell failed rather than only how many did.
    const colliding: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (!meet(boxes[i], boxes[j])) continue;
        colliding.push(`${name(i)} on ${name(j)}`);
      }
    }
    // Two boxes built to overlap, run through the same test.
    const control = meet(
      { left: 0, right: 10, top: 0, bottom: 10 },
      { left: 5, right: 15, top: 5, bottom: 15 },
    );
    return { colliding, boxes: boxes.length, control };
  });
  expect(measured).toEqual({ colliding: [], boxes: T.markers, control: true });
});

/**
 * The plate fits the window -- never wider than its 1072-unit design size,
 * never taller than the room under the navbar -- while every drug label keeps
 * its 12px on screen: the island sets the label's font size in user units to
 * 12 over the plate's rendered scale, and re-solves the label layout at each
 * size, so the whole sweep stays clean as the plate shrinks.
 */
test("the plate fits the window and its text keeps its size", async ({ page }) => {
  for (
    const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [1280, 800],
      [1100, 900],
    ] as const
  ) {
    await page.setViewportSize({ width, height });
    await figureSettled(page);
    const at = `${width}x${height}`;
    await expect.poll(() =>
      page.evaluate(() => {
        const svg = document.querySelector<SVGSVGElement>(
          "svg.timeline-figure",
        )!;
        const rect = svg.getBoundingClientRect();
        const navbar = document.querySelector(".navbar")!
          .getBoundingClientRect().height;
        const scale = svg.getScreenCTM()!.a;
        const offSize = [
          ...svg.querySelectorAll<SVGTextElement>('text[data-label^="drug-"]'),
        ]
          .map((text) => Number(text.getAttribute("font-size")) * scale)
          .filter((size) => Math.abs(size - 12) > 0.5)
          .map((size) => size.toFixed(2));
        return {
          scrolls: document.documentElement.scrollWidth > innerWidth,
          tooTall: rect.height > innerHeight - navbar + 1,
          tooWide: rect.width > 1072,
          offSize,
        };
      }), { message: at }).toEqual({
        scrolls: false,
        tooTall: false,
        tooWide: false,
        offSize: [],
      });
    await expect.poll(() => sweepLabelFit(page), { message: at }).toEqual({
      misfit: [],
      clipped: [],
      touching: [],
      onBand: [],
      boxes: T.labels,
    });
  }
});

test("an unassessed drug draws no ring and an assessed negative draws a dashed one", async ({ page }) => {
  await figureSettled(page);
  const figure = page.locator(FIGURE);
  const dashed = figure.locator("circle.evidence[stroke-dasharray]");
  await expect(dashed).toHaveCount(T.evidenceDashed);
  const solid = figure.locator("circle.evidence:not([stroke-dasharray])");
  await expect(solid).toHaveCount(T.evidenceRings - T.evidenceDashed);
});

test("at a stacked width an opened record is scrolled into view", async ({ page }) => {
  // At 1100px and below the drawer stacks above the plate. Focus that may
  // not scroll left it -- record and close button both -- wholly above the
  // viewport, and the tap appeared to do nothing.
  test.skip(T.markers === 0, NO_MARKER);
  await page.setViewportSize({ width: 900, height: 800 });
  await figureSettled(page);
  // A marker on the radar, or a row once the radar has given way to the list.
  const marker = recordTriggers(page).first();
  await marker.scrollIntoViewIfNeeded();
  await marker.click();
  const close = page.getByRole("button", { name: "Close trial details" });
  await expect(close).toBeFocused();
  await expect(close).toBeInViewport();
});

test("the trial drawer has pointer and keyboard close controls", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  await figureSettled(page);
  const drawer = page.locator("#timeline-drawer");
  await expect(drawer).toBeHidden();
  await expect(drawer).toHaveAttribute("inert", "");

  const trial = page.locator("g.drug").first();
  await expect(trial).toHaveAttribute("aria-expanded", "false");
  // Click the marker rather than the group: the group's box spans its label,
  // and at this density a neighbouring label can sit over that box. Nothing
  // covers a marker -- the label-fit test above pins `touching` at zero.
  await trial.locator("circle.marker").click();
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toHaveAttribute("inert", "");
  await expect(trial).toHaveAttribute("aria-expanded", "true");
  // The first marker drawn is the first trial of the first population in
  // table order.
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText(
    T.firstMarker!.drug,
  );
  await expect(drawer.locator("dt")).toHaveCount(12);

  // A flagged record carries a note above the field list, which keeps its
  // twelve rows either way; an unflagged one carries none.
  const flag = drawer.locator(".timeline-drawer-flag");
  if (T.firstMarker!.flagged) {
    await expect(flag).toBeVisible();
    await expect(flag).toContainText("Incomplete record");
    await expect(flag.locator("li").first()).not.toBeEmpty();
    // Never colour alone: the note carries a glyph and the word as well.
    await expect(flag.locator("svg.icon")).toHaveCount(1);
  } else {
    await expect(flag).toHaveCount(0);
  }

  // A rule between fields, and none above the first.
  const width = (dt: Locator) =>
    dt.evaluate((node) => getComputedStyle(node).borderTopWidth);
  await expect.poll(() => width(drawer.locator("dt").first())).toBe("0px");
  await expect.poll(() => width(drawer.locator("dt").nth(1))).not.toBe("0px");

  const close = page.getByRole("button", { name: "Close trial details" });
  await expect(close).toBeFocused();
  await close.click();
  await expect(drawer).toBeHidden();
  await expect(drawer).toHaveAttribute("inert", "");
  await expect(trial).toBeFocused();
  await expect(trial).toHaveAttribute("aria-expanded", "false");

  await trial.locator("circle.marker").click();
  await expect(drawer).toBeVisible();
  // Wait for the open effects to have run before pressing Escape. The drawer
  // paints in the commit; the close button's focus and the document `keydown`
  // listener are both `useEffect`s that run after it, in that order, so
  // observing the focus proves the listener is attached too. Nobody can press
  // a key inside that window; Playwright can.
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trial).toBeFocused();
});

test("the sticky trial drawer clears the navbar and shows the whole record", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  await page.setViewportSize({ width: 1512, height: 800 });
  await figureSettled(page);
  await page.locator("g.drug").first().locator("circle.marker").click();

  const drawer = page.locator("#timeline-drawer");
  await expect(drawer).toBeVisible();
  // Scrolled just far enough to stick the drawer. The plate fits the window
  // now, so the row is barely taller than the drawer, and the drawer stays
  // stuck for only a few dozen pixels before the row's end carries it up
  // under the navbar with the plate -- which is sticky positioning, not a
  // fault. Scrolling to the drawer's own top assumed the old 1072px plate,
  // whose tall row held the drawer stuck for hundreds of pixels. Measured
  // from the row, the drawer's unstuck slot: the click may already have
  // scrolled the drawer itself into its sticky position.
  const stuckAt = await drawer.evaluate((element) =>
    element.parentElement!.getBoundingClientRect().top + globalThis.scrollY -
    parseFloat(getComputedStyle(element).top) + 4
  );
  await page.evaluate((top) => globalThis.scrollTo(0, top), stuckAt);

  await expect.poll(async () =>
    page.evaluate(() => {
      const navbar = document.querySelector(".navbar")!.getBoundingClientRect();
      const drawer = document.querySelector<HTMLElement>("#timeline-drawer")!;
      const rect = drawer.getBoundingClientRect();
      const style = getComputedStyle(drawer);
      return {
        stuck: Math.abs(rect.top - parseFloat(style.top)) <= 1,
        clearsNavbar: rect.top >= navbar.bottom,
        fitsViewport: rect.bottom <= globalThis.innerHeight,
        overflow: style.overflow,
      };
    })
  ).toEqual({
    stuck: true,
    clearsNavbar: true,
    fitsViewport: true,
    overflow: "visible",
  });
});

/**
 * Opens every trial's drawer in turn and reports, per record, whether the
 * drawer could scroll (it must never be a scrollport), whether any of its
 * text pokes past its edge, and -- once the drawer is stuck under the navbar
 * -- whether the whole record is on screen and at what zoom.
 */
async function everyRecord(page: Page) {
  // The radar's markers, or the list's rows below the radar's floor.
  const markers = recordTriggers(page);
  const drawer = page.locator("#timeline-drawer");
  const close = page.getByRole("button", { name: "Close trial details" });
  const records = [];
  for (let i = 0; i < T.markers; i++) {
    await markers.nth(i).click();
    await expect(close).toBeFocused();
    const top = await drawer.evaluate((element) =>
      element.getBoundingClientRect().top + globalThis.scrollY
    );
    await page.evaluate((y) => globalThis.scrollTo(0, y), top);
    records.push(
      await drawer.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const body = element.querySelector(".timeline-drawer-body");
        const spills = [...element.querySelectorAll("*")]
          .filter((child) => {
            const rect = child.getBoundingClientRect();
            return rect.width > 0 && (
              rect.left < box.left - 0.5 || rect.right > box.right + 0.5 ||
              rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5
            );
          })
          .map((child) => child.textContent?.slice(0, 30));
        return {
          drug: element.querySelector("h2")!.textContent,
          overflow: style.overflow,
          spills,
          onScreen: box.bottom <= globalThis.innerHeight,
          zoom: body ? Number(getComputedStyle(body).zoom) : 1,
          fit: element.dataset.fit ?? null,
        };
      }),
    );
    await close.click();
  }
  return records;
}

for (
  const [width, height] of [[1440, 900], [1366, 768], [1280, 720]] as const
) {
  test(`at ${width}x${height} every trial record fits its drawer with no scrollbar`, async ({ page }) => {
    test.skip(T.markers === 0, NO_MARKER);
    await page.setViewportSize({ width, height });
    await figureSettled(page);
    for (const record of await everyRecord(page)) {
      expect(record, record.drug ?? "").toMatchObject({
        overflow: "visible",
        spills: [],
        onScreen: true,
        fit: null,
      });
      expect(record.zoom).toBeGreaterThanOrEqual(0.85);
    }
  });
}

test("a window too short for a record at the floor zoom lets the page scroll, not the drawer", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  await page.setViewportSize({ width: 1280, height: 520 });
  await figureSettled(page);
  const records = await everyRecord(page);
  for (const record of records) {
    // The box grows to hold the record: nothing spills, nothing scrolls.
    expect(record, record.drug ?? "").toMatchObject({
      overflow: "visible",
      spills: [],
    });
    if (record.fit === "page") expect(record.zoom).toBe(0.85);
    else expect(record.onScreen).toBe(true);
  }
  expect(records.some((record) => record.fit === "page")).toBe(true);
});

test("stacked above the plate, every trial record fits its drawer with no scrollbar", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  for (const [width, height] of [[1000, 800], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await figureSettled(page);
    for (const record of await everyRecord(page)) {
      expect(record, `${record.drug} at ${width}px`).toMatchObject({
        overflow: "visible",
        spills: [],
        zoom: 1,
        fit: null,
      });
    }
  }
});

// F34 fix round 2: .timeline-layout:has(.timeline-drawer:not([hidden]))
// sets flex-wrap: wrap so the key drops to a line below the plate in the
// row-direction rail case. Below the 1453px stack breakpoint the same
// container is flex-direction: column, where the identical flex-wrap: wrap
// instead split it into side-by-side column tracks once an open record's
// tall .timeline-main outgrew the container's hypothetical main size --
// dragging .timeline-scroll's overflow-x: auto along with it, so the plate
// stopped scrolling in its own box and the document scrolled sideways
// instead. Covers both the stacked case and the rail case runtime.spec.ts's
// overflow tripwire never reaches, because it never opens a drawer.
test("opening a trial record does not widen the document, stacked or railed", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  for (const width of [390, 900, 1200, 1440, 1512]) {
    await page.setViewportSize({ width, height: 900 });
    await figureSettled(page);
    await recordTriggers(page).first().click();
    await expect(page.locator("#timeline-drawer")).toBeVisible();
    if (width <= 1100) {
      // Un-stuck, not un-positioned: below 1100px the drawer drops from
      // sticky to relative and must give up the sticky rule's `top` too, or
      // it renders 152px below its slot onto the plate. The source rule
      // reads `top: auto`, but CSSOM resolves a positioned element's offset
      // to its *used* value -- a relative box with no explicit top/bottom
      // resolves that to 0 -- so the computed style reports "0px", not the
      // literal keyword.
      await expect(page.locator(".timeline-drawer")).toHaveCSS(
        "top",
        "0px",
      );
    }

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      scrollWidth,
      `${width}px: scrollWidth ${scrollWidth} vs clientWidth ${clientWidth}`,
    ).toBeLessThanOrEqual(clientWidth);
  }
});

test("an open record sits beside the plate at desktop width and above it when stacked", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/timeline");
  // The collapsed key above .timeline-main pushes the first g.drug marker a
  // few dozen pixels past the fold at this viewport, so Playwright's click
  // scrolls the page to centre it before acting -- which is enough scroll to
  // cross .timeline-drawer's sticky `top`, engaging it while the non-sticky
  // plate stays put. The assertion below is about the unscrolled desktop
  // layout, so the scroll it incidentally caused is undone before measuring.
  await page.locator("g.drug").first().click();
  await page.evaluate(() => window.scrollTo(0, 0));
  const drawer = page.locator(".timeline-drawer");
  const plate = page.locator(".timeline-main > .blueprint-frame");
  await expect(drawer).toBeVisible();
  const [d, p] = await Promise.all([drawer.boundingBox(), plate.boundingBox()]);
  expect(d!.x + d!.width).toBeLessThanOrEqual(p!.x + 1);
  expect(Math.abs(d!.y - p!.y)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 900, height: 900 });
  const [d2, p2] = await Promise.all([
    drawer.boundingBox(),
    plate.boundingBox(),
  ]);
  expect(d2!.y + d2!.height).toBeLessThanOrEqual(p2!.y + 1);
  expect(Math.round(d2!.width)).toBe(Math.round(p2!.width));
});

test("the figure's data colours do not follow the theme", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  await figureSettled(page);
  const cell = T.filledCell!;
  const wedge = page.locator(
    `path.wedge[data-pop="${cell.population}"][data-phase="${cell.phase}"]`,
  );
  const marker = page.locator("g.drug circle.marker").first();
  const before = {
    wedge: await wedge.getAttribute("fill"),
    marker: await marker.getAttribute("fill"),
    page: await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    ),
  };

  // A flip, not a destination: the assertion below is that the body ground
  // moved while the data colours did not, and `switchToDarkTheme` would end
  // where it started on a page that loaded dark -- no change to observe.
  await toggleTheme(page);
  await expect.poll(() =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ).not.toBe(before.page);

  await expect(wedge).toHaveAttribute("fill", before.wedge ?? "");
  await expect(marker).toHaveAttribute("fill", before.marker ?? "");
});

/**
 * `.timeline-legend-sample` cuts its disc from the figure plate with
 * stroke={PLATE} (#ffffff), and the evidence ring is stroked #14172b for the
 * same plate — but the sample itself sits on the themed legend panel, not the
 * plate. In dark mode the panel ground and the near-black ring resolve to
 * almost the same colour, so the "solid ring" state and the "no ring" state
 * of the key become visually the same thing: a disc with a white halo. A
 * measurement here has to resolve computed colour through a <canvas>, because
 * grounds authored in oklch/color-mix serialise as oklch()/color-mix(), which
 * a literal-string comparison would silently treat as unresolved (see
 * theme.spec.ts's file header for the same trap). `resolveCssColor`
 * (e2e/helpers.ts) is that canvas-compositing resolver -- shared with
 * theme.spec.ts's meta-tag check rather than kept as a second local copy.
 */
test("dark mode: the genetic-evidence ring is legible against its own ground", async ({ page }) => {
  await figureSettled(page);
  await switchToDarkTheme(page);
  await openKey(page);

  // The first `.timeline-legend-item` in the evidence key is "supported" --
  // enc.evidenceStates[0], the solid ring -- so its ring circle
  // (fill="none") is the one the key is teaching a reader to see. Collected
  // as raw computed-style strings here -- DOM access has to happen in the
  // page -- and resolved to concrete sRGBA below, one `resolveCssColor` call
  // per string.
  const { ringStroke, backgroundChain } = await page.evaluate(() => {
    const item = document.querySelector(
      ".timeline-legend-evidence .timeline-legend-item",
    )!;
    const sample = item.querySelector("svg.timeline-legend-sample")!;
    const ring = sample.querySelector('circle[fill="none"]')!;
    const chain: string[] = [];
    for (let n: Element | null = sample; n; n = n.parentElement) {
      chain.push(getComputedStyle(n).backgroundColor);
    }
    return {
      ringStroke: getComputedStyle(ring).stroke,
      backgroundChain: chain,
    };
  });

  // The sample sits on the themed legend panel, not the figure's fixed
  // plate, so its effective background is composited by walking up the
  // ancestor chain (nearest first) and stopping once a layer is fully
  // opaque -- getComputedStyle alone can't do this when a background is
  // itself semi-transparent (a color-mix() into transparent).
  let acc: RGBA | null = null;
  for (const css of backgroundChain) {
    const c = await page.evaluate(resolveCssColor, css);
    if (c) {
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 0.999) break;
    }
  }
  const white: RGBA = { r: 255, g: 255, b: 255, a: 1 };
  const bg = acc ? over(acc, white) : white;

  const ringColor = (await page.evaluate(resolveCssColor, ringStroke))!;
  const ratio = contrastRatio(over(ringColor, bg), bg);

  // WCAG 1.4.11 non-text contrast floor for a graphical object against its
  // background.
  expect(ratio, "evidence ring vs. its ground, dark mode")
    .toBeGreaterThanOrEqual(3);
});

/**
 * The tip row above a figure is the only place the page says what the figure
 * responds to. Both rows were dropped in the port from Shiny and nothing
 * noticed, which is what this pins.
 */
test("the timeline names its affordances and credits its source", async ({ page }) => {
  await page.goto("/timeline");
  const tips = page.locator(".tip-row .tip-box");
  await expect(tips).toHaveCount(2);
  await expect(tips.first()).toContainText("trial details panel");

  const citation = tips.nth(1);
  await expect(citation.locator("strong")).toHaveText("Visually-inspired by:");
  await expect(citation.getByRole("link", { name: /^DOI:/ })).toHaveAttribute(
    "href",
    "https://pubmed.ncbi.nlm.nih.gov/37251912/",
  );
});

test("activating the same open trial returns focus to its details", async ({ page }) => {
  test.skip(T.markers === 0, NO_MARKER);
  await figureSettled(page);
  const trial = page.locator("g.drug").first();
  const close = page.getByRole("button", { name: "Close trial details" });
  await trial.focus();
  await page.keyboard.press("Enter");
  await expect(close).toBeFocused();
  await trial.focus();
  await page.keyboard.press("Enter");
  await expect(close).toBeFocused();
});

test("a keyboard user can skip the figure to its end", async ({ page }) => {
  await page.goto("/timeline");
  const skip = page.getByRole("link", { name: "Skip the figure" });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await skip.press("Enter");
  await expect(page.locator("#timeline-end")).toBeInViewport();
  await expect(page.locator("#timeline-end")).toBeFocused();
});

test("the key sits above the plate and opens on demand", async ({ page }) => {
  await figureSettled(page);
  const key = page.locator("#timeline-key");
  await expect(key).not.toHaveAttribute("open", "");
  await expect(key.locator(".timeline-legend")).toBeHidden();
  const keyBox = await key.boundingBox();
  const plateBox = await page.locator(".timeline-main > .blueprint-frame")
    .boundingBox();
  expect(keyBox!.y + keyBox!.height).toBeLessThanOrEqual(plateBox!.y);
  await key.locator("summary").click();
  await expect(key.locator(".timeline-legend")).toBeVisible();
});

/**
 * The population-label edge clamp in islands/TrialsTimeline.tsx exists
 * because the *default* (67-of-102) selection reshapes the sectors enough to
 * push a label off the plate. `scripts/timeline_figure.py` draws only the
 * committed, unfiltered rows and carries no twin of that clamp -- so this is
 * the test that has to prove the clamp is inert on that one layout, not an
 * assumption left unchecked. It reruns `sweepLabelFit` (misfit/clipped/
 * touching/onBand/boxes) over the full figure once Show All is ticked, the
 * same sweep and the same numbers `label boxes fit their text...` pinned
 * before the radar carried a status filter at all.
 */
test("ticking Show All in the study-status group draws every trial", async ({ page }) => {
  await figureSettled(page);
  const group = page.getByRole("group", { name: /^Study status/ });
  await group.getByRole("checkbox", { name: /^Show All/ }).check();
  await expect(page.locator(".timeline-controls-count")).toContainText(
    `Showing ${EXPECTED.trialRows} of ${EXPECTED.trialRows} trials`,
  );
  // A new selection learns its own floor. At the project's 1280x720 the
  // height fit alone would shrink the plate past the scale at which the
  // labels clear its edge; the floor holds it above that, over a few solves.
  expect(await settleRadar(page)).toBe("radar");
  await expect(page.locator(FIGURE).locator("g.drug")).toHaveCount(
    T.allMarkers,
  );
  // One box per drug label, population label and phase label.
  await expect.poll(() => sweepLabelFit(page)).toEqual({
    misfit: [],
    clipped: [],
    touching: [],
    onBand: [],
    boxes: T.labelsAll,
  });
});
