import { expect, type Page, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import manifest from "../../disease/manifest.json" with { type: "json" };
import { EXPECTED } from "../fixtures/expected-data.ts";
import { tooltip } from "../helpers.ts";

/**
 * The "Download SVG" menu on /phenogram saves the karyogram, with or without
 * its key, as a standalone file. These tests read the saved files themselves;
 * every count comes from the committed data through EXPECTED.
 */

const P = EXPECTED.phenogram;
const KEY = manifest.disease.key;
const FIGURE = "svg.phenogram-figure";

async function open(page: Page) {
  await page.goto("/phenogram");
  await expect(page.locator(FIGURE)).toBeVisible();
}

/** Opens the menu and chooses `entry`; returns the saved file's name and text. */
async function download(page: Page, entry: "Figure only" | "Figure with key") {
  await page.getByRole("button", { name: /Download SVG/ }).click();
  const [saved] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: entry }).click(),
  ]);
  const path = await saved.path();
  return { name: saved.suggestedFilename(), svg: await readFile(path, "utf8") };
}

const count = (svg: string, pattern: RegExp) => svg.match(pattern)?.length ?? 0;

test("figure only: one group per chromosome and gene, no key", async ({ page }) => {
  await open(page);
  const { name, svg } = await download(page, "Figure only");
  expect(name).toMatch(
    new RegExp(`^${KEY}-dashboard-phenogram_\\d{2}-\\d{2}-\\d{4}\\.svg$`),
  );
  expect(count(svg, /id="chr-/g)).toBe(P.chromosomes);
  expect(count(svg, /id="gene-\d+"/g)).toBe(P.blocks);
  expect(svg).not.toContain('id="key"');
});

test("figure with key: the key sits above the figure and lists the page key", async ({ page }) => {
  await open(page);
  const { name, svg } = await download(page, "Figure with key");
  expect(name).toMatch(
    new RegExp(`^${KEY}-dashboard-phenogram-key_\\d{2}-\\d{2}-\\d{4}\\.svg$`),
  );
  expect(svg.indexOf('id="key"')).toBeGreaterThan(-1);
  expect(svg.indexOf('id="key"')).toBeLessThan(svg.indexOf('id="karyogram"'));
  expect(count(svg, /id="key-family-\d+"/g)).toBe(P.families);
  const start = svg.indexOf('id="key-phenotypes"');
  expect(start).toBeGreaterThan(-1);
  const phenotypes = svg.slice(start, svg.indexOf('id="karyogram"'));
  // One pill per legend trait; the panel's other rects would only add to this.
  expect(count(phenotypes, /<rect /g)).toBeGreaterThanOrEqual(P.legendTraits);
  expect(count(svg, /id="chr-/g)).toBe(P.chromosomes);
});

test("downloaded pills fit their text in Barlow", async ({ page }) => {
  await open(page);
  // Choose the entry before the fonts settle, as a quick reader would.
  const withKey = await download(page, "Figure with key");
  await page.evaluate(() => document.fonts.ready);

  const result = await page.evaluate(async (svg) => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:2000px";
    host.innerHTML = svg.replace(/^<\?xml[^>]*\?>/, "");
    document.body.append(host);
    // Hinting rounds glyph advances at the file's own 1:1 size; enlarged,
    // getBBox reports the face's true widths, which is what an editor lays out.
    const root = host.querySelector("svg")!;
    root.style.maxWidth = "none";
    root.setAttribute("width", `${root.viewBox.baseVal.width * 10}px`);
    root.setAttribute("height", `${root.viewBox.baseVal.height * 10}px`);
    // Barlow loads when the inserted text first needs it.
    host.getBoundingClientRect();
    await Promise.all([document.fonts.load("400 9.5px Barlow"), document.fonts.load("600 12px Barlow"), document.fonts.load("600 15px \"Barlow Condensed\"")]);
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await document.fonts.ready;

    const misfit: string[] = [];
    let pills = 0;
    const fit = (rect: Element, text: SVGTextElement) => {
      pills++;
      const need = text.getBBox().width + 2 * 5 - 0.5;
      const width = Number(rect.getAttribute("width"));
      if (width < need) {
        misfit.push(`${text.textContent}: ${width} < ${need}`);
      }
    };
    for (const g of host.querySelectorAll("g.phenogram-pill-mark")) {
      fit(g.querySelector("rect")!, g.querySelector("text")!);
    }
    for (const g of host.querySelectorAll("#key g")) {
      const [rect, text] = [...g.children];
      if (
        g.children.length === 2 && rect.tagName === "rect" &&
        text.tagName === "text"
      ) fit(rect, text as SVGTextElement);
    }

    const boxes = [...host.querySelectorAll("#key text")].map((t) => ({
      label: t.textContent ?? "?",
      box: t.getBoundingClientRect(),
    }));
    const overlapping: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box;
        const b = boxes[j].box;
        const apart = a.right <= b.left || a.left >= b.right ||
          a.bottom <= b.top || a.top >= b.bottom;
        if (!apart) overlapping.push(`${boxes[i].label} / ${boxes[j].label}`);
      }
    }
    return { misfit, overlapping, pills, texts: boxes.length };
  }, withKey.svg);

  expect(result.misfit).toEqual([]);
  expect(result.overlapping).toEqual([]);
  expect(result.pills).toBeGreaterThanOrEqual(P.legendTraits);
  expect(result.texts).toBeGreaterThan(0);
});

test("download ignores theme and page state", async ({ page }) => {
  await open(page);
  const light = await download(page, "Figure with key");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("#phenogram-key summary").click();
  if (P.blocks > 0) {
    await page.locator(".phenogram-genes button").first().focus();
    await page.keyboard.press("Enter");
    await expect(tooltip(page)).toBeVisible();
  }
  const dark = await download(page, "Figure with key");

  expect(dark.name).toBe(light.name);
  expect(dark.svg).toBe(light.svg);
});

test("menu fits a 320px window", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await open(page);
  await page.getByRole("button", { name: /Download SVG/ }).click();
  const figureOnly = page.getByRole("button", { name: "Figure only" });
  const withKey = page.getByRole("button", { name: "Figure with key" });
  await expect(figureOnly).toBeVisible();
  await expect(withKey).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  for (const entry of [figureOnly, withKey]) {
    const box = (await entry.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
});

test("keyboard: Enter opens the menu, Escape closes it and returns focus", async ({ page }) => {
  await open(page);
  const button = page.getByRole("button", { name: /Download SVG/ });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Figure only" }))
    .toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Figure only" })).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");
});

test("a failed download says so, and the next attempt clears it", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const fonts = document.fonts as FontFaceSet & { real?: FontFaceSet["load"] };
    fonts.real = fonts.load;
    fonts.load = () => Promise.reject(new Error("offline"));
  });
  await page.getByRole("button", { name: /Download SVG/ }).click();
  // With the key: its titles need a face on any data, where a figure with no
  // gene sets no text and so loads no font to fail on.
  await page.getByRole("button", { name: "Figure with key" }).click();
  const alert = page.locator(".phenogram-download").getByRole("alert");
  await expect(alert).toContainText("could not be saved");

  await page.evaluate(() => {
    const fonts = document.fonts as FontFaceSet & { real?: FontFaceSet["load"] };
    fonts.load = fonts.real!;
  });
  const { svg } = await download(page, "Figure only");
  expect(svg).toContain('id="karyogram"');
  await expect(alert).toHaveCount(0);
});
