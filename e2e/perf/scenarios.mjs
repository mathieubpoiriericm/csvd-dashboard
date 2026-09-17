import { expect } from "@playwright/test";

const ROWS = "table.data-table tbody tr";
const ready = (selector) => (page) => page.waitForSelector(selector);
const tableReady = ready('.table-controls[data-hydrated="true"]');
const timelineReady = ready('.timeline-layout[data-hydrated="true"]');
const aboutReady = ready('.pipeline-card[data-hydrated="true"]');
const phenogramReady = ready('.phenogram-layout[data-hydrated="true"]');
const mapReady = ready(".leaflet-container .leaflet-marker-icon");

/** Fonts plus a bounded quiet DOM period and completed CSS transitions. */
export async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document.getAnimations().filter((a) =>
        a.effect?.getComputedTiming().iterations !== Infinity
      ).map((a) => a.finished.catch(() => {})),
    );
    await new Promise((resolve, reject) => {
      let timer;
      const timeout = setTimeout(() => {
        observer.disconnect();
        clearTimeout(timer);
        reject(new Error("DOM did not settle within 5 seconds"));
      }, 5000);
      const finish = () => {
        observer.disconnect();
        clearTimeout(timeout);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, 100);
      });
      observer.observe(document.querySelector("main") ?? document.body, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      timer = setTimeout(finish, 100);
    });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  });
}

export const ROUTES = [
  { route: "/", label: "About", ready: aboutReady },
  { route: "/genes", label: "Genes", ready: tableReady },
  { route: "/phenogram", label: "Phenogram", ready: phenogramReady },
  { route: "/trials", label: "Clinical Trials", ready: tableReady },
  { route: "/timeline", label: "Trials Timeline", ready: timelineReady },
  { route: "/map", label: "Trials Map", ready: mapReady },
];
const key = (route) => route === "/" ? "about" : route.slice(1);
export const LOAD_SCENARIOS = [
  ...ROUTES.map((route) => ({
    ...route,
    id: `load/${key(route.route)}`,
    kind: "load",
    blockTiles: true,
  })),
  ...["mobile", "network", "warm-cache"].flatMap((mode) =>
    ROUTES.map((route) => ({
      ...route,
      id: `${mode}/${key(route.route)}`,
      label: `${mode} ${route.label}`,
      kind: "load",
      blockTiles: true,
      warm: mode === "warm-cache",
      network: mode === "network",
      viewport: mode === "mobile" ? { width: 390, height: 844 } : undefined,
    }))
  ),
  {
    id: "load/map-live-tiles",
    route: "/map",
    label: "Map with live tiles",
    kind: "load",
    ready: mapReady,
  },
  {
    id: "load/login",
    route: "/login",
    label: "Login",
    kind: "load",
    unauthenticated: true,
    ready: ready('input[name="passphrase"]'),
  },
];
const interaction = (id, ready, act, extra = {}) => ({
  id,
  label: id,
  route: `/${id.split("/")[0] === "about" ? "" : id.split("/")[0]}`,
  kind: "interaction",
  ready,
  act,
  ...extra,
});
const rows = (page) => page.locator(ROWS);
const pageSize = (page) => page.locator(".table-control select");
const tip = (page) => page.locator(".tooltip-pop.is-placed");
const theme = async (page) => {
  const button = page.getByRole("button", {
    name: /Switch to (dark|light) theme/,
  });
  const before = await button.getAttribute("aria-label");
  await button.click();
  await expect(button).not.toHaveAttribute("aria-label", before);
};
const search = (table) => async (page) => {
  const text = table === "genes" ? "COL4A" : "Cerebrolysin";
  const field = page.getByPlaceholder(
    table === "genes" ? "Search genes" : "Search trials",
  );
  await field.pressSequentially(text, { delay: 80 });
  await expect(page.getByRole("status")).toContainText(`Search: “${text}”`);
  await expect(rows(page).first()).toContainText(new RegExp(text, "i"));
};
const size100 = async (page) => {
  await pageSize(page).selectOption("100");
  await expect.poll(() => rows(page).count()).toBeGreaterThan(10);
};
const tooltipHover = async (page) => {
  await page.locator("tbody .tooltip-box").first().hover();
  await expect(tip(page)).toBeVisible();
};
export const INTERACTION_SCENARIOS = [
  interaction("timeline/hover-marker", timelineReady, async (page) => {
    for (const index of [0, 12, 24, 48]) {
      await page.mouse.move(0, 0);
      await expect(page.locator(".timeline-tooltip")).toHaveCount(0);
      const marker = page.locator("g.drug").nth(index);
      const circle = marker.locator("circle.marker");
      await circle.scrollIntoViewIfNeeded();
      const point = await circle.evaluate((circle) => {
        const screen = new DOMPoint(
          circle.cx.baseVal.value,
          circle.cy.baseVal.value,
        )
          .matrixTransform(circle.getScreenCTM());
        if (
          document.elementFromPoint(screen.x, screen.y)?.closest("g.drug") !==
            circle.parentElement
        ) {
          throw new Error("Marker center is not hit-testable");
        }
        return { x: screen.x, y: screen.y };
      });
      await page.mouse.move(point.x, point.y);
      await expect(page.locator(".timeline-tooltip")).toBeVisible();
      await expect(page.locator(".timeline-tooltip-title")).toContainText(
        await marker.getAttribute("data-drug"),
      );
    }
  }),
  interaction("timeline/hover-wedge", timelineReady, async (page) => {
    for (const index of [0, 6]) {
      await page.mouse.move(0, 0);
      await expect(page.locator(".timeline-tooltip")).toHaveCount(0);
      const wedge = page.locator(".wedge").nth(index);
      await wedge.scrollIntoViewIfNeeded();
      const point = await wedge.evaluate((path) => {
        const box = path.getBBox();
        for (let x = 0.05; x < 1; x += 0.05) {
          for (let y = 0.05; y < 1; y += 0.05) {
            const point = new DOMPoint(
              box.x + box.width * x,
              box.y + box.height * y,
            );
            if (path.isPointInFill(point)) {
              const screen = point.matrixTransform(path.getScreenCTM());
              if (document.elementFromPoint(screen.x, screen.y) === path) {
                return { x: screen.x, y: screen.y };
              }
            }
          }
        }
        throw new Error("No interior point found for population wedge");
      });
      await page.mouse.move(point.x, point.y);
      await expect(page.locator(".timeline-tooltip")).toBeVisible();
      await expect(page.locator(".timeline-tooltip")).toContainText(
        await wedge.getAttribute("data-phase"),
      );
    }
  }),
  interaction("timeline/open-drawer", timelineReady, async (page) => {
    await page.locator("g.drug").first().press("Enter");
    await expect(page.locator("#timeline-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#timeline-drawer")).toBeHidden();
  }),
  ...["genes", "trials"].flatMap((table) => [
    interaction(`${table}/search`, tableReady, search(table)),
    interaction(`${table}/search-100`, tableReady, search(table), {
      prepare: size100,
    }),
    interaction(`${table}/page-size-100`, tableReady, size100),
    interaction(`${table}/pagination`, tableReady, async (page) => {
      const first = (await rows(page).first().textContent()) ?? "";
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(rows(page).first()).not.toHaveText(first);
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(rows(page).first()).toHaveText(first);
    }),
    interaction(`${table}/collapse`, tableReady, async (page) => {
      await page.getByRole("button", { name: "Hide filters" }).click();
      await expect(page.getByRole("button", { name: "Show filters" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Show filters" }).click();
      await expect(page.getByRole("button", { name: "Hide filters" }))
        .toBeVisible();
    }),
    interaction(`${table}/sort`, tableReady, async (page) => {
      const button = page.locator("thead button").nth(2);
      const cell = button.locator("..");
      const before = await cell.getAttribute("aria-sort");
      await button.click();
      await expect(cell).not.toHaveAttribute("aria-sort", before);
    }),
    interaction(`${table}/filter-toggle`, tableReady, async (page) => {
      const group = page.getByRole("group", {
        name: table === "genes" ? "GWAS Traits" : "Clinical Trial Phase",
        exact: true,
      });
      const box = group.getByRole("checkbox", {
        name: table === "genes" ? "WMH" : "Clinical Trial Phase II",
        exact: true,
      });
      await box.click();
      await expect(box).toBeChecked();
      await expect(page.locator(".filter-active")).not.toBeEmpty();
      await group.getByRole("checkbox", { name: "Show All", exact: true })
        .click();
      await expect(page.locator(".filter-none")).toHaveText("None");
    }),
  ]),
  interaction("genes/tooltip-hover", tableReady, tooltipHover),
  interaction("genes/keyboard-tooltip", tableReady, async (page) => {
    const button = page.locator("tbody .tooltip-box").first();
    await button.press("Enter");
    await expect(tip(page)).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(tip(page).getByRole("link")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(tip(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  }),
  interaction("genes/theme-toggle", tableReady, theme),
  interaction("phenogram/hover-gene", phenogramReady, async (page) => {
    for (const index of [0, 20]) {
      await page.locator("ul.phenogram-genes .tooltip-box").nth(index).hover();
      await expect(tip(page)).toBeVisible();
    }
  }),
  interaction("about/toggle-step", aboutReady, async (page) => {
    const button = page.locator(".pipeline-step-head:not([disabled])").first();
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
  }),
  interaction("about/drawer", aboutReady, async (page) => {
    await page.getByRole("button", {
      name: "View everything this run recorded",
    }).click();
    await expect(page.locator("#pipeline-run-drawer")).toBeVisible();
    await expect(page.locator(".pipeline-record").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Close run details" }))
      .toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#pipeline-run-drawer")).toBeHidden();
  }),
  interaction("map/zoom", mapReady, async (page) => {
    const before = await page.locator(".leaflet-marker-icon").first()
      .getAttribute("style");
    await page.locator(".leaflet-control-zoom-in").click();
    await expect(page.locator(".leaflet-marker-icon").first()).not
      .toHaveAttribute("style", before);
    await expect(page.locator(".leaflet-zoom-anim, .leaflet-cluster-anim"))
      .toHaveCount(0);
  }, { blockTiles: true }),
  interaction("map/theme", mapReady, theme, { blockTiles: true }),
  interaction("map/pan", mapReady, async (page) => {
    const map = page.locator(".leaflet-container");
    const pane = page.locator(".leaflet-map-pane");
    const before = await pane.getAttribute("style");
    const box = await map.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 100,
      box.y + box.height / 2 + 50,
      { steps: 10 },
    );
    await page.mouse.up();
    await expect(pane).not.toHaveAttribute("style", before);
  }, { blockTiles: true }),
];
export const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "laptop", width: 1440, height: 900 },
  { name: "desktop", width: 1920, height: 1080 },
];
