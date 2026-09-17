import { expect, type Page, test } from "@playwright/test";

import { TRAIT_COUNT } from "../fixtures/expected-data.ts";
import { tooltip } from "../helpers.ts";

/**
 * The karyogram is drawn in-app by islands/Phenogram.tsx. Pill backgrounds are
 * fitted from getBBox() after the fonts settle, so anything that reads a box
 * polls rather than asserting once. The interactive layer is an HTML list of
 * buttons over the SVG, so the tooltip assertions are the same ones the tables
 * use.
 */

const FIGURE = "svg.phenogram-figure";

async function figureSettled(page: Page) {
  await page.goto("/phenogram");
  await expect(page.locator(FIGURE)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** The key is a closed `<details>` above the plate; open it before reading it. */
async function openKey(page: Page) {
  await page.locator("#phenogram-key summary").click();
}

test("draws 21 chromosomes, 79 gene blocks, 79 buttons and both legends", async ({ page }) => {
  await figureSettled(page);
  const figure = page.locator(FIGURE);
  await expect(figure).toHaveAttribute("viewBox", "0 0 1732 1160");
  await expect(figure.locator("g.phenogram-chromosome")).toHaveCount(21);
  await expect(figure.locator('g.phenogram-chromosome[data-chromosome="13"]'))
    .toHaveCount(1);
  await expect(figure.locator("g.phenogram-block")).toHaveCount(79);
  await expect(page.locator(".phenogram-genes button")).toHaveCount(79);
  await expect(page.locator(".phenogram-legend-family")).toHaveCount(7);
  await expect(page.locator(".phenogram-legend-traits .phenogram-pill"))
    .toHaveCount(TRAIT_COUNT);
  // The gene list is interactive on the figure; nothing hidden carries a link.
  await expect(page.locator(".visually-hidden a")).toHaveCount(0);
  await expect(page.locator(".phenogram-unplaced")).toHaveCount(0);
});

test("the raster's errors are gone: ABO on 9, C6orf195 on 6, COL4A1/2 on 13", async ({ page }) => {
  await figureSettled(page);
  for (
    const [symbol, chromosome] of [
      ["ABO", "9"],
      ["APOE", "19"],
      ["C6orf195", "6"],
      ["COL4A1/2", "13"],
    ]
  ) {
    await expect(
      page.locator(`${FIGURE} g.phenogram-block[data-gene="${symbol}"]`),
    ).toHaveAttribute("data-chromosome", chromosome);
  }
});

test("pill backgrounds fit their text and no two label blocks overlap", async ({ page }) => {
  await figureSettled(page);
  await expect.poll(() =>
    page.evaluate(() => {
      const misfit: string[] = [];
      const overlapping: string[] = [];
      const apart = (a: DOMRect, b: DOMRect) =>
        a.right < b.left || a.left > b.right || a.bottom < b.top ||
        a.top > b.bottom;

      for (
        const pill of document.querySelectorAll(
          "svg.phenogram-figure g.phenogram-pill-mark",
        )
      ) {
        const text = pill.querySelector<SVGTextElement>("text[data-pill]")!;
        const rect = pill.querySelector<SVGRectElement>("rect.pill-bg")!;
        const t = text.getBBox();
        const r = rect.getBBox();
        if (r.x > t.x || r.x + r.width < t.x + t.width) {
          misfit.push(text.dataset.pill ?? "?");
        }
      }

      const blocks = [
        ...document.querySelectorAll("svg.phenogram-figure g.phenogram-block"),
      ].map((g) => ({
        gene: g.getAttribute("data-gene") ?? "?",
        rect: g.querySelector("text.phenogram-symbol")!.getBoundingClientRect(),
        chromosome: g.getAttribute("data-chromosome"),
      }));
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          if (blocks[i].chromosome !== blocks[j].chromosome) continue;
          if (!apart(blocks[i].rect, blocks[j].rect)) {
            overlapping.push(`${blocks[i].gene}/${blocks[j].gene}`);
          }
        }
      }
      return { misfit, overlapping, blocks: blocks.length };
    })
  ).toEqual({ misfit: [], overlapping: [], blocks: 79 });
});

test("hovering a gene opens its tooltip and the keyboard reaches the NCBI link", async ({ page }) => {
  await figureSettled(page);
  const lamb1 = page.getByRole("button", { name: /^LAMB1, 7q31\.1\./ });
  await lamb1.hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page)).toContainText("Location");
  await expect(tooltip(page)).toContainText("7q31.1");
  await expect(tooltip(page)).toContainText("None found");
  await page.mouse.move(5, 5);
  await expect(tooltip(page)).toHaveCount(0);

  await lamb1.focus();
  await page.keyboard.press("Enter");
  await expect(tooltip(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tooltip(page).getByRole("link", { name: "View on NCBI Gene" }))
    .toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tooltip(page)).toHaveCount(0);
  await expect(lamb1).toBeFocused();
});

test("gene buttons follow chromosome order and name the evidence", async ({ page }) => {
  await figureSettled(page);
  const names = await page.locator(".phenogram-genes button").evaluateAll(
    (buttons) => buttons.map((b) => b.textContent?.trim() ?? ""),
  );
  expect(names[0]).toMatch(/^PCSK9, 1p32\.3\. GWAS phenotypes: none found\./);
  expect(names.find((n) => n.startsWith("CENPF,"))).toBe(
    "CENPF, 1q41. GWAS phenotypes: WM-PVS, HIP-PVS, PSMD. " +
      "Other evidence: Other omics, Monogenic disease.",
  );
  expect(names.at(-1)).toMatch(/^GLA, Xq22\.1\./);
});

test("the phenotype key explains WMH with its STRIVE-2 definition", async ({ page }) => {
  await figureSettled(page);
  await openKey(page);
  const key = page.locator(".phenogram-legend-traits");
  await key.getByRole("button", { name: "WMH", exact: true }).hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page)).toContainText(
    "White matter hyperintensities (of presumed vascular origin)",
  );
  await expect(tooltip(page)).toContainText("hyperintense on T2-weighted");
  await expect(tooltip(page).getByRole("link", { name: /STRIVE-2/ }))
    .toHaveAttribute("href", "https://doi.org/10.1016/S1474-4422(23)00131-X");

  await page.mouse.move(5, 5);
  await expect(tooltip(page)).toHaveCount(0);
  await key.getByRole("button", { name: "PSMD", exact: true }).hover();
  await expect(tooltip(page)).toContainText("Peak width of skeletonized");
  await expect(tooltip(page).getByRole("link")).toHaveCount(0);
});

test("the figure's data colours do not follow the theme", async ({ page }) => {
  await figureSettled(page);
  const pill = page.locator(`${FIGURE} rect.pill-bg`).first();
  const band = page.locator(
    `${FIGURE} g.phenogram-chromosome[data-chromosome="1"] rect`,
  ).nth(2);
  const before = {
    pill: await pill.getAttribute("fill"),
    band: await band.getAttribute("fill"),
    page: await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    ),
  };
  const plate = page.locator(".phenogram-canvas");
  const plateBefore = await plate.evaluate((el) =>
    getComputedStyle(el).backgroundColor
  );

  await page.getByRole("button", { name: /Switch to (dark|light) theme/ })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    /dark|light/,
  );
  await expect.poll(() =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ).not.toBe(before.page);

  await expect(pill).toHaveAttribute("fill", before.pill ?? "");
  await expect(band).toHaveAttribute("fill", before.band ?? "");
  expect(
    await plate.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(plateBefore);
});

test("the phenogram names its affordance", async ({ page }) => {
  await page.goto("/phenogram");
  const tips = page.locator(".tip-row .tip-box");
  await expect(tips).toHaveCount(1);
  await expect(tips.first()).toContainText("Hover over or activate a gene");
  await expect(tips.first()).toContainText("focus the item and press Enter");
});

test("a keyboard user can skip the figure to its end", async ({ page }) => {
  await page.goto("/phenogram");
  const skip = page.getByRole("link", { name: "Skip the figure" });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await skip.press("Enter");
  await expect(page.locator("#phenogram-end")).toBeInViewport();
  await expect(page.locator("#phenogram-end")).toBeFocused();
});

test("the key sits above the plate and opens on demand", async ({ page }) => {
  await page.goto("/phenogram");
  const key = page.locator("#phenogram-key");
  await expect(key).not.toHaveAttribute("open", "");
  const keyBox = await key.boundingBox();
  const plateBox = await page.locator(".phenogram-layout > .blueprint-frame")
    .boundingBox();
  expect(keyBox!.y + keyBox!.height).toBeLessThanOrEqual(plateBox!.y);
  await key.locator("summary").click();
  await expect(key.locator(".phenogram-legend")).toBeVisible();
});
