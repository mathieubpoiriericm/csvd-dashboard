import { useMemo, useState } from "preact/hooks";
import { createColumnHelper } from "@tanstack/table-core";
import type { RowSpanContext, SortingState } from "@tanstack/table-core";
import { useTable } from "@tanstack/preact-table";

import { Absent, plainCell, valueOrAbsent } from "../components/Absent.tsx";
import { CheckboxFilter } from "../components/CheckboxFilter.tsx";
import { useCheckboxFilters } from "../components/useCheckboxFilters.ts";
import { DensityReadout } from "../components/DensityReadout.tsx";
import { FilterPanel } from "../components/FilterPanel.tsx";
import {
  selectShellState,
  SHELL_FEATURES,
  type ShellFeatures,
  TableShell,
} from "../components/TableShell.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  DEFAULT_TRIAL_STATUSES,
  formatMonthYear,
  PHASE_CHOICES,
  POPULATION_CHOICES,
  REGISTRY_CHOICES,
  SPONSOR_CHOICES,
  STATUS_CHOICES,
  YES_NO_CHOICES,
} from "../lib/constants.ts";
import { POPULATION_FIELD } from "../lib/disease/populations.ts";
import { countBy, uniqueCount } from "../lib/collections.ts";
import { trials } from "../lib/data/trials.ts";
import { filterTrials, normalize } from "../lib/filters.ts";
import { isAbsent } from "../lib/sentinels.ts";
import { registryTooltip, trialGeneTooltip } from "../lib/trial_tooltips.ts";
import { resolveTrialStatus } from "../lib/trials.ts";
import { compareCompletionDates, completionDateKey } from "../lib/sorting.ts";
import type { Trial } from "../lib/types.ts";

/**
 * Merges a run of rows when the value repeats within one drug's block.
 *
 * This is the whole of the Shiny app's row-merging behaviour. There it took an
 * O(n x 4) run-length scan in R (`add_drug_group_indices`) that shipped its
 * results through three hidden columns, plus a ~110-line `drawCallback` in
 * JavaScript to reassemble them at draw time.
 */
const spanWithinDrug = (
  { anchorRow, anchorValue, row, value }: RowSpanContext<
    ShellFeatures,
    Trial,
    string
  >,
) =>
  value === anchorValue &&
  value !== "" &&
  row.original.drug === anchorRow.original.drug;

/**
 * Merged cells only line up while rows are grouped by drug, so spanning is
 * allowed under that sort and nothing else — the same rule the Shiny
 * drawCallback enforced before it would merge anything.
 */
const isGroupedByDrug = (sorting: SortingState) =>
  sorting.length === 0 ||
  (sorting.length === 1 && sorting[0].id === "drug");

/**
 * Gives every comma/semicolon/slash-separated target its own lookup tooltip.
 *
 * The `.cell-scroll` wrapper caps this cell's height the same way
 * `ReferenceCitations` (islands/GenesView.tsx) caps the genes table's
 * references column, and for the same reason: `max-height` on the `<td>`
 * itself does not work in table layout, so the CSS needs an in-flow block
 * element to bind to. Colchicine is the one row that needs it -- its target
 * list runs to 15 tubulin isoforms against a one-symbol median elsewhere.
 */
export function GeneticTargets({ value }: { value: string }) {
  if (isAbsent(value)) return <Absent />;

  const pieces = value.split(/([,;/]\s*)/);

  return (
    <div class="cell-scroll">
      {pieces.map((piece, index) => {
        if (index % 2 === 1) return piece;
        const symbol = piece.trim();
        if (!symbol) return piece;
        return (
          <Tooltip
            key={`${symbol}-${index}`}
            content={trialGeneTooltip(symbol)}
            italic
          >
            {piece}
          </Tooltip>
        );
      })}
    </div>
  );
}

const PHASE_ORDER = ["I", "I/II", "II", "II/III", "III", "IV"];
const TRIALS_PER_PHASE = countBy(
  trials,
  (trial) => trial.clinicalTrialPhase.trim(),
);
const PHASES = [
  ...PHASE_ORDER.filter((phase) => TRIALS_PER_PHASE.has(phase)),
  ...[...TRIALS_PER_PHASE.keys()]
    .filter((phase) => !PHASE_ORDER.includes(phase))
    .sort(),
];

const column = createColumnHelper<ShellFeatures, Trial>();

const COLUMNS = column.columns([
  column.accessor("drug", {
    header: "Drug",
    spanRows: spanWithinDrug,
  }),
  column.accessor("mechanismOfAction", {
    header: "Mechanism of Action",
    cell: plainCell,
  }),
  column.accessor("geneticTarget", {
    header: "Genetic Target",
    spanRows: spanWithinDrug,
    cell: ({ row }) => <GeneticTargets value={row.original.geneticTarget} />,
  }),
  column.accessor("geneticEvidence", {
    header: "Genetic Evidence",
    cell: plainCell,
  }),
  column.accessor("trialName", {
    header: "Trial Name",
    cell: plainCell,
  }),
  column.accessor("registryId", {
    header: "Registry ID",
    cell: ({ row }) =>
      isAbsent(row.original.registryId)
        ? <Absent />
        : (
          <Tooltip content={registryTooltip(row.original.registryId)}>
            {row.original.registryId}
          </Tooltip>
        ),
  }),
  column.accessor("overallStatus", {
    header: "Study Status",
    cell: ({ row }) =>
      isAbsent(row.original.overallStatus)
        ? <Absent />
        : resolveTrialStatus(row.original.overallStatus).label,
  }),
  column.accessor("clinicalTrialPhase", {
    header: "Clinical Trial Phase",
    spanRows: spanWithinDrug,
    cell: plainCell,
  }),
  column.accessor("svdPopulation", {
    header: POPULATION_FIELD.label,
    spanRows: spanWithinDrug,
    cell: plainCell,
  }),
  column.accessor("svdPopulationDetails", {
    header: POPULATION_FIELD.detailsLabel,
    cell: plainCell,
  }),
  column.accessor("targetSampleSize", {
    header: "Target Sample Size",
    cell: plainCell,
  }),
  // The accessor reads `undefined` for a non-date value so `sortUndefined:
  // "last"` -- not TanStack's private sorting atom -- keeps unparsed values
  // last in both sort directions (TanStack negates the comparator itself for
  // descending). For a parseable date it returns the formatted "Jul 2028",
  // not the raw "7/2028", so global search matches what the cell actually
  // shows; the sort comparator reads `row.original` directly and is
  // unaffected.
  column.accessor(
    (row) =>
      completionDateKey(row.estimatedCompletionDate) === null
        ? undefined
        : formatMonthYear(row.estimatedCompletionDate),
    {
      id: "estimatedCompletionDate",
      header: "Estimated Completion Date",
      sortUndefined: "last",
      sortFn: (rowA, rowB) =>
        compareCompletionDates(
          rowA.original.estimatedCompletionDate,
          rowB.original.estimatedCompletionDate,
        ),
      cell: ({ row }) =>
        valueOrAbsent(formatMonthYear(row.original.estimatedCompletionDate)),
    },
  ),
  column.accessor("primaryOutcome", {
    header: "Primary Outcome",
    cell: plainCell,
  }),
  column.accessor("sponsorType", {
    header: "Sponsor Type",
    cell: plainCell,
  }),
]);

const FILTERS = {
  geneticEvidence: {
    label: "Genetic evidence",
    choices: YES_NO_CHOICES,
    mode: "binary",
  },
  registries: {
    label: "Clinical Trial Registry",
    choices: REGISTRY_CHOICES,
  },
  phases: {
    label: "Clinical Trial Phase",
    choices: PHASE_CHOICES,
  },
  populations: {
    label: POPULATION_FIELD.label,
    choices: POPULATION_CHOICES,
  },
  sponsors: {
    label: "Sponsor Type",
    choices: SPONSOR_CHOICES,
  },
  statuses: {
    label: "Study status",
    choices: STATUS_CHOICES,
    initial: DEFAULT_TRIAL_STATUSES,
  },
} as const;

export default function TrialsView() {
  const { values, controls, summary, reset } = useCheckboxFilters(FILTERS);
  // Sorting is the one slice this component owns, because `enableCellSpanning`
  // has to be decided from it before the table is constructed. `setSorting`
  // already accepts a value or an updater, which is exactly what
  // `onSortingChange` hands it.
  const [sorting, setSorting] = useState<SortingState>([
    { id: "drug", desc: false },
  ]);

  const filtered = useMemo(
    () => filterTrials(trials, values),
    [values],
  );
  const groupedByDrug = isGroupedByDrug(sorting);

  const table = useTable({
    features: SHELL_FEATURES,
    data: filtered,
    columns: COLUMNS,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
    state: { sorting },
    onSortingChange: setSorting,
    // Switching spanning off here empties the span index at source, so the
    // renderer needs no second switch of its own.
    enableCellSpanning: groupedByDrug,
  }, selectShellState);

  // Keep the phase readout aligned with global search as well as the sidebar
  // filters by consuming the table's post-filter row model.
  const visibleTrials = table.getFilteredRowModel().rows.map(
    (row) => row.original,
  );

  // Alternate the background per visible drug block rather than per source
  // row. Use the table's post-search, post-sort model: deriving this from the
  // sidebar-filtered input makes two surviving groups share a colour whenever
  // search hides an odd number of groups between them. Memoised because this
  // rebuilds a `Map` by walking every row -- work every render was repeating
  // even when neither the grouping nor the row order had changed.
  const sortedRows = table.getSortedRowModel().rows;
  const groupParity = useMemo(() => {
    const parity = new Map<string, number>();
    if (groupedByDrug) {
      let previousDrug: string | null = null;
      let index = -1;
      for (const row of sortedRows) {
        if (row.original.drug !== previousDrug) {
          index += 1;
          previousDrug = row.original.drug;
        }
        parity.set(row.id, index % 2);
      }
    }
    return parity;
  }, [groupedByDrug, sortedRows]);

  const visibleTrialsPerPhase = countBy(
    visibleTrials,
    (trial) => trial.clinicalTrialPhase.trim(),
  );
  const readout = PHASES.map((phase) => ({
    label: phase || "—",
    total: TRIALS_PER_PHASE.get(phase) ?? 0,
    shown: visibleTrialsPerPhase.get(phase) ?? 0,
  }));

  return (
    <FilterPanel
      titleId="trial-filters-title"
      filters={controls.map((props) => (
        <CheckboxFilter key={props.label} {...props} />
      ))}
    >
      <DensityReadout
        axisLabel="Trials by phase"
        stats={[
          {
            label: "Trials shown",
            value: visibleTrials.length,
            of: trials.length,
          },
          {
            label: "Genetic evidence",
            value:
              visibleTrials.filter((t) =>
                normalize(t.geneticEvidence) === "yes"
              ).length,
          },
          {
            label: "Distinct drugs",
            value: uniqueCount(visibleTrials.map((t) => t.drug.trim())),
          },
        ]}
        buckets={readout}
      />

      <TableShell
        table={table}
        identityColumn="drug"
        filterSummary={summary}
        totalRows={trials.length}
        tableLabel="Clinical trials"
        searchLabel="Search trials"
        rowClass={groupedByDrug
          ? (row) => groupParity.get(row.id) === 0 ? "group-even" : "group-odd"
          : undefined}
        onClearFilters={reset}
      />
    </FilterPanel>
  );
}
