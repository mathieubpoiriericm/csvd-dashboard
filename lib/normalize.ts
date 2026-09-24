/**
 * The normalizers the disease manifest shares with the generated-data
 * boundary. They live here, and `lib/data/normalize.ts` re-exports them,
 * because everything under `lib/data/` is bundled into the protected chunk:
 * a manifest that imported them from there would make the adapt wizard,
 * which renders no data, load the whole dataset before it could hydrate.
 */

export function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
