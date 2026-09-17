import { useState } from "preact/hooks";

import { SHOW_ALL } from "../lib/constants.ts";
import { buildFilterSummary } from "../lib/filters.ts";
import {
  type CheckboxFilterConfig,
  checkboxFilterSummary,
} from "./CheckboxFilter.tsx";

type FilterDefinition = Omit<CheckboxFilterConfig, "selected" | "onChange"> & {
  /**
   * The selection the group starts with and returns to on reset. Absent,
   * a binary group starts with both choices and a showAll group with
   * Show All -- both "unconstrained". The trials pages' "Study status" is
   * the one group that starts constrained (every status but Completed),
   * and the "Active Filters:" line reports it on first paint on purpose.
   */
  initial?: readonly string[];
};

/** One definition owns each filter's controls, initial selection and reset. */
export function useCheckboxFilters<K extends string>(
  definitions: Record<K, FilterDefinition>,
) {
  const keys = Object.keys(definitions) as K[];
  const initialValues = () => {
    const values = {} as Record<K, string[]>;
    for (const key of keys) {
      const { mode, choices, initial } = definitions[key];
      values[key] = initial
        ? [...initial]
        : mode === "binary"
        ? choices.map((choice) => choice.value)
        : [SHOW_ALL];
    }
    return values;
  };
  const [values, setValues] = useState(initialValues);
  const controls: CheckboxFilterConfig[] = keys.map((key) => {
    const { initial: _initial, ...definition } = definitions[key];
    return {
      ...definition,
      selected: values[key],
      onChange: (selected) =>
        setValues((previous) => ({ ...previous, [key]: selected })),
    };
  });

  return {
    values,
    controls,
    summary: buildFilterSummary(controls.map(checkboxFilterSummary)),
    reset: () => setValues(initialValues()),
  };
}
