/**
 * The cSVD radar, pinned: four sectors and their drug counts, the nine empty
 * cells, 102 markers, the evidence-ring and record-flag tallies, the 13
 * families and 46 mechanisms the committed rows draw.
 *
 * The rules that hold for any dataset are in tests/timeline_layout_test.ts;
 * this file is the record of what the committed cSVD data draws, mirrored in
 * tests/scripts/csvd/test_csvd_timeline_figure.py, and a fork deletes the
 * whole tests/csvd/ tree.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { trials } from "../../lib/data.ts";
import { computeTimelineLayout, encoding } from "../../lib/timeline.ts";

const layout = computeTimelineLayout(trials);

/** Empty cells on the committed data — the Python test pins the same list. */
const EMPTY_CELLS = [
  ["CAA", "IV"],
  ["CAA", "II/III"],
  ["CAA", "I"],
  ["CAA", "(unknown)"],
  ["Cognitive Impairment", "I/II"],
  ["Stroke", "I"],
  // SVD/III emptied when the three arms of NCT03082014 -- amlodipine,
  // losartan and atenolol, all TERMINATED -- stopped being published.
  ["SVD", "III"],
  ["SVD", "II/III"],
  ["SVD", "I/II"],
];

Deno.test("sector spans are proportional to unique drugs and sum to a full turn", () => {
  assertEquals(layout.sectors.map((s) => s.key), [
    "CAA",
    "Cognitive Impairment",
    "Stroke",
    "SVD",
  ]);
  assertEquals(layout.sectors.map((s) => s.drugCount), [8, 32, 14, 23]);
  // 77 unique drugs over the four populations; CAA holds 8 of them.
  assertAlmostEquals(layout.sectors[0].endDeg, 8 / 77 * 360, 1e-9);
  assertAlmostEquals(
    layout.sectors[2].endDeg - layout.sectors[2].startDeg,
    14 / 77 * 360,
    1e-9,
  );
});

Deno.test("twenty-eight cells, nine of them empty", () => {
  assertEquals(layout.cells.length, 28);
  const empty = layout.cells.filter((c) => !c.filled)
    .map((c) => [c.population, c.phase]);
  assertEquals(empty, EMPTY_CELLS);
});

Deno.test("every committed trial is a marker", () => {
  assertEquals(layout.markers.length, 102);
});

Deno.test("the seven unphased SVD trials share a cell and alternate their radius", () => {
  // This was the pair of stroke trials until one of them, NCT03783754, was
  // published as TERMINATED and stopped being drawn.
  const shared = layout.markers.filter((m) =>
    m.population === "SVD" && m.phase === "(unknown)"
  );
  assertEquals(shared.length, 7);
  assert(shared[0].r < shared[1].r);
  // Twice 18 % of the unknown-phase ring's thickness (0.15 of the 416
  // radius, which the two seamless rings deliberately did not narrow).
  assertAlmostEquals(shared[1].r - shared[0].r, 2 * 0.18 * 62.4, 1e-9);
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

Deno.test("the family legend carries 13 families and 46 mechanisms", () => {
  // "Other targeted" emptied when NCT04334408 (fremanezumab, WITHDRAWN)
  // stopped being published; the encoding keeps the entry.
  assertEquals(layout.familyLegend.length, 13);
  assertEquals(layout.familyLegend.flatMap((f) => f.entries).length, 46);
});

Deno.test("genetics assessed is a ring; only a bare default draws none", () => {
  // 90 of the committed rows carry `geneticEvidence: "No"` with no target
  // named: the sweep that added them defaulted the column rather than
  // assessing it. Those are `unassessed`, and the nine rows that name a target
  // are the real negative findings.
  const states = layout.markers.map((m) => m.evidenceState);
  assertEquals(states.filter((s) => s === "supported").length, 12);
  assertEquals(states.filter((s) => s === "unsupported").length, 9);
  assertEquals(states.filter((s) => s === "unassessed").length, 81);
  assertEquals(layout.markers.filter((m) => m.evidenceRing).length, 21);
  assertEquals(layout.markers.filter((m) => m.evidenceDash).length, 9);
});

Deno.test("the record flag marks 16 thin records, by named reason", () => {
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

Deno.test("the Stroke trials alone fill six of the seven rings", () => {
  const stroke = trials.filter((t) => t.targetPopulation === "Stroke");
  const partial = computeTimelineLayout(stroke);
  assertEquals(partial.sectors.length, 4);
  assertEquals(partial.sectors.filter((s) => s.drugCount === 0).length, 3);
  assertEquals(partial.cells.filter((c) => c.filled).length, 6);
  assertEquals(partial.markers.length, stroke.length);
  const sector = partial.sectors.find((s) => s.key === "Stroke")!;
  assertEquals([sector.startDeg, sector.endDeg], [0, 360]);
  assertEquals(encoding.populations.length, 4);
});
