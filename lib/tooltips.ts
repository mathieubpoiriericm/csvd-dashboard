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
  GENERIC_ACRONYMS,
  PUBMED_BASE_URL,
} from "./constants.ts";
import { isDoi, toCitation } from "./citations.ts";
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
  lookup: ReadonlyMap<string, readonly GeneInfo[]> = geneInfoByName,
): TooltipContent | null {
  return geneInfoTooltip(lookup.get(geneSymbol));
}

/** UniProt summary, looked up by the gene symbol rather than the protein name. */
export function proteinTooltip(
  geneSymbol: string,
  lookup: ReadonlyMap<string, readonly ProteinInfo[]> = proteinInfoByGene,
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

/**
 * Formatted citation for a PMID, or for a preprint cited by DOI; the lookup
 * defaults to the committed cache.
 */
export function referenceTooltip(
  pmid: string,
  lookup: ReadonlyMap<string, Reference> = referenceByPmid,
): TooltipContent | null {
  const id = pmid.trim();
  const reference = lookup.get(id);
  if (!reference) return null;

  // A preprint cited by DOI has no PubMed record to link to.
  const link = isDoi(id)
    ? { href: `https://doi.org/${encodeURI(id)}`, label: "View on doi.org" }
    : { href: `${PUBMED_BASE_URL}${id}`, label: "View on PubMed" };
  return { rows: referenceRows(reference), links: [link] };
}

// -----------------------------------------------------------------------------
// ABBREVIATIONS
// -----------------------------------------------------------------------------

/** `Matrix, PC`: a subtype qualifier, then the abbreviation it qualifies. */
const SUBTYPED_CELL_TYPE = /^(.+?),\s*(\S+)$/;
/** `Exc Neu (allen brain atlas)`: an abbreviation, then a note on its source. */
const NOTED_CELL_TYPE = /^(.+?)\s*(\([^()]*\))$/;

/**
 * One cell type split into the subtype qualifying it, if any, and the
 * abbreviation: `Matrix, PC` is `Matrix` and `PC`.
 *
 * The comma is the stored form's and stays there, because it is what marks
 * where the subtype ends: an abbreviation can itself hold a space (`Exc Neu`).
 * It is only read as a subtype when the glossary defines what follows it, so
 * free text holding a comma comes back whole, with no subtype.
 */
export function splitSubtype(
  part: string,
): { subtype: string | null; abbreviation: string } {
  const subtyped = SUBTYPED_CELL_TYPE.exec(part);
  return subtyped && Object.hasOwn(CELL_TYPE_NAMES, subtyped[2])
    ? { subtype: subtyped[1].trim(), abbreviation: subtyped[2] }
    : { subtype: null, abbreviation: part };
}

/** A cell type as the cell prints it: `Matrix PC` for the stored `Matrix, PC`. */
export function cellTypeText(part: string): string {
  const { subtype, abbreviation } = splitSubtype(part);
  return subtype === null ? abbreviation : `${subtype} ${abbreviation}`;
}

/**
 * Expansion for one brain cell type: a bare abbreviation (`PC`), a subtype of
 * one (`Matrix, PC` -> "Matrix Pericytes", under the printed `Matrix PC`), or
 * one followed by a parenthesised note (`Exc Neu (allen brain atlas)`), which
 * the expansion keeps.
 */
export function cellTypeTooltip(part: string): TooltipContent | null {
  if (Object.hasOwn(CELL_TYPE_NAMES, part)) {
    return { rows: [{ label: part, value: CELL_TYPE_NAMES[part] }] };
  }
  const { subtype, abbreviation } = splitSubtype(part);
  if (subtype !== null) {
    return {
      rows: [{
        label: cellTypeText(part),
        value: `${subtype} ${CELL_TYPE_NAMES[abbreviation]}`,
      }],
    };
  }
  const noted = NOTED_CELL_TYPE.exec(part);
  if (noted && Object.hasOwn(CELL_TYPE_NAMES, noted[1])) {
    const [, abbreviation, note] = noted;
    return {
      rows: [{
        label: abbreviation,
        value: `${CELL_TYPE_NAMES[abbreviation]} ${note}`,
      }],
    };
  }
  return null;
}

/**
 * One chain of cell types: the abbreviations and the separators between them,
 * under the label the value gave the chain, if any.
 */
export interface CellTypeChain {
  /** `Mouse` in `Mouse: FB>PC`; null for a chain written without a label. */
  label: string | null;
  parts: string[];
  /** `>` or `<`, doubled (`>>`) where the value doubles it. */
  separators: string[];
}

const CELL_TYPE_SEPARATOR = /<<|>>|<|>/g;
const LABELLED_CHAIN = /^\s*([A-Za-z][A-Za-z ]*?)\s*:(.*)$/s;

function splitChain(value: string): Omit<CellTypeChain, "label"> {
  const parts = value.split(CELL_TYPE_SEPARATOR).map((p) => p.trim())
    .filter(Boolean);
  const separators = [...value.matchAll(CELL_TYPE_SEPARATOR)].map((m) => m[0]);
  return { parts, separators };
}

/**
 * Splits a cell-type value into abbreviations and the separators between
 * them, so each abbreviation can carry its own tooltip.
 *
 * Two forms are read. The plain one is a single chain, `FB>PC>SMC`. The
 * labelled one is several chains separated by `;`, each named before a colon,
 * `Mouse: FB>PC; Human: Matrix, PC >> Venous, SMC`; it is taken as labelled only
 * when every `;`-separated segment carries a label, so free text that happens
 * to hold a colon stays one plain chain. `parts` is every chain's
 * abbreviations, in order.
 */
export function splitCellTypes(
  value: string,
): { parts: string[]; chains: CellTypeChain[] } {
  const labelled = value.split(";").map((segment) =>
    LABELLED_CHAIN.exec(segment)
  );
  const chains =
    labelled.every((match): match is RegExpExecArray => match !== null)
      ? labelled.map((match) => ({ label: match[1], ...splitChain(match[2]) }))
      : [{ label: null, ...splitChain(value) }];
  return { parts: chains.flatMap((chain) => chain.parts), chains };
}

/** Expansion for an omics evidence string, e.g. "TWAS;whole blood". */
export function omicsTooltip(value: string): TooltipContent | null {
  const type = omicsType(value);
  const fullName = GENERIC_ACRONYMS[type.toUpperCase()]?.name;
  if (!fullName) return null;

  const semicolon = value.indexOf(";");
  const detail = semicolon === -1 ? "" : value.slice(semicolon + 1).trim();
  const rows: TooltipRow[] = [{ label: type, value: fullName }];
  if (detail) rows.push({ label: "Tissue", value: detail });

  return { rows };
}
