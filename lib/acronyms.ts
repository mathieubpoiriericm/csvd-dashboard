/**
 * Acronyms in free text: finding them, explaining them, and finding the ones
 * the glossary cannot explain.
 *
 * Matching is case-sensitive and whole-token: a glossary key is boxed only
 * where no letter, digit or hyphen precedes it and no letter or digit follows
 * it, so `AB` is not found inside `ABC` or `xAB`. A hyphen may follow when a
 * lower-case word comes after it (`ML-based`), not another code (`AB-X9`),
 * and the longest key wins where two overlap (`WM-PVS` over `PVS`). A slash,
 * a space or punctuation separates.
 */

import { ACRONYMS } from "./disease/acronyms.ts";
import type { TooltipContent, TooltipRow } from "./tooltip_content.ts";
import type { Acronym } from "./types.ts";

/** The tooltip row label that says a tissue colocalized significantly. */
export const COLOCALIZATION_LABEL = "Significant colocalization";

/**
 * Written straight after a term the curators have yet to confirm (`HV-PVS[?]`),
 * or alone where a part is missing (`TWAS;[?]: tissue`). The term stays as
 * the source wrote it; the cell prints a `?` that says so, and the glossary
 * is not expected to know it.
 */
export const CLARIFICATION_MARK = "[?]";

/** A term and the mark straight after it. */
const MARKED_TERM = /[A-Za-z0-9-]*\[\?\]/g;

export function clarificationTooltip(): TooltipContent {
  return {
    rows: [{
      label: "Needs clarification",
      value:
        "Kept as the curated source wrote it; its meaning is not yet confirmed.",
    }],
  };
}

export interface Segment {
  text: string;
  acronym: boolean;
}

const patterns = new WeakMap<ReadonlyMap<string, Acronym>, RegExp | null>();

function patternFor(glossary: ReadonlyMap<string, Acronym>): RegExp | null {
  if (patterns.has(glossary)) return patterns.get(glossary)!;
  const keys = [...glossary.keys()]
    .sort((a, b) => b.length - a.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"));
  const pattern = keys.length === 0 ? null : new RegExp(
    `(?<![A-Za-z0-9-])(?:${keys.join("|")})(?![A-Za-z0-9]|-[A-Z0-9])`,
    "g",
  );
  patterns.set(glossary, pattern);
  return pattern;
}

/** `text` cut into glossary acronyms and the plain text between them. */
export function splitAcronyms(
  text: string,
  glossary: ReadonlyMap<string, Acronym> = ACRONYMS,
): Segment[] {
  const pattern = patternFor(glossary);
  const segments: Segment[] = [];
  let at = 0;
  for (const match of pattern ? text.matchAll(pattern) : []) {
    if (match.index > at) {
      segments.push({ text: text.slice(at, match.index), acronym: false });
    }
    segments.push({ text: match[0], acronym: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) segments.push({ text: text.slice(at), acronym: false });
  return segments;
}

/**
 * What an acronym stands for and what kind of thing it is, plus -- when it
 * sits inside a tissue that colocalized significantly -- a row saying so.
 */
export function acronymTooltip(
  term: string,
  colocalizedIn?: string,
  glossary: ReadonlyMap<string, Acronym> = ACRONYMS,
): TooltipContent | null {
  const entry = glossary.get(term);
  if (!entry) return null;
  const rows: TooltipRow[] = [
    { label: term, value: `${entry.name} · ${entry.kind}` },
  ];
  if (colocalizedIn) {
    rows.push({ label: COLOCALIZATION_LABEL, value: colocalizedIn });
  }
  return { rows };
}

/**
 * The acronym-like tokens in `text` that no glossary entry covers: at least
 * one capital and at least two capitals or digits, so `BA24`, `ZZ9` and
 * `AB-based` count and `Brain`, `c1` and `(age > 65)` do not.
 */
export function uncoveredAcronyms(
  text: string,
  glossary: ReadonlyMap<string, Acronym> = ACRONYMS,
): string[] {
  const pattern = patternFor(glossary);
  const unmarked = text.replace(MARKED_TERM, " ");
  const rest = pattern ? unmarked.replace(pattern, " ") : unmarked;
  const tokens = rest.split(/[^A-Za-z0-9-]+/).filter((token) =>
    // The first test guarantees the match below finds at least one.
    /[A-Z]/.test(token) && token.match(/[A-Z0-9]/g)!.length >= 2
  );
  return [...new Set(tokens)];
}
