/**
 * In-page measurement, independent of the CDP trace.
 *
 * Two channels are recorded for every scenario so that a Tracy failure never
 * leaves one unmeasured: this one, which survives anything, and the trace.
 *
 * The observers are installed by an init script so they are running before any
 * app code evaluates -- `buffered: true` alone would miss long tasks that land
 * between navigation commit and the first `evaluate` call.
 */

/** Installed with `page.addInitScript`, so it runs on every document. */
export const INIT_SCRIPT = `(() => {
  const perf = {
    longTasks: [],
    events: [],
    shifts: [],
    marks: {},
    start: 0,
    supported: PerformanceObserver.supportedEntryTypes,
  };
  globalThis.__perf = perf;

  const observers = [];
  const observe = (type, sink, extra) => {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) sink(entry);
      });
      observer.observe({ type, buffered: true, ...extra });
      observers.push({ observer, sink });
    } catch {
      // A type this browser does not implement is simply not recorded.
    }
  };

  observe("longtask", (e) => perf.longTasks.push({ start: e.startTime, duration: e.duration }));
  observe("layout-shift", (e) => {
    if (!e.hadRecentInput) perf.shifts.push({ start: e.startTime, value: e.value });
  });
  observe("largest-contentful-paint", (e) => {
    perf.marks.lcp = e.startTime;
  });
  observe("paint", (e) => {
    if (e.name === "first-contentful-paint") perf.marks.fcp = e.startTime;
  });
  observe("event", (e) => {
    perf.events.push({
      name: e.name,
      start: e.startTime,
      duration: e.duration,
      delay: e.processingStart - e.startTime,
      processing: e.processingEnd - e.processingStart,
    });
  }, { durationThreshold: 16 });

  perf.flush = () => {
    for (const { observer, sink } of observers) {
      for (const entry of observer.takeRecords()) sink(entry);
    }
  };
  perf.reset = () => {
    perf.flush();
    perf.start = performance.now();
    perf.longTasks.length = 0;
    perf.events.length = 0;
    perf.shifts.length = 0;
  };
})();`;

/** Clear the per-interaction sinks without disturbing the load marks. */
export async function resetMetrics(page) {
  await page.evaluate(() => globalThis.__perf?.reset());
}

/**
 * Read the sinks back.
 *
 * `blockingTime` sums work beyond 50 ms per task within the recorded scenario
 * window. It is not standardized TBT. Event durations are not field INP.
 */
export async function readMetrics(page) {
  return await page.evaluate(() => {
    const perf = globalThis.__perf;
    if (!perf) return null;
    perf.flush();
    const nav = performance.getEntriesByType("navigation")[0];
    const longTasks = perf.longTasks.filter((t) => t.start >= perf.start);
    const events = perf.events.filter((e) => e.start >= perf.start);
    const tasksSupported = perf.supported.includes("longtask");
    return {
      observationStart: perf.start,
      observationEnd: performance.now(),
      supported: perf.supported,
      ttfb: nav ? nav.responseStart : null,
      fcp: perf.marks.fcp ?? null,
      lcp: perf.marks.lcp ?? null,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
      longTaskCount: tasksSupported ? longTasks.length : null,
      longTaskTotal: tasksSupported
        ? longTasks.reduce((sum, t) => sum + t.duration, 0)
        : null,
      longTaskMax: tasksSupported
        ? longTasks.reduce((max, t) => Math.max(max, t.duration), 0)
        : null,
      blockingTime: tasksSupported
        ? longTasks.reduce(
          (sum, t) => sum + Math.max(0, t.duration - 50),
          0,
        )
        : null,
      maxEventDuration: events.length
        ? Math.max(...events.map((e) => e.duration))
        : null,
      eventDelayMax: events.length
        ? Math.max(...events.map((e) => e.delay))
        : null,
      eventProcessingMax: events.length
        ? Math.max(...events.map((e) => e.processing))
        : null,
      eventCount: perf.supported.includes("event") ? events.length : null,
      cls: perf.supported.includes("layout-shift")
        ? perf.shifts.filter((s) => s.start >= perf.start).reduce(
          (sum, s) => sum + s.value,
          0,
        )
        : null,
    };
  });
}

/** Transferred bytes per resource, for the load scenarios. */
export async function readTransfer(page) {
  return await page.evaluate(() => {
    const entries = performance.getEntriesByType("resource");
    const byType = {};
    let total = 0;
    for (const entry of entries) {
      const size = entry.transferSize ?? 0;
      total += size;
      const path = new URL(entry.name).pathname;
      const kind = path.endsWith(".js")
        ? "js"
        : path.endsWith(".css")
        ? "css"
        : /\.(woff2?|ttf|otf)$/.test(path)
        ? "font"
        : "other";
      byType[kind] = (byType[kind] ?? 0) + size;
    }
    const nav = performance.getEntriesByType("navigation")[0];
    return {
      total: total + (nav?.transferSize ?? 0),
      byType,
      resources: entries.map((e) => ({
        url: e.name,
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
      })),
      largest: entries
        .map((e) => ({
          name: e.name.split("/").pop(),
          size: e.transferSize ?? 0,
        }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 5),
    };
  });
}
