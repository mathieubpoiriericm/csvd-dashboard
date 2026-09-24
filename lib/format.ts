/**
 * Two general-purpose number formatters, split out of `lib/pipeline_display.ts`.
 *
 * Neither reads `lib/pipeline_encoding.json`: an island that needs only these
 * -- `GenesView` for a confidence score, `TrialsMap` for a marker count --
 * should not have to bundle the pipeline widget's whole vocabulary to get
 * them. `pipeline_display.ts` re-exports both for its own callers.
 */

/** A whole number with thousands separators. */
export function formatCount(value: number): string {
  return Number.isFinite(value)
    ? Math.round(value).toLocaleString("en-US")
    : "—";
}

/** A confidence score as the two decimals the floors are quoted in. */
export function formatConfidence(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(2);
}
