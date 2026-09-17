/**
 * Reference citations, from the discrete fields the export now publishes.
 *
 * `data/refs.json` used to carry two keys, `pmid` and `formattedRef` -- one
 * pre-rendered HTML fragment built for a tooltip. The author, journal, year and
 * DOI were always in `pubmed_citations`; only the export was narrow. They are
 * published as their own fields now, so a citation is composed here rather than
 * recovered by splitting a string on `<br>` and regexing a year out of
 * "Nature (Nov 2022)".
 *
 * Two shapes come out of this module. The short form is what the Genes table
 * cell shows -- a gene can carry several references, and the full line three
 * times over is a column nobody can read. The long form is the tooltip, which
 * is where the journal and the DOI belong.
 */

import type { Reference } from "./types.ts";

/** A citation split into the parts a renderer places itself. */
export interface Citation {
  /** `Mishra, A.` -- empty when the row carries no authors. */
  author: string;
  /** Four digits, or empty. */
  year: string;
  journal: string;
  doi: string;
  /** Whether the paper has authors beyond the first. */
  etAl: boolean;
}

const YEAR = /\b(1[89]\d{2}|20\d{2})\b/;

/**
 * The first author as `Last, F.`
 *
 * The stored string is `"Mishra A, Malik R, Hachiya T, et al."` -- surname
 * first, initials unpunctuated, already truncated to three names by the
 * pipeline's own formatter. Only the first entry is needed, and only its
 * surname and leading initial.
 */
function firstAuthor(authors: string): string {
  // `split` always yields at least one element, so this needs no guard of its
  // own; an empty `authors` reaches here as one empty string.
  const first = authors.split(",")[0].trim();
  if (!first) return "";

  const parts = first.split(/\s+/);
  if (parts.length < 2) return first;

  const initial = parts[parts.length - 1][0];
  const surname = parts.slice(0, -1).join(" ");
  return `${surname}, ${initial}.`;
}

/**
 * Whether a paper has more authors than the one named.
 *
 * The pipeline appends a literal `"et al."` when it truncates, so the marker is
 * either that or a second comma-separated name.
 */
function hasMoreAuthors(authors: string): boolean {
  const names = authors.split(",").map((name) => name.trim()).filter(Boolean);
  return names.length > 1;
}

/** The parts of a citation, each independently possible to be missing. */
export function toCitation(reference: Reference): Citation {
  const authors = (reference.authors ?? "").trim();
  return {
    author: firstAuthor(authors),
    year: YEAR.exec((reference.publicationDate ?? "").trim())?.[1] ?? "",
    journal: (reference.journal ?? "").trim(),
    doi: (reference.doi ?? "").trim(),
    etAl: hasMoreAuthors(authors),
  };
}

/**
 * `Mishra, A., et al. (2022)` -- the table cell.
 *
 * Falls back to the PMID rather than to a sentinel: a reference whose citation
 * never resolved is still a real identifier, and "(none found)" in a citation
 * column would read as a claim about the paper.
 */
export function shortCitation(reference: Reference): string {
  const { author, year, etAl } = toCitation(reference);
  if (!author) return `PMID ${reference.pmid}`;

  const name = etAl ? `${author}, et al.` : author;
  return year ? `${name} (${year})` : name;
}
