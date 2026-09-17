import { expect, type Locator, type Page, test } from "@playwright/test";
import { resolveCssColor, switchToDarkTheme, toggleTheme } from "../helpers.ts";

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

async function figureSettled(page: Page) {
  await page.goto("/timeline");
  await expect(page.locator(FIGURE)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** The key is a closed `<details>` above the plate; open it before reading it. */
async function openKey(page: Page) {
  await page.locator("#timeline-key summary").click();
}

/**
 * misfit/clipped/touching/onBand/boxes over whatever the plate currently
 * shows. Shared between the default (67-of-102) figure and the full one
 * reached by ticking Show All in the status group, so the population-label
 * plate correction (islands/TrialsTimeline.tsx) is checked against both the
 * layout it was built for and the committed layout it must stay inert on -- the latter is
 * also what `scripts/timeline_figure.py` draws, so this is the guard that
 * keeps the two renderers' claims about the full dataset in step.
 */
function sweepLabelFit(page: Page) {
  return page.evaluate(() => {
    const misfit: string[] = [];
    const clipped: string[] = [];
    const touching: string[] = [];
    let boxes = 0;

    // The plate's own bounds, read off the element rather than retyped, so
    // this cannot drift from lib/timeline.ts's CANVAS. (The first test in
    // this file is what pins the viewBox itself.)
    const figure = document.querySelector<SVGSVGElement>(
      "svg.timeline-figure",
    )!;
    const [minX, minY, vbWidth, vbHeight] = figure
      .getAttribute("viewBox")!
      .split(/\s+/)
      .map(Number);

    for (const group of document.querySelectorAll("svg.timeline-figure g")) {
      const text = group.querySelector<SVGTextElement>("text[data-label]");
      const rect = group.querySelector<SVGRectElement>("rect.label-bg");
      if (!text || !rect) continue;
      const id = text.dataset.label ?? "?";
      const drug = group.getAttribute("data-drug");
      const who = drug ? `${id} "${drug}"` : id;
      const t = text.getBBox();
      const r = rect.getBBox();
      const fits = r.x <= t.x && r.y <= t.y &&
        r.x + r.width >= t.x + t.width && r.y + r.height >= t.y + t.height;
      if (!fits) misfit.push(who);

      // The outermost <svg> clips to its viewBox, and the plate rect pins
      // every getBBox() to exactly the canvas, so a label pushed past an
      // edge is silently cut in half and no other check here can see it.
      const past: string[] = [
        ["left", minX - r.x],
        ["top", minY - r.y],
        ["right", r.x + r.width - (minX + vbWidth)],
        ["bottom", r.y + r.height - (minY + vbHeight)],
      ]
        .filter(([, by]) => (by as number) > 0.01)
        .map(([edge, by]) => `${edge} by ${(by as number).toFixed(1)}`);
      if (past.length) clipped.push(`${who} past the ${past.join(" and ")}`);
      boxes++;
    }

    // Every label -- a drug's or a population's -- against every marker, not
    // just its own: `separateLabels` treats every marker as an obstacle for a
    // drug label, and the population-label plate clamp only pulls a label
    // clear of the canvas edge, not clear of a marker it might land on
    // instead. drugs[j] names the marker in a touching pair.
    const drugs = [
      ...document.querySelectorAll("svg.timeline-figure g.drug"),
    ];
    const markers = drugs.map((drug) =>
      drug.querySelector("circle.marker")!.getBoundingClientRect()
    );
    const drugLabels = drugs.map((drug) => ({
      name: drug.getAttribute("data-drug") ?? "?",
      rect: drug.querySelector("rect.label-bg")!.getBoundingClientRect(),
    }));
    const popLabels = [
      ...document.querySelectorAll("svg.timeline-figure g.pop-label"),
    ].map((pop) => ({
      name: `pop-${pop.getAttribute("data-pop")}`,
      rect: pop.querySelector("rect.label-bg")!.getBoundingClientRect(),
    }));
    for (const label of [...drugLabels, ...popLabels]) {
      for (let j = 0; j < markers.length; j++) {
        const marker = markers[j];
        const apart = marker.right < label.rect.left ||
          marker.left > label.rect.right ||
          marker.bottom < label.rect.top || marker.top > label.rect.bottom;
        if (apart) continue;
        touching.push(
          `${label.name} on ${drugs[j].getAttribute("data-drug")}`,
        );
      }
    }

    // A population label may lie on no rim band -- least of all its own,
    // which sits POPULATION_LABEL_OFFSET units inside it and is the element
    // the name is *about*. Pulling a label that fell off the plate straight
    // back on used to drag it across exactly that band, on three of the four
    // names under the default selection; `placeOnPlate` slides it round its
    // sector instead, and this is what says so.
    //
    // A band is an annular arc, so its bounding box covers most of the
    // quadrant it spans and a box test would report every label near one.
    // The label box is sampled on a 2-unit grid and each band asked about
    // its own geometry with isPointInFill instead.
    const onBand: string[] = [];
    const bands = [
      ...document.querySelectorAll<SVGPathElement>(
        "svg.timeline-figure path.rim-band",
      ),
    ];
    for (
      const pop of document.querySelectorAll("svg.timeline-figure g.pop-label")
    ) {
      const box = pop.querySelector<SVGRectElement>("rect.label-bg")!.getBBox();
      const columns = Math.max(1, Math.ceil(box.width / 2));
      const rows = Math.max(1, Math.ceil(box.height / 2));
      const samples: { x: number; y: number }[] = [];
      for (let i = 0; i <= columns; i++) {
        for (let j = 0; j <= rows; j++) {
          samples.push({
            x: box.x + (box.width * i) / columns,
            y: box.y + (box.height * j) / rows,
          });
        }
      }
      for (const band of bands) {
        if (!samples.some((point) => band.isPointInFill(point))) continue;
        onBand.push(
          `pop-${pop.getAttribute("data-pop")} on ${
            band.getAttribute("data-pop") ?? "?"
          }`,
        );
      }
    }

    return { misfit, clipped, touching, onBand, boxes };
  });
}

test("draws one group per visible trial, twenty-eight cells, and both legends", async ({ page }) => {
  await figureSettled(page);
  await openKey(page);
  const figure = page.locator(FIGURE);
  // lib/timeline.ts's CANVAS, and .timeline-figure's min-width in
  // assets/app.css, which is the same number.
  await expect(figure).toHaveAttribute("viewBox", "0 0 1072 940");
  // Completed trials are hidden by default: 67 of 102 rows visible.
  await expect(figure.locator("g.drug")).toHaveCount(67);
  await expect(figure.locator("path.wedge")).toHaveCount(28);
  await expect(figure.locator("path.rim-band")).toHaveCount(4);
  // A ring means somebody assessed the drug's genetics: 8 found evidence,
  // 7 looked and found none. The other 52 markers were never assessed.
  await expect(figure.locator("circle.evidence")).toHaveCount(15);
  await expect(figure.locator("circle.gap")).toHaveCount(8);
  await expect(figure.locator("g.pop-label")).toHaveCount(4);
  await expect(figure.locator("g.phase-label")).toHaveCount(7);
  // Thirteen of the fourteen families are represented among the visible
  // trials' mechanisms.
  await expect(page.locator(".timeline-legend-family")).toHaveCount(13);
  // 3 evidence states + 1 record-completeness row + 36 mechanisms among the
  // visible trials (Completed trials carry the other 10).
  await expect(page.locator(".timeline-legend-item")).toHaveCount(40);

  // Every legend swatch is a different colour — the old palette cycled 9
  // colours over 11 mechanisms, and tests/timeline_encoding_test.ts holds
  // the same rule over all 46 in the encoding; only 36 are drawn among the
  // default-visible trials.
  const swatches = await page.locator(".timeline-legend-dot").evaluateAll(
    (dots) => dots.map((dot) => getComputedStyle(dot).backgroundColor),
  );
  expect(new Set(swatches).size).toBe(36);
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
  // 67 drug labels + 4 population labels + 7 phase labels.
  await expect.poll(() => sweepLabelFit(page)).toEqual({
    misfit: [],
    clipped: [],
    touching: [],
    onBand: [],
    boxes: 78,
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
  expect(measured).toEqual({ colliding: [], boxes: 67, control: true });
});

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

test("an unassessed drug draws no ring and an assessed negative draws a dashed one", async ({ page }) => {
  await figureSettled(page);
  const figure = page.locator(FIGURE);
  const dashed = figure.locator("circle.evidence[stroke-dasharray]");
  await expect(dashed).toHaveCount(7);
  const solid = figure.locator("circle.evidence:not([stroke-dasharray])");
  await expect(solid).toHaveCount(8);
});

test("the trial drawer has pointer and keyboard close controls", async ({ page }) => {
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
  // The first marker drawn is the first CAA trial in table order.
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText(
    "Jiedu Huayu",
  );
  await expect(drawer.locator("dt")).toHaveCount(12);

  // Jiedu Huayu is a multi-component herbal preparation, so its record is
  // flagged. The note is a statement about the record and sits above the
  // field list, which keeps its twelve rows either way.
  const flag = drawer.locator(".timeline-drawer-flag");
  await expect(flag).toBeVisible();
  await expect(flag).toContainText("Incomplete record");
  await expect(flag.locator("li")).toHaveText([
    "Mechanism of action not characterised",
  ]);
  // Never colour alone: the note carries a glyph and the word as well.
  await expect(flag.locator("svg.icon")).toHaveCount(1);

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

test("the sticky trial drawer clears the navbar and scrolls long records", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 800 });
  await figureSettled(page);
  await page.locator("g.drug").first().locator("circle.marker").click();

  const drawer = page.locator("#timeline-drawer");
  await expect(drawer).toBeVisible();
  const documentTop = await drawer.evaluate((element) =>
    element.getBoundingClientRect().top + globalThis.scrollY
  );
  await page.evaluate((top) => globalThis.scrollTo(0, top), documentTop);

  await expect.poll(async () =>
    page.evaluate(() => {
      const navbar = document.querySelector(".navbar")!.getBoundingClientRect();
      const drawer = document.querySelector<HTMLElement>("#timeline-drawer")!;
      const rect = drawer.getBoundingClientRect();
      return {
        clearsNavbar: rect.top >= navbar.bottom,
        fitsViewport: rect.bottom <= globalThis.innerHeight,
        scrollable: drawer.scrollHeight > drawer.clientHeight,
        overflowY: getComputedStyle(drawer).overflowY,
      };
    })
  ).toEqual({
    clearsNavbar: true,
    fitsViewport: true,
    scrollable: true,
    overflowY: "auto",
  });
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
  for (const width of [390, 900, 1200, 1440, 1512]) {
    await page.setViewportSize({ width, height: 900 });
    await figureSettled(page);
    await page.locator("g.drug").first().locator("circle.marker").click();
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

test("the figure's data colours do not follow the theme", async ({ page }) => {
  await figureSettled(page);
  const wedge = page.locator('path.wedge[data-pop="CAA"][data-phase="III"]');
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

test("activating the same open trial returns focus to its details", async ({ page }) => {
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
  await expect(page.locator(FIGURE).locator("g.drug")).toHaveCount(102);
  await expect(page.locator(".timeline-controls-count")).toContainText(
    "Showing 102 of 102 trials",
  );
  // 102 drug labels + 4 population labels + 7 phase labels.
  await expect.poll(() => sweepLabelFit(page)).toEqual({
    misfit: [],
    clipped: [],
    touching: [],
    onBand: [],
    boxes: 113,
  });
});
