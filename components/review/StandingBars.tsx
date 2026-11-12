import { KIND_LABELS, STANDING_LABELS } from "../../lib/review/display.ts";
import type { Standing } from "../../lib/review/rules.ts";
import type { ReviewSummary } from "../../lib/review/summary.ts";
import { KINDS } from "./ReviewQueue.tsx";

/**
 * The bars' segments and the legend, in this order: the settled outcomes
 * first, then what is still open, as the approved layout draws them. The
 * queue's `STANDINGS` keeps its own order (work still to do first), which is
 * right for a filter row and wrong for a bar read left to right.
 */
export const BAR_STANDINGS: readonly Standing[] = [
  "accepted",
  "rejected",
  "conflict",
  "in_review",
  "not_started",
  "no_quorum",
];

/**
 * Where the round's genes stand, one stacked bar per kind of change: a
 * segment per standing the kind holds, each grown by its count. A kind with
 * no gene has no bar, so no bar is ever an empty ratio. Each bar is an image
 * whose name says its counts in words, and the legend under them names every
 * standing with its count over the whole round, so colour is never the only
 * signal. The style is a string because Fresh's renderer appends "px" to a
 * numeric `flexGrow`.
 */
export function StandingBars({ summary }: { summary: ReviewSummary }) {
  const totals: Record<Standing, number> = {
    accepted: summary.accepted,
    rejected: summary.rejected,
    conflict: summary.conflict,
    in_review: summary.inReview,
    not_started: summary.notStarted,
    no_quorum: summary.noQuorum,
  };
  const kinds = KINDS.map((kind) => {
    const row = summary.byKind[kind];
    const held = BAR_STANDINGS.filter((st) => row[st] > 0);
    return {
      kind,
      row,
      held,
      total: held.reduce((n, st) => n + row[st], 0),
    };
  }).filter((k) => k.total > 0);

  return (
    <section class="card">
      <div class="card-body">
        <h2 class="card-title">Where the genes stand</h2>
        {kinds.length === 0
          ? <p class="empty-state">No genes in this round</p>
          : (
            <div class="review-standing-bars">
              {kinds.map(({ kind, row, held, total }) => (
                <div class="review-standing-row" key={kind}>
                  <span class="review-standing-kind">{KIND_LABELS[kind]}</span>
                  <span
                    class="review-standing-bar"
                    role="img"
                    aria-label={`${KIND_LABELS[kind]}: ${
                      held.map((st) =>
                        `${row[st]} ${STANDING_LABELS[st].toLowerCase()}`
                      ).join(", ")
                    }`}
                  >
                    {held.map((st) => (
                      <span
                        key={st}
                        class={`review-standing-${st}`}
                        style={`flex-grow: ${row[st]}`}
                      />
                    ))}
                  </span>
                  <span class="review-standing-total">{total}</span>
                </div>
              ))}
            </div>
          )}
        <ul class="review-tally-legend review-standing-legend">
          {BAR_STANDINGS.map((st) => (
            <li key={st}>
              <span class={`review-tally-swatch review-standing-${st}`} />
              {STANDING_LABELS[st]}{" "}
              <span class="review-number">{totals[st]}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
