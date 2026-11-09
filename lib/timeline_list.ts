/**
 * The phone layout of the trials radar: the markers the radar draws, listed
 * under their phase instead of placed on rings.
 */

import { encoding, type Marker, type TimelineEncoding } from "./timeline.ts";

export interface PhaseGroup {
  phase: string;
  markers: Marker[];
}

const byDrug = (a: Marker, b: Marker) =>
  a.trial.drug.localeCompare(b.trial.drug, undefined, { sensitivity: "base" });

/**
 * Groups markers by the ring they sit on, in the encoding's ring order (most
 * advanced first), drugs alphabetical inside each group. A phase with no
 * marker produces no group. `marker.phase` is already the parent ring, so a
 * sub-phase lands under its parent.
 */
export function groupMarkersByPhase(
  markers: readonly Marker[],
  enc: TimelineEncoding = encoding,
): PhaseGroup[] {
  return enc.rings
    .map((ring) => ({
      phase: ring.phase,
      markers: markers.filter((m) => m.phase === ring.phase).sort(byDrug),
    }))
    .filter((group) => group.markers.length > 0);
}

/** "Phase Ib" for a sub-phase trial, null when it sits on its own ring. */
export function subPhaseLabel(marker: Marker): string | null {
  const phase = marker.trial.clinicalTrialPhase;
  return phase !== marker.phase ? `Phase ${phase}` : null;
}
