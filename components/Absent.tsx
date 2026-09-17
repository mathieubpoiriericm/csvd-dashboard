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

/** A table cell whose raw value may be absent. */
export const plainCell = ({ getValue }: { getValue: () => unknown }) =>
  valueOrAbsent(String(getValue() ?? ""));
