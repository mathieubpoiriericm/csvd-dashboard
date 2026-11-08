import { useMemo } from "preact/hooks";
import { createColumnHelper } from "@tanstack/table-core";
import { useTable } from "@tanstack/preact-table";

import {
  Absent,
  plainCell,
  presentOrUndefined,
} from "../components/Absent.tsx";
import { CheckboxFilter } from "../components/CheckboxFilter.tsx";
import { useCheckboxFilters } from "../components/useCheckboxFilters.ts";
import { DensityReadout } from "../components/DensityReadout.tsx";
import { FilterPanel } from "../components/FilterPanel.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  selectShellState,
  SHELL_FEATURES,
  type ShellFeatures,
  TableShell,
} from "../components/TableShell.tsx";
import {
  hasRealValues,
  OMICS_CHOICES,
  YES_NO_CHOICES,
} from "../lib/constants.ts";
import { CELL_TYPES_LABEL } from "../lib/disease/cell_types.ts";
import { countBy } from "../lib/collections.ts";
import { isDoi, shortCitation, toCitation } from "../lib/citations.ts";
import { referenceByPmid } from "../lib/data/references.ts";
import { genes } from "../lib/data/genes.ts";
import {
  filterGenes,
  formatOmicsValue,
  gwasTraitChoices,
} from "../lib/filters.ts";
import { isAbsent } from "../lib/sentinels.ts";
import { chromosomeOf, CHROMOSOMES } from "../lib/sorting.ts";
import {
  cellTypeTooltip,
  geneTooltip,
  omicsTooltip,
  omimTooltip,
  proteinTooltip,
  referenceTooltip,
  splitCellTypes,
} from "../lib/tooltips.ts";
import { formatConfidence } from "../lib/format.ts";
import { GOLD_ONLY } from "../lib/gold_only.ts";
import type { TooltipContent } from "../lib/tooltip_content.ts";
import type { Gene } from "../lib/types.ts";

/**
 * Header groups above the leaf columns, reproducing the two-row grouped header
 * the Shiny app hand-built as an `htmltools::withTags` sketch.
 */
const HEADER_GROUPS = [
  { label: "Putative Causal Genes", span: 3, border: false },
  { label: "Genetic and Omics Evidence", span: 4, border: true },
  { label: "Expression Context", span: 2, border: true },
  {
    label: "References",
    span: 1,
    spansBothRows: true,
    columnId: "references",
    border: true,
  },
  { label: "Extraction Provenance", span: 2, border: true },
] as const;

/**
 * The columns only a pipeline extraction fills. The hand-curated rows carry
 * neither a source quote nor a confidence score, so under `GOLD_ONLY` the two
 * columns and their header group are left out rather than shown empty.
 */
const PROVENANCE_COLUMNS: ReadonlySet<string> = new Set([
  "sourceQuote",
  "confidence",
]);
const GOLD_HEADER_GROUPS = HEADER_GROUPS.filter((group) =>
  group.label !== "Extraction Provenance"
);

/** Columns that start a visual group, matching the header group boundaries. */
const GROUP_START_COLUMNS = new Set([
  "gwasTrait",
  "brainCellTypes",
  "references",
  "sourceQuote",
]);

/**
 * Joins a list column into the plain text used for sorting and searching:
 * the values the cell shows, as it shows them, or `undefined` when it shows
 * only the absent dash (`presentOrUndefined`).
 */
function asText(
  values: readonly string[],
  format: (value: string) => string = (value) => value,
): string | undefined {
  const present = values.filter((value) => !isAbsent(value));
  return present.length > 0 ? present.map(format).join(", ") : undefined;
}

interface TooltippedValuesProps {
  values: readonly string[];
  tooltipFor?: (value: string) => TooltipContent | null;
  /** How each value renders as the trigger text; the raw value by default. */
  format?: (value: string) => string;
}

/** Comma-separated values that each carry their own optional tooltip. */
function TooltippedValues(
  { values, tooltipFor, format }: TooltippedValuesProps,
) {
  return (
    <>
      {values.map((value, index) => (
        <span key={`${value}-${index}`}>
          {index > 0 && ", "}
          {isAbsent(value)
            ? <Absent />
            : (
              <Tooltip content={tooltipFor?.(value) ?? null}>
                {format ? format(value) : value}
              </Tooltip>
            )}
        </span>
      ))}
    </>
  );
}

/**
 * How one reference reads in the cell.
 *
 * The short form -- `Mishra, A., et al. (2022)` -- rather than the whole
 * citation, because a gene carries up to three references and the journal and
 * DOI on each turns the column into a paragraph. Those live one hover or one
 * keypress away, in the tooltip this trigger already opened; the panel is the
 * whole record, the cell is enough to recognise the paper by.
 *
 * A PMID with no citation falls back to `PMID 12345678`, so the column never
 * has a hole in it.
 */
function ReferenceCitation({ pmid }: { pmid: string }) {
  if (isAbsent(pmid)) return <Absent />;

  const reference = referenceByPmid.get(pmid.trim());
  if (!reference) return <>{pmid}</>;

  const { author, year, etAl } = toCitation(reference);
  if (!author) return <>PMID {reference.pmid}</>;

  return (
    <>
      {author}
      {
        /*
        The space inside "et al." below is a literal U+00A0, not a space --
        invisible in an editor, so do not retype the abbreviation. The
        references column is the table's last and narrowest, so a citation
        wraps, and "et" ending one line with "al." starting the next is the one
        break that reads as a mistake rather than as a wrap. `deno lint`'s
        jsx-curly-braces rule rejects the explicit `{"et\u00A0al."}` form.
      */
      }
      {etAl && (
        <>
          , <i>et al.</i>
        </>
      )}
      {year && ` (${year})`}
    </>
  );
}

/**
 * The references cell: one short citation per PMID, each with its tooltip.
 *
 * The citations are separated by a space and nothing else. Each one is a
 * `.tooltip-box` -- a tinted chip with its own padding --
 * so the boundary between two of them is already drawn; a semicolon between
 * them only added a stray mark to a column that is the table's narrowest.
 *
 * The `.cell-scroll` wrapper is load-bearing, not decorative: `max-height` +
 * `overflow-y: auto` on the `<td>` itself (a `display: table-cell` box) is
 * not honoured by the table row-height algorithm in any browser tested --
 * confirmed with a minimal repro outside this component -- so a real cap
 * needs an in-flow block element between the citations and the cell for the
 * CSS in assets/app.css (`.col-references .cell-scroll`) to bind to. Popover
 * tooltips render in the top layer regardless (see components/Tooltip.tsx),
 * so this wrapper's overflow cannot clip them, the same way .table-scroll's
 * overflow-x already doesn't.
 */
function ReferenceCitations({ values }: { values: readonly string[] }) {
  return (
    <div class="cell-scroll">
      {values.map((pmid, index) => (
        <span key={`${pmid}-${index}`}>
          {index > 0 && " "}
          {isDoi(pmid)
            ? <DoiReference doi={pmid.trim()} />
            : (
              <Tooltip content={referenceTooltip(pmid)}>
                <ReferenceCitation pmid={pmid} />
              </Tooltip>
            )}
        </span>
      ))}
    </div>
  );
}

/**
 * A reference the curators cite by DOI -- a preprint with no PMID, so no
 * PubMed citation to show. The DOI itself is the citation: it reads as a link
 * to the resolver rather than as a PMID whose citation failed to resolve.
 * A DOI suffix may hold any printable character, so the link encodes it
 * (`%` and non-ASCII above all) while the text shows it as written.
 */
function DoiReference({ doi }: { doi: string }) {
  return (
    <a
      href={`https://doi.org/${encodeURI(doi)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {doi}
    </a>
  );
}

/**
 * The references column's sort and search key.
 *
 * Both the PMID and the citation, because the cell shows one and the reader may
 * well search the other: the digits were the only thing this column held until
 * the citation replaced them on screen, and dropping them here would quietly
 * break searching by PMID.
 */
function referencesKey(values: readonly string[]): string | undefined {
  return asText(values, (pmid) => {
    const reference = referenceByPmid.get(pmid.trim());
    return reference ? `${pmid} ${shortCitation(reference)}` : pmid;
  });
}

/**
 * The cell types as the cell prints them -- `FB > PC > SMC` for the stored
 * `FB>PC>SMC`, `Mouse: FB > PC; Human: EC` for a labelled value -- so the
 * search box finds what the reader can see.
 */
function cellTypesText(value: string): string {
  const { parts, chains } = splitCellTypes(value);
  if (parts.length === 0) return value;
  return chains
    .map(({ label, parts, separators }) => {
      const chain = parts
        .map((part, i) => i > 0 ? `${separators[i - 1] ?? ">"} ${part}` : part)
        .join(" ");
      return label === null ? chain : `${label}: ${chain}`;
    })
    .join("; ");
}

/**
 * The brain cell types column's sort and search key: the stored form and the
 * printed one, as `referencesKey` keeps both the PMID and the citation, so
 * either spelling finds the row. The stored form leads, so the order is
 * unchanged.
 */
function cellTypesKey(value: string): string | undefined {
  if (isAbsent(value)) return undefined;
  const shown = cellTypesText(value);
  return shown === value ? value : `${value} ${shown}`;
}

/**
 * The brain cell types cell: each abbreviation gets its own tooltip, unless
 * the value is one of the export's absent sentinels, which renders as
 * `<Absent />` before any splitting is attempted.
 *
 * A part the vocabulary does not recognise renders plain rather than sinking
 * the whole cell back to raw text: one unrecognised abbreviation in a chain
 * used to cost the tooltip on every other part in it too. A labelled value
 * prints each chain after its label, the chains separated by `;` as stored.
 */
export function BrainCellTypesCell({ value }: { value: string }) {
  if (isAbsent(value)) return <Absent />;

  const { parts, chains } = splitCellTypes(value);
  if (parts.length === 0) return value;

  return (
    <>
      {chains.map(({ label, parts, separators }, c) => (
        <span key={`${label}-${c}`}>
          {c > 0 && "; "}
          {label !== null && `${label}: `}
          {parts.map((part, i) => (
            <span key={part + i}>
              {i > 0 && ` ${separators[i - 1] ?? ">"} `}
              <Tooltip content={cellTypeTooltip(part)}>{part}</Tooltip>
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

const column = createColumnHelper<ShellFeatures, Gene>();

const COLUMNS = column.columns([
  column.accessor("gene", {
    header: "Gene",
    cell: ({ row }) => (
      <Tooltip content={geneTooltip(row.original.gene)} italic>
        {row.original.gene}
      </Tooltip>
    ),
  }),
  column.accessor((row) => presentOrUndefined(row.protein), {
    id: "protein",
    header: "Protein",
    cell: ({ row }) =>
      isAbsent(row.original.protein)
        ? <Absent />
        : (
          <Tooltip content={proteinTooltip(row.original.gene)}>
            {row.original.protein}
          </Tooltip>
        ),
  }),
  column.accessor((row) => presentOrUndefined(row.chromosomalLocation), {
    id: "chromosomalLocation",
    header: "Chromosomal Location",
    // Karyotype order, not `alphanumeric`: see the sortFns registry in
    // components/TableShell.tsx.
    sortFn: "chromosome",
    cell: plainCell,
  }),
  column.accessor((row) => asText(row.gwasTrait), {
    id: "gwasTrait",
    header: "GWAS Trait",
    cell: ({ row }) => <TooltippedValues values={row.original.gwasTrait} />,
  }),
  column.accessor((row) => presentOrUndefined(row.mendelianRandomization), {
    id: "mendelianRandomization",
    header: "Mendelian Randomization",
    cell: plainCell,
  }),
  column.accessor(
    (row) => asText(row.evidenceFromOtherOmicsStudies, formatOmicsValue),
    {
      id: "evidenceFromOtherOmicsStudies",
      header: "Evidence From Other Omics Studies",
      cell: ({ row }) => (
        <TooltippedValues
          values={row.original.evidenceFromOtherOmicsStudies}
          tooltipFor={omicsTooltip}
          format={formatOmicsValue}
        />
      ),
    },
  ),
  column.accessor((row) => asText(row.linkToMonogenicDisease), {
    id: "linkToMonogenicDisease",
    header: "Link to Monogenic Disease",
    cell: ({ row }) => (
      <TooltippedValues
        values={row.original.linkToMonogenicDisease}
        tooltipFor={omimTooltip}
      />
    ),
  }),
  column.accessor((row) => cellTypesKey(row.brainCellTypes), {
    id: "brainCellTypes",
    header: CELL_TYPES_LABEL,
    cell: ({ row }) => (
      <BrainCellTypesCell value={row.original.brainCellTypes} />
    ),
  }),
  column.accessor((row) => presentOrUndefined(row.affectedPathway), {
    id: "affectedPathway",
    header: "Affected Pathway",
    cell: plainCell,
  }),
  column.accessor((row) => referencesKey(row.references), {
    id: "references",
    header: "References",
    cell: ({ row }) => <ReferenceCitations values={row.original.references} />,
  }),
  column.accessor((row) => presentOrUndefined(row.sourceQuote), {
    id: "sourceQuote",
    header: "Source Quote",
    cell: plainCell,
  }),
  column.accessor(
    (row) =>
      row.confidence === null ? undefined : formatConfidence(row.confidence),
    {
      id: "confidence",
      header: "Confidence",
      sortUndefined: "last",
      // Search the displayed precision, but sort by the full numeric score.
      sortFn: (a, b) =>
        (a.original.confidence ?? 0) - (b.original.confidence ?? 0),
      cell: ({ row }) => formatConfidence(row.original.confidence),
    },
  ),
]);

/** The sidebar's groups; the trait choices follow the rows (`gwasTraitChoices`). */
function filtersFor(rows: readonly Gene[], goldOnly: boolean) {
  return {
    mendelianRandomization: {
      label: "Mendelian randomization performed",
      choices: YES_NO_CHOICES,
      mode: "binary",
    },
    gwasTraits: {
      label: "GWAS Traits",
      choices: gwasTraitChoices(rows, goldOnly),
    },
    omics: {
      label: "Evidence From Other Omics Studies",
      choices: OMICS_CHOICES,
    },
  } as const;
}

/** The table without the provenance columns, for `GOLD_ONLY`. */
const GOLD_COLUMNS = COLUMNS.filter((def) =>
  !("id" in def && def.id !== undefined && PROVENANCE_COLUMNS.has(def.id))
);

interface GenesViewProps {
  /** The rows to render; the committed table by default. Tests hand in synthetic rows. */
  rows?: readonly Gene[];
  /**
   * Whether to leave out the provenance columns and offer only the traits the
   * rows carry; `GOLD_ONLY` by default.
   */
  goldOnly?: boolean;
}

export default function GenesView(
  { rows = genes, goldOnly = GOLD_ONLY }: GenesViewProps = {},
) {
  const filters = useMemo(() => filtersFor(rows, goldOnly), [rows, goldOnly]);
  const { values, controls, summary, reset } = useCheckboxFilters(filters);
  const filtered = useMemo(
    () => filterGenes(rows, values),
    [rows, values],
  );
  /** Genes per chromosome, unfiltered, so the readout bars keep a stable height. */
  const genesPerChromosome = useMemo(
    () => countBy(rows, (gene) => chromosomeOf(gene.chromosomalLocation)),
    [rows],
  );

  const table = useTable({
    features: SHELL_FEATURES,
    data: filtered,
    columns: goldOnly ? GOLD_COLUMNS : COLUMNS,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
    // A column's key is `undefined` exactly where its cell shows the absent
    // dash (`presentOrUndefined`), and those rows sort last either way.
    defaultColumn: { sortUndefined: "last" },
    // No column here opts into row spanning; switching the feature off keeps
    // its span index from being built at all.
    enableCellSpanning: false,
  }, selectShellState);

  // The table's global search is a filter too. Build the readout from the
  // post-search row model so its counts cannot disagree with the table below.
  const visibleGenes = table.getFilteredRowModel().rows.map(
    (row) => row.original,
  );

  const shownByChromosome = countBy(
    visibleGenes,
    (gene) => chromosomeOf(gene.chromosomalLocation),
  );
  const readout = CHROMOSOMES
    .map((chromosome) => ({
      label: chromosome,
      total: genesPerChromosome.get(chromosome) ?? 0,
      shown: shownByChromosome.get(chromosome) ?? 0,
    }))
    .filter((bucket) => bucket.total > 0);

  return (
    <FilterPanel
      titleId="gene-filters-title"
      filters={controls.map((props) => (
        <CheckboxFilter key={props.label} {...props} />
      ))}
    >
      <DensityReadout
        axisLabel="Genes by chromosome"
        stats={[
          {
            label: "Genes shown",
            value: visibleGenes.length,
            of: rows.length,
          },
          {
            label: "GWAS-supported",
            value: visibleGenes.filter((g) => hasRealValues(g.gwasTrait))
              .length,
          },
          {
            label: "Monogenic link",
            value:
              visibleGenes.filter((g) =>
                hasRealValues(g.linkToMonogenicDisease)
              )
                .length,
          },
        ]}
        buckets={readout}
      />

      <TableShell
        table={table}
        headerGroups={goldOnly ? GOLD_HEADER_GROUPS : HEADER_GROUPS}
        groupStartColumns={GROUP_START_COLUMNS}
        identityColumn="gene"
        filterSummary={summary}
        totalRows={rows.length}
        tableLabel="Putative causal genes"
        searchLabel="Search genes"
        onClearFilters={reset}
      />
    </FilterPanel>
  );
}
