/** The reference-data refreshes and their runtime normalization boundary. */

import pipelineSyncsJson from "../../data/pipeline_syncs.json" with {
  type: "json",
};

import type { RunStatus, SyncRun, SyncSource } from "../types.ts";
import {
  nonnegativeInteger,
  nonnegativeNumber,
  normalizeApis,
  normalizeRows,
  nullableText,
  record,
  textArray,
} from "./normalize.ts";

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "completed_with_warnings",
  "failed",
]);

const SYNC_MODES: ReadonlySet<string> = new Set([
  "clinical_trials",
  "external_sync",
  "annotation_sync",
]);

function normalizeSource(value: unknown): SyncSource | null {
  const source = record(value);
  const key = nullableText(source.key);
  const label = nullableText(source.label);
  const identity = key ?? label;
  if (identity === null) return null;

  return {
    // A display label can rescue a legacy row whose machine key is absent;
    // using it for both fields gives Preact a stable, nonblank identity too.
    key: key ?? identity,
    // The label rides the wire, as it does for an API row: which database
    // was consulted is data, not appearance.
    label: label ?? identity,
    fetched: nonnegativeInteger(source.fetched) ?? 0,
    cached: nonnegativeInteger(source.cached) ?? 0,
    failed: nonnegativeInteger(source.failed) ?? 0,
  };
}

function normalizeErrors(value: unknown): SyncRun["errors"] {
  const source = record(value);
  const items = textArray(source.items);
  return {
    // Filtering a broken item changes what can actually be shown. Recompute
    // shown, retain a trustworthy upstream total, and never let total claim
    // fewer errors than the readable items in hand.
    shown: items.length,
    total: Math.max(
      nonnegativeInteger(source.total) ?? items.length,
      items.length,
    ),
    items,
  };
}

/**
 * One refresh, or `null` when the row cannot be trusted as a whole.
 *
 * All-or-nothing on the three fields that identify it, the rule
 * `normalizePipelineRun` already applies: a row with no timestamp, an
 * unknown mode or an unknown status would render as a refresh that half
 * happened, which is worse than not rendering it.
 */
export function normalizeSyncRun(value: unknown): SyncRun | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;

  const runTimestamp = nullableText(source.runTimestamp);
  const mode = nullableText(source.mode);
  const status = nullableText(source.status);
  if (runTimestamp === null || mode === null || status === null) return null;
  if (!SYNC_MODES.has(mode) || !RUN_STATUSES.has(status)) return null;

  return {
    runTimestamp,
    mode,
    status: status as RunStatus,
    durationSeconds: nonnegativeNumber(source.durationSeconds) ?? 0,
    sources: normalizeRows(source.sources, normalizeSource),
    apis: normalizeApis(source.apis),
    errors: normalizeErrors(source.errors),
  };
}

/** Every readable refresh, in the order the export published them. */
export function normalizeSyncRuns(value: unknown): SyncRun[] {
  return normalizeRows(value, normalizeSyncRun);
}

export const pipelineSyncs = normalizeSyncRuns(pipelineSyncsJson);
