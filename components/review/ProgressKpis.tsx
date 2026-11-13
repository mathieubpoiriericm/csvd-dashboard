import type { ComponentChildren } from "preact";

import { percent, plural } from "../../lib/review/display.ts";
import type { ReviewSummary } from "../../lib/review/summary.ts";

/**
 * One headline figure: a label, the figure with an optional unit beside it,
 * and a line under it. Its own tile rather than `ValueBox`, which holds a
 * bare number and a label; it wears the same framed, striped recipe.
 */
function Kpi({ label, value, unit, sub }: {
  label: string;
  value: ComponentChildren;
  unit?: string;
  sub: string;
}) {
  return (
    <div class="review-kpi">
      <span class="review-kpi-label">{label}</span>
      <span class="review-kpi-value">
        {value}
        {unit && <span class="review-kpi-unit">{unit}</span>}
      </span>
      <span class="review-kpi-sub">{sub}</span>
    </div>
  );
}

/**
 * The state of the whole review in four figures: what is settled, what is in
 * conflict, how many of the answers owed are in, and how many acceptances
 * still have edits to reconcile.
 */
export function ProgressKpis({ summary }: { summary: ReviewSummary }) {
  return (
    <section class="review-kpis" aria-label="Review totals">
      <Kpi
        label="Settled"
        value={summary.settled}
        unit={`of ${plural(summary.total, "gene", "genes")}`}
        sub={`${summary.accepted} accepted · ${summary.rejected} rejected`}
      />
      <Kpi
        label="In conflict"
        value={summary.conflict}
        sub={summary.conflict === 0 ? "None" : "Waiting on the chair's ruling"}
      />
      <Kpi
        label="Verdicts in"
        value={percent(summary.answersIn, summary.answersOwed)}
        sub={`${summary.answersIn} of ${summary.answersOwed}`}
      />
      <Kpi
        label="Edits to reconcile"
        value={summary.editsToReconcile}
        sub={summary.editsToReconcile === 0
          ? "None"
          : "Accepted, but the edits asked for differ"}
      />
    </section>
  );
}
