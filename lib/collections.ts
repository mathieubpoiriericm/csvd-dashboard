/** Small collection transforms shared by the dashboard's derived views. */

/** Groups values by key while preserving their input order. */
export function groupBy<T, K>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

/** Counts values by key. */
export function countBy<T, K>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Map<K, number> {
  const counts = new Map<K, number>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Indexes values by key; later values replace earlier duplicate keys. */
export function indexBy<T, K>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Map<K, T> {
  return new Map(values.map((value) => [keyOf(value), value]));
}

/** Number of distinct values. */
export function uniqueCount<T>(values: readonly T[]): number {
  return new Set(values).size;
}
