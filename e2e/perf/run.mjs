/**
 * The responsiveness harness.
 *
 * Drives the *production* build behind the login gate, exactly as
 * `e2e/playwright.config.ts` does and for the same reason: the islands import
 * `data/*.json` at build time, so only bundled output measures what a viewer
 * actually pays. It reuses that config's passphrase and session secret, so no
 * second set of credentials exists.
 *
 * Deliberately a plain script rather than a Playwright project. The main suite
 * runs `fullyParallel: true`, which is right for correctness and fatal for
 * timing; a script has one worker by construction and full control over
 * repetitions, trace boundaries and the order scenarios run in.
 *
 * Every page runs under CPU throttling. Unthrottled on an Apple-silicon laptop
 * every surface here measures as instant, which is not a result -- it is the
 * measurement failing to discriminate. 4x is Lighthouse's mid-tier device
 * default and is what makes a 5 ms handler and a 40 ms handler tell apart.
 *
 *   node e2e/perf/run.mjs [--only <substring>] [--reps N] [--throttle N] [--no-trace]
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { runLifecycle } from "./lifecycle.mjs";
import {
  INIT_SCRIPT,
  readMetrics,
  readTransfer,
  resetMetrics,
} from "./metrics.mjs";
import { rankedZones, tracyAvailable, zonesFromTrace } from "./tracy.mjs";
import {
  INTERACTION_SCENARIOS,
  LOAD_SCENARIOS,
  ROUTES,
  settle,
  VIEWPORTS,
} from "./scenarios.mjs";

const PASSPHRASE = "e2e passphrase: correct horse battery staple";
const BASE = process.env.PERF_BASE_URL ?? "http://localhost:8000";
const runId = new Date().toISOString().replaceAll(":", "-");
const OUT = fileURLToPath(new URL(`./artifacts/${runId}/`, import.meta.url));

const args = process.argv.slice(2);
const only = valueOf("--only");
const reps = Number(valueOf("--reps") ?? 5);
const throttle = Number(valueOf("--throttle") ?? 4);
const useTrace = !args.includes("--no-trace");

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "blink.user_timing",
  "v8.execute",
  "disabled-by-default-v8.cpu_profiler",
];

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Bring up the gated production server, unless one is already listening.
 *
 * `deno task perf` builds first, so `_fresh/server.js` is current. The two
 * secrets are the e2e suite's, so a server it left running is reused rather
 * than fought over -- and neither is a real credential.
 */
async function startServer() {
  const reachable = async () => {
    try {
      await fetch(BASE, { redirect: "manual" });
      return true;
    } catch {
      return false;
    }
  };
  if (await reachable()) return null;

  const child = spawn("deno", [
    "serve",
    "-A",
    "--port",
    new URL(BASE).port,
    "_fresh/server.js",
  ], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      DASHBOARD_PASSPHRASE: PASSPHRASE,
      DASHBOARD_SESSION_SECRET: "e2e-session-secret-not-for-production",
    },
    stdio: "ignore",
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await reachable()) return child;
  }
  child.kill("SIGKILL");
  throw new Error(`No server on ${BASE} after 15s`);
}

/** Throttle the renderer's main thread, so handler cost is discriminable. */
async function applyThrottle(page, scenario = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  if (scenario.blockTiles) {
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", {
      urls: ["*://*.tile.openstreetmap.org/*", "*://tile.openstreetmap.org/*"],
    });
  }
  if (scenario.network) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 200000,
      uploadThroughput: 100000,
    });
  }
}

async function signIn(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE}/`);
  const state = await context.storageState();
  await context.close();
  return state;
}

/** One repetition. Returns the in-page metrics plus a trace path, if traced. */
async function runOnce(browser, storageState, scenario, index, trace) {
  const context = await browser.newContext({
    storageState: scenario.unauthenticated ? undefined : storageState,
    viewport: scenario.viewport,
  });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  await applyThrottle(page, scenario);
  if (scenario.warm) {
    await page.goto(`${BASE}${scenario.route}`);
    await scenario.ready(page);
    await settle(page);
  }

  const tracePath = trace
    ? `${OUT}${scenario.id.replaceAll("/", "_")}-${index}.json`
    : null;
  let metrics = null;
  let transfer = null;

  try {
    if (scenario.kind === "load") {
      if (tracePath) {
        await browser.startTracing(page, {
          path: tracePath,
          categories: TRACE_CATEGORIES,
        });
      }
      await page.goto(`${BASE}${scenario.route}`);
      await scenario.ready(page);
      await settle(page);
      if (tracePath) await browser.stopTracing();
      metrics = await readMetrics(page);
      transfer = await readTransfer(page);
    } else {
      await page.goto(`${BASE}${scenario.route}`);
      await scenario.ready(page);
      // Let hydration, the font swap and the figures' measure passes finish, so
      // the trace covers the interaction and not the tail of the load.
      await settle(page);
      if (scenario.prepare) {
        await scenario.prepare(page);
        await settle(page);
      }
      await resetMetrics(page);
      if (tracePath) {
        await browser.startTracing(page, {
          path: tracePath,
          categories: TRACE_CATEGORIES,
        });
      }
      await scenario.act(page);
      await settle(page);
      if (tracePath) await browser.stopTracing();
      metrics = await readMetrics(page);
    }
  } catch (error) {
    await page.screenshot({
      path: `${OUT}${scenario.id.replaceAll("/", "_")}-${index}-failure.png`,
    }).catch(() => {});
    throw error;
  } finally {
    if (tracePath) await browser.stopTracing().catch(() => {});
    await context.close();
  }

  if (!metrics) {
    throw new Error("In-page metric instrumentation was not installed");
  }
  return { metrics, transfer, tracePath };
}

async function runScenario(browser, storageState, scenario, trace) {
  const runs = [];
  let tracePath = null;
  for (let index = 0; index < reps + Number(trace); index += 1) {
    const wantTrace = index === reps;
    try {
      const result = await runOnce(
        browser,
        storageState,
        scenario,
        index,
        wantTrace,
      );
      runs.push({ ...result, traced: wantTrace, index, status: "passed" });
      if (result.tracePath) tracePath = result.tracePath;
    } catch (error) {
      runs.push({
        index,
        traced: wantTrace,
        status: "failed",
        error: error.message,
      });
      await writeFile(
        `${OUT}${scenario.id.replaceAll("/", "_")}-runs.json`,
        JSON.stringify(runs, null, 2),
      );
      throw new Error(`${scenario.id} rep ${index}: ${error.message}`);
    }
    await writeFile(
      `${OUT}${scenario.id.replaceAll("/", "_")}-runs.json`,
      JSON.stringify(runs, null, 2),
    );
  }
  const timing = runs.filter((run) => !run.traced);
  const sampleCounts = {};
  const pick = (key) => {
    const values = timing.map((run) => run.metrics?.[key]).filter(
      Number.isFinite,
    );
    sampleCounts[key] = values.length;
    return median(values);
  };
  const summary = {
    viewport: scenario.viewport ?? { width: 1280, height: 720 },
    warm: scenario.warm ?? false,
    network: scenario.network ?? false,
    blockTiles: scenario.blockTiles ?? false,
    id: scenario.id,
    label: scenario.label,
    route: scenario.route,
    kind: scenario.kind,
    blockingTime: pick("blockingTime"),
    longTaskMax: pick("longTaskMax"),
    longTaskTotal: pick("longTaskTotal"),
    longTaskCount: pick("longTaskCount"),
    maxEventDuration: pick("maxEventDuration"),
    runs,
    sampleCounts,
    eventProcessingMax: pick("eventProcessingMax"),
    cls: pick("cls"),
    transfer: timing[0]?.transfer ?? null,
  };
  if (scenario.kind === "load") {
    summary.ttfb = pick("ttfb");
    summary.fcp = pick("fcp");
    summary.lcp = pick("lcp");
  }

  if (tracePath) {
    try {
      const capture = tracePath.replace(/\.json$/, ".tracy");
      const zones = await zonesFromTrace(tracePath, capture);
      summary.zones = rankedZones(zones).map((zone) => ({
        name: zone.name,
        totalMs: Number(zone.totalMs.toFixed(2)),
        count: zone.count,
        maxMs: Number(zone.maxMs.toFixed(2)),
      }));
      summary.capture = capture;
    } catch (error) {
      throw new Error(
        `Tracy conversion failed for ${scenario.id}: ${error.message}`,
      );
    }
  }
  return summary;
}

/** The layout half: overflow, unscrollable containers and small touch targets. */
async function auditViewport(page) {
  return await page.evaluate(() => {
    const describe = (element) =>
      `${element.tagName.toLowerCase()}${
        element.className && typeof element.className === "string"
          ? `.${element.className.trim().split(/\s+/).join(".")}`
          : ""
      }`;

    const overflowing = [];
    const unscrollable = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.right > innerWidth + 1 && rect.width > 0) {
        overflowing.push({
          element: describe(element),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          overflowX: style.overflowX,
          position: style.position,
        });
      }
      // A box whose content is wider than itself but which cannot scroll is
      // what pushes the document sideways instead of scrolling internally.
      if (
        element.scrollWidth > element.clientWidth + 1 &&
        element.clientWidth > 0 &&
        ["visible", "clip"].includes(style.overflowX)
      ) {
        unscrollable.push({
          element: describe(element),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          overflowX: style.overflowX,
        });
      }
    }

    const small = [];
    for (
      const control of document.querySelectorAll(
        "a[href], button, input, select, [tabindex]:not([tabindex='-1'])",
      )
    ) {
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width < 24 || rect.height < 24) {
        small.push({
          element: describe(control),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      overflows: document.documentElement.scrollWidth > innerWidth,
      overflowing: overflowing.slice(0, 15),
      unscrollable: unscrollable.slice(0, 15),
      smallTargets: small.slice(0, 15),
      smallTargetCount: small.length,
    };
  });
}

async function runViewportSweep(browser, storageState) {
  const results = [];
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await applyThrottle(page, { blockTiles: true });
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const { route, label, ready } of ROUTES) {
      await page.goto(`${BASE}${route}`);
      await ready(page);
      await settle(page);
      const audit = await auditViewport(page);
      results.push({ viewport: viewport.name, route, label, ...audit });
    }
  }
  await context.close();
  return results;
}

function renderReport(scenarios, viewports) {
  const lines = [
    "# Responsiveness measurements",
    "",
    `Production build, ${throttle}x CPU throttling, median of ${reps} untraced runs${
      useTrace ? " plus a separate attribution trace" : " (tracing disabled)"
    }. ` +
    "All times in milliseconds.",
    "",
  ];
  const number = (value) =>
    value === null || value === undefined ? "—" : value.toFixed(1);

  lines.push(
    "Blocking is excess task time within each scenario window, not standardized TBT. Event duration is not field INP; — means unavailable.",
    "",
  );
  const incomplete = scenarios.filter((s) => s.status !== "passed");
  if (incomplete.length) {
    lines.push(
      "## Failures and skips",
      "",
      ...incomplete.map((s) =>
        `- ${s.id}: ${s.status} — ${s.error ?? s.reason}`
      ),
      "",
    );
  }
  lines.push("## Loads (median of " + reps + ")", "");
  lines.push(
    "| Scenario | TTFB | FCP | LCP | Blocking | Longest task | Transfer |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const s of scenarios.filter((s) => s?.kind === "load")) {
    const kb = s.transfer ? Math.round(s.transfer.total / 1024) + " KB" : "—";
    lines.push(
      `| ${s.label} | ${number(s.ttfb)} | ${number(s.fcp)} | ${
        number(s.lcp)
      } | ${number(s.blockingTime)} | ${number(s.longTaskMax)} | ${kb} |`,
    );
  }

  lines.push("", "## Interactions (median of " + reps + ")", "");
  lines.push(
    "| Scenario | Blocking | Longest task | Total task | Max observed event | Max handler | CLS |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  const interactions = scenarios
    .filter((s) => s?.kind === "interaction")
    .sort((a, b) => (b.longTaskTotal ?? 0) - (a.longTaskTotal ?? 0));
  for (const s of interactions) {
    lines.push(
      `| ${s.label} | ${number(s.blockingTime)} | ${number(s.longTaskMax)} | ${
        number(s.longTaskTotal)
      } | ${number(s.maxEventDuration)} | ${number(s.eventProcessingMax)} | ${
        (s.cls ?? 0).toFixed(3)
      } |`,
    );
  }

  lines.push(
    "",
    "## Aggregate Tracy zones (all threads and asynchronous spans; not renderer CPU)",
    "",
  );
  for (const s of scenarios) {
    if (!s?.zones?.length) continue;
    const top = s.zones.slice(0, 6)
      .map((z) => `${z.name} ${z.totalMs}×${z.count}`)
      .join(", ");
    lines.push(`- **${s.label}** — ${top}`);
  }

  lines.push("", "## Layout", "");
  const bad = viewports.filter((v) =>
    v.overflows || v.unscrollable.length > 0 || v.smallTargetCount > 0
  );
  if (viewports.length === 0) {
    lines.push("Layout sweep not run.");
  } else if (bad.length === 0) {
    lines.push("No overflow, unscrollable container or small touch target.");
  } else {
    lines.push(
      "| Viewport | Route | Overflows | Unscrollable | Small targets |",
    );
    lines.push("| --- | --- | --- | --- | ---: |");
    for (const v of bad) {
      lines.push(
        `| ${v.viewport} | ${v.route} | ${
          v.overflows ? `${v.documentWidth} > ${v.viewportWidth}` : "no"
        } | ${
          v.unscrollable.map((u) => u.element).join(", ") || "—"
        } | ${v.smallTargetCount} |`,
      );
    }
  }
  return lines.join("\n");
}

if (
  !Number.isInteger(reps) || reps < 1 || !Number.isFinite(throttle) ||
  throttle < 1
) {
  throw new Error(
    "--reps must be a positive integer; --throttle must be at least 1",
  );
}
if (useTrace && !await tracyAvailable()) {
  throw new Error(
    "Tracy binaries missing; set TRACY_DIR or explicitly use --no-trace",
  );
}
let all = [...LOAD_SCENARIOS, ...INTERACTION_SCENARIOS];
if (only) all = all.filter((s) => s.id.includes(only));
if (!all.length) throw new Error(`No scenarios match ${only}`);
await mkdir(OUT, { recursive: true });
const metadata = {
  runId,
  reps,
  throttle,
  tracing: useTrace,
  only: only ?? null,
  buildSha256: createHash("sha256").update(
    await readFile(
      new URL("../../_fresh/server/server-entry.mjs", import.meta.url),
    ),
  ).digest("hex"),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
    .trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
    .trim(),
  node: process.version,
  deno: execFileSync("deno", ["--version"], { encoding: "utf8" }).trim(),
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
  blockingDefinition:
    "Sum of task duration beyond 50ms, from navigation/interaction reset through asserted outcome and visual settlement",
  eventDefinition:
    "Maximum observed EventTiming duration; null if no qualifying event; not field INP",
};
const results = [];
let viewports = [];
let lifecycle = [];
const persist = async () => {
  await writeFile(
    `${OUT}report.json`,
    JSON.stringify(
      { ...metadata, scenarios: results, viewports, lifecycle },
      null,
      2,
    ),
  );
  await writeFile(`${OUT}report.md`, renderReport(results, viewports) + "\n");
};
let server;
let browser;
try {
  server = await startServer();
  browser = await chromium.launch();
  metadata.chromium = browser.version();
  const storageState = await signIn(browser);
  for (const scenario of args.includes("--lifecycle-only") ? [] : all) {
    process.stdout.write(`  ${scenario.id} … `);
    try {
      const summary = await runScenario(
        browser,
        storageState,
        scenario,
        useTrace,
      );
      results.push({ status: "passed", ...summary });
      console.log(
        `blocking ${summary.blockingTime?.toFixed(0)}ms, longest ${
          summary.longTaskMax?.toFixed(0)
        }ms`,
      );
    } catch (error) {
      results.push({ id: scenario.id, status: "failed", error: error.message });
      console.error(error.message);
      process.exitCode = 1;
    }
    await persist();
  }
  viewports = only || args.includes("--lifecycle-only")
    ? []
    : await runViewportSweep(browser, storageState);
  if (!only || args.includes("--lifecycle-only")) {
    lifecycle = await runLifecycle({
      browser,
      storageState,
      base: BASE,
      out: OUT,
      trace: useTrace,
      configure: applyThrottle,
    });
  }
  await persist();
  console.log(`Reports: ${OUT}`);
} catch (error) {
  metadata.error = error.message;
  await persist();
  throw error;
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
}
