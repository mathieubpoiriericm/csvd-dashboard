import type { ComponentChildren } from "preact";

import { FieldNote, useNoted } from "./FieldNote.tsx";

interface ListEditorProps<T> {
  items: T[];
  render: (item: T, index: number) => ComponentChildren;
  add: () => void;
  addLabel: string;
  remove?: (index: number) => void;
  empty?: string;
  /** The list's own issue path (its count), for its note and its add button. */
  field?: string;
  /**
   * A row's name, e.g. "Trait 2: T2". Each row is then a group under it, so
   * a screen reader tells four "Key" fields apart while each control keeps
   * its own exact name.
   */
  rowLabel?: (item: T, index: number) => string;
}

/** The list's add button, below its rows. */
const focusAdd = (list: Element | null | undefined) =>
  list?.querySelector<HTMLElement>(":scope > .adapt-actions > .adapt-button")
    ?.focus();

/** `control` in the row now at `index` (the last, past the end), else the add button. */
function focusRow(
  list: Element | null | undefined,
  index: number,
  control: string,
) {
  const rows = list?.querySelectorAll<HTMLElement>(":scope > .adapt-row");
  const target = rows?.[Math.min(index, rows.length - 1)]?.querySelector<
    HTMLElement
  >(control);
  if (target) target.focus();
  else focusAdd(list);
}

/**
 * The list's add button, described by the list's own note while that note
 * has something to say ("Add at least one population"), so the message is
 * read with the button focus lands on. The new row is drawn by the next
 * render; its first control then takes focus, ready to type.
 */
export function AddButton(
  { field, label, onAdd }: {
    field?: string;
    label: string;
    onAdd: () => void;
  },
) {
  const described = useNoted(field);
  return (
    <button
      type="button"
      class="adapt-button"
      data-field={field}
      aria-describedby={described}
      onClick={(e) => {
        const list = (e.currentTarget as HTMLElement).closest(".adapt-lookup");
        onAdd();
        setTimeout(() =>
          focusRow(list, Infinity, "input, textarea, select, button")
        );
      }}
    >
      {label}
    </button>
  );
}

/**
 * One row. A component rather than the div itself because `jsx:
 * "precompile"` drops the key of an element it compiles to a template, and
 * the row's key is what makes it drawn afresh (see ListEditor).
 */
function ListRow(
  { label, children }: { label?: string; children: ComponentChildren },
) {
  return (
    <div
      class="adapt-row"
      role={label === undefined ? undefined : "group"}
      aria-label={label}
    >
      {children}
    </div>
  );
}

/**
 * Rows plus an add button; each row gets a Remove button when `remove` is
 * given. Stays hook-free: the steps are called as functions in the tests.
 */
export function ListEditor<T>(
  { items, render, add, addLabel, remove, empty, field, rowLabel }:
    ListEditorProps<T>,
) {
  return (
    <div class="adapt-lookup">
      {items.length === 0 && empty && <p class="adapt-status">{empty}</p>}
      {items.map((item, index) => (
        // Keyed by the list's length as well as the index, so adding or
        // removing a row draws every row afresh: a field keeping what was
        // typed (a ParsedTextField's "0,8") would otherwise hand it, and
        // its fix button, to the row that took the removed row's place.
        <ListRow
          key={`${items.length}:${index}`}
          label={rowLabel?.(item, index)}
        >
          {render(item, index)}
          {remove && (
            <button
              type="button"
              class="adapt-button"
              onClick={(e) => {
                // Every row is drawn afresh, so focus would fall to the
                // page; the Remove button of the row that takes this one's
                // place takes it, or the add button once the last row goes.
                const list = (e.currentTarget as HTMLElement).closest(
                  ".adapt-lookup",
                );
                const last = index === items.length - 1;
                remove(index);
                setTimeout(() =>
                  last
                    ? focusAdd(list)
                    : focusRow(list, index, ":scope > .adapt-button")
                );
              }}
            >
              Remove
            </button>
          )}
        </ListRow>
      ))}
      {field !== undefined && <FieldNote field={field} />}
      <div class="adapt-actions">
        <AddButton field={field} label={addLabel} onAdd={add} />
      </div>
    </div>
  );
}
