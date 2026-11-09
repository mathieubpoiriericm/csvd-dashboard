import { expect, type Page } from "@playwright/test";

/**
 * Helpers shared by the radar's specs: e2e/tests/timeline.spec.ts,
 * e2e/tests/timeline-responsive.spec.ts and the cSVD one under csvd/.
 */

/**
 * misfit/clipped/touching/onBand/boxes over whatever the plate currently
 * shows. Shared between the default (67-of-102) figure and the full one
 * reached by ticking Show All in the status group, so the population-label
 * plate correction (islands/TrialsTimeline.tsx) is checked against both the
 * layout it was built for and the committed layout it must stay inert on -- the latter is
 * also what `scripts/timeline_figure.py` draws, so this is the guard that
 * keeps the two renderers' claims about the full dataset in step.
 */
export function sweepLabelFit(page: Page) {
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

/** The layout the island chose: `data-mode` on `.timeline-layout`. */
export function radarMode(page: Page) {
  return page.locator(".timeline-layout").getAttribute("data-mode");
}

/** The readable-width floor the island has learnt, in CSS px (0 if none). */
export async function radarFloor(page: Page) {
  return Number(
    await page.locator(".timeline-layout").getAttribute("data-floor"),
  );
}

/**
 * Waits until the island has stopped deciding: the drug labels are set for
 * the plate's current scale (12px on screen) by a hydrated island, and the
 * mode, floor, stacking and plate width read the same twice running. A floor
 * is learnt over several solves of a frame or two each, so a single read can
 * land between them. Returns the mode it settled in.
 */
export async function settleRadar(page: Page): Promise<string> {
  await page.evaluate(() => document.fonts.ready);
  let last = "";
  await expect.poll(async () => {
    const now = await page.evaluate(() => {
      const root = document.querySelector(".timeline-layout")!;
      const svg = document.querySelector<SVGSVGElement>(
        "svg.timeline-figure",
      );
      const text = svg?.querySelector('text[data-label^="drug-"]');
      const scaled = !svg || !text ||
        Math.abs(
            Number(text.getAttribute("font-size")) * svg.getScreenCTM()!.a -
              12,
          ) < 0.05;
      return JSON.stringify({
        mode: root.getAttribute("data-mode"),
        floor: root.getAttribute("data-floor"),
        stack: document.querySelector(".timeline-main")!
          .getAttribute("data-stack"),
        plate: svg?.getBoundingClientRect().width.toFixed(1) ?? null,
        ready: root.hasAttribute("data-hydrated") && scaled,
      });
    });
    const settled = now === last && JSON.parse(now).ready;
    last = now;
    return settled;
  }, { intervals: [250], timeout: 15_000 }).toBe(true);
  return JSON.parse(last).mode;
}

/**
 * Whatever opens a record in the layout on screen: the radar's markers, or
 * the phone list's rows. Only one of the two is ever mounted.
 */
export function recordTriggers(page: Page) {
  return page.locator(
    "svg.timeline-figure g.drug circle.marker, .timeline-list button.timeline-row",
  );
}
