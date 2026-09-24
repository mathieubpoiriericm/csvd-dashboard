/**
 * Tooltip content for the data tables.
 *
 * The Shiny app precomputed every tooltip as an HTML string at startup —
 * `tooltips.R` is 784 lines of `paste0`, `htmlEscape` and single-quoted
 * attribute juggling, because the markup had to survive being embedded in a
 * `data-tippy-content` attribute. The tooltip panel is now plain JSX, so this
 * module returns structured data and the components render it. No escaping, no
 * attribute nesting, no startup precomputation.
 */

import {
  CELL_TYPE_NAMES,
  OMICS_FULL_NAMES,
  PUBMED_BASE_URL,
} from "./constants.ts";
import { toCitation } from "./citations.ts";
import { geneInfoByName } from "./data/gene_info.ts";
import { omimByNumber } from "./data/omim.ts";
import { proteinInfoByGene } from "./data/protein_info.ts";
import { referenceByPmid } from "./data/references.ts";
import { omicsType } from "./filters.ts";
import type { GeneInfo, ProteinInfo, Reference } from "./types.ts";
import {
  geneInfoTooltip,
  omimEntryTooltip,
  optionalText,
  proteinInfoTooltip,
  type TooltipContent,
  type TooltipRow,
} from "./tooltip_content.ts";

// -----------------------------------------------------------------------------
// GENE / PROTEIN
// -----------------------------------------------------------------------------

/**
 * NCBI Gene summary for a gene symbol from Table 1.
 *
 * The lookup defaults to the committed cache; tests hand in a Map of their
 * own so the all-null and partial-row rules are checked on any dataset.
 */
export function geneTooltip(
  geneSymbol: string,
  lookup: ReadonlyMap<string, GeneInfo> = geneInfoByName,
): TooltipContent | null {
  return geneInfoTooltip(lookup.get(geneSymbol));
}

/** UniProt summary, looked up by the gene symbol rather than the protein name. */
export function proteinTooltip(
  geneSymbol: string,
  lookup: ReadonlyMap<string, ProteinInfo> = proteinInfoByGene,
): TooltipContent | null {
  return proteinInfoTooltip(lookup.get(geneSymbol));
}

// -----------------------------------------------------------------------------
// OMIM
// -----------------------------------------------------------------------------

/** OMIM phenotype detail for a six-digit MIM number. */
export function omimTooltip(omimNumber: string): TooltipContent | null {
  return omimEntryTooltip(omimByNumber.get(omimNumber.trim()));
}

// -----------------------------------------------------------------------------
// REFERENCES
// -----------------------------------------------------------------------------

/**
 * `formattedRef` is the one lookup value that is not structured data: it
 * arrives as a pre-rendered HTML fragment, copied verbatim from the
 * `pubmed_citations.formatted_ref` database column, because the Shiny app
 * embedded it in a `data-tippy-content` attribute and let the browser parse
 * it. Nothing renders `TooltipRow.value` as HTML any more — it becomes a JSX
 * text child — so the fragment is split back into plain-text rows here.
 *
 * This is the fallback path now. The export publishes the same citation as
 * discrete fields, and `citationRows` prefers those; the fragment is still
 * parsed for a row whose fields are empty, which is what a database missing
 * migration-era metadata would produce.
 */
const CITATION_LABELS = ["Authors", "Title", "Journal", "DOI"];

const LINE_BREAK = /<br\s*\/?>/i;
const HTML_TAG = /<[^>]*>/g;
const DOI_PREFIX = /^DOI:\s*/i;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * Derived from `ENTITIES` rather than written out beside it: the replacer
 * indexes the map with whatever the pattern matched, so an entity the pattern
 * knows and the map does not substitutes the string "undefined" into a
 * citation. None of the current names carries a regex metacharacter; escaping
 * keeps that from becoming a trap for the next one added.
 */
const NAMED_ENTITY = new RegExp(
  Object.keys(ENTITIES)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "g",
);

function toPlainText(segment: string): string {
  return segment
    .replace(HTML_TAG, "")
    .replace(NAMED_ENTITY, (entity) => ENTITIES[entity])
    .trim();
}

/** The tooltip's rows, parsed out of the pre-rendered fragment. */
export function citationRows(formatted: string): TooltipRow[] {
  const segments = formatted.split(LINE_BREAK).map(toPlainText).filter(Boolean);

  // Every citation in the database has the same four segments. Anything else
  // has no labels to hang on it — notably the "PMID: … (citation not
  // available)" fallback `read_pubmed_refs` in `pipeline/export/lookups.py`
  // writes for a PMID it cannot resolve — so it stays a single row, still
  // stripped of any markup.
  if (segments.length !== CITATION_LABELS.length) {
    return [{ label: "Reference", value: segments.join(" ") }];
  }

  return segments.map((value, i) => ({
    label: CITATION_LABELS[i],
    value: CITATION_LABELS[i] === "DOI" ? value.replace(DOI_PREFIX, "") : value,
  }));
}

/**
 * The tooltip's rows, from the discrete fields.
 *
 * Only what the row actually carries: a citation with no DOI shows no DOI row
 * rather than an empty one. The year is separated out of `publicationDate`
 * ("Nov 2022") because the cell shows the year alone and the two panels must
 * agree.
 */
function fieldRows(reference: Reference): TooltipRow[] {
  const { year, journal, doi } = toCitation(reference);
  const rows: TooltipRow[] = [];

  const authors = optionalText(reference.authors);
  if (authors) rows.push({ label: "Authors", value: authors });

  const title = optionalText(reference.title);
  if (title) rows.push({ label: "Title", value: title });

  if (journal) rows.push({ label: "Journal", value: journal });
  if (year) rows.push({ label: "Year", value: year });
  if (doi) rows.push({ label: "DOI", value: doi });

  return rows;
}

/**
 * One reference's rows, from its fields where it has them.
 *
 * The fragment is the fallback: a row with no discrete fields at all is either
 * the export's "citation not available" sentinel or a database predating the
 * widened query, and both still have something to show. Exported so the choice
 * between the two can be tested against a ragged row -- `referenceTooltip`
 * reads a module-level map and cannot be handed one.
 */
export function referenceRows(reference: Reference): TooltipRow[] {
  const rows = fieldRows(reference);
  return rows.length > 0 ? rows : citationRows(reference.formattedRef);
}

/** Formatted citation for a PMID; the lookup defaults to the committed cache. */
export function referenceTooltip(
  pmid: string,
  lookup: ReadonlyMap<string, Reference> = referenceByPmid,
): TooltipContent | null {
  const id = pmid.trim();
  const reference = lookup.get(id);
  if (!reference) return null;

  return {
    rows: referenceRows(reference),
    link: { href: `${PUBMED_BASE_URL}${id}`, label: "View on PubMed" },
  };
}

// -----------------------------------------------------------------------------
// ABBREVIATIONS
// -----------------------------------------------------------------------------

/** Expansion for a brain cell type abbreviation. */
export function cellTypeTooltip(
  abbreviation: string,
): TooltipContent | null {
  const name = CELL_TYPE_NAMES[abbreviation];
  return name ? { rows: [{ label: abbreviation, value: name }] } : null;
}

/**
 * Splits a "FB>PC>SMC" style string into abbreviations and the separators
 * between them, so each abbreviation can carry its own tooltip.
 */
export function splitCellTypes(
  value: string,
): { parts: string[]; separators: string[] } {
  const parts = value.split(/[<>]/).map((p) => p.trim()).filter(Boolean);
  const separators = [...value.matchAll(/[<>]/g)].map((m) => m[0]);
  return { parts, separators };
}

/** Expansion for an omics evidence string, e.g. "TWAS;whole blood". */
export function omicsTooltip(value: string): TooltipContent | null {
  const type = omicsType(value);
  const fullName = OMICS_FULL_NAMES[type.toUpperCase()];
  if (!fullName) return null;

  const semicolon = value.indexOf(";");
  const detail = semicolon === -1 ? "" : value.slice(semicolon + 1).trim();
  const rows: TooltipRow[] = [{ label: type, value: fullName }];
  if (detail) rows.push({ label: "Tissue", value: detail });

  return { rows };
}
