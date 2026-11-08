/**
 * The cSVD radar, pinned: four sectors and their drug counts, the 21 empty
 * cells, 16 markers, the evidence-ring tallies, the 6 families and 11
 * mechanisms the committed gold rows draw.
 *
 * The rules that hold for any dataset are in tests/timeline_layout_test.ts;
 * this file is the record of what the committed cSVD data draws, mirrored in
 * tests/scripts/csvd/test_csvd_timeline_figure.py, and a fork deletes the
 * whole tests/csvd/ tree.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { trials } from "../../lib/data.ts";
import { GOLD_ONLY } from "../../lib/gold_only.ts";
import { computeTimelineLayout, encoding } from "../../lib/timeline.ts";

const layout = computeTimelineLayout(trials);

/**
 * Empty cells on the committed data — the Python test pins the same list.
 * The gold trials fill seven cells: CAA/II, Cognitive Impairment/III and II,
 * Stroke/III and II, SVD/II and I (THN391's "Ib", on its parent's ring).
 */
const EMPTY_CELLS = [
  ["CAA", "IV"],
  ["CAA", "III"],
  ["CAA", "I"],
  ["Cognitive Impairment", "IV"],
  ["Cognitive Impairment", "I"],
  ["Stroke", "IV"],
  ["Stroke", "I"],
  ["SVD", "IV"],
  ["SVD", "III"],
];

Deno.test("sector spans are proportional to unique drugs and sum to a full turn", () => {
  assertEquals(layout.sectors.map((s) => s.key), [
    "CAA",
    "Cognitive Impairment",
    "Stroke",
    "SVD",
  ]);
  assertEquals(layout.sectors.map((s) => s.drugCount), [3, 2, 4, 3]);
  // 12 unique drugs over the four populations; CAA holds 3 of them.
  assertAlmostEquals(layout.sectors[0].endDeg, 3 / 12 * 360, 1e-9);
  assertAlmostEquals(
    layout.sectors[2].endDeg - layout.sectors[2].startDeg,
    4 / 12 * 360,
    1e-9,
  );
});

Deno.test("sixteen cells, nine of them empty", () => {
  assertEquals(layout.cells.length, 16);
  const empty = layout.cells.filter((c) => !c.filled)
    .map((c) => [c.population, c.phase]);
  assertEquals(empty, EMPTY_CELLS);
});

Deno.test("every committed trial is a marker", () => {
  assertEquals(layout.markers.length, 16);
});

Deno.test("the six Phase III Stroke trials share a cell and alternate their radius", () => {
  // Before gold-only this was the seven unphased SVD trials; the gold table
  // states a phase for every trial, and Stroke/III is its fullest cell.
  const shared = layout.markers.filter((m) =>
    m.population === "Stroke" && m.phase === "III"
  );
  assertEquals(shared.length, 6);
  assert(shared[0].r < shared[1].r);
  // Twice 18 % of the Phase III ring's thickness (0.2 of the 416 radius).
  assertAlmostEquals(shared[1].r - shared[0].r, 2 * 0.18 * 0.2 * 416, 1e-9);
});

Deno.test("population labels anchor away from the centre line and wrap the SVD label", () => {
  assertEquals(layout.populationLabels.map((l) => l.key), [
    "CAA",
    "Cognitive Impairment",
    "Stroke",
    "SVD",
  ]);
  const byKey = new Map(layout.populationLabels.map((l) => [l.key, l]));
  assertEquals(byKey.get("CAA")!.anchor, "start");
  assertEquals(byKey.get("SVD")!.anchor, "end");
  assertEquals(byKey.get("SVD")!.lines, ["Any SVD", "(including monogenic)"]);
});

Deno.test("a rim band frames each of the four populated sectors", () => {
  assertEquals(layout.rimBands.map((b) => b.population), [
    "CAA",
    "Cognitive Impairment",
    "Stroke",
    "SVD",
  ]);
  const stroke = trials.filter((t) => t.targetPopulation === "Stroke");
  const partial = computeTimelineLayout(stroke);
  assertEquals(partial.rimBands.map((b) => b.population), ["Stroke"]);
});

Deno.test("the family legend carries 6 families and 11 mechanisms", () => {
  // The legend lists only what the rows draw; the encoding keeps every
  // family and mechanism the pipeline's trials used.
  assertEquals(layout.familyLegend.length, 6);
  assertEquals(layout.familyLegend.flatMap((f) => f.entries).length, 11);
});

Deno.test("genetics assessed is a ring; only a bare default draws none", () => {
  // Five gold rows carry `geneticEvidence: "No"` with no target named, so
  // genetics was not assessed for them; the six that name a target and say
  // No are the real negative findings, and five name a supported target.
  const states = layout.markers.map((m) => m.evidenceState);
  assertEquals(states.filter((s) => s === "supported").length, 5);
  assertEquals(states.filter((s) => s === "unsupported").length, 6);
  assertEquals(states.filter((s) => s === "unassessed").length, 5);
  assertEquals(layout.markers.filter((m) => m.evidenceRing).length, 11);
  assertEquals(layout.markers.filter((m) => m.evidenceDash).length, 6);
});

// Gold-only: no gold trial is a thin record -- every mechanism is
// characterised and every enrolment and completion date stated -- so the
// committed data cannot exercise the flag. Its rules are tested on synthetic
// rows in tests/timeline_layout_test.ts.
Deno.test({
  name: "the record flag marks 16 thin records, by named reason",
  ignore: GOLD_ONLY,
}, () => {
  const flagged = layout.markers.filter((m) => m.flagReasons.length > 0);
  assertEquals(flagged.length, 16);
  const counts = new Map<string, number>();
  for (const marker of flagged) {
    for (const reason of marker.flagReasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  assertEquals(counts.get("mechanism-uncharacterised"), 14);
  assertEquals(counts.get("enrolment-unstated"), 1);
  assertEquals(counts.get("completion-unstated"), 1);
  // No committed row earns two reasons at once any more -- NCT02467413 was
  // the only one, and it is WITHDRAWN, so it is no longer published.
  const multiple = flagged.filter((m) => m.flagReasons.length > 1);
  assertEquals(multiple.map((m) => m.trial.registryId), []);
});

Deno.test("the Stroke trials alone fill two of the four rings", () => {
  const stroke = trials.filter((t) => t.targetPopulation === "Stroke");
  const partial = computeTimelineLayout(stroke);
  assertEquals(partial.sectors.length, 4);
  assertEquals(partial.sectors.filter((s) => s.drugCount === 0).length, 3);
  assertEquals(partial.cells.filter((c) => c.filled).length, 2);
  assertEquals(partial.markers.length, stroke.length);
  const sector = partial.sectors.find((s) => s.key === "Stroke")!;
  assertEquals([sector.startDeg, sector.endDeg], [0, 360]);
  assertEquals(encoding.populations.length, 4);
});
