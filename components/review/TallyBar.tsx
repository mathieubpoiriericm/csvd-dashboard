import { tallyWords } from "../../lib/review/display.ts";
import type { Tally } from "../../lib/review/rules.ts";

/** The bar's segments, in the order they are drawn and in the legend. */
export const TALLY_SEGMENTS: ReadonlyArray<[keyof Tally, string]> = [
  ["accept", "Accept"],
  ["reject", "Reject"],
  ["abstain", "Abstain"],
  ["outstanding", "Not answered yet"],
];

/**
 * A gene's answers as one bar: a segment per answer, each as wide as its
 * count. The style is a string because Fresh's renderer appends "px" to a
 * numeric `flexGrow`. The bar is an image whose name is the tally in words,
 * so the counts never live in colour alone.
 */
export function TallyBar({ tally }: { tally: Tally }) {
  return (
    <span class="review-tally" role="img" aria-label={tallyWords(tally)}>
      {TALLY_SEGMENTS.map(([key]) => (
        <span
          key={key}
          class={`review-tally-${key}`}
          style={`flex-grow: ${tally[key]}`}
        />
      ))}
    </span>
  );
}

/** The key to the bar's colours, drawn once under the table. */
export function TallyLegend() {
  return (
    <ul class="review-tally-legend">
      {TALLY_SEGMENTS.map(([key, label]) => (
        <li key={key}>
          <span class={`review-tally-swatch review-tally-${key}`} />
          {label}
        </li>
      ))}
    </ul>
  );
}
