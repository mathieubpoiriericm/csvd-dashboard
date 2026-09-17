/**
 * The bridge from a Chromium CDP trace to Tracy.
 *
 * Tracy is a native frame profiler and cannot instrument Preact, so nothing
 * here is an instrumented build: `tracy-import-chrome` ingests the Chrome
 * trace-event JSON that `browser.startTracing` already writes, and
 * `tracy-csvexport` turns the resulting capture into per-zone statistics. That
 * second step is what makes the traces rankable from a script rather than only
 * readable in the GUI.
 *
 * The binaries are a local, gitignored distribution; a missing one fails a requested trace run. Use --no-trace explicitly
 * when only in-page measurements are wanted.
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

/**
 * The distribution is gitignored, so its location is a local fact rather than a
 * committed one: the repository root by default, `TRACY_DIR` to point elsewhere.
 * Absent, `tracyAvailable()` returns false and the runner fails preflight.
 */
const TRACY_DIR = (process.env.TRACY_DIR ??
  fileURLToPath(new URL("../../tracy-profiler-0.14.1", import.meta.url)))
  .replace(/\/+$/, "");

export const IMPORT_CHROME = `${TRACY_DIR}/tracy-import-chrome`;
export const CSV_EXPORT = `${TRACY_DIR}/tracy-csvexport`;

export async function tracyAvailable() {
  try {
    await access(IMPORT_CHROME, constants.X_OK);
    await access(CSV_EXPORT, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert one trace and return its zones, ranked by self time.
 *
 * `-e` asks for self times rather than inclusive ones, which is the only
 * version of the number that ranks honestly: `RunTask` wraps almost everything
 * and would otherwise dominate every scenario.
 */
export async function zonesFromTrace(tracePath, capturePath) {
  await run(IMPORT_CHROME, [tracePath, capturePath]);
  const { stdout } = await run(CSV_EXPORT, ["-e", capturePath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseCsv(stdout);
}

function parseCsv(text) {
  const [header, ...rows] = text.trim().split("\n");
  const columns = header.split(",");
  const zones = [];
  for (const row of rows) {
    if (!row) continue;
    const cells = row.split(",");
    const record = {};
    columns.forEach((column, index) => {
      record[column] = cells[index];
    });
    zones.push({
      name: record.name,
      totalMs: Number(record.total_ns) / 1e6,
      count: Number(record.counts),
      meanMs: Number(record.mean_ns) / 1e6,
      maxMs: Number(record.max_ns) / 1e6,
    });
  }
  return zones.sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * Zones that describe the compositor or the profiler itself rather than the
 * work the page asked for. Kept out of the headline ranking; the raw capture
 * still holds them for a deep dive in the GUI.
 */
const NOISE = /^(RunTask|V8\.GC_|V8\.Stack|V8\.Handle|V8\.Bytecode|V8\.Invoke)/;

export function rankedZones(zones, limit = 12) {
  return zones.filter((zone) => !NOISE.test(zone.name)).slice(0, limit);
}
