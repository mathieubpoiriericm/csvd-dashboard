import { useMemo } from "preact/hooks";
import { createColumnHelper } from "@tanstack/table-core";
import { useTable } from "@tanstack/preact-table";

import { Absent, plainCell } from "../components/Absent.tsx";
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
  GWAS_TRAIT_CHOICES,
  hasRealValues,
  OMICS_CHOICES,
  YES_NO_CHOICES,
} from "../lib/constants.ts";
import { countBy } from "../lib/collections.ts";
import { shortCitation, toCitation } from "../lib/citations.ts";
import { referenceByPmid } from "../lib/data/references.ts";
import { genes } from "../lib/data/genes.ts";
import { filterGenes, formatOmicsValue } from "../lib/filters.ts";
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

/** Columns that start a visual group, matching the header group boundaries. */
const GROUP_START_COLUMNS = new Set([
  "gwasTrait",
  "brainCellTypes",
  "references",
  "sourceQuote",
]);

/** Genes per chromosome, unfiltered, so the readout bars keep a stable height. */
const GENES_PER_CHROMOSOME = countBy(
  genes,
  (gene) => chromosomeOf(gene.chromosomalLocation),
);

/** Joins a list column into the plain text used for sorting and searching. */
const asText = (values: string[]) => values.join(", ");

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
 * `.tooltip-box` -- a tinted, dotted-underlined chip with its own padding --
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
          <Tooltip content={referenceTooltip(pmid)}>
            <ReferenceCitation pmid={pmid} />
          </Tooltip>
        </span>
      ))}
    </div>
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
function referencesKey(values: readonly string[]): string {
  return values
    .map((pmid) => {
      const reference = referenceByPmid.get(pmid.trim());
      return reference ? `${pmid} ${shortCitation(reference)}` : pmid;
    })
    .join(", ");
}

/**
 * The brain cell types cell: each abbreviation gets its own tooltip, unless
 * the value is one of the export's absent sentinels, which renders as
 * `<Absent />` before any splitting is attempted.
 *
 * A part the vocabulary does not recognise renders plain rather than sinking
 * the whole cell back to raw text: one unrecognised abbreviation in a chain
 * used to cost the tooltip on every other part in it too.
 */
export function BrainCellTypesCell({ value }: { value: string }) {
  if (isAbsent(value)) return <Absent />;

  const { parts, separators } = splitCellTypes(value);
  if (parts.length === 0) return value;

  return (
    <>
      {parts.map((part, i) => (
        <span key={part + i}>
          {i > 0 && ` ${separators[i - 1] ?? ">"} `}
          <Tooltip content={cellTypeTooltip(part)}>{part}</Tooltip>
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
  column.accessor("protein", {
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
  column.accessor("chromosomalLocation", {
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
  column.accessor("mendelianRandomization", {
    header: "Mendelian Randomization",
    cell: plainCell,
  }),
  column.accessor(
    (row) => asText(row.evidenceFromOtherOmicsStudies.map(formatOmicsValue)),
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
  column.accessor("brainCellTypes", {
    header: "Brain Cell Types",
    cell: ({ row }) => (
      <BrainCellTypesCell value={row.original.brainCellTypes} />
    ),
  }),
  column.accessor("affectedPathway", {
    header: "Affected Pathway",
    cell: plainCell,
  }),
  column.accessor((row) => referencesKey(row.references), {
    id: "references",
    header: "References",
    cell: ({ row }) => <ReferenceCitations values={row.original.references} />,
  }),
  column.accessor("sourceQuote", {
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

const FILTERS = {
  mendelianRandomization: {
    label: "Mendelian randomization performed",
    choices: YES_NO_CHOICES,
    mode: "binary",
  },
  gwasTraits: {
    label: "GWAS Traits",
    choices: GWAS_TRAIT_CHOICES,
  },
  omics: {
    label: "Evidence From Other Omics Studies",
    choices: OMICS_CHOICES,
  },
} as const;

export default function GenesView() {
  const { values, controls, summary, reset } = useCheckboxFilters(FILTERS);
  const filtered = useMemo(
    () => filterGenes(genes, values),
    [values],
  );

  const table = useTable({
    features: SHELL_FEATURES,
    data: filtered,
    columns: COLUMNS,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
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
      total: GENES_PER_CHROMOSOME.get(chromosome) ?? 0,
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
            of: genes.length,
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
        headerGroups={HEADER_GROUPS}
        groupStartColumns={GROUP_START_COLUMNS}
        identityColumn="gene"
        filterSummary={summary}
        totalRows={genes.length}
        tableLabel="Putative causal genes"
        searchLabel="Search genes"
        onClearFilters={reset}
      />
    </FilterPanel>
  );
}
