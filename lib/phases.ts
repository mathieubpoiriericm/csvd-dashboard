/**
 * Sub-phases. A registry may split a phase into lettered parts -- "Ib",
 * "IIa", "IIb" -- and the curated table keeps that wording. The radar has a
 * ring per phase and the filter a choice per phase, so both read a sub-phase
 * as its parent: "Ib" is drawn on the Phase I ring and selected by Phase I,
 * while the table, the tooltips and the drawer still print "Ib".
 *
 * `scripts/timeline_figure.py`'s `parent_phase` is the print figure's copy of
 * this rule; the two have to agree or the figure and the page place a trial
 * differently.
 */

/**
 * An upper-case Roman phase directly followed by a lower-case `a` or `b`.
 * Case-sensitive on purpose: free text such as "via" must not read as a
 * Phase VI sub-phase.
 */
const SUB_PHASE = /\b(I{1,3}|IV)[ab]\b/g;

/** The phase with every sub-phase collapsed onto its parent ("Ib" -> "I"). */
export function parentPhase(phase: string): string {
  return phase.replace(SUB_PHASE, "$1");
}
