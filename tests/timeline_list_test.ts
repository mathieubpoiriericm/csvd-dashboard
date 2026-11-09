import { assertEquals } from "@std/assert";

import { sampleTrial } from "./fixtures/rows.ts";
import { computeTimelineLayout, encoding } from "../lib/timeline.ts";
import { groupMarkersByPhase, subPhaseLabel } from "../lib/timeline_list.ts";

const POPULATION = encoding.populations[0].key;
const MECHANISM = Object.keys(encoding.mechanisms)[0];
const [P_OUTER, P_NEXT, , P_INNER] = encoding.rings.map((r) => r.phase);

const markersFor = (
  specs: { drug: string; phase: string }[],
) =>
  computeTimelineLayout(
    specs.map(({ drug, phase }) =>
      sampleTrial({
        drug,
        clinicalTrialPhase: phase,
        targetPopulation: POPULATION,
        mechanismOfAction: MECHANISM,
      })
    ),
  ).markers;

Deno.test("groups come in ring order, most advanced first", () => {
  const markers = markersFor([
    { drug: "A", phase: P_NEXT },
    { drug: "B", phase: P_OUTER },
  ]);
  assertEquals(
    groupMarkersByPhase(markers).map((g) => g.phase),
    [P_OUTER, P_NEXT],
  );
});

Deno.test("a phase with no markers produces no group", () => {
  const markers = markersFor([{ drug: "A", phase: P_INNER }]);
  assertEquals(groupMarkersByPhase(markers).map((g) => g.phase), [P_INNER]);
});

Deno.test("drugs are alphabetical within a group, ignoring case", () => {
  const markers = markersFor([
    { drug: "banana", phase: P_OUTER },
    { drug: "Cherry", phase: P_OUTER },
    { drug: "Apple", phase: P_OUTER },
  ]);
  assertEquals(
    groupMarkersByPhase(markers)[0].markers.map((m) => m.trial.drug),
    ["Apple", "banana", "Cherry"],
  );
});

Deno.test("a sub-phase lands in its parent group and is labelled", () => {
  const markers = markersFor([
    { drug: "A", phase: "Ib" },
    { drug: "B", phase: "II" },
  ]);
  const groups = groupMarkersByPhase(markers);
  const one = groups.find((g) => g.phase === "I")!;
  assertEquals(one.markers.map((m) => m.trial.drug), ["A"]);
  assertEquals(subPhaseLabel(one.markers[0]), "Phase Ib");
  const two = groups.find((g) => g.phase === "II")!;
  assertEquals(subPhaseLabel(two.markers[0]), null);
});

Deno.test("no markers, no groups", () => {
  assertEquals(groupMarkersByPhase([]), []);
});
