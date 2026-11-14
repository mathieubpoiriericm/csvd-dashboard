import { Icon } from "../Icon.tsx";
import {
  EVIDENCE_RING_RADIUS,
  EVIDENCE_RING_WIDTH,
  MARKER_DRAW_RADIUS,
  MARKER_GAP_RADIUS,
  MARKER_RING_WIDTH,
  PLATE,
  type TimelineLayout,
} from "../../lib/timeline.ts";
import { groupMarkersByPhase, subPhaseLabel } from "../../lib/timeline_list.ts";
import { resolveTrialStatus } from "../../lib/trials.ts";

interface PhaseListProps {
  layout: TimelineLayout;
  activeIndex: number | null;
  onActivate: (index: number) => void;
  rowRef: (index: number, el: HTMLButtonElement | null) => void;
}

const DOT_EXTENT = EVIDENCE_RING_RADIUS + EVIDENCE_RING_WIDTH + 1;

/**
 * The trials the radar draws, listed under their phase for a window too
 * narrow to read the figure. Each row opens the same drawer a marker does.
 */
export function PhaseList(
  { layout, activeIndex, onActivate, rowRef }: PhaseListProps,
) {
  const groups = groupMarkersByPhase(layout.markers);
  // True whether the selection matched no trial, matched only trials with
  // no ring, or there are no trials at all.
  if (groups.length === 0) {
    return (
      <p class="timeline-list-empty">
        None of the selected trials sits on a phase ring.
      </p>
    );
  }
  const band = (key: string) => layout.sectors.find((s) => s.key === key)?.band;
  return (
    <div class="timeline-list">
      {groups.map(({ phase, markers }) => (
        <section key={phase} class="timeline-list-group">
          <h2>
            {`Phase ${phase} · ${markers.length} trial${
              markers.length === 1 ? "" : "s"
            }`}
          </h2>
          <ul>
            {markers.map((marker) => {
              const sub = subPhaseLabel(marker);
              return (
                <li key={marker.index}>
                  <button
                    ref={(el) => rowRef(marker.index, el)}
                    type="button"
                    class="timeline-row"
                    aria-controls="timeline-dialog"
                    aria-expanded={activeIndex === marker.index
                      ? "true"
                      : "false"}
                    onClick={() =>
                      onActivate(marker.index)}
                  >
                    <svg
                      class="timeline-row-dot"
                      viewBox={`${-DOT_EXTENT} ${-DOT_EXTENT} ${
                        DOT_EXTENT * 2
                      } ${DOT_EXTENT * 2}`}
                      aria-hidden="true"
                    >
                      <circle r={DOT_EXTENT} fill={PLATE} />
                      <circle
                        r={MARKER_DRAW_RADIUS}
                        fill={marker.color}
                        stroke={PLATE}
                        stroke-width={MARKER_RING_WIDTH}
                      />
                      {marker.flagReasons.length > 0 && (
                        <circle r={MARKER_GAP_RADIUS} fill={PLATE} />
                      )}
                      {marker.evidenceRing && (
                        <circle
                          r={EVIDENCE_RING_RADIUS}
                          fill="none"
                          stroke={marker.evidenceRing}
                          stroke-width={EVIDENCE_RING_WIDTH}
                          stroke-dasharray={marker.evidenceDash ?? undefined}
                        />
                      )}
                    </svg>
                    <span class="timeline-row-main">
                      <span class="timeline-row-drug">
                        {sub
                          ? `${marker.trial.drug} (${sub})`
                          : marker.trial.drug}
                      </span>
                      <span class="timeline-row-meta">
                        <span
                          class="timeline-row-pill"
                          style={{ background: band(marker.population) }}
                        >
                          {marker.populationLabel}
                        </span>
                        <span class="timeline-row-status">
                          {resolveTrialStatus(marker.trial.overallStatus).label}
                        </span>
                      </span>
                    </span>
                    <span class="timeline-row-chevron">
                      <Icon name="chevronRight" />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
