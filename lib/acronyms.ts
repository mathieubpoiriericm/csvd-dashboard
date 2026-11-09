/**
 * Acronyms in free text: finding them, explaining them, and finding the ones
 * the glossary cannot explain.
 *
 * Matching is case-sensitive and whole-token: a glossary key is boxed only
 * where no letter, digit or hyphen precedes it and no letter or digit follows
 * it, so `AB` is not found inside `ABC` or `xAB`. A hyphen may follow when a
 * lower-case word comes after it (`ML-based`), not another code (`AB-X9`),
 * and the longest key wins where two overlap (`AB-CD` over `CD`). A slash,
 * a space or punctuation separates.
 *
 * A term followed by `CLARIFICATION_MARK` (`lib/omics.ts`) awaits the
 * curators: it stays as the source wrote it, the cell prints a `?` after it,
 * and the glossary is not expected to know it.
 */

import { ACRONYMS } from "./disease/acronyms.ts";
import { CLARIFICATION_MARK, parseOmicsEntry } from "./omics.ts";
import { isAbsent } from "./sentinels.ts";
import type { TooltipContent, TooltipRow } from "./tooltip_content.ts";
import type { Acronym, Gene } from "./types.ts";

export { CLARIFICATION_MARK };

/**
 * The acronyms in the trait and omics columns no glossary entry covers, as
 * `GENE: TOKEN`, split by whether a pipeline run can coin them.
 *
 * `enforced` holds what no run can: every row's traits and study types,
 * which come from closed vocabularies, and a curated row's -- no extraction
 * quote -- biomarker and items, which were reviewed. A gap there is a
 * manifest bug, and `tests/acronym_coverage_test.ts` holds it to an empty
 * list. `reported` holds the biomarker and items of a row a run wrote, in
 * the model's own words; those gaps are for the glossary to catch up with,
 * and never block a deploy. A gene symbol in any case, alone or leading a
 * hyphenated word (`Abc1-deficient`), is no acronym, and a term marked
 * `CLARIFICATION_MARK` awaits the curators, so neither counts.
 */
export function glossaryGaps(
  genes: readonly Gene[],
  glossary: ReadonlyMap<string, Acronym> = ACRONYMS,
): { enforced: string[]; reported: string[] } {
  const symbols = genes.map((gene) => gene.gene.toLowerCase());
  const isSymbol = (token: string) => {
    const lower = token.toLowerCase();
    return symbols.some((symbol) =>
      lower === symbol || lower.startsWith(`${symbol}-`)
    );
  };
  const gapsIn = (gene: Gene, texts: readonly string[]) =>
    [
      ...new Set(
        texts
          .flatMap((text) => uncoveredAcronyms(text, glossary))
          .filter((token) => !isSymbol(token)),
      ),
    ].map((token) => `${gene.gene}: ${token}`);
  // Array methods rather than a loop: V8 counts a loop body as a branch of
  // its own, which a run over no rows (`deno task data:empty`) leaves untaken.
  const split = genes.map((gene) => {
    // The stored value, not the printed one: the mark is what exempts the
    // term before it, and printing turns it into a bare `?`.
    const entries = gene.evidenceFromOtherOmicsStudies
      .filter((value) => !isAbsent(value))
      .map(parseOmicsEntry);
    const vocabulary = [
      ...gene.gwasTrait.filter((value) => !isAbsent(value)),
      ...entries.map((entry) => entry.type),
    ];
    const words = entries.flatMap((entry) => [
      entry.biomarker ?? "",
      ...entry.items.map((item) => item.text),
    ]);
    const curated = isAbsent(gene.sourceQuote);
    return {
      enforced: gapsIn(gene, curated ? [...vocabulary, ...words] : vocabulary),
      reported: curated ? [] : gapsIn(gene, words),
    };
  });
  return {
    enforced: split.flatMap((gaps) => gaps.enforced),
    reported: split.flatMap((gaps) => gaps.reported),
  };
}

/** The tooltip row label that says a tissue colocalized significantly. */
export const COLOCALIZATION_LABEL = "Significant colocalization";

/** A term and the mark straight after it. */
const MARKED_TERM = /[A-Za-z0-9-]*\[\?\]/g;

/** A protein variant in one-letter codes: `R187W`, `Q12X` (a stop). */
const VARIANT = /^[ACDEFGHIKLMNPQRSTVWY]\d+[ACDEFGHIKLMNPQRSTVWYX]$/;

export function clarificationTooltip(): TooltipContent {
  return {
    rows: [{
      label: "Needs clarification",
      value:
        "The curated source leaves this point unclear, and the curators have yet to settle it.",
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
 * `AB-based` count and `Brain`, `c1` and `(age > 65)` do not. A protein
 * variant (`R187W`) is a position, not an acronym.
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
    /[A-Z]/.test(token) && token.match(/[A-Z0-9]/g)!.length >= 2 &&
    !VARIANT.test(token)
  );
  return [...new Set(tokens)];
}
