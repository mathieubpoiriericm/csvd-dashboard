---
paths:
  - "lib/filters.ts"
  - "lib/constants.ts"
  - "components/CheckboxFilter.tsx"
  - "components/useCheckboxFilters.ts"
  - "components/FilterPanel.tsx"
  - "components/TableShell.tsx"
  - "islands/GenesView.tsx"
  - "islands/TrialsView.tsx"
  - "tests/filters_test.ts"
  - "e2e/tests/genes-filters.spec.ts"
  - "e2e/tests/trials-filters.spec.ts"
---

# Filtering

`lib/filters.ts` is the only place row selection happens; islands hold the
selection state and call it. It deliberately diverges from the Shiny original by
normalizing case and surrounding whitespace on both sides of every comparison —
the R version compared raw strings and silently hid rows (`"Proteomics"` vs
`"proteomics"`, traits stored as `"PSMD "`). The data boundary also trims
display strings, while the raw-JSON contract test keeps generator regressions
visible.

Two matching rules are non-obvious: a binary group (Yes/No) only constrains when
exactly one option is selected, and a `SHOW_ALL` selection means "no filter".
The same rules are enforced in the UI by `nextSelection()` in
`components/CheckboxFilter.tsx`, which can never leave a group matching nothing.

One group starts constrained: the trials pages' "Study status" seeds
`DEFAULT_TRIAL_STATUSES` (every status but Completed, Suspended and Unknown)
through the `initial` field on a `useCheckboxFilters` definition, and `reset()`
returns to it rather than to Show All. The `Active Filters:` line therefore
reports it on first paint, which is intended -- it is what tells a viewer those
trials are hidden. Unknown also answers for a trial with no ClinicalTrials.gov
record (`matchesStatus`), so the default hides every ISRCTN, ANZCTR and ChiCTR
trial from the table and the radar too; that was chosen, not overlooked.
**Under `GOLD_ONLY` (`lib/gold_only.ts`) the default is Show All instead**
(`defaultTrialStatuses`): a curated trial registered outside
ClinicalTrials.gov carries no status and reads as Unknown, so the run default
would hide every such trial, and every completed one, from all three pages,
where the curated set is meant to be seen whole.
`visibleTrials()` in `lib/filters.ts` is the same default as a function, for the
SSR tests and any count that has to agree with the page.

The GWAS trait group offers every vocabulary trait, except **under
`GOLD_ONLY`, where it offers only the traits a row carries**
(`gwasTraitChoices`, beside Show All and None Found): the published rows are
the whole curated set, and a trait no curated row uses would be a choice that
matches nothing. `tests/data_contract_test.ts` checks reachability against
those offered choices, not against the vocabulary.

`components/FilterPanel.tsx` owns the sidebar-and-table layout both data pages
render, and the collapse state with it -- the `is-collapsed` class has to reach
the grid wrapper as well as the panel, so the panel cannot hold it alone.
Collapsing folds the sidebar to a rail rather than unmounting it: the toggle
stays one button in one place, so the press keeps focus and the pointer. Hiding
the controls hides no information, because `TableShell` prints the
`Active Filters:` line above the table either way -- keep that true if the
readout ever moves.
