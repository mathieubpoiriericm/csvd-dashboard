/**
 * One omics evidence entry, read from its wire form
 * `Type;<biomarker>: <item>, <item>*, …` and printed as
 * `Type (<biomarker>: <item>, <item>, …)`.
 *
 * A `*` marks an item that colocalized significantly (the curated workbook's
 * footnote, "Other omics (*significant colocalization)"). The cell never
 * prints it: it becomes `colocalized`, and the tooltips say it in words.
 *
 * The biomarker is the text before the first colon outside parentheses; with
 * no such colon the whole detail is items. The printed text is the same
 * either way -- the distinction only decides which parts can be colocalized.
 * Items split on commas outside parentheses, counted rather than matched,
 * because curated items nest them (`brain (RNA-Seq)`, `(age > 65)`).
 */

export interface OmicsItem {
  text: string;
  colocalized: boolean;
}

export interface OmicsEntry {
  type: string;
  biomarker: string | null;
  items: OmicsItem[];
}

/** `text` split at every `separator` outside parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Written straight after a term the curators have yet to confirm (`XX[?]`),
 * or alone where a part is missing (`TWAS;[?]: tissue`). The cell prints it
 * as a boxed `?` (components/AcronymText.tsx); every text-only surface --
 * the search key, a tooltip's row, the phenogram panel, the run drawer --
 * prints a bare `?` through `printed`.
 */
export const CLARIFICATION_MARK = "[?]";

/** Stored text as a text-only surface prints it. */
export function printed(text: string): string {
  return text.replaceAll(CLARIFICATION_MARK, "?");
}

const unstarred = (text: string) => text.replaceAll("*", "").trim();

function item(raw: string): OmicsItem {
  return { text: unstarred(raw), colocalized: raw.includes("*") };
}

export function parseOmicsEntry(value: string): OmicsEntry {
  const semicolon = value.indexOf(";");
  const type = unstarred(semicolon === -1 ? value : value.slice(0, semicolon));
  const detail = semicolon === -1 ? "" : value.slice(semicolon + 1).trim();
  const [head, ...rest] = splitTopLevel(detail, ":");
  const biomarker = rest.length > 0 ? unstarred(head) || null : null;
  const listed = rest.length > 0 ? rest.join(":") : head;
  const items = splitTopLevel(listed, ",")
    .map(item)
    .filter((entry) => entry.text !== "");
  return { type, biomarker, items };
}

/** The entry as a text-only surface prints it: no `*`, and `?` for `[?]`. */
export function formatOmicsEntry(entry: OmicsEntry): string {
  const items = entry.items.map((entry) => entry.text).join(", ");
  const detail = entry.biomarker
    ? items ? `${entry.biomarker}: ${items}` : entry.biomarker
    : items;
  return printed(detail ? `${entry.type} (${detail})` : entry.type);
}

/** The items that colocalized significantly, as printed. */
export function colocalizedItems(entry: OmicsEntry): string[] {
  return entry.items.filter((item) => item.colocalized).map((item) =>
    printed(item.text)
  );
}

/** An item's printed text when it colocalized significantly, else undefined. */
export function colocalizedText(item: OmicsItem): string | undefined {
  return item.colocalized ? printed(item.text) : undefined;
}
