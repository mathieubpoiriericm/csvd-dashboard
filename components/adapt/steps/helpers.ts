/** Turn "a, b, c" into ["a", "b", "c"] without empties. */
export function splitList(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** A comma list as the field renders it; the canonical form of a ParsedTextField. */
export function joinList(text: string): string {
  return splitList(text).join(", ");
}

/**
 * A family <select>'s options: the placeholder, then each family that has
 * a key, once. A family added but not yet named would otherwise be a
 * second option with the placeholder's empty value -- the two collide as
 * keys, and a trait with no family shows the blank one as its choice.
 */
export function familyOptions(
  families: Array<{ key: string; label: string }>,
): Array<{ value: string; label: string }> {
  const options = [{ value: "", label: "— pick a family —" }];
  const seen = new Set<string>();
  for (const family of families) {
    if (family.key.trim() === "" || seen.has(family.key)) continue;
    seen.add(family.key);
    options.push({
      value: family.key,
      label: family.label.trim() === "" ? family.key : family.label,
    });
  }
  return options;
}
