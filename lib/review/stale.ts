/**
 * Whether a round still describes the gold it would be shown beside. Pure: the
 * caller decides what a stale round means and says so.
 */

import type { Gene, ReviewRound } from "../types.ts";

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function sameGene(a: Gene, b: Gene): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) =>
    sameValue(a[k as keyof Gene], b[k as keyof Gene])
  );
}

/**
 * The genes whose change no longer matches `genes`, in the round's order;
 * empty when the round is current. A change is stale when gold was curated
 * after the round was measured: its `before` differs from the gold row of the
 * same gene, that row is gone, or a new gene is now in gold. Rows compare as
 * normalized `Gene`s, field by field.
 */
export function staleChanges(
  round: ReviewRound,
  genes: readonly Gene[],
): string[] {
  const gold = new Map(genes.map((g) => [g.gene, g]));
  return round.changes
    .filter((change) => {
      const row = gold.get(change.gene);
      if (change.kind === "new") return row !== undefined;
      return row === undefined || change.before === null ||
        !sameGene(change.before, row);
    })
    .map((change) => change.gene);
}
