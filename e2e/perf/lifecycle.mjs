import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { INTERACTION_SCENARIOS, ROUTES, settle } from "./scenarios.mjs";
import { zonesFromTrace } from "./tracy.mjs";

/** Retained DOM/listeners and heap, measured after warm-up and explicit GC. */
export async function runLifecycle(
  { browser, storageState, base, out, trace, configure },
) {
  const ids = [
    "genes/pagination",
    "trials/pagination",
    "genes/tooltip-hover",
    "phenogram/hover-gene",
    "timeline/open-drawer",
    "about/drawer",
  ];
  const scenarios = ids.map((id) =>
    INTERACTION_SCENARIOS.find((s) => s.id === id)
  );
  scenarios.push({
    ...ROUTES.find((s) => s.route === "/map"),
    id: "map/popup",
    blockTiles: true,
    act: async (page) => {
      await openMapPopup(page);
      await expect(page.locator(".map-popup")).toBeVisible();
      await page.locator(".leaflet-popup-close-button").click();
      await expect(page.locator(".map-popup")).toHaveCount(0);
    },
  });
  const reports = [];
  for (const scenario of scenarios) {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    const snapshots = [];
    const stem = `${out}lifecycle-${scenario.id.replaceAll("/", "_")}`;
    let tracing = false;
    const report = {
      id: scenario.id,
      cycles: 20,
      warmupCycles: 5,
      snapshots,
      status: "running",
    };
    reports.push(report);
    try {
      await configure(page, scenario);
      await page.goto(`${base}${scenario.route}`);
      await scenario.ready(page);
      await settle(page);
      const cdp = await context.newCDPSession(page);
      const cycle = async () => {
        await scenario.act(page);
        await page.mouse.move(0, 0);
        await page.keyboard.press("Escape");
        await expect(page.locator(".tooltip-pop.is-placed")).toHaveCount(0);
        await settle(page);
      };
      const snapshot = async (cycle) => {
        await cdp.send("HeapProfiler.collectGarbage");
        snapshots.push({
          cycle,
          ...await cdp.send("Memory.getDOMCounters"),
          ...await cdp.send("Runtime.getHeapUsage"),
        });
        await writeFile(
          `${out}lifecycle.json`,
          JSON.stringify(reports, null, 2),
        );
      };
      for (let i = -4; i <= 0; i++) {
        await cycle();
        await snapshot(i);
      }
      if (trace) {
        await browser.startTracing(page, { path: `${stem}.json` });
        tracing = true;
      }
      for (let i = 1; i <= 20; i++) {
        await cycle();
        await snapshot(i);
      }
      if (tracing) {
        await browser.stopTracing();
        tracing = false;
      }
      if (trace) {
        await zonesFromTrace(`${stem}.json`, `${stem}.tracy`);
        report.capture = `${stem}.tracy`;
      }
      const first = snapshots.find((s) => s.cycle === 0),
        last = snapshots.at(-1);
      report.retainedNodeDelta = last.nodes - first.nodes;
      report.retainedListenerDelta = last.jsEventListeners -
        first.jsEventListeners;
      expect(report.retainedNodeDelta, `${scenario.id} retained nodes`).toBe(0);
      expect(report.retainedListenerDelta, `${scenario.id} retained listeners`)
        .toBe(0);
      report.status = "passed";
    } catch (error) {
      report.status = "failed";
      report.error = error.message;
      process.exitCode = 1;
    } finally {
      if (tracing) await browser.stopTracing().catch(() => {});
      await context.close();
      await writeFile(`${out}lifecycle.json`, JSON.stringify(reports, null, 2));
      console.log(`  lifecycle/${scenario.id}: ${report.status}`);
    }
  }
  return reports;
}

async function openMapPopup(page) {
  await expect(page.locator(".trials-map.leaflet-container")).toBeVisible();
  // Leaflet keeps a path in the overlay pane for markers it has not laid out
  // yet, drawn as `d="M0 0"`. With 431 facility sites one of those is often
  // first in document order, so the visible ones are what this drills for.
  const marker = page.locator(
    ".leaflet-overlay-pane path.leaflet-interactive:visible",
  );
  const cluster = page.locator(".marker-cluster");
  const markerInView = () =>
    marker.evaluateAll((elements) => {
      const map = document.querySelector(".trials-map")
        .getBoundingClientRect();
      return elements.findIndex((element) => {
        const box = element.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        return x > map.left && x < map.right && y > map.top && y < map.bottom;
      });
    });

  await expect(async () => {
    if (await markerInView() === -1) {
      if (await cluster.count() > 0) {
        await cluster.first().click();
      } else {
        await page.getByRole("button", { name: "Zoom in" }).click();
      }
    }
    // Let the zoom animation settle so the click lands on a stable target.
    await expect(page.locator(".leaflet-zoom-anim, .leaflet-cluster-anim"))
      .toHaveCount(0);
    expect(await markerInView()).toBeGreaterThanOrEqual(0);
  }).toPass({ timeout: 30_000 });

  await marker.nth(await markerInView()).click();
}
