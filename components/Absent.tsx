import type { ComponentChildren } from "preact";
import { isAbsent } from "../lib/sentinels.ts";

/** An absent cell value: an em dash, with words for assistive technology. */
export function Absent() {
  return (
    <span class="cell-absent">
      <span aria-hidden="true">—</span>
      <span class="visually-hidden">not recorded</span>
    </span>
  );
}

export function valueOrAbsent(value: string): ComponentChildren {
  return isAbsent(value) ? <Absent /> : value;
}

/**
 * A value as a table column's sort and search key: `undefined` when the cell
 * shows the absent dash.
 *
 * The sentinels are parenthesised, and `(` sorts before every letter and a
 * text chunk before a number, so a column keyed on them opened its first
 * ascending page on nothing but dashes -- and a search for "unknown" or
 * "none found" matched rows whose cells say neither. An `undefined` key
 * matches no search, and the tables' `sortUndefined: "last"` keeps it last in
 * both directions, as the completion-date and confidence columns already did.
 */
export function presentOrUndefined(value: string): string | undefined {
  return isAbsent(value) ? undefined : value;
}

/** A table cell whose raw value may be absent. */
export const plainCell = ({ getValue }: { getValue: () => unknown }) => {
  const value = getValue();
  return value === undefined ? <Absent /> : valueOrAbsent(String(value ?? ""));
};
