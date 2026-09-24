import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { trials } from "../lib/data.ts";
import { sampleTrial } from "./fixtures/rows.ts";
import {
  type Anchor,
  anchorOffsetX,
  annularSectorPath,
  CANVAS,
  CENTER,
  computeTimelineLayout,
  encoding,
  MARKER_RADIUS,
  OUTER_RADIUS,
  placePopulationLabel,
  PLATE_MARGIN,
  polarToPoint,
  POPULATION_LABEL_OFFSET,
  populationAnchor,
  type PopulationLabel,
  resolveEvidenceState,
  resolveRecordFlag,
  rimBandRadii,
  sameBoxes,
  type Sector,
  separateLabels,
  stagger,
} from "../lib/timeline.ts";
import {
  placeTooltip,
  timelineInteractionReducer,
} from "../islands/TrialsTimeline.tsx";

// The rules below hold for any dataset: the committed rows are looped over,
// and the constructed cases build their trials from the encoding. The cSVD
// numbers -- four sectors, nine empty cells, 102 markers -- are pinned in
// tests/csvd/timeline_layout_test.ts.
const layout = computeTimelineLayout(trials);

const POPULATION = encoding.populations[0].key;
const PHASE = encoding.rings[0].phase;
const MECHANISM = Object.keys(encoding.mechanisms)[0];

/** A trial the radar places in the first population's first ring. */
const placed = (overrides: Partial<ReturnType<typeof sampleTrial>> = {}) =>
  sampleTrial({
    targetPopulation: POPULATION,
    clinicalTrialPhase: PHASE,
    mechanismOfAction: MECHANISM,
    ...overrides,
  });

Deno.test("polar angles run clockwise from 12 o'clock", () => {
  assertEquals(polarToPoint(0, OUTER_RADIUS), { x: 536, y: 68 });
  const right = polarToPoint(90, OUTER_RADIUS);
  assertAlmostEquals(right.x, 952, 1e-9);
  assertAlmostEquals(right.y, 484, 1e-9);
  const bottom = polarToPoint(180, OUTER_RADIUS);
  assertAlmostEquals(bottom.x, 536, 1e-9);
  assertAlmostEquals(bottom.y, 900, 1e-9);
});

Deno.test("a wedge from the centre and an annular sector produce the old paths", () => {
  // The same two paths scripts/python_plot.py emitted for CAA, translated to
  // the enlarged canvas's centre: only CENTER moved, the radii are unchanged.
  assertEquals(
    annularSectorPath(0, 180, 0, 90),
    "M 536.00 484.00 L 536.00 304.00 A 180.00 180.00 0 0 1 716.00 484.00 Z",
  );
  assertEquals(
    annularSectorPath(180, 250, 0, 90),
    "M 536.00 234.00 A 250.00 250.00 0 0 1 786.00 484.00 L 716.00 484.00 A 180.00 180.00 0 0 0 536.00 304.00 Z",
  );
  // Past a half turn the large-arc flag flips.
  assert(annularSectorPath(0, 100, 0, 200).includes(" 0 1 1 "));
});

Deno.test("sector spans are proportional to unique drugs and sum to a full turn", () => {
  assertEquals(
    layout.sectors.map((s) => s.key),
    encoding.populations.map((p) => p.key),
  );
  assertEquals(layout.sectors[0].startDeg, 0);
  for (let i = 1; i < layout.sectors.length; i++) {
    assertEquals(layout.sectors[i].startDeg, layout.sectors[i - 1].endDeg);
  }
  const total = layout.sectors.reduce((n, s) => n + s.drugCount, 0);
  if (total > 0) {
    assertAlmostEquals(layout.sectors.at(-1)!.endDeg, 360, 1e-9);
    for (const sector of layout.sectors) {
      assertAlmostEquals(
        sector.endDeg - sector.startDeg,
        sector.drugCount / total * 360,
        1e-9,
        sector.key,
      );
    }
  }

  // Two drugs in one population, one in the next: a 2:1 split. Built on
  // two populations of its own, because a disease may declare only one.
  const second = { ...encoding.populations[0], key: `${POPULATION}-b` };
  const constructed = computeTimelineLayout([
    placed({ drug: "Drug A" }),
    placed({ drug: "Drug B", registryId: "NCT00000002" }),
    placed({
      drug: "Drug C",
      registryId: "NCT00000003",
      targetPopulation: second.key,
    }),
  ], { ...encoding, populations: [encoding.populations[0], second] });
  assertEquals(constructed.sectors[0].drugCount, 2);
  assertAlmostEquals(constructed.sectors[0].endDeg, 240, 1e-9);
  assertAlmostEquals(constructed.sectors.at(-1)!.startDeg, 240, 1e-9);
  assertAlmostEquals(constructed.sectors.at(-1)!.endDeg, 360, 1e-9);
});

Deno.test("one cell per population and ring; an empty one keeps its population's colour at the empty-cell opacity", () => {
  assertEquals(
    layout.cells.length,
    encoding.populations.length * encoding.rings.length,
  );
  for (const cell of layout.cells) {
    const population = encoding.populations.find((p) =>
      p.key === cell.population
    )!;
    assertEquals(
      cell.color,
      population.color,
      `${cell.population}/${cell.phase}`,
    );
    if (!cell.filled) assertEquals(cell.opacity, encoding.emptyCell.opacity);
    else {assert(
        cell.opacity > encoding.emptyCell.opacity,
        "a filled cell reads darker than an empty one",
      );}
    assert(cell.path.startsWith("M "), "cell has no path");
  }
});

Deno.test("every marker sits inside its own cell, coloured by mechanism", () => {
  assertEquals(layout.markers.map((m) => m.index), [
    ...Array(layout.markers.length).keys(),
  ]);
  for (const marker of layout.markers) {
    const sector = layout.sectors.find((s) => s.key === marker.population)!;
    const ring = encoding.rings.find((r) => r.phase === marker.phase)!;
    assert(
      marker.thetaDeg > sector.startDeg && marker.thetaDeg < sector.endDeg,
      `${marker.trial.drug} is outside its sector`,
    );
    assert(
      marker.r > ring.innerRadius * OUTER_RADIUS &&
        marker.r < ring.outerRadius * OUTER_RADIUS,
      `${marker.trial.drug} is outside its ring`,
    );
    assertEquals(
      marker.color,
      encoding.mechanisms[marker.trial.mechanismOfAction],
    );
    const state = encoding.evidenceStates.find((s) =>
      s.key === marker.evidenceState
    );
    assertEquals(marker.evidenceRing, state?.ring ?? null);
    assertEquals(marker.evidenceDash, state?.dash ?? null);
    // Labels sit beside the marker, on the side away from the centre line.
    const outward = marker.point.x >= CENTER.x ? "start" : "end";
    assertEquals(marker.anchor, outward);
    assertAlmostEquals(
      Math.abs(marker.labelPoint.x - marker.point.x),
      MARKER_RADIUS + 10,
      1e-9,
    );
    assertEquals(marker.labelPoint.y, marker.point.y);
  }
});

Deno.test("markers sharing a cell alternate their radius so labels cannot stack", () => {
  assertEquals(stagger(0, 1, 100), 0);
  assertEquals(stagger(0, 2, 100), -18);
  assertEquals(stagger(1, 2, 100), 18);
  assertEquals(stagger(2, 3, 100), -18);

  // Two trials in one cell: their radii straddle the ring's midpoint by 18 %
  // of its thickness each way.
  const shared = computeTimelineLayout([
    placed({ drug: "Drug A" }),
    placed({ drug: "Drug B", registryId: "NCT00000002" }),
  ]).markers;
  assertEquals(shared.length, 2);
  assert(shared[0].r < shared[1].r);
  const ring = encoding.rings[0];
  const thickness = (ring.outerRadius - ring.innerRadius) * OUTER_RADIUS;
  assertAlmostEquals(shared[1].r - shared[0].r, 2 * 0.18 * thickness, 1e-9);
});

Deno.test("population labels sit just outside the rim band on the outward side", () => {
  // One label per populated sector, in population order.
  assertEquals(
    layout.populationLabels.map((l) => l.key),
    layout.sectors.filter((s) => s.drugCount > 0).map((s) => s.key),
  );
  // A sector on the right half of the plate anchors its label at the start,
  // one on the left half at the end.
  const one = computeTimelineLayout([placed()]);
  assertEquals(one.populationLabels.length, 1);
  assertEquals(one.populationLabels[0].key, POPULATION);
  assertEquals(one.populationLabels[0].lines, encoding.populations[0].label);
  const bandOuter = OUTER_RADIUS *
    (1 + encoding.rimBand.gap + encoding.rimBand.width);
  for (const label of layout.populationLabels) {
    const dx = label.point.x - CENTER.x;
    const dy = label.point.y - CENTER.y;
    assertAlmostEquals(Math.hypot(dx, dy), bandOuter + 24, 1e-9);
  }
});

interface RimBand {
  population: string;
  path: string;
  color: string;
}

interface FamilyLegend {
  key: string;
  label: string;
  entries: { label: string; color: string }[];
}

/** The fields the rim band and the family legend add to the layout. */
type WithBands = { rimBands?: RimBand[]; familyLegend?: FamilyLegend[] };

Deno.test("a rim band frames each populated sector just outside the rings", () => {
  const bands = (layout as WithBands).rimBands ?? [];
  assertEquals(
    bands.map((b) => b.population),
    layout.sectors.filter((s) => s.drugCount > 0).map((s) => s.key),
  );
  const inner = OUTER_RADIUS * (1 + encoding.rimBand.gap);
  const outer = inner + OUTER_RADIUS * encoding.rimBand.width;
  for (const band of bands) {
    const sector = layout.sectors.find((s) => s.key === band.population)!;
    const population = encoding.populations.find((p) =>
      p.key === band.population
    )!;
    assertEquals(band.color, population.band);
    assertEquals(
      band.path,
      annularSectorPath(inner, outer, sector.startDeg, sector.endDeg),
    );
  }

  // Nothing to frame around a population without trials.
  const partial = computeTimelineLayout([placed()]) as WithBands;
  assertEquals(partial.rimBands?.map((b) => b.population), [POPULATION]);
});

Deno.test("the family legend groups every mechanism under its family, coloured as its marker", () => {
  const families = (layout as WithBands).familyLegend ?? [];
  // The legend is derived from the data, so it carries the encoding's
  // families **in encoding order, minus any with no mechanism in the
  // committed rows** -- "Other targeted" emptied when NCT04334408
  // (fremanezumab, WITHDRAWN) stopped being published. The encoding keeps
  // the entry: `tests/timeline_encoding_test.ts` fails on data the encoding
  // does not cover, never on an encoding entry the data does not use.
  const order = encoding.families.map((f) => f.label);
  assertEquals(
    families.map((f) => f.label),
    order.filter((label) => families.some((f) => f.label === label)),
  );
  assert(families.every((f) => f.entries.length > 0), "empty family in legend");
  const entries = families.flatMap((f) => f.entries);
  assertEquals(
    new Set(entries.map((e) => e.label)),
    new Set(layout.markers.map((m) => m.trial.mechanismOfAction)),
  );
  for (const entry of entries) {
    assertEquals(entry.color, encoding.mechanisms[entry.label], entry.label);
  }
  assertEquals(layout.evidenceLegend.map((e) => [e.key, e.ring, e.dash]), [
    ["supported", "#14172b", null],
    ["unsupported", "#14172b", "3 2"],
    ["unassessed", null, null],
  ]);
});

Deno.test("phase labels stack on the 12 o'clock boundary at ring midpoints", () => {
  assertEquals(layout.phaseLabels.map((l) => l.phase), [
    "IV",
    "III",
    "II/III",
    "II",
    "I/II",
    "I",
    "(unknown)",
  ]);
  // CENTER.y less each ring's midpoint radius, on the 416-unit plate.
  const ys = [400.8, 298.88, 261.44, 224, 186.56, 149.12, 99.2];
  layout.phaseLabels.forEach((label, i) => {
    assertEquals(label.point.x, 536);
    assertAlmostEquals(label.point.y, ys[i], 1e-9);
  });
});

Deno.test("the evidence legend lists all three states in encoding order", () => {
  // The mechanism side of this is `the family legend groups every mechanism
  // under its family` above — the legend the island actually renders — and
  // `tests/timeline_encoding_test.ts` owns "every mechanism has its own
  // distinct colour".
  assertEquals(
    layout.evidenceLegend.map((e) => e.key),
    ["supported", "unsupported", "unassessed"],
  );
  assertEquals(
    layout.evidenceLegend.map((e) => e.label),
    encoding.evidenceStates.map((s) => s.legend),
  );
});

Deno.test("genetics assessed is a ring; only a bare default draws none", () => {
  // A row carrying `geneticEvidence: "No"` with no target named was defaulted
  // rather than assessed and draws no ring; one that names a target is a real
  // negative finding and draws a dashed one.
  const constructed = computeTimelineLayout([
    placed({ drug: "Drug A", geneticEvidence: "Yes" }),
    placed({
      drug: "Drug B",
      registryId: "NCT00000002",
      geneticEvidence: "No",
      geneticTarget: "GENE1",
    }),
    placed({ drug: "Drug C", registryId: "NCT00000003" }),
  ]);
  assertEquals(constructed.markers.map((m) => m.evidenceState), [
    "supported",
    "unsupported",
    "unassessed",
  ]);
  assertEquals(constructed.markers.map((m) => m.evidenceRing !== null), [
    true,
    true,
    false,
  ]);
  assertEquals(constructed.markers.map((m) => m.evidenceDash !== null), [
    false,
    true,
    false,
  ]);

  for (const marker of layout.markers) {
    const assessed = marker.evidenceState !== "unassessed";
    assertEquals(
      marker.evidenceRing !== null,
      assessed,
      `${marker.trial.drug} rings without having been assessed, or vice versa`,
    );
  }
});

Deno.test("resolveEvidenceState separates a default No from an assessed one", () => {
  const base = sampleTrial();
  assertEquals(
    resolveEvidenceState({ ...base, geneticEvidence: "Yes" }),
    "supported",
  );
  assertEquals(
    resolveEvidenceState({
      ...base,
      geneticEvidence: "No",
      geneticTarget: "PDE3A",
    }),
    "unsupported",
  );
  assertEquals(
    resolveEvidenceState({
      ...base,
      geneticEvidence: "No",
      geneticTarget: "(none)",
    }),
    "unassessed",
  );
});

Deno.test("the flag legend counts the thin records, by named reason", () => {
  const flagged = layout.markers.filter((m) => m.flagReasons.length > 0);
  assertEquals(layout.flagLegend.count, flagged.length);
  for (const marker of flagged) {
    for (const reason of marker.flagReasons) {
      assert(
        reason in encoding.recordFlag.reasons,
        `${marker.trial.drug}: ${reason} has no legend wording`,
      );
    }
  }

  // The drawer lists reasons rather than naming one: the rules are
  // independent and can co-occur.
  const thin = computeTimelineLayout([
    placed({
      targetSampleSize: "(unknown)",
      estimatedCompletionDate: "(unknown)",
    }),
  ]);
  assertEquals(thin.flagLegend.count, 1);
  assertEquals(thin.markers[0].flagReasons, [
    "enrolment-unstated",
    "completion-unstated",
  ]);
});

Deno.test("record-flag rules fire on the exact values and nothing near them", () => {
  const base = sampleTrial();
  const clean = {
    ...base,
    mechanismOfAction: "Vasodilator (nitrate)",
    targetSampleSize: "120",
    estimatedCompletionDate: "7/2028",
  };
  assertEquals(resolveRecordFlag(clean), []);

  // A stated enrolment of zero is as absent as no enrolment at all; one is not.
  assertEquals(resolveRecordFlag({ ...clean, targetSampleSize: "0" }), [
    "enrolment-unstated",
  ]);
  assertEquals(resolveRecordFlag({ ...clean, targetSampleSize: "1" }), []);
  assertEquals(resolveRecordFlag({ ...clean, targetSampleSize: "(unknown)" }), [
    "enrolment-unstated",
  ]);
  assertEquals(
    resolveRecordFlag({ ...clean, estimatedCompletionDate: "(unknown)" }),
    ["completion-unstated"],
  );
  // A completed trial is not a thin record: 69 committed rows have a
  // completion date in the past.
  assertEquals(
    resolveRecordFlag({ ...clean, estimatedCompletionDate: "8/2019" }),
    [],
  );
  // Nor is a phase the registry never stated — the encoding gives it a ring of
  // its own, so the geometry already says so.
  assertEquals(
    resolveRecordFlag({ ...clean, clinicalTrialPhase: "(unknown)" }),
    [],
  );
  // The mechanism rule reads the encoding's `uncharacterised` family, which
  // a disease declares or does not -- so the test brings its own.
  const zed = "Zed (mechanism not characterised)";
  const withFamily = {
    ...encoding,
    families: [
      ...encoding.families.filter((f) => f.key !== "uncharacterised"),
      { key: "uncharacterised", label: "Uncharacterised", mechanisms: [zed] },
    ],
  };
  assertEquals(
    resolveRecordFlag({ ...clean, mechanismOfAction: zed }, withFamily),
    ["mechanism-uncharacterised"],
  );
  // The rules are independent, so one record can earn several at once. No
  // committed row does today; the drawer still has to render a list.
  assertEquals(
    resolveRecordFlag({
      ...clean,
      mechanismOfAction: zed,
      targetSampleSize: "(unknown)",
      estimatedCompletionDate: "(unknown)",
    }, withFamily),
    ["mechanism-uncharacterised", "enrolment-unstated", "completion-unstated"],
  );
});

Deno.test("a population with no trials still gets its sector and grey cells", () => {
  const partial = computeTimelineLayout([placed()]);
  assertEquals(partial.sectors.length, encoding.populations.length);
  assertEquals(
    partial.sectors.filter((s) => s.drugCount === 0).length,
    encoding.populations.length - 1,
  );
  assertEquals(partial.cells.filter((c) => c.filled).length, 1);
  assertEquals(partial.markers.length, 1);

  // That sole population spans the whole 360°, and a sector that closes on
  // itself has to be drawn as two arcs: SVG omits an elliptical arc whose
  // endpoints coincide, so one arc would paint nothing at all.
  const sector = partial.sectors.find((s) => s.key === POPULATION)!;
  assertEquals([sector.startDeg, sector.endDeg], [0, 360]);
  const ARC = /A [\d.]+ [\d.]+ 0 \d \d ([\d.]+ [\d.]+)/g;
  for (const cell of partial.cells.filter((c) => c.population === POPULATION)) {
    for (const subpath of cell.path.split("Z").filter((part) => part.trim())) {
      const start = /M ([\d.]+ [\d.]+)/.exec(subpath)![1];
      const targets = [...subpath.matchAll(ARC)].map((m) => m[1]);
      assert(targets.length >= 2, `${cell.phase}: ${targets.length} arc(s)`);
      // At least one arc has to land somewhere other than where the subpath
      // began; an arc back to its own start is the one the renderer drops.
      assert(
        targets.some((target) => target !== start),
        `${cell.phase} only has zero-length arcs at ${start}`,
      );
    }
  }
});

Deno.test("an empty trial set produces zero-width sectors without dividing by zero", () => {
  const empty = computeTimelineLayout([]);
  const zeros = encoding.populations.map(() => 0);
  assertEquals(empty.sectors.map((sector) => sector.drugCount), zeros);
  assertEquals(empty.sectors.map((sector) => sector.endDeg), zeros);
  assertEquals(empty.markers, []);
  assertEquals(empty.rimBands, []);
  assertEquals(empty.populationLabels, []);
});

Deno.test("unknown mechanism and evidence encodings use visible safe fallbacks", () => {
  const fixture = {
    ...sampleTrial(),
    targetPopulation: encoding.populations[0].key,
    mechanismOfAction: "Future mechanism",
    geneticEvidence: "Pending",
  };
  const customEncoding = structuredClone(encoding);
  customEncoding.mechanisms = {};
  customEncoding.families = [{
    key: "future",
    label: "Future family",
    mechanisms: ["Future mechanism"],
  }];

  const partial = computeTimelineLayout([fixture], customEncoding);
  assertEquals(partial.markers[0].color, "#888888");
  assertEquals(partial.markers[0].evidenceRing, null);
  assertEquals(partial.markers[0].evidenceDash, null);
  assertEquals(partial.familyLegend, [{
    key: "future",
    label: "Future family",
    entries: [{ label: "Future mechanism", color: "#888888" }],
  }]);
});

Deno.test("annularSectorPath draws a full turn as two arcs, wedge and annulus", () => {
  const disc = annularSectorPath(0, 100, 0, 360);
  assertEquals((disc.match(/A /g) ?? []).length, 2);
  // A closed disc has no radial edge, so no line-to back to the centre.
  assert(!disc.includes("L "), disc);

  const ring = annularSectorPath(50, 100, 0, 360);
  assertEquals((ring.match(/A /g) ?? []).length, 4);
  // Outer clockwise, inner anticlockwise: nonzero fill then cuts the hole.
  assert(ring.includes("A 100.00 100.00 0 0 1"), ring);
  assert(ring.includes("A 50.00 50.00 0 0 0"), ring);

  // Anything short of a full turn is untouched.
  assertEquals(
    annularSectorPath(0, 100, 0, 90),
    "M 536.00 484.00 L 536.00 384.00 A 100.00 100.00 0 0 1 636.00 484.00 Z",
  );
});

/**
 * The relaxation pass's four cases, unchanged in value: every one of them is
 * settled before the placement pass looks, so each shift is still the same
 * number it was when the return type was a bare `dy` -- what moved is the
 * shape around it, which now carries the `dx` the placement pass needs.
 */
Deno.test("separateLabels leaves boxes that already clear each other alone", () => {
  assertEquals(
    separateLabels([
      { x: 0, y: 0, width: 50, height: 20 },
      { x: 0, y: 30, width: 50, height: 20 },
      { x: 100, y: 5, width: 50, height: 20 },
    ]),
    [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }],
  );
  // Nothing to place: the median height the placement grid is built from is
  // undefined for an empty figure, so the pass has to be skipped rather than
  // reached with a NaN step.
  assertEquals(separateLabels([]), []);
});

Deno.test("separateLabels splits an overlap between two labels, lower one down", () => {
  const boxes = [
    { x: 0, y: 10, width: 50, height: 20 },
    { x: 20, y: 0, width: 50, height: 20 },
  ];
  const shifts = separateLabels(boxes, [], 2);
  // They overlap by 10 in y; plus the 2 gap, each moves 6.
  assertEquals(shifts, [{ dx: 0, dy: 6 }, { dx: 0, dy: -6 }]);
  const a = { ...boxes[0], y: boxes[0].y + shifts[0].dy };
  const b = { ...boxes[1], y: boxes[1].y + shifts[1].dy };
  assert(a.y >= b.y + b.height + 2 - 1e-9);
});

Deno.test("separateLabels resolves an exact tie by index", () => {
  const box = { x: 0, y: 0, width: 40, height: 10 };
  assertEquals(separateLabels([box, { ...box }], [], 2), [
    { dx: 0, dy: -6 },
    { dx: 0, dy: 6 },
  ]);
});

Deno.test("separateLabels moves a label clear of a fixed box without moving the box", () => {
  const fixed = { x: 0, y: 0, width: 100, height: 30 };
  const below = { x: 10, y: 20, width: 40, height: 20 };
  const above = { x: 10, y: -15, width: 40, height: 20 };
  assertEquals(separateLabels([below, above], [fixed], 2), [
    { dx: 0, dy: 12 },
    { dx: 0, dy: -7 },
  ]);
});

/**
 * The placement pass, and why a shift has a `dx`.
 *
 * Three identical boxes stacked on the same spot, walled in above and below
 * by fixed obstacles two box-heights away. Relaxation splits them vertically
 * into the wall and stops -- the fixed pushes and the pairwise splits cancel,
 * and no number of passes gets past it, which is the deadlock the committed
 * figure hits against its markers. So the placement pass takes over, and the
 * only free space left is sideways: the boxes that cannot stay put leave
 * along their own `outward` vector.
 */
Deno.test("separateLabels displaces along `outward` when the vertical is walled in", () => {
  const outward = { x: 1, y: 0 };
  const boxes = [
    { x: 0, y: 0, width: 40, height: 10, outward },
    { x: 0, y: 0, width: 40, height: 10, outward },
    { x: 0, y: 0, width: 40, height: 10, outward },
  ];
  // A corridor 20 units tall: one 10-unit box fits, three cannot.
  const walls = [
    { x: -50, y: -500, width: 80, height: 495 },
    { x: -50, y: 15, width: 80, height: 500 },
  ];
  // The first box keeps the corridor; the other two leave along `outward`,
  // to the first radial step clear of the walls (30), and separate there.
  assertEquals(separateLabels(boxes, walls, 2), [
    { dx: 0, dy: 0 },
    { dx: 30, dy: 12.5 },
    { dx: 30, dy: -12.5 },
  ]);

  // The same boxes with nowhere to go: relaxation splits them into the walls
  // and stops, three boxes still stacked in a corridor that holds one. This
  // is the deadlock the committed figure hits against its markers, and it is
  // what makes the second axis load-bearing rather than decorative.
  const confined = separateLabels(
    boxes.map(({ outward: _outward, ...box }) => box),
    walls,
    2,
  );
  assertEquals(confined, [
    { dx: 0, dy: 0 },
    { dx: 0, dy: -3 },
    { dx: 0, dy: 3 },
  ]);
});

/**
 * The two reaches, pinned from both sides, because the case above pins only
 * the two step sizes: 12.5 is five vertical steps and 30 is six radial ones,
 * and either reach could be halved with that case still green.
 *
 * Each box here is 20 tall, so relaxation shoves it 22 a pass and runs out at
 * 264 after its twelve — short of both openings — and the placement pass is
 * what has to find them. `scripts/timeline_figure.py` carries both cases.
 */
Deno.test("separateLabels reaches an opening at the far end of each axis", () => {
  const outward = { x: 1, y: 0 };
  const box = { x: 0, y: 0, width: 40, height: 20, outward };

  // A wall 540 tall and wider than the radial reach: the only way out is
  // vertical, at 270 = 13.5 box heights. PLACEMENT_REACH of 13 falls back to
  // relaxation's 264, 14 finds it.
  assertEquals(
    separateLabels([box], [{ x: -50, y: -270, width: 1050, height: 540 }], 2),
    [{ dx: 0, dy: 270 }],
  );

  // A wall 800 tall and 200 wide: taller than the vertical reach, so the only
  // way out is radial, at 150 = 7.5 box heights. RADIAL_REACH of 7 falls back
  // to relaxation's 264, 8 finds it — and the 150 is 15 radial steps, so a
  // coarser RADIAL_STEP overshoots to 160.
  assertEquals(
    separateLabels([box], [{ x: -50, y: -400, width: 200, height: 800 }], 2),
    [{ dx: 150, dy: 0 }],
  );
});

Deno.test("timeline tooltips stay inside every viewport edge", () => {
  const viewport = { width: 400, height: 300 };
  const size = { width: 100, height: 50 };

  assertEquals(placeTooltip(size, { x: 200, y: 100 }, viewport), {
    x: 150,
    y: 38,
  });
  assertEquals(placeTooltip(size, { x: 20, y: 100 }, viewport), {
    x: 10,
    y: 38,
  });
  assertEquals(placeTooltip(size, { x: 100, y: 20 }, viewport), {
    x: 112,
    y: 10,
  });
  assertEquals(placeTooltip(size, { x: 390, y: 20 }, viewport), {
    x: 278,
    y: 10,
  });

  // CSS normally caps the panel to the viewport. Geometry must still be safe
  // before that constraint lands (or at extreme browser zoom): an inverted
  // clamp range must never return a negative leading edge.
  assertEquals(
    placeTooltip({ width: 420, height: 50 }, { x: 200, y: 100 }, viewport),
    { x: 0, y: 38 },
  );
  assertEquals(
    placeTooltip({ width: 100, height: 340 }, { x: 100, y: 20 }, viewport),
    { x: 112, y: 0 },
  );
});

Deno.test("activating a timeline marker clears its transient tooltip", () => {
  const tooltip = {
    title: "Drug A",
    rows: [{ label: "Phase", value: "III" }],
  };
  assertEquals(
    timelineInteractionReducer(
      { active: null, tooltip },
      { type: "activate-marker", index: 3 },
    ),
    { active: 3, tooltip: null },
  );
});

Deno.test("the interaction reducer shows, hides and closes without churning state", () => {
  const tooltip = { title: "Drug A", rows: [] };
  const closed = { active: null, tooltip: null };
  assertEquals(
    timelineInteractionReducer(closed, { type: "show-tooltip", tooltip }),
    { active: null, tooltip },
  );
  // Hiding an already-hidden tooltip returns the same object, so a repeated
  // pointer-leave does not re-render.
  assert(
    timelineInteractionReducer(closed, { type: "hide-tooltip" }) === closed,
  );
  assertEquals(
    timelineInteractionReducer({ active: 2, tooltip }, {
      type: "hide-tooltip",
    }),
    { active: 2, tooltip: null },
  );
  assertEquals(
    timelineInteractionReducer({ active: 2, tooltip }, {
      type: "close-drawer",
    }),
    closed,
  );
});

Deno.test("separation moves only labels that meet", () => {
  // Synthetic stand-ins for a measured pair of neighbouring drug labels:
  // same x span, three units of vertical overlap.
  const shifts = separateLabels([
    { x: 254, y: 444, width: 132, height: 20 },
    { x: 254, y: 461, width: 132, height: 20 },
  ]);
  assertEquals(shifts, [{ dx: 0, dy: -2.5 }, { dx: 0, dy: 2.5 }]);
});

Deno.test("a re-measure that moved nothing compares equal", () => {
  const box = { x: 10, y: 20, width: 30, height: 40 };
  const measured = new Map([["drug-0", box]]);

  // The case the guard exists for: a fresh Map holding the same numbers, as
  // `measureSvgTextBoxes` returns on every pass.
  assert(sameBoxes(measured, new Map([["drug-0", { ...box }]])));
  assert(sameBoxes(new Map(), new Map()));

  // A pass that measured more or fewer labels.
  assert(!sameBoxes(measured, new Map()));

  // Same size, different key: the label was replaced, not moved.
  assert(!sameBoxes(measured, new Map([["drug-1", { ...box }]])));

  // One differing edge is enough, on any of the four.
  for (const edge of ["x", "y", "width", "height"] as const) {
    assert(
      !sameBoxes(measured, new Map([["drug-0", { ...box, [edge]: 99 }]])),
      `${edge} must be compared`,
    );
  }
});

Deno.test("zero-height label measurements terminate without a zero-step search", () => {
  assertEquals(
    separateLabels([{ x: 0, y: 0, width: 10, height: 0 }]),
    [{ dx: 0, dy: 0 }],
  );
  assertEquals(
    separateLabels([
      { x: 0, y: 0, width: 10, height: 0 },
      { x: 20, y: 0, width: 10, height: 10 },
    ]),
    [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }],
  );
});

Deno.test("captured font geometry preserves exact shifts and immutable inputs", async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/timeline-geometry.json", import.meta.url),
    ),
  );
  const before = JSON.stringify(fixture);
  assertEquals(separateLabels(fixture.movable, fixture.fixed), fixture.shifts);
  assertEquals(separateLabels(fixture.movable, fixture.fixed), fixture.shifts);
  assertEquals(JSON.stringify(fixture), before);
});

Deno.test("unindexable obstacles and labels use bounded collision checks", () => {
  const label = { x: 0, y: 0, width: 10, height: 10 };
  // Large boxes span too many cells; far-away boxes exceed safe grid indices.
  // Both must remain real obstacles, and never create an unbounded cell loop.
  const large = { x: -1e6, y: -1e6, width: 2e6, height: 2e6 };
  assertEquals(separateLabels([label], [large], 2, 0), [{ dx: 0, dy: 0 }]);
  assertEquals(
    separateLabels([label], [
      { x: 1e300, y: 0, width: 10, height: 10 },
      { x: NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: -1, height: 10 },
      { x: 0, y: 0, width: 1, height: -1 },
    ]),
    [{ dx: 0, dy: 0 }],
  );
  assertEquals(separateLabels([large, label], [], 2, 0).length, 2);
  assertEquals(separateLabels([label, { ...label, x: 1e300 }]), [
    { dx: 0, dy: 0 },
    { dx: 0, dy: 0 },
  ]);
  for (const height of [Number.MIN_VALUE, 1e200, Infinity, NaN]) {
    assertEquals(separateLabels([{ ...label, height }], [], 2, 0), [{
      dx: 0,
      dy: 0,
    }]);
  }
});

// -----------------------------------------------------------------------------
// POPULATION LABEL PLACEMENT
// -----------------------------------------------------------------------------

const { outer: BAND_OUTER } = rimBandRadii(encoding);
const LABEL_RADIUS = BAND_OUTER + POPULATION_LABEL_OFFSET;

/** A sector of the shape `computeTimelineLayout` produces. */
const sectorAt = (key: string, startDeg: number, endDeg: number): Sector => ({
  key,
  label: [key],
  color: "#000",
  band: "#000",
  startDeg,
  endDeg,
  drugCount: 1,
});

/** A population label anchored the way the layout anchors it. */
function labelAt(key: string, thetaDeg: number): PopulationLabel {
  return {
    key,
    lines: [key],
    point: polarToPoint(thetaDeg, LABEL_RADIUS),
    anchor: populationAnchor(thetaDeg),
  };
}

interface TestBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a box ends up once a shift -- offset and anchor -- is applied. */
function shifted(
  label: PopulationLabel,
  base: TestBox,
  textWidth: number,
  shift: { dx: number; dy: number; anchor: Anchor },
): TestBox {
  return {
    ...base,
    x: base.x + shift.dx + anchorOffsetX(label.anchor, shift.anchor, textWidth),
    y: base.y + shift.dy,
  };
}

const insidePlate = (box: TestBox) =>
  box.x >= PLATE_MARGIN && box.y >= PLATE_MARGIN &&
  box.x + box.width <= CANVAS.width - PLATE_MARGIN &&
  box.y + box.height <= CANVAS.height - PLATE_MARGIN;

/** Distance from the plate's centre to the nearest point of a box. */
const nearestRadius = (box: TestBox) =>
  Math.hypot(
    Math.min(Math.max(CENTER.x, box.x), box.x + box.width) - CENTER.x,
    Math.min(Math.max(CENTER.y, box.y), box.y + box.height) - CENTER.y,
  );

Deno.test("a population label reads from the side its angle puts it on", () => {
  assertEquals(populationAnchor(0), "middle");
  assertEquals(populationAnchor(180), "middle");
  assertEquals(populationAnchor(90), "start");
  assertEquals(populationAnchor(270), "end");
});

Deno.test("re-anchoring moves a box by its own width", () => {
  assertEquals(anchorOffsetX("start", "end", 100), -100);
  assertEquals(anchorOffsetX("end", "start", 100), 100);
  assertEquals(anchorOffsetX("start", "middle", 100), -50);
  assertEquals(anchorOffsetX("middle", "middle", 100), 0);
});

Deno.test("the rim band sits where the encoding's fractions put it", () => {
  const { inner, outer } = rimBandRadii(encoding);
  assertEquals(inner, OUTER_RADIUS * (1 + encoding.rimBand.gap));
  assertEquals(outer, inner + OUTER_RADIUS * encoding.rimBand.width);
});

Deno.test("a population label already on the plate is left alone", () => {
  const label = labelAt("P1", 23);
  const base = {
    x: label.point.x,
    y: label.point.y - 10,
    width: 40,
    height: 20,
  };
  assertEquals(
    placePopulationLabel(label, base, 32, [sectorAt("P1", 0, 46)]),
    undefined,
  );
});

Deno.test("a label clear of the band is pulled straight back onto the plate", () => {
  // Top-left and bottom-right corners: the pull lands nowhere near the rings,
  // so the cheap correction is the right one and the anchor does not change.
  const label = labelAt("P1", 300);
  assertEquals(
    placePopulationLabel(
      label,
      { x: 20, y: -5, width: 60, height: 20 },
      52,
      [],
    ),
    { dx: 0, dy: 15, anchor: label.anchor },
  );
  assertEquals(
    placePopulationLabel(
      label,
      { x: 1040, y: 920, width: 60, height: 40 },
      52,
      [],
    ),
    { dx: -38, dy: -30, anchor: label.anchor },
  );
  // Off the left edge only: the vertical is already inside the plate.
  assertEquals(
    placePopulationLabel(
      label,
      { x: -20, y: 20, width: 60, height: 20 },
      52,
      [],
    ),
    { dx: 30, dy: 0, anchor: label.anchor },
  );
});

Deno.test("a label that would be pulled onto its own band slides round its sector", () => {
  // Straight down, as Stroke sits under the radar's default selection: the
  // box hangs off the bottom of the plate, and pulling it up puts it on the
  // band. The slide keeps the radius and re-anchors to the side it lands on.
  const label = labelAt("P2", 183.33);
  const base = {
    x: label.point.x - 26,
    y: label.point.y - 8,
    width: 52,
    height: 21,
  };
  const sectors = [sectorAt("P2", 140, 226.67)];
  const pulled = { ...base, y: CANVAS.height - PLATE_MARGIN - base.height };
  assert(!insidePlate(base));
  assert(nearestRadius(pulled) < BAND_OUTER, "the pull would land on the band");

  const shift = placePopulationLabel(label, base, 44, sectors)!;
  assertEquals(shift.anchor, "end");
  const box = shifted(label, base, 44, shift);
  assert(insidePlate(box), "the slid label is on the plate");
  assert(nearestRadius(box) > BAND_OUTER, "and clear of the band");
  // Same radius: a slide is tangential, never radial.
  assertAlmostEquals(
    Math.hypot(
      label.point.x + shift.dx - CENTER.x,
      label.point.y + shift.dy - CENTER.y,
    ),
    LABEL_RADIUS,
    1e-9,
  );
  // Idempotent: re-placing the same base reaches the same answer.
  assertEquals(placePopulationLabel(label, base, 44, sectors), shift);
});

Deno.test("a label with no angle to slide to keeps the straight pull", () => {
  const label = labelAt("P2", 183.33);
  const base = {
    x: label.point.x - 26,
    y: label.point.y - 8,
    width: 52,
    height: 21,
  };
  const straight = {
    dx: 0,
    dy: CANVAS.height - PLATE_MARGIN - (base.y + base.height),
    anchor: label.anchor,
  };
  // A sector too narrow to walk out of, and a label whose sector is not in
  // the layout at all: both fall back to the pull rather than to nothing.
  assertEquals(
    placePopulationLabel(label, base, 44, [sectorAt("P2", 183, 183.66)]),
    straight,
  );
  assertEquals(
    placePopulationLabel(label, base, 44, [sectorAt("P1", 0, 46)]),
    straight,
  );
});
