/**
 * The parts a record of the run details is built from: a named field, a
 * value from a fixed vocabulary, a linked PMID, and a section that says
 * when it is showing less than it counted.
 *
 * Each kind of thing has one look, so nothing has to be read twice to tell
 * a name from a value: a field's name is a `<dt>` in the label column, a
 * value from a vocabulary is a neutral pill, and a number or identifier is
 * plain text that says what it is.
 */

import type { ComponentChildren } from "preact";

import {
  describeTruncation,
  field,
  formatCount,
  isTruncated,
} from "../../lib/pipeline_display.ts";

/**
 * One field of a drawer record: its name in the label column, its value in
 * the `<dd>` beside it.
 *
 * The names used to be chips the same shape as the values next to them, so
 * a line read as a row of pills with nothing to say which was the label.
 * `pills` lays the value out as a wrapping row, for a list of pills or a
 * verdict pill and its detail.
 */
export function Field(
  { name, pills = false, children }: {
    name: string;
    pills?: boolean;
    children: ComponentChildren;
  },
) {
  return (
    <>
      <FieldName name={name} />
      <dd class={pills ? "pipeline-pills" : undefined}>{children}</dd>
    </>
  );
}

/** A field's name, in words, as the term of a record's list. */
export function FieldName({ name }: { name: string }) {
  return <dt>{field(name).label}</dt>;
}

/** A neutral pill: a value from a fixed vocabulary, not a verdict. */
export function ValuePill({ children }: { children: ComponentChildren }) {
  return <span class="pipeline-chip pipeline-tint-muted">{children}</span>;
}

/**
 * "PMID" and the number, linked to the paper -- the one way a PMID reads in
 * the drawer, in a gene's head and at the start of a paper's row alike.
 */
export function Pmid({ pmid }: { pmid: string }) {
  return (
    <span class="pipeline-fact">
      {field("pmid").label}{" "}
      <a
        class="pipeline-pmid"
        href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {pmid}
      </a>
    </span>
  );
}

/** A drawer section that says when it is showing less than it counted. */
export function DrawerSection<T>(
  { title, list, render, keyOf }: {
    title: string;
    list: { shown: number; total: number; items: T[] };
    render: (item: T) => ComponentChildren;
    keyOf: (item: T, index: number) => string;
  },
) {
  if (list.total === 0) return null;
  return (
    <section class="pipeline-drawer-section">
      <h3>
        {title}
        <span class="pipeline-count">{formatCount(list.total)}</span>
      </h3>
      {isTruncated(list.shown, list.total) && (
        <p class="pipeline-truncation">
          {describeTruncation(list.shown, list.total)}
        </p>
      )}
      <ul class="pipeline-records">
        {list.items.map((item, index) => (
          <li key={keyOf(item, index)} class="pipeline-record">
            {render(item)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A column's head. A column of figures is set right, as its cells are. */
export function TableHead(
  { label, numeric = false }: { label: string; numeric?: boolean },
) {
  return (
    <th
      role="columnheader"
      scope="col"
      class={numeric ? "is-numeric" : undefined}
    >
      {label}
    </th>
  );
}

/**
 * A count in a table. Muted when it is none: a column of zeros is not what
 * to read. `label` is what the count is, for the phone layout, where a row
 * folds into lines and a cell no longer sits under its column's head.
 */
export function CountCell({ value, label }: { value: number; label: string }) {
  return (
    <td
      role="cell"
      class={`is-numeric${value === 0 ? " is-zero" : ""}`}
      data-label={label}
    >
      {formatCount(value)}
    </td>
  );
}
