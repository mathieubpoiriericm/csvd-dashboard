import { createSearchDraft } from "./searchDraft.ts";
import { useHydratedRef } from "./useHydratedRef.ts";
import { FlexRender } from "@tanstack/preact-table";
import { Icon } from "./Icon.tsx";
import { compareChromosomalLocation } from "../lib/sorting.ts";
import type { PreactTable } from "@tanstack/preact-table";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  cellSpanningFeature,
  columnFilteringFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
} from "@tanstack/table-core";
import type {
  PaginationState,
  Row,
  RowData,
  SortingState,
} from "@tanstack/table-core";

/** A spanning cell in the upper header row. */
interface HeaderGroupSpec {
  label: string;
  span: number;
  /** Render across both header rows instead of sitting above leaf columns. */
  spansBothRows?: boolean;
  /** Id of the leaf column this group stands in for, when spansBothRows. */
  columnId?: string;
  border?: boolean;
}

/**
 * The features this shell's controls call into, declared once so the shell and
 * its callers cannot drift apart: `Table` is invariant in its feature set, so
 * a shell generic over the features could not resolve any feature-gated API.
 *
 * `columnFilteringFeature` is `globalFilteringFeature`'s and
 * `filteredRowModel`'s declared prerequisite — `tableFeatures` rejects the set
 * without it. The core features and the core row model are supplied by
 * `constructTable` itself and must not be listed here.
 *
 * The `sortFns` registry is what makes `sortFn: 'auto'` resolve to anything.
 * Left unregistered, every column silently falls back to `sortFn_basic`, which
 * compares raw strings: "1300" sorts before "15", chromosome 10 before
 * chromosome 1, and "ARSB" before "Apo E".
 *
 * `chromosome` is registered beside them because `alphanumeric` is not right
 * for a cytogenetic band either: it compares the leading chunk and orders a
 * string chunk before a numeric one, so "Xq22.1" sorted above chromosome 1.
 * A column naming it sorts in karyotype order instead.
 *
 * A table that does not merge cells opts out with `enableCellSpanning: false`
 * rather than by dropping the feature, which keeps one shared feature type.
 */
/** Karyotype order for the chromosomal-location column. */
function sortFn_chromosome(
  rowA: { getValue: (id: string) => unknown },
  rowB: { getValue: (id: string) => unknown },
  columnId: string,
): number {
  return compareChromosomalLocation(
    String(rowA.getValue(columnId) ?? ""),
    String(rowB.getValue(columnId) ?? ""),
  );
}

export const SHELL_FEATURES = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowPaginationFeature,
  cellSpanningFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    chromosome: sortFn_chromosome,
  },
});

export type ShellFeatures = typeof SHELL_FEATURES;

/**
 * The state slices the shell and its islands render from.
 *
 * Passing this as an explicit `useTable` selector keeps re-renders to these
 * three. Omitting the selector subscribes to every registered slice, which
 * now includes the `columnFilters` that `columnFilteringFeature` brings along
 * as `globalFilteringFeature`'s prerequisite and that nothing here reads.
 */
interface ShellState {
  pagination: PaginationState;
  globalFilter: unknown;
  sorting: SortingState;
}

export const selectShellState = (state: ShellState): ShellState => ({
  pagination: state.pagination,
  globalFilter: state.globalFilter,
  sorting: state.sorting,
});

interface TableShellProps<TData extends RowData> {
  table: PreactTable<ShellFeatures, TData, ShellState>;
  headerGroups?: readonly HeaderGroupSpec[];
  groupStartColumns?: ReadonlySet<string>;
  /** Column id that carries `col-identity`, on top of its `col-<columnId>`. */
  identityColumn?: string;
  filterSummary: readonly string[];
  totalRows: number;
  tableLabel: string;
  searchLabel: string;
  /** Extra class per body row, used for drug-group striping. */
  rowClass?: (row: Row<ShellFeatures, TData>) => string | undefined;
  /**
   * Resets every sidebar filter group to its unconstrained state. When given,
   * the empty state offers a "Clear all filters" button that calls it after
   * clearing the search box and the table's own global filter — the empty
   * state is otherwise a dead end with no way back to the full table.
   */
  onClearFilters?: () => void;
}

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * How long the table waits after the last keystroke before it re-filters.
 *
 * Below roughly 100 ms a fast typist still pays for most keystrokes; above
 * roughly 200 ms the table visibly trails the box. This sits between them.
 */
const SEARCH_DEBOUNCE_MS = 120;
/** Draft keystrokes rerender only this field, not the table's rows. */
function SearchInput({ label, initialValue, onCommit, resetRef }: {
  label: string;
  initialValue: string;
  onCommit: (value: string) => void;
  resetRef: { current: (() => void) | null };
}) {
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = useRef<ReturnType<typeof createSearchDraft>>();
  const commit = useRef(onCommit);
  commit.current = onCommit;
  pending.current ??= createSearchDraft(
    (value) => commit.current(value),
    SEARCH_DEBOUNCE_MS,
  );
  const search = pending.current;
  resetRef.current = () => {
    search.cancel();
    setDraft("");
    inputRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => search.cancel, []);
  return (
    <label class="table-control">
      <span class="visually-hidden">{label}</span>
      <input
        type="search"
        placeholder={label}
        ref={inputRef}
        value={draft}
        onInput={(event) => {
          const value = event.currentTarget.value;
          setDraft(value);
          search.update(value);
        }}
      />
    </label>
  );
}

type SortDirection = false | "asc" | "desc";

const classNames = (...values: Array<string | false | undefined>) =>
  values.filter(Boolean).join(" ") || undefined;

export function ariaSort(
  sortable: boolean,
  sorted: SortDirection,
): "ascending" | "descending" | "none" | undefined {
  if (!sortable) return undefined;
  return sorted === "asc"
    ? "ascending"
    : sorted === "desc"
    ? "descending"
    : "none";
}

interface HeaderCellProps {
  sortable: boolean;
  sorted: SortDirection;
  onSort: () => void;
  className?: string;
  colSpan?: number;
  rowSpan?: number;
  scope: "col" | "colgroup";
  children: ComponentChildren;
}

/** Shared sorting semantics for both grouped and leaf headers. */
function HeaderCell({
  sortable,
  sorted,
  onSort,
  className,
  colSpan,
  rowSpan,
  scope,
  children,
}: HeaderCellProps) {
  return (
    <th
      colSpan={colSpan}
      rowSpan={rowSpan}
      scope={scope}
      class={classNames(className, sortable && "sortable")}
      aria-sort={ariaSort(sortable, sorted)}
    >
      {sortable
        ? (
          <button class="sort-button" type="button" onClick={onSort}>
            {children}
            <span class="sort-indicator">
              <Icon
                name={sorted === "asc"
                  ? "sortAsc"
                  : sorted === "desc"
                  ? "sortDesc"
                  : "sortNone"}
              />
            </span>
          </button>
        )
        : children}
    </th>
  );
}

/**
 * Renders a TanStack table: controls, the optional two-row grouped header,
 * body and pagination.
 *
 * Row merging uses the cell-spanning feature rather than the Shiny app's
 * approach, which shipped rowspan runs in three hidden columns and reassembled
 * them in a ~110-line DataTables `drawCallback`.
 */
export function TableShell<TData extends RowData>({
  table,
  headerGroups,
  groupStartColumns,
  identityColumn,
  filterSummary,
  totalRows,
  tableLabel,
  searchLabel,
  rowClass,
  onClearFilters,
}: TableShellProps<TData>) {
  const hydratedRef = useHydratedRef<HTMLDivElement>();
  const resetSearchRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pagination, globalFilter } = table.state;
  const { pageIndex, pageSize } = pagination;
  useLayoutEffect(() => {
    // A new page starts at its first row; preserve the chosen column position.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [pageIndex, pageSize]);
  const pageCount = table.getPageCount();
  const rows = table.getRowModel().rows;
  const filteredRows = table.getFilteredRowModel().rows.length;
  const leafHeaders = table.getHeaderGroups().at(-1)?.headers ?? [];
  const searchTerm = typeof globalFilter === "string"
    ? globalFilter.trim()
    : "";
  const activeFilters = searchTerm
    ? [...filterSummary, `Search: “${searchTerm}”`]
    : filterSummary;

  const bothRowColumnIds = new Set(
    (headerGroups ?? []).filter((g) => g.spansBothRows).map((g) => g.columnId),
  );

  // Additive on top of whatever else a cell already carries (`group-cell`,
  // `col-group-start`, the `group-even`/`group-odd` row classes) — never a
  // replacement, since `td:nth-child(N)` selectors in assets/app.css still
  // depend on the pre-existing classes being there unchanged.
  const identityClass = (columnId: string) =>
    identityColumn === columnId ? "col-identity" : undefined;

  const columnClass = (columnId: string) =>
    classNames(
      `col-${columnId}`,
      groupStartColumns?.has(columnId) && "col-group-start",
      identityClass(columnId),
    );

  return (
    <>
      <div class="filter-message" role="status">
        <strong>Active Filters:</strong> {activeFilters.length > 0
          ? <span class="filter-active">{activeFilters.join(" | ")}</span>
          : <span class="filter-none">None</span>}
        {" — "}
        showing {filteredRows} of {totalRows} rows
      </div>

      <div class="table-controls" ref={hydratedRef}>
        <label class="table-control">
          Show
          <select
            value={String(pageSize)}
            onChange={(e) => table.setPageSize(Number(e.currentTarget.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={String(size)}>{size}</option>
            ))}
          </select>
          entries
        </label>

        <SearchInput
          resetRef={resetSearchRef}
          label={searchLabel}
          initialValue={typeof globalFilter === "string" ? globalFilter : ""}
          onCommit={(value) => table.setGlobalFilter(value)}
        />
      </div>

      {
        /* The scroller is `overflow: auto`, which clips the frame's
          registration marks at their negative inset, so the frame is a
          wrapper rather than the scroller itself. */
      }
      <div class="blueprint-frame">
        <div class="table-scroll" ref={scrollRef}>
          <table class="data-table">
            <caption class="visually-hidden">{tableLabel}</caption>
            <thead>
              {headerGroups && (
                <tr>
                  {headerGroups.map((group) => {
                    const header = group.columnId
                      ? leafHeaders.find(({ column }) =>
                        column.id === group.columnId
                      )
                      : undefined;
                    const column = header?.column;
                    const sorted = column?.getIsSorted();
                    const sortable = column?.getCanSort() ?? false;

                    return (
                      <HeaderCell
                        key={group.label}
                        colSpan={group.span}
                        rowSpan={group.spansBothRows ? 2 : undefined}
                        scope={group.spansBothRows ? "col" : "colgroup"}
                        className={classNames(
                          "col-group-head",
                          group.border && "col-group-start",
                          // Only a group header that stands in for one leaf
                          // column (spansBothRows) corresponds to an actual
                          // column id; a header spanning several leaf columns
                          // below it does not, and gets no col-<id>/col-identity.
                          column && `col-${column.id}`,
                          column && identityClass(column.id),
                        )}
                        sortable={sortable}
                        sorted={sorted ?? false}
                        onSort={() => column?.toggleSorting()}
                      >
                        {group.label}
                      </HeaderCell>
                    );
                  })}
                </tr>
              )}

              <tr>
                {leafHeaders
                  .filter(({ column }) => !bothRowColumnIds.has(column.id))
                  .map((header) => {
                    const column = header.column;
                    const sorted = column.getIsSorted();
                    const sortable = column.getCanSort();

                    return (
                      <HeaderCell
                        key={column.id}
                        scope="col"
                        className={columnClass(column.id)}
                        sortable={sortable}
                        sorted={sorted}
                        onSort={() => column.toggleSorting()}
                      >
                        <FlexRender header={header} />
                      </HeaderCell>
                    );
                  })}
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={leafHeaders.length}>
                    <div class="empty-state">
                      No rows match the current filters.
                      {onClearFilters && (
                        <button
                          type="button"
                          class="empty-state-clear"
                          onClick={() => {
                            // A pending debounced write must not clobber the
                            // clear with a stale (or no-longer-relevant)
                            // filter value once the timer fires.
                            resetSearchRef.current?.();
                            table.setGlobalFilter("");
                            onClearFilters();
                          }}
                        >
                          Clear all filters
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}

              {rows.map((row) => (
                <tr key={row.id} class={rowClass?.(row)}>
                  {row.getAllCells().map((cell) => {
                    // A covered cell must not be rendered at all: rowspan="0" is
                    // valid HTML meaning "span to the end of the row group", so
                    // emitting one would merge this cell down the whole tbody.
                    // With spanning disabled the span index is empty and these
                    // return false/1, so no second switch is needed here.
                    if (cell.getIsCovered()) return null;
                    const rowSpan = cell.getRowSpan();
                    const merged = rowSpan > 1;

                    return (
                      <td
                        key={cell.id}
                        rowSpan={merged ? rowSpan : undefined}
                        class={classNames(
                          columnClass(cell.column.id),
                          merged && "group-cell",
                        )}
                      >
                        <FlexRender cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <nav class="pagination" aria-label={`${tableLabel} pagination`}>
        <span role="status">
          {filteredRows === 0
            ? "No entries"
            : `Showing ${pageIndex * pageSize + 1}–${
              Math.min((pageIndex + 1) * pageSize, filteredRows)
            } of ${filteredRows}`}
        </span>

        <div class="pagination-buttons">
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <Icon name="chevronLeft" />
            Previous
          </button>
          {pageWindow(pageIndex, pageCount).map((page) => (
            <button
              key={page}
              type="button"
              aria-current={page === pageIndex ? "page" : undefined}
              aria-label={`Page ${page + 1}`}
              onClick={() => table.setPageIndex(page)}
            >
              {page + 1}
            </button>
          ))}
          <button
            type="button"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
            <Icon name="chevronRight" />
          </button>
        </div>
      </nav>
    </>
  );
}

/** At most seven page buttons, centred on the current page. */
export function pageWindow(pageIndex: number, pageCount: number): number[] {
  if (pageCount <= 1) return [];
  const span = Math.min(7, pageCount);
  const start = Math.min(
    Math.max(0, pageIndex - Math.floor(span / 2)),
    pageCount - span,
  );
  return Array.from({ length: span }, (_, i) => start + i);
}
