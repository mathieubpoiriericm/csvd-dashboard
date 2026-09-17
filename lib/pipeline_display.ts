/**
 * How the pipeline widget words and decorates every value.
 *
 * The point of this module is that a failure, a paper count, a service
 * name and a piece of API metadata are all formatted in one place.
 * `lib/pipeline_encoding.json` holds the labels, glyphs and tints;
 * nothing here or in the island restates one.
 */

import encoding from "./pipeline_encoding.json" with { type: "json" };

import type { IconName } from "../components/Icon.tsx";
import type { ApiService, RunError, RunStep } from "./types.ts";
import { formatCount } from "./format.ts";

export { formatConfidence, formatCount } from "./format.ts";

interface Badge {
  label: string;
  icon: IconName;
  tint: string;
}

const RUN_STATUS = encoding.runStatus as Record<string, Badge>;
const STEP_STATUS = encoding.stepStatus as Record<string, Badge>;
const STEPS = encoding.steps as Record<string, { icon: IconName }>;
const RUN_MODES = encoding.runModes as Record<string, string>;
const SYNC_MODES = encoding.syncModes as Record<string, string>;
const PAPER_SOURCES = encoding.paperSources as Record<string, string>;
const ERROR_KINDS = encoding.errorKinds as Record<
  string,
  { icon: IconName; hint: string }
>;
const WARNING_KINDS = encoding.warningKinds as Record<
  string,
  { icon: IconName }
>;
const FIELDS = encoding.fields as Record<
  string,
  { label: string; icon: IconName }
>;

interface RejectionKind extends Badge {
  kind: string;
  match: string;
  strip: boolean;
}

const REJECTION_KINDS = encoding.rejectionReasons.kinds as RejectionKind[];
const REJECTION_FALLBACK = encoding.rejectionReasons.fallback as
  & Badge
  & { kind: string };

/**
 * The glyph every fallback below resolves to.
 *
 * One name, declared once and typed, because these are the paths taken
 * when the data carries something the encoding has never seen — which is
 * exactly when a wrong name would go unnoticed. Rendering it is asserted
 * in `tests/pipeline_display_test.ts`; asserting the string was non-empty
 * is what let four kebab-case names ship against camelCase `PATHS` keys.
 */
const FALLBACK_ICON: IconName = "info";

const UNKNOWN_BADGE: Badge = {
  label: "Unknown",
  icon: FALLBACK_ICON,
  tint: "muted",
};

/** The headline badge for a whole run. */
export function runStatusBadge(status: string): Badge {
  return RUN_STATUS[status] ?? UNKNOWN_BADGE;
}

/** The badge for one step. */
export function stepStatusBadge(status: string): Badge {
  return STEP_STATUS[status] ?? UNKNOWN_BADGE;
}

/** The glyph beside a step's name. */
export function stepIcon(key: string): IconName {
  return STEPS[key]?.icon ?? FALLBACK_ICON;
}

/** How the run was started, in words rather than an enum value. */
export function runModeLabel(mode: string): string {
  return RUN_MODES[mode] ?? mode;
}

/** What a reference-data refresh refreshed, in words. */
export function syncModeLabel(mode: string): string {
  return SYNC_MODES[mode] ?? mode;
}

/**
 * Where a paper's text came from, in words.
 *
 * The pipeline's own values are sentinels -- `none` means retrieval
 * succeeded and found nothing, `unknown` means it never got that far --
 * and a chip reading "Source: none" put the sentinel in front of the
 * reader. An unlisted source falls back to its own name, as a run mode
 * does.
 */
export function paperSourceLabel(source: string): string {
  return PAPER_SOURCES[source] ?? source;
}

/** A field's label and glyph, for a labelled value anywhere in the widget. */
export function field(key: string): { label: string; icon: IconName } {
  return FIELDS[key] ?? { label: key, icon: FALLBACK_ICON };
}

/**
 * Why a gene was rejected, split into a badge and what is left to say.
 *
 * The pipeline hands the report a finished sentence -- "Low confidence:
 * 0.30 < 0.45" -- because it is written for a log as much as for a
 * reader. The badge carries the category, so repeating it in the detail
 * would say the same thing twice; a kind matched mid-sentence (the NCBI
 * miss names the gene before it says anything else) keeps its words.
 * An unrecognised reason is shown whole under the fallback badge rather
 * than being cut at a guess.
 */
export function describeRejection(
  reason: string,
): {
  kind: string;
  label: string;
  icon: IconName;
  tint: string;
  detail: string;
} {
  const text = reason.trim();
  for (const entry of REJECTION_KINDS) {
    const at = text.indexOf(entry.match);
    if (at === -1) continue;
    const detail = entry.strip && at === 0
      ? text.slice(entry.match.length).trim()
      : text;
    return {
      kind: entry.kind,
      label: entry.label,
      icon: entry.icon,
      tint: entry.tint,
      detail,
    };
  }
  return { ...REJECTION_FALLBACK, detail: text };
}

/**
 * A failure, ready to render: the pipeline's own sentence, a glyph, and
 * a hint saying what the category means.
 *
 * The hint is the part that keeps this from being a console dump. "The
 * service returned HTTP 503" says what happened; "The service answered,
 * but with an error status" says what kind of problem that is to
 * someone who does not run the pipeline.
 */
export function describeError(
  error: RunError,
): { title: string; icon: IconName; hint: string; detail: string | null } {
  const kind = ERROR_KINDS[error.kind] ?? ERROR_KINDS.unknown;
  return {
    title: error.subject ? `${error.title} (${error.subject})` : error.title,
    icon: kind.icon,
    hint: kind.hint,
    detail: error.detail,
  };
}

/** A warning's glyph; its title is already a sentence from the pipeline. */
export function warningIcon(kind: string): IconName {
  return WARNING_KINDS[kind]?.icon ?? FALLBACK_ICON;
}

/** Everything a step warned about, counted as things rather than rows. */
export function warningCount(step: RunStep): number {
  return step.warnings.reduce((total, warning) => total + warning.count, 0);
}

/**
 * A duration, at the precision a reader can act on.
 *
 * Sub-second times print in milliseconds because a step that took 40 ms
 * and one that took 0.9 s are different facts; above a minute the
 * seconds still show, because "2m" hides whether a run took two minutes
 * or nearly three.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  // Rounded before the branch here too: 0.9996 s is 1000 ms once
  // rounded, and "1000 ms" is the sub-second case printing a second.
  const ms = Math.round(seconds * 1000);
  if (ms < 1000) return `${ms} ms`;
  // Rounded before the branch, not inside it. Rounding after deciding
  // that 59.6 belongs to the sub-minute case printed "60 s"; the
  // minutes branch had its own guard for the same arithmetic and this
  // one did not.
  const whole = Math.round(seconds);
  if (whole < 60) return `${seconds < 10 ? seconds.toFixed(1) : whole} s`;
  const minutes = Math.floor(whole / 60);
  return `${minutes}m ${whole - minutes * 60}s`;
}

/** Milliseconds, for the API panel, through the same rules as seconds. */
export function formatMilliseconds(ms: number): string {
  return formatDuration(ms / 1000);
}

/** A byte count in the largest unit that keeps it under four digits. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** A cost in dollars, never rounded away to "$0". */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "—";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** A percentage, for the cache hit rate. */
export function formatPercent(fraction: number): string {
  return Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : "—";
}

/**
 * The run's date and time, in UTC.
 *
 * UTC is stated rather than converted: every timestamp the pipeline
 * writes is UTC, and a reader comparing this against a log line needs
 * them to be the same clock.
 */
const RUN_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatRunTimestamp(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${RUN_DATE_FORMAT.format(date)} UTC`;
}

/**
 * One line summarising a service's traffic.
 *
 * Retries and errors are named only when they happened, so a clean row
 * stays short and a troubled one is visibly different at a glance.
 */
export function describeApi(api: ApiService): string {
  const parts = [`${formatCount(api.calls)} call${api.calls === 1 ? "" : "s"}`];
  if (api.retries > 0) parts.push(`${formatCount(api.retries)} retried`);
  // "not found" reads separately from "failed" because it is the normal
  // answer for the two open-access lookups, not a fault.
  if (api.notFound > 0) parts.push(`${formatCount(api.notFound)} not found`);
  if (api.errors > 0) parts.push(`${formatCount(api.errors)} failed`);
  if (api.totalMs > 0) parts.push(formatMilliseconds(api.totalMs));
  if (api.bytes > 0) parts.push(formatBytes(api.bytes));
  return parts.join(" · ");
}

/** Whether a capped list left anything out. */
export function isTruncated(shown: number, total: number): boolean {
  return shown < total;
}

/**
 * "Showing 200 of 1,412", for a list that did -- or "Showing 3 of 12
 * errors" when the caller names what is being counted. Every caption on
 * this page that states a truncation goes through this one function, so
 * the punctuation reads the same whether or not a noun is given: no
 * terminal period, matching the widget's other one-line captions
 * (`.pipeline-provenance`, `.pipeline-tokens`).
 */
export function describeTruncation(
  shown: number,
  total: number,
  noun?: string,
): string {
  const base = `Showing ${formatCount(shown)} of ${formatCount(total)}`;
  return noun ? `${base} ${noun}` : base;
}
