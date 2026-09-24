import { useId } from "preact/hooks";
import { formatCount } from "../lib/format.ts";

interface ReadoutStat {
  label: string;
  value: number;
  /** The unfiltered total, when the value is a subset of one. */
  of?: number;
}

interface ReadoutBucket {
  label: string;
  total: number;
  shown: number;
}

interface DensityReadoutProps {
  stats: readonly ReadoutStat[];
  buckets: readonly ReadoutBucket[];
  /** Names what the bars are counted across, e.g. "Genes by chromosome". */
  axisLabel: string;
}

/**
 * The most buckets a histogram can carry and still skip the sub-600px hide.
 *
 * This has to be a plain number -- the component has no way to know which
 * axis it is drawing -- so it is picked to clear the real ceiling on the
 * smaller of the two axes in play today with room to spare, not to just
 * clear what that axis's data happens to contain. Trial phases
 * (islands/TrialsView.tsx's `PHASE_ORDER`) enumerate four phases already in
 * the data (I, II, III, IV), two combination phases the code anticipates but
 * no committed trial uses yet (I/II, II/III), and the always-possible
 * "(unknown)" catch-all: seven buckets, by design, however the data moves.
 * Chromosomes never come close on the other side: up to 24 by biology, 21
 * populated today. Ten sits with margin above the first and well below the
 * second, so it tells the two axes apart by shape rather than tracking
 * either one's live count -- unlike the "6" this replaced, which was one
 * new trial phase away from silently reverting to hiding a histogram that
 * was never too big to read.
 *
 * If trial phases ever genuinely need more than seven buckets, or a third,
 * differently-shaped axis is added, this stops being a safe proxy:
 * `e2e/tests/readout.spec.ts`'s "the trials readout keeps its bars visible
 * below 600px" assertion runs against the live committed data and will fail
 * rather than regress silently. When it does, the fix is a per-caller
 * `compact` flag driven by what each axis's vocabulary actually is, not a
 * bigger version of this same guess.
 */
export const COMPACT_BUCKET_CEILING = 10;

/**
 * Summary before detail: what the current filter leaves, above the table that
 * lists it.
 *
 * The bars are the point. Each column is one bucket, drawn to the full
 * unfiltered count and filled to the part still showing, so narrowing the
 * filters reads as the fill draining rather than as a number changing. It
 * answers "how much have I narrowed this, and where did it go" without
 * reading a row.
 *
 * The bars are decorative to assistive technology. A visually hidden list
 * exposes the same per-bucket counts without making each graphical layer a
 * separate stop.
 */
export function DensityReadout(
  { stats, buckets, axisLabel }: DensityReadoutProps,
) {
  const peak = Math.max(1, ...buckets.map((b) => b.total));
  // Below 600px the bars are dropped to save space -- but only when there
  // are enough of them to need it. See COMPACT_BUCKET_CEILING above for what
  // this threshold is actually bound to. The screen-reader list a few lines
  // down is never affected either way.
  const compact = buckets.length <= COMPACT_BUCKET_CEILING;
  // useId, not a slug of the label: two readouts with one axis label would
  // otherwise share an id and aria-labelledby would point at the wrong one.
  const axisLabelId = useId();

  return (
    <section class="readout" aria-labelledby={axisLabelId}>
      <div class="readout-stats">
        {stats.map((stat) => (
          <div class="readout-stat" key={stat.label}>
            <span class="readout-stat-label">{stat.label}</span>
            <span class="readout-stat-value">
              {formatCount(stat.value)}
              {stat.of !== undefined && <em>/ {formatCount(stat.of)}</em>}
            </span>
          </div>
        ))}
      </div>

      <div class="readout-dist">
        <span class="readout-stat-label" id={axisLabelId}>
          {axisLabel}
        </span>
        <ul class="visually-hidden">
          {buckets.map((bucket) => (
            <li key={bucket.label}>
              {bucket.label}: {bucket.shown} of {bucket.total}
            </li>
          ))}
        </ul>
        <div
          class={`readout-bars${compact ? " readout-bars--compact" : ""}`}
          aria-hidden="true"
        >
          {buckets.map((bucket) => (
            <div
              class="readout-bar"
              key={bucket.label}
              title={`${bucket.label}: ${bucket.shown} of ${bucket.total}`}
            >
              <div
                class="readout-bar-track"
                style={{ height: `${(bucket.total / peak) * 100}%` }}
              >
                <div
                  class="readout-bar-fill"
                  style={{
                    height: bucket.total === 0
                      ? "0%"
                      : `${(bucket.shown / bucket.total) * 100}%`,
                  }}
                />
              </div>
              <span class="readout-bar-label">{bucket.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
