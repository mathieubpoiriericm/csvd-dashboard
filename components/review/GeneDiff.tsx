import type { ComponentChildren } from "preact";

import { Absent } from "../Absent.tsx";
import { FIELD_LABELS } from "../../lib/review/display.ts";
import { isAbsent } from "../../lib/sentinels.ts";
import type { Gene, ReviewChange, ReviewFieldValue } from "../../lib/types.ts";

const FIELDS = Object.keys(FIELD_LABELS) as (keyof Gene)[];

/** A scalar as text; null is the absent dash, a sentinel shows as it is. */
function Scalar({ value }: { value: string | number | null }) {
  return value === null ? <Absent /> : <>{String(value)}</>;
}

/**
 * A value marked as added or removed. A sentinel is never marked: it says
 * nothing was recorded, and "(none found)" struck through would read as a
 * finding withdrawn. The marks are real `<ins>` and `<del>`, so an underline
 * and a strike say what the tint repeats.
 */
function Marked(
  { value, mark }: { value: string | number | null; mark: "ins" | "del" },
) {
  if (value === null || isAbsent(String(value))) {
    return <Scalar value={value} />;
  }
  return mark === "ins"
    ? <ins>{String(value)}</ins>
    : <del>{String(value)}</del>;
}

/** A list as one item per value, so a long omics entry wraps on its own. */
function ValueList({ items }: { items: ComponentChildren[] }) {
  return (
    <ul class="review-values">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

/** A value with nothing marked: the gold column, and an unchanged field. */
export function Plain({ value }: { value: ReviewFieldValue }) {
  return Array.isArray(value)
    ? <ValueList items={value} />
    : <Scalar value={value} />;
}

/**
 * How a value moved, in one place: a list keeps the values it still holds,
 * then marks each added one and strikes each removed one; a scalar strikes
 * the old value and marks the new. Shared by the diff and by an edit in the
 * history, so the two cannot draw a change two ways.
 */
export function Moved(
  { before, after, added, removed, keep = true }: {
    before: ReviewFieldValue;
    after: ReviewFieldValue;
    added: readonly string[];
    removed: readonly string[];
    /** Whether to list the values that stay; an edit names only its marks. */
    keep?: boolean;
  },
) {
  if (Array.isArray(after)) {
    const fresh = new Set(added.filter((v) => !isAbsent(v)));
    const kept = keep ? after.filter((v) => !fresh.has(v)) : [];
    return (
      <ValueList
        items={[
          ...kept,
          ...[...fresh].map((v) => (
            <Marked key={`+${v}`} value={v} mark="ins" />
          )),
          ...removed.filter((v) =>
            !isAbsent(v)
          ).map((v) => <Marked key={`-${v}`} value={v} mark="del" />),
        ]}
      />
    );
  }
  const old = Array.isArray(before) ? before.join("; ") : before;
  return (
    <span class="review-moved">
      {old !== null && !isAbsent(String(old)) && (
        <>
          <Marked value={old} mark="del" />
          {" "}
        </>
      )}
      <Marked value={after} mark="ins" />
    </span>
  );
}

/**
 * The gene's whole stored row against gold, one row per column in the
 * labels' order: what gold holds and what the run would leave. A field the
 * run does not touch is muted rather than dropped, so the reader sees the
 * row the committee would be signing off, not only its edges.
 */
export function GeneDiff({ change }: { change: ReviewChange }) {
  const moved = new Map(change.fields.map((f) => [f.field, f]));
  return (
    <section class="card">
      <div class="card-body">
        <h2 class="card-title">Change against the gold data</h2>
        <table class="review-diff">
          <caption class="visually-hidden">
            {change.gene}: the gold data and the row after the run
          </caption>
          <thead>
            <tr>
              <th scope="col" class="review-diff-label">Field</th>
              <th scope="col">Gold</th>
              <th scope="col">After the run</th>
            </tr>
          </thead>
          <tbody>
            {FIELDS.map((field) => {
              const delta = moved.get(field);
              const same = change.before !== null && !delta;
              return (
                <tr key={field} class={same ? "review-diff-same" : undefined}>
                  <th scope="row">{FIELD_LABELS[field]}</th>
                  <td>
                    {change.before === null
                      ? <span class="review-absent">Not in the gold data</span>
                      : <Plain value={change.before[field]} />}
                  </td>
                  <td>
                    {delta
                      ? <Moved {...delta} />
                      : <Plain value={change.after[field]} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
