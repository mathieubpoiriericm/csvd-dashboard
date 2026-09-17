import { SHOW_ALL } from "../lib/constants.ts";
import { type FilterMode, isFilterActive } from "../lib/filters.ts";
import type { FilterChoice } from "../lib/types.ts";

/**
 * Sidebar checkbox filter group.
 *
 * Reproduces the two behaviours of the Shiny app's mod_checkbox_filter.R:
 *
 *   "showAll" — the group carries an explicit "Show All" option. Ticking it
 *   clears every other choice; ticking any other choice clears "Show All".
 *
 *   "binary" — a Yes/No pair with no "Show All". Unticking the last remaining
 *   choice re-selects both, so the filter can never be stuck matching nothing.
 *
 * The R version needed `freezeReactiveValue` around each corrective update to
 * stop the observer re-firing on its own write. Deriving the next selection in
 * the change handler removes that whole class of problem.
 */
export interface CheckboxFilterProps {
  label: string;
  choices: readonly FilterChoice[];
  selected: readonly string[];
  mode?: FilterMode;
  onChange: (next: string[]) => void;
}

/**
 * A rendered filter, as consumed by both `CheckboxFilter` and
 * `checkboxFilterSummary`. It used to carry a second, shorter `name` for the
 * "Active Filters:" line, but that let a group's sidebar legend and its
 * readout term drift apart (F57) — `label` is now the only name a group has.
 */
export type CheckboxFilterConfig = CheckboxFilterProps;

export const checkboxFilterSummary = (
  { label, selected: value, mode, choices }: CheckboxFilterConfig,
) => ({ label, value, mode, choices });

/** Applies the group's selection rules to a raw checkbox toggle. */
export function nextSelection(
  mode: FilterMode,
  choices: readonly FilterChoice[],
  current: readonly string[],
  value: string,
  checked: boolean,
): string[] {
  if (mode === "binary") {
    const next = checked
      ? [...current, value]
      : current.filter((v) => v !== value);
    // Never leave a binary group empty — that would match no rows at all.
    return next.length === 0 ? choices.map((c) => c.value) : next;
  }

  if (checked && value === SHOW_ALL) return [SHOW_ALL];

  const next = checked
    ? [...current.filter((v) => v !== SHOW_ALL), value]
    : current.filter((v) => v !== value);

  // Unticking the last real choice falls back to "Show All".
  return next.length === 0 ? [SHOW_ALL] : next;
}

export function CheckboxFilter(
  { label, choices, selected, mode = "showAll", onChange }: CheckboxFilterProps,
) {
  const showingAll = !isFilterActive(selected, mode);
  const activeCount = selected.filter((v) => v !== SHOW_ALL).length;

  return (
    <fieldset class="filter-group">
      <legend class="filter-group-header">
        <span class="filter-group-label">{label}</span>
        {!showingAll && (
          <span class="visually-hidden">, {activeCount} selected</span>
        )}
        <span class="filter-count" aria-hidden="true">
          {showingAll ? "All" : activeCount}
        </span>
      </legend>

      <div class="filter-options">
        {choices.map((choice) => (
          <label
            class="filter-option"
            key={choice.value}
            title={choice.description}
          >
            <input
              type="checkbox"
              checked={selected.includes(choice.value)}
              onChange={(event) =>
                onChange(
                  nextSelection(
                    mode,
                    choices,
                    selected,
                    choice.value,
                    event.currentTarget.checked,
                  ),
                )}
            />
            <span>
              {choice.label}
              {choice.description && (
                <span class="visually-hidden">, {choice.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
