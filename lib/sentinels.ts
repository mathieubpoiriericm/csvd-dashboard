/**
 * The export's absent-value sentinels, as `pipeline/export/tables.py` emits
 * them. This is the one place they are spelled: `lib/data/*` fills a missing
 * field with them, `lib/constants.ts` matches filter choices against them and
 * `lib/timeline.ts` reads two of them as record-confidence signals, all by
 * importing these names. `tests/pipeline/export/test_tables.py` reads the
 * literals back out of this file and checks the export still writes each one,
 * so a renamed sentinel fails on both sides of the JSON boundary.
 *
 * They stay in the data and in every filter choice value; only the tables and
 * popups render them differently (components/Absent.tsx).
 */
export const NONE = "(none)";
export const NONE_FOUND = "(none found)";
export const UNKNOWN = "(unknown)";
export const NOT_YET_EXTRACTED = "(not yet extracted)";
export const REFERENCE_NEEDED = "(reference needed)";

export const ABSENT_SENTINELS: ReadonlySet<string> = new Set([
  NONE,
  NONE_FOUND,
  UNKNOWN,
  NOT_YET_EXTRACTED,
  REFERENCE_NEEDED,
]);

export function isAbsent(value: string): boolean {
  return ABSENT_SENTINELS.has(value.trim());
}
