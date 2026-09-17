---
paths:
  - "components/TableShell.tsx"
  - "islands/GenesView.tsx"
  - "islands/TrialsView.tsx"
  - "tests/table_sorting_test.ts"
  - "e2e/tests/genes-table.spec.ts"
  - "e2e/tests/trials-table.spec.ts"
---

# Tables

Both tables share `components/TableShell.tsx` (controls, header, body,
pagination), which also owns `SHELL_FEATURES` — the one `tableFeatures({…})`
call both islands pass to `useTable`. There is deliberately no per-island
feature object: `Table` is **invariant** in its feature set, so a shell generic
over `TFeatures` cannot resolve a single feature-gated API (`setPageSize`,
`getIsSorted`, `getRowSpan` …) and collapses straight back to `any`. One shared
registry is what keeps the shell and its callers typed.

Three things about that registry are load-bearing:

- **Row models are feature slots.** `constructTable` destructures
  `filteredRowModel`/`sortedRowModel`/`paginatedRowModel` out of `features`; a
  separate `rowModels` key (v9 beta, and still in web search results) is
  silently ignored. `getRowModel()` then falls back to the raw core model, so
  every row renders while the pagination, sorting and search controls keep
  updating their own labels — the table looks wired up and is not.
- **`columnFilteringFeature` is a prerequisite**, not an optional extra:
  `globalFilteringFeature` and `filteredRowModel` both declare it in
  `FeatureSlotPrereqs`. `tableFeatures()` rejects the set without it. Search
  happens to keep working when it is missing, because `globalFilterFn` defaults
  to `'auto'` and resolves outside the registry — which is exactly why the gap
  survives unnoticed unless the validator runs.
- **`sortFns` must be registered.** v9 made the built-in comparators opt-in for
  tree-shaking. `sortFn: 'auto'` picks the name `alphanumeric` or `text` and
  looks it up in this registry; on a miss it silently falls back to
  `sortFn_basic`, a raw `>` compare that orders `"1300"` before `"15"` and
  chromosome 10 before chromosome 1. Nothing warns in a production build.
  `tests/table_sorting_test.ts` pins this against the committed data.

  **`chromosome` is registered beside them**, and the chromosomal-location
  column names it. `alphanumeric` is wrong for a cytogenetic band: it compares
  the leading chunk of each value and orders a string chunk before a numeric
  one, so "Xq22.1" sorted above chromosome 1. Nothing showed it until the
  365-day run added GLA, the table's first X-linked gene.

Do not add `as any` back to the `useTable` call. It compiles either way, and its
only effect is to switch off the prerequisite checking above.

Row merging in `TrialsView` uses the `cellSpanningFeature` with a
`spanWithinDrug` predicate. Merged cells only line up while rows are grouped by
drug, so spanning is switched off under any other sort — via the
`enableCellSpanning` **table option**, which empties the span index at source,
rather than by branching in the renderer. `TrialsView` therefore owns its
`sorting` slice (`state` + `onSortingChange`): the option has to be computed
before `useTable` is called. `TableShell` calls `getIsCovered()`/`getRowSpan()`
unconditionally and must keep skipping covered cells entirely — `rowspan="0"` is
valid HTML meaning "span to the end of the row group", so rendering one merges
the cell down the whole `tbody`.

`@tanstack/table-core` and `@tanstack/preact-table` each ship a `skills/`
directory inside `node_modules` documenting the exact installed version. Prefer
it to the website, which mixes v9 beta into search results.
