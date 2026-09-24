/**
 * The whitespace either language strips from a value's ends: JavaScript's
 * trim() set, and the one Python's str.strip() uses when
 * pipeline/disease.py reads the file back -- the same set plus the four
 * information separators (U+001C-U+001F) and U+0085 (NEL).
 */
const edge = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return /\s/.test(c) || (code >= 0x1c && code <= 0x1f) || code === 0x85;
};

/** Where a value's text lies once that whitespace is off both ends. */
export function textSpan(value: string): [number, number] {
  let start = 0;
  let end = value.length;
  while (start < end && edge(value[start])) start++;
  while (end > start && edge(value[end - 1])) end--;
  return [start, end];
}

/** A value with that whitespace off both ends. */
export function trim(value: string): string {
  return value.slice(...textSpan(value));
}

/**
 * A key, label, symbol or name as the generated file spells it.
 *
 * The forms take what was typed, so a trailing space rides along; a key
 * written into one file and matched against another in a second would
 * then match nothing. Trimmed as JavaScript alone trims, a value ending in
 * NEL would reach the file with it and be read back without it, and the
 * fork's own gates compare the two. It is written in NFC, so the
 * decomposed spelling a PDF or a macOS paste gives is the same key as the
 * one typed. Every generator puts these values through here, and
 * `validate()` compares them the same way.
 */
export function clean(value: string): string {
  return trim(value).normalize("NFC");
}

/** A record with every string value through clean(), keys and order kept. */
export function cleanAll<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).map((
      [key, value],
    ) => [key, typeof value === "string" ? clean(value) : value]),
  ) as T;
}

/** Two-space JSON plus a trailing newline: the shape `deno fmt` leaves alone. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** One RFC 4180 line; a field is quoted only when it needs to be. */
export function csvLine(fields: string[]): string {
  return fields.map((field) =>
    /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field
  ).join(",");
}

/**
 * A word that, at the start of a line, would make that line a list item,
 * a blockquote or a heading rather than the rest of a sentence.
 */
const BLOCK_MARKER = /^(?:[-+*>]|#{1,6}|\d+[.)])$/;

/** Wrap paragraphs at 80 columns the way `deno fmt` wraps Markdown prose. */
export function wrap80(text: string): string {
  return text.split("\n").map((line) => {
    // Tables, indented code and headings are never wrapped, by deno fmt or
    // here: a heading broken in two is a heading and a paragraph.
    if (
      line.length <= 80 || line.startsWith("|") || line.startsWith("    ") ||
      line.startsWith("#")
    ) {
      return line;
    }
    // A `- ` list item's continuation lines are indented two spaces, to
    // align under the text rather than the marker, the way deno fmt does.
    const indent = line.startsWith("- ") ? "  " : "";
    const out: string[] = [];
    let current = "";
    for (const word of line.split(" ")) {
      // A break never falls before a word that would open a block: a
      // population named "APOE ε4 + carriers" must not become a list.
      if (
        current.length > 0 && current.length + 1 + word.length > 80 &&
        !BLOCK_MARKER.test(word)
      ) {
        out.push(current);
        current = indent + word;
      } else {
        current = current.length === 0 ? word : `${current} ${word}`;
      }
    }
    out.push(current);
    return out.join("\n");
  }).join("\n");
}
