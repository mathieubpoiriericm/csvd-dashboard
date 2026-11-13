import {
  geneHref,
  KIND_LABELS,
  proposalLine,
  STANDING_LABELS,
} from "../../lib/review/display.ts";
import type { Standing } from "../../lib/review/rules.ts";
import type { ReviewState } from "../../lib/review/summary.ts";
import type { ReviewKind } from "../../lib/types.ts";
import { StandingBadge } from "./StandingBadge.tsx";
import { TallyBar, TallyLegend } from "./TallyBar.tsx";

export const KINDS: readonly ReviewKind[] = ["new", "claims", "citation"];

export const STANDINGS: readonly Standing[] = [
  "not_started",
  "in_review",
  "conflict",
  "accepted",
  "rejected",
  "no_quorum",
];

/** The queue's own URL for a pair of filters; a null filter is left out. */
function queueHref(kind: ReviewKind | null, standing: Standing | null) {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (standing) params.set("standing", standing);
  const query = params.toString();
  return query ? `/review?${query}` : "/review";
}

interface FilterLink {
  label: string;
  count: number;
  href: string;
  active: boolean;
}

/**
 * One row of filter links; the active one carries `aria-current="true"`.
 * The others say "false" rather than leaving it out: Fresh marks every
 * unmarked link to the page's own path as current or ancestor, and every
 * link here is to `/review`.
 */
function FilterRow({ label, links }: { label: string; links: FilterLink[] }) {
  return (
    <nav class="review-filters" aria-label={label}>
      {links.map((link) => (
        <a
          key={link.href}
          class="review-filter"
          href={link.href}
          aria-current={link.active ? "true" : "false"}
        >
          {link.label} <span class="review-filter-count">{link.count}</span>
        </a>
      ))}
    </nav>
  );
}

/**
 * Every gene the round changes, one row each, with the committee's standing.
 *
 * The filters are links rather than controls, so the page is whole without
 * JavaScript. Both rows count the whole round, not the other row's share, so
 * the numbers are the ones the progress page shows; a link keeps the other
 * row's filter, so the two combine, and each "All" clears its own row only.
 */
export function ReviewQueue({ state, kind, standing }: {
  state: ReviewState;
  kind: ReviewKind | null;
  standing: Standing | null;
}) {
  const entries = state.round.changes.map((change, i) => ({
    change,
    review: state.reviews[i],
  }));
  const total = entries.length;
  const shown = entries.filter(({ change, review }) =>
    (kind === null || change.kind === kind) &&
    (standing === null || review.standing === standing)
  );

  const kindLinks: FilterLink[] = [
    {
      label: "All",
      count: total,
      href: queueHref(null, standing),
      active: kind === null,
    },
    ...KINDS.map((k) => ({
      label: KIND_LABELS[k],
      count: entries.filter((e) => e.change.kind === k).length,
      href: queueHref(k, standing),
      active: kind === k,
    })),
  ];
  const standingLinks: FilterLink[] = [
    {
      label: "All",
      count: total,
      href: queueHref(kind, null),
      active: standing === null,
    },
    ...STANDINGS.map((st) => ({
      label: STANDING_LABELS[st],
      count: entries.filter((e) => e.review.standing === st).length,
      href: queueHref(kind, st),
      active: standing === st,
    })),
  ];

  return (
    <>
      <div class="review-filter-rows">
        <FilterRow label="Filter by kind" links={kindLinks} />
        <FilterRow label="Filter by standing" links={standingLinks} />
      </div>
      <div class="blueprint-frame">
        <div class="table-scroll">
          <table class="data-table review-queue">
            <caption class="visually-hidden">Review queue</caption>
            <thead>
              <tr>
                <th scope="col" class="col-identity">Gene</th>
                <th scope="col">Change</th>
                <th scope="col">What the run proposes</th>
                <th scope="col">Committee</th>
                <th scope="col">Standing</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div class="empty-state">No genes match</div>
                  </td>
                </tr>
              )}
              {shown.map(({ change, review }) => {
                const { accept, reject, abstain, outstanding } = review.tally;
                const answered = accept + reject + abstain;
                return (
                  <tr key={change.gene}>
                    <td class="col-identity col-gene">
                      <a href={geneHref(change.gene)}>{change.gene}</a>
                    </td>
                    <td class="review-kind">{KIND_LABELS[change.kind]}</td>
                    <td>{proposalLine(change)}</td>
                    <td class="review-committee">
                      <span class="review-answered">
                        {answered} of {answered + outstanding}
                      </span>
                      <TallyBar tally={review.tally} />
                    </td>
                    <td>
                      <StandingBadge review={review} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <TallyLegend />
    </>
  );
}
