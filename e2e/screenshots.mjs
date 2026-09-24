/**
 * The README's screenshots.
 *
 * Captures the six tabs into `docs/screenshots/` from the *production* build,
 * the one `e2e/playwright.config.ts` and the perf harness drive: 1440 CSS px
 * wide at device scale 2, light theme, signed in. Each image is cropped to what
 * its README caption describes and written as lossless WebP by libwebp's
 * `cwebp`. Chromium's own encoder is no substitute: its lossless output holds
 * the same pixels in two to seven times the bytes.
 *
 * The server is this script's own, on a free port, behind a passphrase and a
 * session secret made up for the run. Unlike the perf harness it never reuses a
 * server already listening: one left running from an older build would be
 * captured as if it were current.
 *
 * Run it on a dashboard with data. `data/*.json` is bundled at build time, so
 * the images show whatever the build holds -- after a fork's first live run,
 * that fork's disease.
 *
 *   deno task screenshots          (builds first)
 *   node e2e/screenshots.mjs       (after `deno task build`)
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { ROUTES, settle } from "./perf/scenarios.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = path.join(ROOT, "docs", "screenshots");
const WIDTH = 1440;
const SCALE = 2;
/** The viewport height, and so where a "first screenful" is cut. */
const FOLD = 900;
/** The page's own gutter, kept around a cropped element. */
const MARGIN = 20;

try {
  execFileSync("cwebp", ["-version"], { stdio: "ignore" });
} catch {
  console.error(
    "cwebp not found. Install libwebp: `brew install webp`, or the `webp` " +
      "package on Debian and Ubuntu.",
  );
  process.exit(1);
}

const READY = new Map(ROUTES.map(({ route, ready }) => [route, ready]));

/** The document-space top and bottom of an element, or `null` if absent. */
function extent(page, selector, closest) {
  return page.evaluate(([selector, closest]) => {
    let element = document.querySelector(selector);
    if (element && closest) element = element.closest(closest);
    if (!element) return null;
    const { top, bottom } = element.getBoundingClientRect();
    return { top: top + scrollY, bottom: bottom + scrollY };
  }, [selector, closest]);
}

/** A figure's framed white plate, with the page gutter around it. */
async function plate(page, figure) {
  const frame = await extent(page, figure, ".blueprint-frame");
  if (!frame) throw new Error(`no ${figure} to crop to`);
  return { top: frame.top - MARGIN, bottom: frame.bottom + MARGIN };
}

/**
 * The first row boundary at or below the fold that no merged drug block spans,
 * so the image shows a block whole rather than halving one. The fold itself
 * when that boundary is far below it: a drug with many trials would otherwise
 * stretch the image.
 */
function belowMergedBlock(page) {
  return page.evaluate(({ fold, limit }) => {
    let coveredThrough = -1;
    const rows = document.querySelectorAll("table.data-table tbody tr");
    for (const [index, row] of rows.entries()) {
      for (const cell of row.cells) {
        coveredThrough = Math.max(coveredThrough, index + cell.rowSpan - 1);
      }
      // The +1 keeps the row's bottom border inside the cut.
      const bottom = row.getBoundingClientRect().bottom + scrollY + 1;
      if (bottom >= fold && coveredThrough <= index) {
        return bottom <= limit ? bottom : fold;
      }
    }
    return fold;
  }, { fold: FOLD, limit: FOLD + 300 });
}

/**
 * The About page hydrates its run report, and renders none -- only a status
 * card -- while `data/pipeline_run.json` is `null`.
 */
async function aboutReady(page) {
  if (await page.$(".pipeline-card")) await READY.get("/")(page);
}

/**
 * The map's markers are drawn when the island mounts; the basemap arrives
 * from tile.openstreetmap.org afterwards. The perf harness's readiness, a
 * cluster icon, never appears when no two sites are near enough to cluster,
 * and a tile that fails never gets Leaflet's loaded class, so a broken basemap
 * times out here rather than being committed.
 */
async function mapReady(page) {
  await page.waitForSelector(".leaflet-container");
  await page.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll(".leaflet-tile")];
      return tiles.length > 0 &&
        tiles.every((tile) => tile.classList.contains("leaflet-tile-loaded"));
    },
    null,
    { timeout: 30_000 },
  );
}

/** In README order. `crop` returns the document-space band to keep. */
const SHOTS = [
  {
    name: "about",
    route: "/",
    ready: aboutReady,
    // The hero card and the whole run report under it.
    crop: async (page) => {
      const card = await extent(page, ".pipeline-card");
      return { top: 0, bottom: card ? card.bottom + MARGIN : FOLD };
    },
  },
  {
    name: "genes",
    route: "/genes",
    ready: READY.get("/genes"),
    // One screenful: the filters, the summary strip and the first rows.
    crop: () => ({ top: 0, bottom: FOLD }),
  },
  {
    name: "phenogram",
    route: "/phenogram",
    ready: READY.get("/phenogram"),
    crop: (page) => plate(page, ".phenogram-figure"),
  },
  {
    name: "clinical-trials",
    route: "/trials",
    ready: READY.get("/trials"),
    crop: async (page) => ({ top: 0, bottom: await belowMergedBlock(page) }),
  },
  {
    name: "trials-radar",
    route: "/timeline",
    ready: READY.get("/timeline"),
    crop: (page) => plate(page, ".timeline-figure"),
  },
  {
    name: "trials-map",
    route: "/map",
    ready: mapReady,
    // The status filter and the whole map under it.
    crop: async (page) => {
      const map = await extent(page, ".map-container");
      if (!map) throw new Error("no .map-container to crop to");
      return { top: 0, bottom: map.bottom + MARGIN };
    },
  },
];

/** A port nothing is listening on, from the operating system. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** `deno serve` over the build, gated by the two values in `env`. */
async function startServer(base, env) {
  const child = spawn("deno", [
    "serve",
    "-A",
    "--host",
    "127.0.0.1",
    "--port",
    new URL(base).port,
    "_fresh/server.js",
  ], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (exited) {
      throw new Error("deno serve exited; has `deno task build` run?");
    }
    try {
      await fetch(base, { redirect: "manual" });
      return child;
    } catch {
      // Not listening yet.
    }
  }
  child.kill("SIGKILL");
  throw new Error(`No server on ${base} after 15s`);
}

async function signIn(browser, base, passphrase) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel("Passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${base}/`);
  const state = await context.storageState();
  await context.close();
  return state;
}

const passphrase = randomBytes(18).toString("base64url");
const base = `http://127.0.0.1:${await freePort()}`;
const scratch = await mkdtemp(path.join(os.tmpdir(), "screenshots-"));
let server;
let browser;

try {
  server = await startServer(base, {
    DASHBOARD_PASSPHRASE: passphrase,
    DASHBOARD_SESSION_SECRET: randomBytes(32).toString("base64url"),
  });
  browser = await chromium.launch();
  const storageState = await signIn(browser, base, passphrase);
  // A fresh context: signing in clicked a button, and a pointer left over it
  // would hover whatever the next page draws there.
  const context = await browser.newContext({
    storageState,
    viewport: { width: WIDTH, height: FOLD },
    deviceScaleFactor: SCALE,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await mkdir(OUT, { recursive: true });

  for (const shot of SHOTS) {
    try {
      await page.goto(`${base}${shot.route}`);
      await shot.ready(page);
      await settle(page);
      const band = await shot.crop(page);
      const top = Math.floor(band.top);
      const height = Math.ceil(band.bottom) - top;
      const png = path.join(scratch, `${shot.name}.png`);
      await page.screenshot({
        path: png,
        fullPage: true,
        clip: { x: 0, y: top, width: WIDTH, height },
      });
      const webp = path.join(OUT, `${shot.name}.webp`);
      execFileSync("cwebp", [
        "-quiet",
        "-lossless",
        "-z",
        "9",
        png,
        "-o",
        webp,
      ]);
      const { size } = await stat(webp);
      console.log(
        `${path.relative(ROOT, webp)}  ${WIDTH * SCALE}x${height * SCALE}  ` +
          `${Math.round(size / 1024)} KB`,
      );
    } catch (error) {
      throw new Error(`${shot.route}: ${error.message}`, { cause: error });
    }
  }
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true });
}
