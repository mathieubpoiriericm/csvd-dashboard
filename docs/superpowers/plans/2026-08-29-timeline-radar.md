# Trials Timeline Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw the trials radar (population sectors × phase rings × labelled
drug markers) as an in-app SVG island fed by `data/table2.json`, and add a
pyCirclize script that draws the same figure for print from the same data and
the same shared encoding file.

**Architecture:** One committed encoding file (`lib/timeline_encoding.json`)
holds every styling decision — population order and colours, ring radii and
opacities, the mechanism palette, the genetic-evidence fills. `lib/timeline.ts`
(TypeScript) and `scripts/timeline_figure.py` (Python) each implement the same
~30-line layout rule on top of it; a Deno test pins the encoding to the data.
The island renders SVG and measures label boxes with `getBBox()`; the Python
script renders with pyCirclize/matplotlib and measures with
`Text.get_window_extent()`. The static artifact, its generator, the sandboxed
iframe and the registry-ID drift test all go away.

**Tech Stack:** Deno 2 + Fresh 2 + Preact (islands), `@std/assert` unit tests,
Playwright e2e (npm-isolated under `e2e/`), Python 3.14 via `uv`, pyCirclize ≥
1.10.1 on matplotlib ≥ 3.10.

**Spec:** `docs/superpowers/specs/2026-08-29-timeline-radar-design.md`

## Global Constraints

- Angles are degrees, **clockwise from 12 o'clock**, in both languages.
  Cartesian: `x = cx + r·sin θ`, `y = cy − r·cos θ` (SVG y grows downward).
  pyCirclize uses the same convention (verified: deg 0 is top, deg 90 is right).
- Sector span ∝ **unique drug names** per population; markers within a cell at
  `(j+1)/(m+1)` of the sector span in **table order**; marker radius = ring
  midpoint ± `STAGGER_FRACTION = 0.18` × ring thickness, alternating from `−`
  for `j = 0`, only when the cell holds more than one marker.
- Ring radii in the encoding are **fractions of the outer radius**; the island
  uses outer radius 320 on a `0 0 960 800` viewBox centred at (500, 400); the
  Python figure uses pyCirclize's 0–100 scale.
- Committed data pins: 16 trials, 4 populations (`CAA`,
  `Cognitive
  Impairment`, `Stroke`, `SVD`), unique drugs 3/1/5/3 → spans
  90°/30°/150°/90°, 7 filled cells, 5 empty cells: (CAA, I), (Cognitive
  Impairment, II), (Cognitive Impairment, I), (Stroke, I), (SVD, III). 11
  mechanisms.
- No colour literal and no palette-tier token in a CSS rule
  (`tests/styles_contract_test.ts`); data colours are SVG **attributes** from
  the encoding, never CSS. Every declared `--svd-` token must be used.
- No `as any`. Kebab-case SVG attributes in JSX (`text-anchor`, `fill-opacity`,
  `stroke-width`) — Preact sets camelCase names verbatim and SVG attribute names
  are case-sensitive.
- `deno task check` = `deno fmt --check . && deno lint . && deno check`; run
  `deno fmt` on every file you touch (including `.json` and `.md`).
- Python: ruff line length 88, target py314, rules `E F I UP B SIM`; tests
  import as `from scripts.timeline_figure import …` (repo root on `sys.path` via
  `pyproject.toml`). Pre-existing ruff/ty findings in `pipeline/` are **not** in
  scope — check only the new files.
- Do not touch `data/*.json`, `data-prep/`, `pipeline/`, or the two dated specs
  under `docs/superpowers/specs/` that belong to the pipeline work.
- Commit after every task; never on `main` (the branch is `timeline-radar`).
  Commit trailer per repo rule:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

| File                                                                                                        | Responsibility                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `lib/timeline_encoding.json`                                                                                | **Create.** The only styling truth shared by both renderers.                                      |
| `tests/timeline_encoding_test.ts`                                                                           | **Create.** Pins the encoding to `data/table2.json`; distinct valid colours; contiguous rings.    |
| `lib/timeline.ts`                                                                                           | **Create.** Pure, DOM-free layout: types, geometry helpers, `computeTimelineLayout`.              |
| `tests/timeline_layout_test.ts`                                                                             | **Create.** Geometry and layout rule against the committed data.                                  |
| `islands/TrialsTimeline.tsx`                                                                                | **Create.** SVG render, label measurement, tooltip, drawer, keyboard/ARIA.                        |
| `routes/timeline.tsx`                                                                                       | **Modify.** `Page` + tips + island instead of `EmbedPage`.                                        |
| `assets/app.css`                                                                                            | **Modify.** One `--svd-figure-ink` token; a `/* === TRIALS TIMELINE === */` section.              |
| `e2e/tests/timeline.spec.ts`                                                                                | **Create.** Replaces the timeline block of `embeds.spec.ts` and all of `timeline-layout.spec.ts`. |
| `e2e/tests/embeds.spec.ts`, `e2e/tests/theme.spec.ts`                                                       | **Modify.** Drop the timeline iframe cases.                                                       |
| `static/timeline.html`, `static/timeline.js`, `scripts/python_plot.py`, `e2e/tests/timeline-layout.spec.ts` | **Delete.**                                                                                       |
| `deno.json`                                                                                                 | **Modify.** Drop the `static/timeline.js` exclude; add the `figure` task.                         |
| `scripts/timeline_figure.py`                                                                                | **Create.** pyCirclize print renderer (layout twin + drawing + CLI).                              |
| `tests/scripts/test_timeline_figure.py`                                                                     | **Create.** Layout pins (same numbers as the TS test) + render smoke test.                        |
| `pyproject.toml`, `uv.lock`, `.gitignore`                                                                   | **Modify.** `figure` dependency group; ignore `figures/`.                                         |
| `CLAUDE.md`, `README.md`                                                                                    | **Modify.** Islands list, embed paragraphs, new Timeline section, figure task.                    |

---

### Task 1: Shared encoding + contract test

**Files:**

- Create: `lib/timeline_encoding.json`
- Test: `tests/timeline_encoding_test.ts`

**Interfaces:**

- Produces: the JSON shape below, imported by `lib/timeline.ts` (Task 2) and
  read by `scripts/timeline_figure.py` (Task 5). Keys are the raw data values
  from `data/table2.json` (`svdPopulation`, `clinicalTrialPhase`,
  `mechanismOfAction`, `geneticEvidence`), trimmed.

- [x] **Step 1: Write the failing test**

```ts
// tests/timeline_encoding_test.ts
import { assert, assertEquals } from "@std/assert";

import encoding from "../lib/timeline_encoding.json" with { type: "json" };
import { trials } from "../lib/data.ts";

/**
 * `lib/timeline_encoding.json` is read by two renderers — `lib/timeline.ts`
 * for the island and `scripts/timeline_figure.py` for print — so it is the
 * one place a new mechanism, population or phase has to be given a colour.
 * These assertions make the committed data and the encoding fail together.
 */

const HEX = /^#[0-9a-f]{6}$/;

const unique = <T>(values: readonly T[]) => new Set(values);

Deno.test("every population in the data has an encoding entry, in a fixed order", () => {
  const keys = encoding.populations.map((p) => p.key);
  assertEquals(keys, ["CAA", "Cognitive Impairment", "Stroke", "SVD"]);
  assertEquals(unique(keys).size, keys.length, "population keys repeat");

  const missing = [...unique(trials.map((t) => t.svdPopulation))]
    .filter((key) => !keys.includes(key));
  assertEquals(missing, [], `populations without an encoding: ${missing}`);

  for (const population of encoding.populations) {
    assert(population.label.length > 0, `${population.key} has no label`);
    assert(HEX.test(population.color), `${population.key}: bad color`);
    assert(HEX.test(population.ink), `${population.key}: bad ink`);
  }
});

Deno.test("every phase in the data has a ring, and the rings tile 0..1", () => {
  const phases = encoding.rings.map((r) => r.phase);
  assertEquals(phases, ["III", "II", "I"]);

  const missing = [...unique(trials.map((t) => t.clinicalTrialPhase))]
    .filter((phase) => !phases.includes(phase));
  assertEquals(missing, [], `phases without a ring: ${missing}`);

  assertEquals(encoding.rings[0].innerRadius, 0);
  assertEquals(encoding.rings.at(-1)?.outerRadius, 1);
  for (let i = 0; i < encoding.rings.length; i++) {
    const ring = encoding.rings[i];
    assert(ring.outerRadius > ring.innerRadius, `${ring.phase}: empty ring`);
    assert(ring.opacity > 0 && ring.opacity <= 1, `${ring.phase}: opacity`);
    if (i > 0) {
      assertEquals(
        ring.innerRadius,
        encoding.rings[i - 1].outerRadius,
        `${ring.phase} does not start where ${
          encoding.rings[i - 1].phase
        } ends`,
      );
    }
  }
});

Deno.test("every mechanism in the data has its own distinct colour", () => {
  const colours = encoding.mechanisms as Record<string, string>;
  const missing = [...unique(trials.map((t) => t.mechanismOfAction))]
    .filter((mechanism) => !(mechanism in colours));
  assertEquals(missing, [], `mechanisms without a colour: ${missing}`);

  const values = Object.values(colours);
  for (const value of values) assert(HEX.test(value), `bad colour ${value}`);
  assertEquals(
    unique(values.map((v) => v.toLowerCase())).size,
    values.length,
    "two mechanisms share a colour",
  );
});

Deno.test("genetic evidence values and the empty-cell style are encoded", () => {
  const fills = encoding.geneticEvidenceFill as Record<string, string>;
  const missing = [...unique(trials.map((t) => t.geneticEvidence))]
    .filter((value) => !(value in fills));
  assertEquals(missing, [], `evidence values without a fill: ${missing}`);
  for (const value of Object.values(fills)) assert(HEX.test(value));

  assert(HEX.test(encoding.emptyCell.color));
  assert(encoding.emptyCell.opacity > 0 && encoding.emptyCell.opacity < 1);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `deno test -A tests/timeline_encoding_test.ts` Expected: FAIL — module not
found `../lib/timeline_encoding.json`.

- [x] **Step 3: Write the encoding file**

The eleven mechanism strings are the exact, trimmed `mechanismOfAction` values
in table order. Reconfirm with
`python3 -c "import json;print(sorted({r['mechanismOfAction'].strip() for r in json.load(open('data/table2.json'))}))"`
before committing.

```json
{
  "populations": [
    { "key": "CAA", "label": ["CAA"], "color": "#440154", "ink": "#ffffff" },
    {
      "key": "Cognitive Impairment",
      "label": ["Cognitive", "Impairment"],
      "color": "#31688e",
      "ink": "#ffffff"
    },
    {
      "key": "Stroke",
      "label": ["Stroke"],
      "color": "#35b779",
      "ink": "#000000"
    },
    {
      "key": "SVD",
      "label": ["Any SVD", "(including monogenic)"],
      "color": "#fde725",
      "ink": "#000000"
    }
  ],
  "rings": [
    { "phase": "III", "innerRadius": 0, "outerRadius": 0.5625, "opacity": 1 },
    {
      "phase": "II",
      "innerRadius": 0.5625,
      "outerRadius": 0.78125,
      "opacity": 0.6
    },
    { "phase": "I", "innerRadius": 0.78125, "outerRadius": 1, "opacity": 0.35 }
  ],
  "emptyCell": { "color": "#c8c8c8", "opacity": 0.4 },
  "geneticEvidenceFill": { "Yes": "#90ee90", "No": "#ffffff" },
  "mechanisms": {
    "Neuroprotective, antioxidant (multiple mechanisms)": "#e41a1c",
    "Neuroprotective, neurotrophic (neuropeptide drug)": "#377eb8",
    "Antiplatelet, vasodilator (phosphodiesterase 3 inhibitor)": "#4daf4a",
    "Anti-inflammatory (tubulin beta chain inhibitor)": "#984ea3",
    "Neuroprotective, antioxidant (free radical scavenger)": "#ff7f00",
    "Blood glucose lowering agent (GLP-1 agonist)": "#d4a017",
    "Vasodilator (nitrate)": "#a65628",
    "APP mRNA reduction (RNA interference therapy)": "#f781bf",
    "Neuroprotective, antioxidant (vitamin E analogs)": "#999999",
    "Anti-fibrin (humanized monoclonal antibody)": "#17becf",
    "Antifibrinolytic (plasminogen inhibitor)": "#1a1a1a"
  }
}
```

Ring fractions are 180/320, 250/320 and 320/320 — the radii the old script used.
The two former duplicates (_Anti-fibrin_, _Antifibrinolytic_) now get cyan and
near-black; `#ffff33` (unreadable on the light plate) becomes `#d4a017`. Every
marker also gets a white stroke in both renderers, so the dark colours stay
separable on the dark purple wedge.

- [x] **Step 4: Run the test to verify it passes**

Run:
`deno fmt lib/timeline_encoding.json tests/timeline_encoding_test.ts && deno test -A tests/timeline_encoding_test.ts`
Expected: 4 passed.

- [x] **Step 5: Commit**

```bash
git add lib/timeline_encoding.json tests/timeline_encoding_test.ts
git commit -m "Add the shared timeline encoding and pin it to the trials data"
```

---

### Task 2: Pure layout module

**Files:**

- Create: `lib/timeline.ts`
- Test: `tests/timeline_layout_test.ts`

**Interfaces:**

- Consumes: `encoding` JSON (Task 1); `trials` and `Trial` from `lib/data.ts` /
  `lib/types.ts`.
- Produces (used verbatim by the island in Task 3):

```ts
export const CANVAS: { width: 960; height: 800 };
export const CENTER: { x: 500; y: 400 };
export const OUTER_RADIUS = 320;
export const MARKER_RADIUS = 9;
export const LABEL_GAP = 10;
export const STAGGER_FRACTION = 0.18;
export interface Point {
  x: number;
  y: number;
}
export type Anchor = "start" | "middle" | "end";
export interface Sector {
  key: string;
  label: string[];
  color: string;
  ink: string;
  startDeg: number;
  endDeg: number;
  drugCount: number;
}
export interface Cell {
  population: string;
  phase: string;
  path: string;
  color: string;
  opacity: number;
  filled: boolean;
}
export interface Marker {
  index: number;
  trial: Trial;
  population: string;
  populationLabel: string;
  phase: string;
  thetaDeg: number;
  r: number;
  point: Point;
  color: string;
  labelFill: string;
  anchor: "start" | "end";
  labelPoint: Point;
}
export interface PopulationLabel {
  key: string;
  lines: string[];
  point: Point;
  anchor: Anchor;
  color: string;
  ink: string;
}
export interface PhaseLabel {
  phase: string;
  point: Point;
}
export interface LegendEntry {
  label: string;
  color: string;
}
export interface TimelineLayout {
  sectors: Sector[];
  cells: Cell[];
  markers: Marker[];
  populationLabels: PopulationLabel[];
  phaseLabels: PhaseLabel[];
  mechanismLegend: LegendEntry[];
  evidenceLegend: LegendEntry[];
}
export function polarToPoint(thetaDeg: number, r: number): Point;
export function annularSectorPath(
  rInner: number,
  rOuter: number,
  theta0Deg: number,
  theta1Deg: number,
): string;
export function stagger(j: number, m: number, ringThickness: number): number;
export function computeTimelineLayout(
  rows: readonly Trial[],
  enc?: TimelineEncoding,
): TimelineLayout;
```

- [x] **Step 1: Write the failing tests**

```ts
// tests/timeline_layout_test.ts
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { trials } from "../lib/data.ts";
import {
  annularSectorPath,
  CENTER,
  computeTimelineLayout,
  encoding,
  MARKER_RADIUS,
  OUTER_RADIUS,
  polarToPoint,
  stagger,
} from "../lib/timeline.ts";

const layout = computeTimelineLayout(trials);

/** Empty cells on the committed data — the Python test pins the same list. */
const EMPTY_CELLS = [
  ["CAA", "I"],
  ["Cognitive Impairment", "II"],
  ["Cognitive Impairment", "I"],
  ["Stroke", "I"],
  ["SVD", "III"],
];

Deno.test("polar angles run clockwise from 12 o'clock", () => {
  assertEquals(polarToPoint(0, OUTER_RADIUS), { x: 500, y: 80 });
  const right = polarToPoint(90, OUTER_RADIUS);
  assertAlmostEquals(right.x, 820, 1e-9);
  assertAlmostEquals(right.y, 400, 1e-9);
  const bottom = polarToPoint(180, OUTER_RADIUS);
  assertAlmostEquals(bottom.x, 500, 1e-9);
  assertAlmostEquals(bottom.y, 720, 1e-9);
});

Deno.test("a wedge from the centre and an annular sector produce the old paths", () => {
  // Byte-identical to what scripts/python_plot.py emitted for CAA.
  assertEquals(
    annularSectorPath(0, 180, 0, 90),
    "M 500.00 400.00 L 500.00 220.00 A 180.00 180.00 0 0 1 680.00 400.00 Z",
  );
  assertEquals(
    annularSectorPath(180, 250, 0, 90),
    "M 500.00 150.00 A 250.00 250.00 0 0 1 750.00 400.00 L 680.00 400.00 A 180.00 180.00 0 0 0 500.00 220.00 Z",
  );
  // Past a half turn the large-arc flag flips.
  assert(annularSectorPath(0, 100, 0, 200).includes(" 0 1 1 "));
});

Deno.test("sector spans are proportional to unique drugs and sum to a full turn", () => {
  assertEquals(layout.sectors.map((s) => s.key), [
    "CAA",
    "Cognitive Impairment",
    "Stroke",
    "SVD",
  ]);
  assertEquals(layout.sectors.map((s) => s.drugCount), [3, 1, 5, 3]);
  assertEquals(layout.sectors[0].startDeg, 0);
  assertAlmostEquals(layout.sectors[0].endDeg, 90, 1e-9);
  assertAlmostEquals(
    layout.sectors[2].endDeg - layout.sectors[2].startDeg,
    150,
    1e-9,
  );
  assertAlmostEquals(layout.sectors.at(-1)!.endDeg, 360, 1e-9);
  for (let i = 1; i < layout.sectors.length; i++) {
    assertEquals(layout.sectors[i].startDeg, layout.sectors[i - 1].endDeg);
  }
});

Deno.test("twelve cells; empty ones are greyed exactly where no trial exists", () => {
  assertEquals(layout.cells.length, 12);
  const empty = layout.cells.filter((c) => !c.filled)
    .map((c) => [c.population, c.phase]);
  assertEquals(empty, EMPTY_CELLS);
  for (const cell of layout.cells) {
    const expected = cell.filled
      ? encoding.populations.find((p) => p.key === cell.population)!.color
      : encoding.emptyCell.color;
    assertEquals(cell.color, expected, `${cell.population}/${cell.phase}`);
    assert(cell.path.startsWith("M "), "cell has no path");
  }
});

Deno.test("sixteen markers sit inside their own cell, coloured by mechanism", () => {
  assertEquals(layout.markers.length, 16);
  assertEquals(layout.markers.map((m) => m.index), [...Array(16).keys()]);
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
      (encoding.mechanisms as Record<string, string>)[
        marker.trial.mechanismOfAction
      ],
    );
    assertEquals(
      marker.labelFill,
      (encoding.geneticEvidenceFill as Record<string, string>)[
        marker.trial.geneticEvidence
      ],
    );
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

  const cilostazol = layout.markers.filter((m) =>
    m.population === "Cognitive Impairment" && m.phase === "III"
  );
  assertEquals(cilostazol.length, 2);
  assert(cilostazol[0].r < cilostazol[1].r);
  assertAlmostEquals(cilostazol[1].r - cilostazol[0].r, 2 * 0.18 * 180, 1e-9);
});

Deno.test("population labels sit just outside the rim on the outward side", () => {
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
  for (const label of layout.populationLabels) {
    const dx = label.point.x - CENTER.x;
    const dy = label.point.y - CENTER.y;
    assertAlmostEquals(Math.hypot(dx, dy), OUTER_RADIUS + 24, 1e-9);
  }
});

Deno.test("phase labels stack on the 12 o'clock boundary at ring midpoints", () => {
  assertEquals(layout.phaseLabels.map((l) => l.phase), ["III", "II", "I"]);
  assertEquals(layout.phaseLabels.map((l) => l.point), [
    { x: 500, y: 310 },
    { x: 500, y: 185 },
    { x: 500, y: 115 },
  ]);
});

Deno.test("legends list every mechanism once, in table order, plus Yes/No", () => {
  assertEquals(layout.mechanismLegend.length, 11);
  assertEquals(
    layout.mechanismLegend[0].label,
    "Neuroprotective, antioxidant (multiple mechanisms)",
  );
  assertEquals(
    new Set(layout.mechanismLegend.map((e) => e.color)).size,
    11,
  );
  assertEquals(layout.evidenceLegend.map((e) => e.label), ["Yes", "No"]);
});

Deno.test("a population with no trials still gets its sector and grey cells", () => {
  const stroke = trials.filter((t) => t.svdPopulation === "Stroke");
  const partial = computeTimelineLayout(stroke);
  assertEquals(partial.sectors.length, 4);
  assertEquals(partial.sectors.filter((s) => s.drugCount === 0).length, 3);
  assertEquals(partial.cells.filter((c) => c.filled).length, 2);
  assertEquals(partial.markers.length, stroke.length);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `deno test -A tests/timeline_layout_test.ts` Expected: FAIL — module not
found `../lib/timeline.ts`.

- [x] **Step 3: Write the layout module**

```ts
// lib/timeline.ts
/**
 * Layout for the trials radar: population sectors × phase rings × drug
 * markers. Pure functions over `Trial` rows; no DOM, so the same code runs on
 * the server, in the island, and under `deno test`.
 *
 * `scripts/timeline_figure.py` implements this rule a second time for print.
 * Both read `timeline_encoding.json`, which is the only place colours, ring
 * radii and population order live — keep the *rule* here in step with the
 * Python twin (same names, same constants) if either changes.
 *
 * Angles are degrees clockwise from 12 o'clock. Cartesian conversion uses
 * `x = cx + r·sin θ`, `y = cy − r·cos θ`, so θ = 0 is straight up on an
 * SVG canvas whose y axis points down. pyCirclize shares this convention.
 */

import encodingJson from "./timeline_encoding.json" with { type: "json" };
import type { Trial } from "./types.ts";

export interface PopulationEncoding {
  key: string;
  label: string[];
  color: string;
  ink: string;
}

export interface RingEncoding {
  phase: string;
  innerRadius: number;
  outerRadius: number;
  opacity: number;
}

export interface TimelineEncoding {
  populations: PopulationEncoding[];
  rings: RingEncoding[];
  emptyCell: { color: string; opacity: number };
  geneticEvidenceFill: Record<string, string>;
  mechanisms: Record<string, string>;
}

export const encoding: TimelineEncoding = encodingJson;

/** SVG user units. Same centre and radius as the retired static figure. */
export const CANVAS = { width: 960, height: 800 } as const;
export const CENTER = { x: 500, y: 400 } as const;
export const OUTER_RADIUS = 320;
export const MARKER_RADIUS = 9;
/** Gap between a marker's edge and the start of its label. */
export const LABEL_GAP = 10;
/** Alternate marker radii by this fraction of the ring thickness. */
export const STAGGER_FRACTION = 0.18;
/** How far beyond the rim population labels are anchored. */
export const POPULATION_LABEL_OFFSET = 24;
/** |sin θ| below this, a population label is centred rather than side-anchored. */
const SIDE_THRESHOLD = 0.2;

export interface Point {
  x: number;
  y: number;
}

export type Anchor = "start" | "middle" | "end";

export interface Sector {
  key: string;
  label: string[];
  color: string;
  ink: string;
  startDeg: number;
  endDeg: number;
  drugCount: number;
}

export interface Cell {
  population: string;
  phase: string;
  path: string;
  color: string;
  opacity: number;
  filled: boolean;
}

export interface Marker {
  index: number;
  trial: Trial;
  population: string;
  populationLabel: string;
  phase: string;
  thetaDeg: number;
  r: number;
  point: Point;
  color: string;
  labelFill: string;
  anchor: "start" | "end";
  labelPoint: Point;
}

export interface PopulationLabel {
  key: string;
  lines: string[];
  point: Point;
  anchor: Anchor;
  color: string;
  ink: string;
}

export interface PhaseLabel {
  phase: string;
  point: Point;
}

export interface LegendEntry {
  label: string;
  color: string;
}

export interface TimelineLayout {
  sectors: Sector[];
  cells: Cell[];
  markers: Marker[];
  populationLabels: PopulationLabel[];
  phaseLabels: PhaseLabel[];
  mechanismLegend: LegendEntry[];
  evidenceLegend: LegendEntry[];
}

const toRadians = (deg: number) => (deg * Math.PI) / 180;

export function polarToPoint(thetaDeg: number, r: number): Point {
  const rad = toRadians(thetaDeg);
  return { x: CENTER.x + r * Math.sin(rad), y: CENTER.y - r * Math.cos(rad) };
}

const fixed = (n: number) => n.toFixed(2);
const at = (p: Point) => `${fixed(p.x)} ${fixed(p.y)}`;

/**
 * SVG path for the annular sector between two angles. With `rInner` at zero it
 * degenerates to a wedge from the centre. Ported from the retired generator's
 * `annular_sector_path`, whose output the layout test pins byte for byte.
 */
export function annularSectorPath(
  rInner: number,
  rOuter: number,
  theta0Deg: number,
  theta1Deg: number,
): string {
  const largeArc = theta1Deg - theta0Deg > 180 ? 1 : 0;
  const outer0 = polarToPoint(theta0Deg, rOuter);
  const outer1 = polarToPoint(theta1Deg, rOuter);
  const arc = (r: number, sweep: 0 | 1, to: Point) =>
    `A ${fixed(r)} ${fixed(r)} 0 ${largeArc} ${sweep} ${at(to)}`;

  if (rInner <= 0) {
    return `M ${at(CENTER)} L ${at(outer0)} ${arc(rOuter, 1, outer1)} Z`;
  }
  const inner1 = polarToPoint(theta1Deg, rInner);
  const inner0 = polarToPoint(theta0Deg, rInner);
  return `M ${at(outer0)} ${arc(rOuter, 1, outer1)} L ${at(inner1)} ${
    arc(rInner, 0, inner0)
  } Z`;
}

/** Radial offset for the j-th of m markers in one cell; zero for a lone marker. */
export function stagger(j: number, m: number, ringThickness: number): number {
  if (m < 2) return 0;
  return (j % 2 === 0 ? -1 : 1) * STAGGER_FRACTION * ringThickness;
}

const uniqueDrugCount = (rows: readonly Trial[]) =>
  new Set(rows.map((row) => row.drug)).size;

export function computeTimelineLayout(
  rows: readonly Trial[],
  enc: TimelineEncoding = encoding,
): TimelineLayout {
  const rowsByPopulation = new Map(
    enc.populations.map((p) => [
      p.key,
      rows.filter((row) => row.svdPopulation === p.key),
    ]),
  );

  const counts = enc.populations.map((p) =>
    uniqueDrugCount(rowsByPopulation.get(p.key) ?? [])
  );
  const total = counts.reduce((sum, n) => sum + n, 0) || 1;

  let cursor = 0;
  const sectors: Sector[] = enc.populations.map((p, i) => {
    const startDeg = cursor;
    cursor += (counts[i] / total) * 360;
    return {
      key: p.key,
      label: p.label,
      color: p.color,
      ink: p.ink,
      startDeg,
      endDeg: cursor,
      drugCount: counts[i],
    };
  });

  const cells: Cell[] = [];
  const markers: Marker[] = [];

  for (const sector of sectors) {
    const populationRows = rowsByPopulation.get(sector.key) ?? [];
    for (const ring of enc.rings) {
      const inCell = populationRows.filter((row) =>
        row.clinicalTrialPhase === ring.phase
      );
      const filled = inCell.length > 0;
      cells.push({
        population: sector.key,
        phase: ring.phase,
        path: annularSectorPath(
          ring.innerRadius * OUTER_RADIUS,
          ring.outerRadius * OUTER_RADIUS,
          sector.startDeg,
          sector.endDeg,
        ),
        color: filled ? sector.color : enc.emptyCell.color,
        opacity: filled ? ring.opacity : enc.emptyCell.opacity,
        filled,
      });

      const thickness = (ring.outerRadius - ring.innerRadius) * OUTER_RADIUS;
      const midRadius = ((ring.innerRadius + ring.outerRadius) / 2) *
        OUTER_RADIUS;
      inCell.forEach((trial, j) => {
        const fraction = (j + 1) / (inCell.length + 1);
        const thetaDeg = sector.startDeg +
          fraction * (sector.endDeg - sector.startDeg);
        const r = midRadius + stagger(j, inCell.length, thickness);
        const point = polarToPoint(thetaDeg, r);
        const anchor = point.x >= CENTER.x ? "start" : "end";
        const dx = (MARKER_RADIUS + LABEL_GAP) * (anchor === "start" ? 1 : -1);
        markers.push({
          index: markers.length,
          trial,
          population: sector.key,
          populationLabel: sector.label.join(" "),
          phase: ring.phase,
          thetaDeg,
          r,
          point,
          color: enc.mechanisms[trial.mechanismOfAction] ?? "#888888",
          labelFill: enc.geneticEvidenceFill[trial.geneticEvidence] ??
            enc.geneticEvidenceFill.No,
          anchor,
          labelPoint: { x: point.x + dx, y: point.y },
        });
      });
    }
  }

  const populationLabels: PopulationLabel[] = sectors.map((sector) => {
    const midDeg = (sector.startDeg + sector.endDeg) / 2;
    const sine = Math.sin(toRadians(midDeg));
    const anchor: Anchor = sine > SIDE_THRESHOLD
      ? "start"
      : sine < -SIDE_THRESHOLD
      ? "end"
      : "middle";
    return {
      key: sector.key,
      lines: sector.label,
      point: polarToPoint(midDeg, OUTER_RADIUS + POPULATION_LABEL_OFFSET),
      anchor,
      color: sector.color,
      ink: sector.ink,
    };
  });

  const phaseLabels: PhaseLabel[] = enc.rings.map((ring) => ({
    phase: ring.phase,
    point: polarToPoint(
      sectors[0].startDeg,
      ((ring.innerRadius + ring.outerRadius) / 2) * OUTER_RADIUS,
    ),
  }));

  const mechanismLegend: LegendEntry[] = [];
  for (const row of rows) {
    if (mechanismLegend.some((e) => e.label === row.mechanismOfAction)) {
      continue;
    }
    mechanismLegend.push({
      label: row.mechanismOfAction,
      color: enc.mechanisms[row.mechanismOfAction] ?? "#888888",
    });
  }
  const evidenceLegend: LegendEntry[] = Object.entries(enc.geneticEvidenceFill)
    .map(([label, color]) => ({ label, color }));

  return {
    sectors,
    cells,
    markers,
    populationLabels,
    phaseLabels,
    mechanismLegend,
    evidenceLegend,
  };
}
```

`polarToPoint(0, 320)` must equal exactly `{ x: 500, y: 80 }`: `sin(0)` is
exactly 0 and `cos(0)` exactly 1, so it does. The phase-label test relies on
`sin(0) === 0` too.

- [x] **Step 4: Run the tests to verify they pass**

Run:
`deno fmt lib/timeline.ts tests/timeline_layout_test.ts && deno test -A tests/timeline_layout_test.ts tests/timeline_encoding_test.ts`
Expected: all pass. If `polarToPoint(180, …)` fails by 1e-14 that is fine — the
test uses `assertAlmostEquals` there; only the θ = 0 cases are exact.

- [x] **Step 5: Type-check and lint**

Run: `deno task check` Expected: the two pre-existing unformatted pipeline docs
may still be reported by `deno fmt --check` (see Global Constraints); nothing
else. `deno lint` and `deno check` clean.

- [x] **Step 6: Commit**

```bash
git add lib/timeline.ts tests/timeline_layout_test.ts
git commit -m "Add the pure timeline radar layout"
```

---

### Task 3: Swap the iframe for the island

**Files:**

- Create: `islands/TrialsTimeline.tsx`
- Create: `e2e/tests/timeline.spec.ts`
- Modify: `routes/timeline.tsx` (whole file)
- Modify: `assets/app.css` (one token in the light `:root` block; one new
  section before `/* === REDUCED MOTION === */`)
- Modify: `e2e/tests/embeds.spec.ts` (remove the `test.describe("timeline", …)`
  block and the `"the timeline's registry IDs match the trials table"` test;
  keep `/timeline.js` in the resources list until Task 4 deletes the file)
- Modify: `e2e/tests/theme.spec.ts` (remove the `/timeline` entry from the
  iframe loop and its `render-mask` branch)

**Interfaces:**

- Consumes: everything exported from `lib/timeline.ts` (Task 2); `trials` from
  `lib/data.ts`; `Trial` from `lib/types.ts`.
- Produces: DOM contract the e2e spec relies on —
  `svg.timeline-figure[viewBox="0 0 960 800"]`,
  `path.wedge[data-pop][data-phase]`, `g.pop-label[data-pop]`,
  `g.phase-label[data-phase]`,
  `g.drug[data-drug][data-pop][data-phase][role=button][tabindex=0][aria-controls=timeline-drawer][aria-expanded]`,
  each `g.drug` holding `circle.marker`, `rect.label-bg` and `text[data-label]`;
  `#timeline-drawer` (`hidden` + `inert` while closed) with
  `button[aria-label="Close trial details"]`;
  `.timeline-tooltip[role=tooltip][aria-hidden=true]` rendered only while
  hovering; `.timeline-legend-item` × 13.

- [x] **Step 1: Write the failing e2e spec**

```ts
// e2e/tests/timeline.spec.ts
import { expect, type Page, test } from "@playwright/test";

/**
 * The radar is drawn in-app by islands/TrialsTimeline.tsx. Label boxes are
 * fitted from getBBox() after the fonts settle, so anything that reads a box
 * polls rather than asserting once.
 */

const FIGURE = "svg.timeline-figure";

async function figureSettled(page: Page) {
  await page.goto("/timeline");
  await expect(page.locator(FIGURE)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("draws one group per trial, twelve cells, and both legends", async ({ page }) => {
  await figureSettled(page);
  const figure = page.locator(FIGURE);
  await expect(figure).toHaveAttribute("viewBox", "0 0 960 800");
  await expect(figure.locator("g.drug")).toHaveCount(16);
  await expect(figure.locator("path.wedge")).toHaveCount(12);
  await expect(figure.locator("g.pop-label")).toHaveCount(4);
  await expect(figure.locator("g.phase-label")).toHaveCount(3);
  await expect(page.locator(".timeline-legend-item")).toHaveCount(13);

  // Every legend swatch is a different colour — the old palette cycled 9
  // colours over 11 mechanisms.
  const swatches = await page.locator(".timeline-legend-dot").evaluateAll(
    (dots) => dots.map((dot) => getComputedStyle(dot).backgroundColor),
  );
  expect(new Set(swatches).size).toBe(11);
});

test("label boxes fit their text and no drug label touches a marker", async ({ page }) => {
  await figureSettled(page);
  await expect.poll(() =>
    page.evaluate(() => {
      const misfit: string[] = [];
      const touching: string[] = [];
      const overlapping: string[] = [];
      const boxes: Array<{ id: string; rect: DOMRect }> = [];

      for (const group of document.querySelectorAll("svg.timeline-figure g")) {
        const text = group.querySelector<SVGTextElement>("text[data-label]");
        const rect = group.querySelector<SVGRectElement>("rect.label-bg");
        if (!text || !rect) continue;
        const id = text.dataset.label ?? "?";
        const t = text.getBBox();
        const r = rect.getBBox();
        const fits = r.x <= t.x && r.y <= t.y &&
          r.x + r.width >= t.x + t.width && r.y + r.height >= t.y + t.height;
        if (!fits) misfit.push(id);
        boxes.push({ id, rect: rect.getBoundingClientRect() });
      }

      for (
        const drug of document.querySelectorAll("svg.timeline-figure g.drug")
      ) {
        const marker = drug.querySelector("circle.marker")!
          .getBoundingClientRect();
        const label = drug.querySelector("rect.label-bg")!
          .getBoundingClientRect();
        const apart = marker.right < label.left || marker.left > label.right ||
          marker.bottom < label.top || marker.top > label.bottom;
        if (!apart) touching.push(drug.getAttribute("data-drug") ?? "?");
      }

      const drugBoxes = boxes.filter((b) => b.id.startsWith("drug-"));
      for (let i = 0; i < drugBoxes.length; i++) {
        for (let j = i + 1; j < drugBoxes.length; j++) {
          const a = drugBoxes[i].rect;
          const b = drugBoxes[j].rect;
          const apart = a.right < b.left || a.left > b.right ||
            a.bottom < b.top || a.top > b.bottom;
          if (!apart) overlapping.push(`${drugBoxes[i].id}/${drugBoxes[j].id}`);
        }
      }
      return { misfit, touching, overlapping, boxes: boxes.length };
    })
  ).toEqual({ misfit: [], touching: [], overlapping: [], boxes: 23 });
});

test("the trial drawer has pointer and keyboard close controls", async ({ page }) => {
  await figureSettled(page);
  const drawer = page.locator("#timeline-drawer");
  await expect(drawer).toBeHidden();
  await expect(drawer).toHaveAttribute("inert", "");

  const trial = page.locator("g.drug").first();
  await expect(trial).toHaveAttribute("aria-expanded", "false");
  await trial.click();
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toHaveAttribute("inert", "");
  await expect(trial).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText(
    "Butylphthalide (NBP)",
  );
  await expect(drawer.locator("dt")).toHaveCount(11);

  const close = page.getByRole("button", { name: "Close trial details" });
  await expect(close).toBeFocused();
  await close.click();
  await expect(drawer).toBeHidden();
  await expect(drawer).toHaveAttribute("inert", "");
  await expect(trial).toBeFocused();
  await expect(trial).toHaveAttribute("aria-expanded", "false");

  await trial.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trial).toBeFocused();
});

test("trial details are keyboard accessible", async ({ page }) => {
  await figureSettled(page);
  const trial = page.getByRole("button", {
    name: "Cerebrolysin, Phase II, CAA",
  });
  await trial.focus();
  await page.keyboard.press("Enter");
  const drawer = page.locator("#timeline-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText(
    "Cerebrolysin",
  );
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await trial.focus();
  await page.keyboard.press(" ");
  await expect(drawer).toBeVisible();
});

test("hovering a trial shows its tooltip, and its children keep it open", async ({ page }) => {
  await figureSettled(page);
  const trial = page.locator('g.drug[data-drug="Cerebrolysin"]');
  await trial.locator("circle.marker").hover();
  const tooltip = page.locator(".timeline-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("aria-hidden", "true");
  await expect(tooltip).toContainText("Cerebrolysin");
  await expect(tooltip).toContainText("NCT05755997");

  await trial.locator("text").hover();
  await expect(tooltip).toBeVisible();

  await page.mouse.move(5, 5);
  await expect(tooltip).toHaveCount(0);
});

test("hovering a wedge names its population and phase", async ({ page }) => {
  await figureSettled(page);
  await page.locator('path.wedge[data-pop="Stroke"][data-phase="III"]').hover({
    position: { x: 40, y: 40 },
  });
  const tooltip = page.locator(".timeline-tooltip");
  await expect(tooltip).toContainText("Stroke");
  await expect(tooltip).toContainText("III");
});

test("the figure's data colours do not follow the theme", async ({ page }) => {
  await figureSettled(page);
  const wedge = page.locator('path.wedge[data-pop="CAA"][data-phase="III"]');
  const marker = page.locator("g.drug circle.marker").first();
  const before = {
    wedge: await wedge.getAttribute("fill"),
    marker: await marker.getAttribute("fill"),
    page: await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    ),
  };

  await page.getByRole("button", { name: /Switch to (dark|light) theme/ })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    /dark|light/,
  );
  await expect.poll(() =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ).not.toBe(before.page);

  await expect(wedge).toHaveAttribute("fill", before.wedge ?? "");
  await expect(marker).toHaveAttribute("fill", before.marker ?? "");
});
```

`boxes: 23` is 16 drug labels + 4 population labels + 3 phase labels.

- [x] **Step 2: Run the spec to verify it fails**

Run: `cd e2e && npx playwright test tests/timeline.spec.ts` Expected: FAIL —
`svg.timeline-figure` never becomes visible (the route still renders the
iframe).

- [x] **Step 3: Add the token and the stylesheet section**

In `assets/app.css`, inside the light `:root` token block, directly after the
line `--svd-tooltip-ink: var(--svd-white);` (around line 99), add:

```css
/* Ink for text drawn on fixed, data-coloured surfaces (figure label boxes,
   legend chips). Declared once, never overridden by the dark blocks: the
   boxes stay light in dark mode because their colours carry meaning. */
--svd-figure-ink: var(--svd-indigo-925);
```

Then insert this section immediately before `/* === REDUCED MOTION === */`:

```css
/* === TRIALS TIMELINE === */

/*
 * The radar is drawn in-app by islands/TrialsTimeline.tsx from lib/timeline.ts.
 * Everything that encodes data — wedge, marker and label-box colours — arrives
 * as SVG attributes from lib/timeline_encoding.json and is deliberately left
 * alone by the theme; these rules style only the chrome around it.
 */
.timeline-layout {
  display: flex;
  align-items: flex-start;
  gap: var(--svd-space-5);
}

.timeline-scroll {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  padding: var(--svd-space-4);
  background: var(--svd-bg-card);
  border-radius: var(--svd-radius-md);
  box-shadow: var(--svd-shadow-sm);
}

/* Native scale is the floor: below 960px the plate scrolls sideways inside its
   own container, as the retired iframe did. */
.timeline-figure {
  display: block;
  width: 100%;
  min-width: 960px;
  height: auto;
  font-family: var(--svd-font);
}

.timeline-figure .label-ink {
  fill: var(--svd-figure-ink);
}

.timeline-figure .drug {
  cursor: pointer;
}

.timeline-figure .drug:focus-visible {
  outline: var(--svd-focus-width) solid var(--svd-focus-color);
  outline-offset: var(--svd-focus-offset);
}

.timeline-legend {
  flex: 0 0 18rem;
  display: flex;
  flex-direction: column;
  gap: var(--svd-space-4);
}

.timeline-legend-panel {
  padding: var(--svd-space-4);
  background: var(--svd-bg-card);
  border-radius: var(--svd-radius-md);
  box-shadow: var(--svd-shadow-sm);
}

.timeline-legend-title {
  margin: 0 0 var(--svd-space-3);
  font-size: var(--svd-text-md);
}

.timeline-legend-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--svd-space-2);
  font-size: var(--svd-text-base);
}

.timeline-legend-item {
  display: flex;
  align-items: flex-start;
  gap: var(--svd-space-2);
}

.timeline-legend-dot {
  flex: none;
  width: 1rem;
  height: 1rem;
  margin-top: 0.15rem;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px var(--svd-line);
}

/* Chips carry the label-box fills, which are data colours, so their ink is
   fixed too. */
.timeline-legend-chip {
  display: inline-block;
  padding: 0.1rem 0.6rem;
  border-radius: var(--svd-radius-xs);
  color: var(--svd-figure-ink);
  box-shadow: inset 0 0 0 1px var(--svd-line);
}

.timeline-tooltip {
  position: fixed;
  z-index: var(--svd-z-sticky);
  pointer-events: none;
  width: max-content;
  max-width: 360px;
  padding: 12px 16px;
  background: var(--svd-tooltip-bg);
  color: var(--svd-tooltip-ink);
  font-size: var(--svd-text-base);
  line-height: 1.5;
  border-radius: var(--svd-radius-md);
  box-shadow: var(--svd-shadow-lg);
}

.timeline-tooltip-title {
  margin-bottom: var(--svd-space-2);
  font-weight: var(--svd-weight-semibold);
}

.timeline-drawer {
  flex: 0 0 20rem;
  position: sticky;
  top: var(--svd-space-4);
  padding: var(--svd-space-4);
  background: var(--svd-bg-card);
  border-radius: var(--svd-radius-md);
  box-shadow: var(--svd-shadow-md);
  font-size: var(--svd-text-base);
}

.timeline-drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--svd-space-3);
  margin-bottom: var(--svd-space-3);
}

.timeline-drawer-head h2 {
  margin: 0;
  font-size: var(--svd-text-md);
}

.timeline-drawer-close {
  flex: none;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--svd-border);
  border-radius: 50%;
  background: var(--svd-bg-light);
  color: var(--svd-text);
  font: inherit;
  font-size: var(--svd-text-xl);
  line-height: 1;
  cursor: pointer;
}

.timeline-drawer-fields {
  margin: 0;
  display: grid;
  gap: var(--svd-space-2);
}

.timeline-drawer-fields dt {
  font-weight: var(--svd-weight-semibold);
}

.timeline-drawer-fields dd {
  margin: 0;
}

@media (max-width: 1100px) {
  .timeline-layout {
    flex-direction: column;
  }

  .timeline-legend,
  .timeline-drawer {
    flex-basis: auto;
    width: 100%;
    position: static;
  }
}
```

Run: `deno fmt assets/app.css && deno test -A tests/styles_contract_test.ts`
Expected: pass (the new token is referenced twice; no literals; no palette token
outside the token region).

- [x] **Step 4: Write the island**

```tsx
// islands/TrialsTimeline.tsx
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { trials } from "../lib/data.ts";
import {
  type Anchor,
  CANVAS,
  CENTER,
  computeTimelineLayout,
  type Marker,
  MARKER_RADIUS,
  type Point,
} from "../lib/timeline.ts";
import type { Trial } from "../lib/types.ts";

/** Computed once at module load, on the server and in the browser alike. */
const LAYOUT = computeTimelineLayout(trials);
const SECTOR_BY_KEY = new Map(LAYOUT.sectors.map((s) => [s.key, s]));

const DRAWER_ID = "timeline-drawer";
const DRUG_FONT_SIZE = 12;
const POPULATION_FONT_SIZE = 18;
const PHASE_FONT_SIZE = 16;
const LINE_HEIGHT_EM = 1.2;
/** Radial push when a fitted drug label still touches its marker. */
const NUDGE = 10;
const MAX_NUDGE_PASSES = 3;
/**
 * Pre-hydration placeholder only. Every box is refitted from `getBBox()` as
 * soon as the island mounts, and again once the web font has loaded.
 */
const PLACEHOLDER_EM = 0.55;
const TOOLTIP_MARGIN = 10;
const TOOLTIP_CURSOR_GAP = 12;

const DRUG_PADDING = { x: 4, y: 2 };
const LABEL_PADDING = { x: 8, y: 4 };

const DRUG_FIELDS: ReadonlyArray<[keyof Trial, string]> = [
  ["mechanismOfAction", "Mechanism of Action"],
  ["geneticTarget", "Genetic Target"],
  ["geneticEvidence", "Genetic Evidence"],
  ["trialName", "Clinical Trial Name"],
  ["registryId", "Registry ID"],
  ["clinicalTrialPhase", "Clinical Trial Phase"],
  ["svdPopulationDetails", "SVD Population Details"],
  ["targetSampleSize", "Target Sample Size"],
  ["estimatedCompletionDate", "Estimated Completion Date"],
  ["primaryOutcome", "Primary Outcome"],
  ["sponsorType", "Sponsor Type"],
];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Padding {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface TooltipState {
  title: string;
  rows: ReadonlyArray<[string, string]>;
  x: number;
  y: number;
}

function placeholderBox(
  lines: readonly string[],
  fontSize: number,
  point: Point,
  anchor: Anchor,
): Box {
  const longest = Math.max(...lines.map((line) => line.length));
  const width = longest * fontSize * PLACEHOLDER_EM;
  const height = lines.length * fontSize * LINE_HEIGHT_EM;
  const x = anchor === "start"
    ? point.x
    : anchor === "end"
    ? point.x - width
    : point.x - width / 2;
  return { x, y: point.y - height / 2, width, height };
}

function padded(box: Box, pad: Padding): Box {
  return {
    x: box.x - pad.x,
    y: box.y - pad.y,
    width: box.width + pad.x * 2,
    height: box.height + pad.y * 2,
  };
}

/** Same test the retired timeline.js used: the marker's bounding square. */
function touchesMarker(box: Box, marker: Point): boolean {
  return marker.x + MARKER_RADIUS > box.x &&
    marker.x - MARKER_RADIUS < box.x + box.width &&
    marker.y + MARKER_RADIUS > box.y &&
    marker.y - MARKER_RADIUS < box.y + box.height;
}

/** The label anchor pushed `amount` units further from the centre. */
function nudgedLabelPoint(marker: Marker, amount: number): Point {
  if (!amount) return marker.labelPoint;
  const dx = marker.point.x - CENTER.x;
  const dy = marker.point.y - CENTER.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: marker.labelPoint.x + (dx / length) * amount,
    y: marker.labelPoint.y + (dy / length) * amount,
  };
}

/**
 * Clamp a fixed-position tooltip to the viewport: centred above the cursor
 * when that fits, otherwise beside it (never below — a panel under the cursor
 * would sit over what the pointer is about to move onto).
 */
export function placeTooltip(size: Size, cursor: Point, viewport: Size): Point {
  const margin = TOOLTIP_MARGIN;
  let x = cursor.x - size.width / 2;
  let y = cursor.y - size.height - TOOLTIP_CURSOR_GAP;

  if (y >= margin) {
    x = Math.min(Math.max(x, margin), viewport.width - size.width - margin);
    return { x, y };
  }

  x = cursor.x + TOOLTIP_CURSOR_GAP;
  y = Math.min(
    Math.max(cursor.y - size.height / 2, margin),
    viewport.height - size.height - margin,
  );
  if (x + size.width > viewport.width - margin) {
    x = Math.max(cursor.x - size.width - TOOLTIP_CURSOR_GAP, margin);
  }
  return { x, y };
}

interface LabelBoxProps {
  id: string;
  lines: readonly string[];
  point: Point;
  anchor: Anchor;
  fontSize: number;
  fill: string;
  /** Explicit ink for data-coloured boxes; omitted, the ink token applies. */
  ink?: string;
  padding: Padding;
  measured: Box | undefined;
}

/**
 * A text label on a rounded box. The box is sized from the measured text, so
 * it fits whatever font the browser actually rendered — the reason the old
 * generator's glyph-width table could go.
 */
function LabelBox(
  { id, lines, point, anchor, fontSize, fill, ink, padding, measured }:
    LabelBoxProps,
) {
  const box = padded(
    measured ?? placeholderBox(lines, fontSize, point, anchor),
    padding,
  );
  const firstDy = 0.35 - (LINE_HEIGHT_EM * (lines.length - 1)) / 2;
  return (
    <>
      <rect
        class="label-bg"
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={6}
        fill={fill}
        pointer-events="none"
      />
      <text
        data-label={id}
        class={ink ? undefined : "label-ink"}
        x={point.x}
        y={point.y}
        font-size={fontSize}
        text-anchor={anchor}
        fill={ink}
      >
        {lines.map((line, i) => (
          <tspan
            key={i}
            x={point.x}
            dy={`${i === 0 ? firstDy : LINE_HEIGHT_EM}em`}
          >
            {line}
          </tspan>
        ))}
      </text>
    </>
  );
}

function drugTooltip(marker: Marker, x: number, y: number): TooltipState {
  return {
    title: marker.trial.drug,
    rows: DRUG_FIELDS.map(([key, label]) => [label, marker.trial[key]]),
    x,
    y,
  };
}

/**
 * The trials radar: population sectors × phase rings × one marker per trial.
 *
 * Replaces the sandboxed iframe around a pre-rendered SVG. The layout is
 * `lib/timeline.ts`; this island only renders it, fits the label boxes to the
 * text the browser actually drew, and carries the interaction the old
 * `static/timeline.js` had — pointer tooltips, a details drawer, and a
 * keyboard path through the marker groups.
 */
export default function TrialsTimeline() {
  const svgRef = useRef<SVGSVGElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const markerRefs = useRef<Array<SVGGElement | null>>([]);
  const nudgePasses = useRef(0);

  const [boxes, setBoxes] = useState<ReadonlyMap<string, Box>>(new Map());
  const [nudges, setNudges] = useState<ReadonlyMap<number, number>>(new Map());
  const [active, setActive] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [tooltipAt, setTooltipAt] = useState<Point | null>(null);

  const measure = () => {
    const svg = svgRef.current;
    if (!svg) return;

    const next = new Map<string, Box>();
    for (
      const text of svg.querySelectorAll<SVGTextElement>("text[data-label]")
    ) {
      let bbox: DOMRect;
      try {
        bbox = text.getBBox();
      } catch {
        continue;
      }
      if (bbox.width === 0) continue;
      next.set(text.dataset.label ?? "", {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
      });
    }
    setBoxes(next);

    if (nudgePasses.current >= MAX_NUDGE_PASSES) return;
    const pushed = new Map(nudges);
    for (const marker of LAYOUT.markers) {
      const box = next.get(`drug-${marker.index}`);
      if (box && touchesMarker(padded(box, DRUG_PADDING), marker.point)) {
        pushed.set(marker.index, (pushed.get(marker.index) ?? 0) + NUDGE);
      }
    }
    if (pushed.size !== nudges.size) {
      nudgePasses.current += 1;
      setNudges(pushed);
    }
  };

  // Fit once on mount and after every nudge; the nudge changes text positions,
  // which changes the boxes.
  useLayoutEffect(measure, [nudges]);

  // The web font arrives after first paint; fit again when it does.
  useEffect(() => {
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (cancelled) return;
      nudgePasses.current = 0;
      measure();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const drawer = drawerRef.current;
    if (drawer) drawer.inert = active === null;
    if (active !== null) closeRef.current?.focus({ preventScroll: true });
  }, [active]);

  const close = () => {
    const restore = active;
    setActive(null);
    if (restore !== null) {
      markerRefs.current[restore]?.focus({ preventScroll: true });
    }
  };

  useEffect(() => {
    if (active === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  useLayoutEffect(() => {
    const panel = tooltipRef.current;
    if (!tooltip || !panel) {
      setTooltipAt(null);
      return;
    }
    const rect = panel.getBoundingClientRect();
    setTooltipAt(placeTooltip(
      { width: rect.width, height: rect.height },
      { x: tooltip.x, y: tooltip.y },
      { width: globalThis.innerWidth, height: globalThis.innerHeight },
    ));
  }, [tooltip]);

  const follow = (event: PointerEvent) => {
    setTooltip((current) =>
      current ? { ...current, x: event.clientX, y: event.clientY } : current
    );
  };
  const hide = () => setTooltip(null);

  const activeMarker = active === null ? null : LAYOUT.markers[active];

  return (
    <div class="timeline-layout">
      <aside
        ref={drawerRef}
        id={DRAWER_ID}
        class="timeline-drawer"
        role="region"
        aria-label="Trial details"
        aria-live="polite"
        hidden={active === null}
      >
        {activeMarker && (
          <>
            <div class="timeline-drawer-head">
              <h2>{activeMarker.trial.drug}</h2>
              <button
                ref={closeRef}
                type="button"
                class="timeline-drawer-close"
                aria-label="Close trial details"
                onClick={close}
              >
                ×
              </button>
            </div>
            <dl class="timeline-drawer-fields">
              {DRUG_FIELDS.map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{activeMarker.trial[key]}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </aside>

      <div class="timeline-scroll">
        <svg
          ref={svgRef}
          class="timeline-figure"
          viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
          aria-labelledby="timeline-title timeline-desc"
        >
          <title id="timeline-title">
            Cerebral SVD clinical trials by population and phase
          </title>
          <desc id="timeline-desc">
            Rings are trial phases, Phase III innermost; sectors are target
            populations; each marker is one trial, coloured by mechanism of
            action. Activate a marker for the trial's details.
          </desc>

          {LAYOUT.cells.map((cell) => (
            <path
              key={`${cell.population}/${cell.phase}`}
              class="wedge"
              data-pop={cell.population}
              data-phase={cell.phase}
              d={cell.path}
              fill={cell.color}
              fill-opacity={cell.opacity}
              onPointerEnter={(event) =>
                setTooltip({
                  title: SECTOR_BY_KEY.get(cell.population)?.label.join(" ") ??
                    cell.population,
                  rows: [["Phase", cell.phase]],
                  x: event.clientX,
                  y: event.clientY,
                })}
              onPointerMove={follow}
              onPointerLeave={hide}
            />
          ))}

          {LAYOUT.phaseLabels.map((label) => (
            <g key={label.phase} class="phase-label" data-phase={label.phase}>
              <LabelBox
                id={`phase-${label.phase}`}
                lines={[`Phase ${label.phase}`]}
                point={label.point}
                anchor="middle"
                fontSize={PHASE_FONT_SIZE}
                fill="#ffffff"
                padding={LABEL_PADDING}
                measured={boxes.get(`phase-${label.phase}`)}
              />
            </g>
          ))}

          {LAYOUT.populationLabels.map((label) => (
            <g key={label.key} class="pop-label" data-pop={label.key}>
              <LabelBox
                id={`pop-${label.key}`}
                lines={label.lines}
                point={label.point}
                anchor={label.anchor}
                fontSize={POPULATION_FONT_SIZE}
                fill={label.color}
                ink={label.ink}
                padding={LABEL_PADDING}
                measured={boxes.get(`pop-${label.key}`)}
              />
            </g>
          ))}

          {LAYOUT.markers.map((marker) => (
            <g
              key={marker.index}
              ref={(element) => {
                markerRefs.current[marker.index] = element;
              }}
              class="drug"
              data-drug={marker.trial.drug}
              data-pop={marker.population}
              data-phase={marker.phase}
              tabIndex={0}
              role="button"
              aria-controls={DRAWER_ID}
              aria-expanded={active === marker.index}
              aria-label={`${marker.trial.drug}, Phase ${marker.phase}, ${marker.populationLabel}`}
              onClick={() => setActive(marker.index)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setActive(marker.index);
              }}
              onPointerEnter={(event) =>
                setTooltip(drugTooltip(marker, event.clientX, event.clientY))}
              onPointerMove={follow}
              onPointerLeave={hide}
            >
              <circle
                class="marker"
                cx={marker.point.x}
                cy={marker.point.y}
                r={MARKER_RADIUS}
                fill={marker.color}
                stroke="#ffffff"
                stroke-width={1.5}
              />
              <LabelBox
                id={`drug-${marker.index}`}
                lines={[marker.trial.drug]}
                point={nudgedLabelPoint(marker, nudges.get(marker.index) ?? 0)}
                anchor={marker.anchor}
                fontSize={DRUG_FONT_SIZE}
                fill={marker.labelFill}
                padding={DRUG_PADDING}
                measured={boxes.get(`drug-${marker.index}`)}
              />
            </g>
          ))}
        </svg>
      </div>

      <div class="timeline-legend">
        <section class="timeline-legend-panel">
          <h2 class="timeline-legend-title">Genetic evidence</h2>
          <ul class="timeline-legend-list">
            {LAYOUT.evidenceLegend.map((entry) => (
              <li key={entry.label} class="timeline-legend-item">
                <span
                  class="timeline-legend-chip"
                  style={{ background: entry.color }}
                >
                  {entry.label}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section class="timeline-legend-panel">
          <h2 class="timeline-legend-title">Mechanism of action</h2>
          <ul class="timeline-legend-list">
            {LAYOUT.mechanismLegend.map((entry) => (
              <li key={entry.label} class="timeline-legend-item">
                <span
                  class="timeline-legend-dot"
                  style={{ background: entry.color }}
                  aria-hidden="true"
                />
                {entry.label}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {tooltip && (
        <div
          ref={tooltipRef}
          class="timeline-tooltip"
          role="tooltip"
          aria-hidden="true"
          style={{
            left: `${tooltipAt?.x ?? 0}px`,
            top: `${tooltipAt?.y ?? 0}px`,
            visibility: tooltipAt ? "visible" : "hidden",
          }}
        >
          <div class="timeline-tooltip-title">{tooltip.title}</div>
          {tooltip.rows.map(([label, value]) => (
            <span key={label} class="tooltip-row">
              <strong>{label}</strong> {value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
```

Notes for the implementer:

- `document.fonts?.ready` — `FontFaceSet` is in Deno's DOM lib; if `deno check`
  rejects the optional chain, use
  `"fonts" in document ? document.fonts.ready : Promise.resolve()`.
- If the JSX types reject `inert` or `pointer-events` as attributes, keep
  `inert` in the effect (as written) and set `pointer-events` through the
  existing `.label-bg` selector in CSS instead (`pointer-events: none`).
- Pointer handler parameters are typed by Preact as targeted events; the
  `follow` helper's `PointerEvent` parameter is assignable to them.
- The kebab-case attributes (`fill-opacity`, `stroke-width`, `text-anchor`,
  `pointer-events`) are the supported spelling in Preact's SVG typings.

- [x] **Step 5: Replace the route**

```tsx
// routes/timeline.tsx
import { define } from "../utils.ts";
import TrialsTimeline from "../islands/TrialsTimeline.tsx";
import { TipBox } from "../components/TipBox.tsx";
import { Page } from "../components/Page.tsx";

/**
 * The trials radar, drawn in-app from data/table2.json. It replaced a
 * sandboxed iframe around a pre-rendered SVG that a Python script in the Shiny
 * pipeline used to generate; the print version of the same figure is
 * scripts/timeline_figure.py.
 */
export default define.page(function Timeline() {
  return (
    <Page
      title="Trials Timeline"
      description="Planned and ongoing cerebral SVD clinical trials, arranged by target population and trial phase."
    >
      <div class="tip-row">
        <TipBox>
          Hover over plot elements to display tooltips, or select a drug name or
          marker to open the trial details panel.
        </TipBox>
        <TipBox label="Visually-inspired by:">
          Fig. 1 in Cummings, J.{" "}
          <em>et al.</em>, Alzheimer's disease drug development pipeline: 2023,
          {" "}
          <em>Alzheimer's Dement.</em> (May 2023){" "}
          <a
            href="https://pubmed.ncbi.nlm.nih.gov/37251912/"
            target="_blank"
            rel="noopener noreferrer"
          >
            DOI: 10.1002/trc2.12385
          </a>
        </TipBox>
      </div>

      <TrialsTimeline />
    </Page>
  );
});
```

The `embed tips` e2e test pins the first tip's "trial details panel" text and
the citation's `strong` label and link — keep both boxes verbatim.

- [x] **Step 6: Type-check, lint, unit tests, build**

Run:
`deno fmt islands/TrialsTimeline.tsx routes/timeline.tsx && deno task check && deno task test && deno task build`
Expected: all clean; the build emits the new island. (The pre-existing
unformatted pipeline docs are the only tolerated `fmt --check` noise.)

- [x] **Step 7: Run the new spec**

Run: `cd e2e && npx playwright test tests/timeline.spec.ts` Expected: 7 passed.
If `label boxes fit their text …` reports `touching`, the nudge pass is not
reaching the marker in question — check that `measure` runs after the nudge (the
`useLayoutEffect` dependency is `[nudges]`). If it reports `overlapping`, the
stagger did not apply — compare `marker.r` values in `deno test` first.

- [x] **Step 8: Retire the iframe assertions**

In `e2e/tests/embeds.spec.ts`:

1. Delete the whole `test.describe("timeline", () => { … })` block.
2. Delete the `test("the timeline's registry IDs match the trials table", …)`
   test and its doc comment, and the now-unused `readFileSync`/`join` imports if
   nothing else uses them
   (`grep -n "readFileSync\|join(" e2e/tests/embeds.spec.ts`).
3. Delete `const TIMELINE = …`.
4. Rewrite the comment above the phenogram block so it no longer says "Both
   embeds": "The phenogram is derived from the Shiny app and is loaded with
   loading="lazy", so each test scrolls the frame into view before entering it."
5. In `test.describe("embed tips", …)` keep both tests; the timeline one still
   holds (the tips row stays on the page).
6. Leave `/timeline.js` in the resources test for now (Task 4 removes it with
   the file).

In `e2e/tests/theme.spec.ts`: remove
`["/timeline", 'iframe[title*="Timeline"]']` from the loop and delete the
`if (route === "/timeline") { … }` block; update the comment above the loop to
talk about "the phenogram frame" in the singular.

- [x] **Step 9: Run the whole e2e suite**

Run: `deno task test:e2e` Expected: all passed (128 − 10 removed timeline/iframe
cases + 7 new = 125). `runtime.spec.ts` must stay green on the 390px viewport:
the plate scrolls inside `.timeline-scroll`, so the document never overflows.

- [x] **Step 10: Commit**

```bash
git add islands/TrialsTimeline.tsx routes/timeline.tsx assets/app.css e2e/tests/timeline.spec.ts e2e/tests/embeds.spec.ts e2e/tests/theme.spec.ts
git commit -m "Draw the trials timeline in-app instead of embedding a static SVG"
```

---

### Task 4: Retire the static artifact and its generator

**Files:**

- Delete: `static/timeline.html`, `static/timeline.js`,
  `scripts/python_plot.py`, `e2e/tests/timeline-layout.spec.ts`
- Modify: `deno.json` (`exclude` list), `e2e/tests/embeds.spec.ts` (resources
  list), `CLAUDE.md`, `README.md`

**Interfaces:**

- Consumes: the island route from Task 3 (nothing else references the static
  files — verify with
  `grep -rn "timeline.html\|timeline.js\|python_plot" --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' . | grep -v node_modules | grep -v _fresh | grep -v docs/superpowers`).

- [x] **Step 1: Delete the files and the exclude entry**

```bash
git rm static/timeline.html static/timeline.js scripts/python_plot.py e2e/tests/timeline-layout.spec.ts
```

In `deno.json`, remove the line `"static/timeline.js",` from `exclude`, leaving
`"**/_fresh/*"`, `"static/phenogram.html"`, `"e2e"`.

In `e2e/tests/embeds.spec.ts`, remove `"/timeline.js",` from the array in
`test("standalone embed resources resolve", …)`.

- [x] **Step 2: Update CLAUDE.md**

Apply these four edits (exact old text → new text):

1. Under **Commands**, replace

   > The standalone static files excluded from fmt/lint/check in `deno.json` are
   > covered by browser tests instead; `timeline.js` can be syntax-checked with
   > `node --check`.

   with

   > The standalone `static/phenogram.html` is excluded from fmt/lint/check in
   > `deno.json` and covered by browser tests instead.

2. Under **Routes and islands**, change "Interactivity lives in five islands:"
   to "Interactivity lives in six islands:" and add, after the `TrialsMap`
   bullet:

   ```markdown
   - `islands/TrialsTimeline.tsx` — the trials radar: population sectors × phase
     rings × one marker per trial, drawn as SVG from `lib/timeline.ts`. See
     "Timeline" below.
   ```

   Then replace the paragraph beginning "`routes/phenogram.tsx` and
   `routes/timeline.tsx` differ only in their sandbox token…" with:

   ```markdown
   `routes/phenogram.tsx` renders `components/EmbedPage.tsx`, which points at
   `static/phenogram.html`. That artifact originated in the Shiny app; this repo
   maintains its accessibility and interaction wrapper. The timeline used to be a
   second such embed and is now drawn in-app.
   ```

3. Insert a new section between **### Map** and **### Tooltips and styling**:

   ```markdown
   ### Timeline

   `islands/TrialsTimeline.tsx` draws the trials radar — population sectors × phase
   rings × one marker per trial — from `data/table2.json`, the way every other
   island reads its data. It replaced a sandboxed iframe around an SVG that a
   Python script in the Shiny pipeline generated and that was then hand-hardened,
   so the two had drifted apart: the generator estimated glyph widths from a
   Raleway table while the artifact used Plex, cycled nine marker colours over
   eleven mechanisms, and could no longer reproduce what was committed.

   The figure has two renderers and one contract:

   - `lib/timeline_encoding.json` is the only place styling lives — population
     order and colours, ring radii (fractions of the outer radius) and opacities,
     the mechanism palette, the genetic-evidence fills, the empty-cell grey.
     `tests/timeline_encoding_test.ts` fails when the committed data contains a
     population, phase, mechanism or evidence value the file does not cover, or
     when two mechanisms share a colour. Add the entry; do not widen the test.
   - `lib/timeline.ts` (island) and `scripts/timeline_figure.py` (print, via
     `deno task figure`) each implement the same layout rule: sector span ∝ unique
     drugs per population; markers at `(j+1)/(m+1)` of the sector in table order;
     marker radius = ring midpoint ± 18 % of the ring thickness, alternating, when
     a cell holds more than one. Angles are degrees clockwise from 12 o'clock in
     both. `tests/timeline_layout_test.ts` and
     `tests/scripts/test_timeline_figure.py` pin the same numbers (spans, empty
     cells, marker count), so a change to the rule has to be made twice or fails.
   - Text metrics belong to the renderer. The island measures every label with
     `getBBox()` after mount and again on `document.fonts.ready`, then fits the
     box; a label that still touches its marker is pushed 10 units outward, up to
     three times. The Python script does the same with `Text.get_window_extent()`
     and annotation offsets in points. Neither estimates glyph widths.

   Data colours are SVG attributes, never CSS, and the drawer, tooltip and legend
   chrome use the semantic tokens. Keyboard access is the drawer, not the tooltip:
   each `g.drug` is a `role="button"` with `aria-expanded` and `aria-controls`,
   Enter and Space open the `<aside>`, the close button takes focus, Escape closes
   and returns it. The tooltip is pointer-only and `aria-hidden`, as the old one
   was.
   ```

4. Under **Tooltips and styling**, replace the last paragraph ("The two embedded
   pages cannot see `app.css`…") with:

   ```markdown
   The embedded phenogram page cannot see `app.css`, so it declares its own small
   token preamble. The host hands it the theme by `postMessage` — `allow-scripts`
   without `allow-same-origin` blocks reading the parent but not receiving
   messages. Only its chrome switches: the plate stays light in dark mode because
   the figure encodes meaning in hue (a phenotype key) and filtering it would
   change what the colours mean. The in-app timeline follows the same rule: its
   wedge, marker and label-box colours are SVG attributes from
   `lib/timeline_encoding.json`, never CSS, so the theme cannot reach them; the one
   fixed ink they need is `--svd-figure-ink`, declared once and never overridden by
   the dark blocks.
   ```

- [x] **Step 3: Update README.md**

1. In the **Layout** tree:
   `islands/        the three interactive views: GenesView, TrialsView, TrialsMap`
   →
   `islands/        the interactive views: GenesView, TrialsView, TrialsMap, TrialsTimeline`;
   `static/         fonts, images, and the two carried-over standalone pages` →
   `static/         fonts, images, and the carried-over phenogram page`.
2. Replace the paragraph beginning "The phenogram (a 362 KB WebP raster…" at the
   end of **Notes on the port** with:

   ```markdown
   The phenogram (a 362 KB WebP raster with pixel-colour hit-testing) remains a
   standalone page in `static/`; its local wrapper adds keyboard, pointer, and
   error-boundary hardening around the original artifact. The trials timeline is
   drawn in-app from `data/table2.json`; `deno task figure` draws the same figure
   for print (see "Paper figure").
   ```

- [x] **Step 4: Verify**

Run: `deno fmt CLAUDE.md README.md deno.json e2e/tests/embeds.spec.ts` — note
`e2e` is excluded from `deno fmt`, so format that file by hand to match its
neighbours — then `deno task check && deno task test && deno task test:e2e`.
Expected: all green; the only `fmt --check` noise is the pre-existing pipeline
docs. Then confirm nothing dangling:
`grep -rn "timeline.html\|timeline.js\|python_plot\|EmbedPage" --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' . | grep -v node_modules | grep -v _fresh | grep -v docs/superpowers`
should list only `components/EmbedPage.tsx`, `routes/phenogram.tsx`, `CLAUDE.md`
and `README.md` lines about the phenogram.

- [x] **Step 5: Commit**

```bash
git add -A deno.json e2e/tests/embeds.spec.ts CLAUDE.md README.md static scripts e2e/tests
git commit -m "Retire the static timeline artifact and its generator"
```

---

### Task 5: pyCirclize print renderer

**Files:**

- Create: `scripts/timeline_figure.py`
- Test: `tests/scripts/test_timeline_figure.py`
- Modify: `pyproject.toml` (new dependency group), `uv.lock` (regenerated),
  `.gitignore`, `deno.json` (task), `CLAUDE.md` (Commands), `README.md`
  (Pipeline)

**Interfaces:**

- Consumes: `data/table2.json`, `lib/timeline_encoding.json` (Task 1).
- Produces: `sector_spans`, `cells`, `markers`, `stagger`, `draw`, `main`
  (signatures in the code below); `figures/timeline.{svg,pdf,png}`.

- [x] **Step 1: Declare the dependency group and lock it**

In `pyproject.toml`, after the `dev = [...]` group inside `[dependency-groups]`:

```toml
# Print renderer for the trials timeline (scripts/timeline_figure.py). Its
# only extra over the base install is pyCirclize; matplotlib is already a base
# dependency.
figure = [
    "pycirclize>=1.10.1",
]
```

Run: `uv lock && uv sync --group figure` Expected: `uv.lock` gains `pycirclize`
(and its `biopython`/`pandas`/`numpy` pins, which the base install already
carries); `.venv` has it. Commit the lock with the script — that lock is the
reproducibility claim for the manuscript.

Add to `.gitignore` under `# Python`:

```gitignore
# Print figures written by `deno task figure`; regenerate rather than commit.
figures/
```

Add to `deno.json` `tasks`, after `"geocode"`:

```json
"figure": "uv run --group figure scripts/timeline_figure.py",
```

- [x] **Step 2: Write the failing tests**

```python
# tests/scripts/test_timeline_figure.py
"""Unit tests for scripts/timeline_figure.py.

The layout numbers pinned here are the same ones tests/timeline_layout_test.ts
pins for lib/timeline.ts: the island and the print figure implement one rule
over one encoding file, and these two suites are what keep them in step.
"""

from pathlib import Path

import pytest

pytest.importorskip("pycirclize")

from scripts.timeline_figure import (  # noqa: E402
    DEFAULT_ENCODING,
    DEFAULT_TRIALS,
    cells,
    draw,
    load_encoding,
    load_trials,
    main,
    markers,
    sector_spans,
    stagger,
)

EMPTY_CELLS = [
    ("CAA", "I"),
    ("Cognitive Impairment", "II"),
    ("Cognitive Impairment", "I"),
    ("Stroke", "I"),
    ("SVD", "III"),
]


@pytest.fixture(scope="module")
def trials() -> list[dict[str, str]]:
    return load_trials(DEFAULT_TRIALS)


@pytest.fixture(scope="module")
def encoding() -> dict:
    return load_encoding(DEFAULT_ENCODING)


class TestLayout:
    def test_sector_spans_follow_unique_drug_counts(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        assert [s.key for s in sectors] == [
            "CAA",
            "Cognitive Impairment",
            "Stroke",
            "SVD",
        ]
        assert [s.drug_count for s in sectors] == [3, 1, 5, 3]
        assert sectors[0].start_deg == 0
        assert sectors[0].end_deg == pytest.approx(90)
        assert sectors[2].end_deg - sectors[2].start_deg == pytest.approx(150)
        assert sectors[-1].end_deg == pytest.approx(360)
        for previous, current in zip(sectors, sectors[1:], strict=False):
            assert current.start_deg == previous.end_deg

    def test_twelve_cells_with_the_expected_empties(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        cell_list = cells(trials, encoding, sectors)
        assert len(cell_list) == 12
        assert [(c.population, c.phase) for c in cell_list if not c.filled] == (
            EMPTY_CELLS
        )
        colours = {p["key"]: p["color"] for p in encoding["populations"]}
        for cell in cell_list:
            expected = colours[cell.population] if cell.filled else (
                encoding["emptyCell"]["color"]
            )
            assert cell.color == expected

    def test_sixteen_markers_inside_their_cells(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        assert len(marker_list) == 16
        assert [m.index for m in marker_list] == list(range(16))
        rings = {r["phase"]: r for r in encoding["rings"]}
        for marker in marker_list:
            sector = next(s for s in sectors if s.key == marker.population)
            ring = rings[marker.phase]
            assert sector.start_deg < marker.theta_deg < sector.end_deg
            assert ring["innerRadius"] * 100 < marker.r < ring["outerRadius"] * 100
            mechanism = marker.trial["mechanismOfAction"]
            assert marker.color == encoding["mechanisms"][mechanism]
            evidence = marker.trial["geneticEvidence"]
            assert marker.label_fill == encoding["geneticEvidenceFill"][evidence]

    def test_stagger_alternates_only_in_shared_cells(self) -> None:
        assert stagger(0, 1, 100) == 0
        assert stagger(0, 2, 100) == pytest.approx(-18)
        assert stagger(1, 2, 100) == pytest.approx(18)
        assert stagger(2, 3, 100) == pytest.approx(-18)

    def test_shared_cell_markers_differ_in_radius(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        cilostazol = [
            m
            for m in markers(trials, encoding, sectors)
            if m.population == "Cognitive Impairment" and m.phase == "III"
        ]
        assert len(cilostazol) == 2
        assert cilostazol[1].r - cilostazol[0].r == pytest.approx(2 * 0.18 * 56.25)


class TestRender:
    def test_svg_carries_every_marker_and_label_and_both_legends(
        self, trials, encoding, tmp_path: Path
    ) -> None:
        fig = draw(trials, encoding)
        target = tmp_path / "timeline.svg"
        fig.savefig(target, format="svg", bbox_inches="tight")
        svg = target.read_text(encoding="utf-8")
        assert svg.count('id="marker-') == 16
        assert svg.count('id="label-') == 16
        assert "Genetic evidence" in svg
        assert "Mechanism of action" in svg
        assert "Any SVD" in svg
        # Text stays text: no glyph outlines in place of the drug names.
        assert "Cilostazol" in svg

    def test_main_writes_the_requested_formats(self, tmp_path: Path) -> None:
        code = main(["--out", str(tmp_path), "--format", "svg", "pdf", "--dpi", "72"])
        assert code == 0
        assert (tmp_path / "timeline.svg").stat().st_size > 0
        assert (tmp_path / "timeline.pdf").stat().st_size > 0
        assert not (tmp_path / "timeline.png").exists()
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `uv run --group figure pytest tests/scripts/test_timeline_figure.py -q`
Expected: FAIL —
`ModuleNotFoundError: No module named 'scripts.timeline_figure'`.

- [x] **Step 4: Write the script**

```python
# scripts/timeline_figure.py
"""Draw the trials radar (population sectors x phase rings) for print.

The dashboard draws the same figure in the browser (islands/TrialsTimeline.tsx
from lib/timeline.ts). Both renderers read lib/timeline_encoding.json -- the
one place the colours, ring radii and population order live -- and both apply
the same layout rule: sector span proportional to unique drugs per population,
markers at (j+1)/(m+1) of the sector in table order, radius staggered by 18 %
of the ring thickness, alternating, when a cell holds more than one marker.
Angles are degrees clockwise from 12 o'clock; pyCirclize shares that
convention, so its sectors are sized straight from the drug counts.

Usage:
    uv run --group figure scripts/timeline_figure.py
    uv run --group figure scripts/timeline_figure.py --out figures/ --format svg pdf
    uv run --group figure scripts/timeline_figure.py --font /path/to/Arial.ttf --dpi 600
"""

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TRIALS = _PROJECT_ROOT / "data" / "table2.json"
DEFAULT_ENCODING = _PROJECT_ROOT / "lib" / "timeline_encoding.json"
DEFAULT_OUT = _PROJECT_ROOT / "figures"
FORMATS = ("svg", "pdf", "png")

# Layout constants shared with lib/timeline.ts.
STAGGER_FRACTION = 0.18
SIDE_THRESHOLD = 0.2
# pyCirclize draws the plate on a 0-100 radius; labels sit just outside it.
PLATE_RADIUS = 100.0
POPULATION_LABEL_RADIUS = 108.0

# Print sizing, in points.
MARKER_AREA_PT2 = 80.0
LABEL_OFFSET_PT = 12.0
NUDGE_PT = 8.0
MAX_NUDGE_PASSES = 3
DRUG_FONT_PT = 7.0
POPULATION_FONT_PT = 10.0
PHASE_FONT_PT = 8.0
LEGEND_FONT_PT = 7.5
FALLBACK_COLOR = "#888888"


@dataclass(frozen=True)
class Sector:
    key: str
    label: list[str]
    color: str
    ink: str
    start_deg: float
    end_deg: float
    drug_count: int


@dataclass(frozen=True)
class Cell:
    population: str
    phase: str
    filled: bool
    color: str
    opacity: float


@dataclass(frozen=True)
class Marker:
    index: int
    trial: dict[str, str]
    population: str
    phase: str
    theta_deg: float
    r: float
    color: str
    label_fill: str
    anchor: str


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


def load_trials(path: Path = DEFAULT_TRIALS) -> list[dict[str, str]]:
    """Table 2 rows with every string trimmed, as lib/data.ts normalizes them."""
    with path.open(encoding="utf-8") as handle:
        rows = json.load(handle)
    return [
        {key: value.strip() if isinstance(value, str) else value for key, value in row.items()}
        for row in rows
    ]


def load_encoding(path: Path = DEFAULT_ENCODING) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


# ---------------------------------------------------------------------------
# Layout (twin of lib/timeline.ts)
# ---------------------------------------------------------------------------


def _unique_drug_count(rows: list[dict[str, str]]) -> int:
    return len({row["drug"] for row in rows})


def _rows_for(trials: list[dict[str, str]], population: str) -> list[dict[str, str]]:
    return [row for row in trials if row["svdPopulation"] == population]


def sector_spans(trials: list[dict[str, str]], encoding: dict[str, Any]) -> list[Sector]:
    populations = encoding["populations"]
    counts = [_unique_drug_count(_rows_for(trials, p["key"])) for p in populations]
    total = sum(counts) or 1
    sectors: list[Sector] = []
    cursor = 0.0
    for population, count in zip(populations, counts, strict=True):
        start = cursor
        cursor += count / total * 360
        sectors.append(
            Sector(
                key=population["key"],
                label=list(population["label"]),
                color=population["color"],
                ink=population["ink"],
                start_deg=start,
                end_deg=cursor,
                drug_count=count,
            )
        )
    return sectors


def stagger(j: int, m: int, ring_thickness: float) -> float:
    """Radial offset for the j-th of m markers in one cell; zero for a lone marker."""
    if m < 2:
        return 0.0
    return (-1 if j % 2 == 0 else 1) * STAGGER_FRACTION * ring_thickness


def cells(
    trials: list[dict[str, str]], encoding: dict[str, Any], sectors: list[Sector]
) -> list[Cell]:
    out: list[Cell] = []
    for sector in sectors:
        rows = _rows_for(trials, sector.key)
        for ring in encoding["rings"]:
            filled = any(row["clinicalTrialPhase"] == ring["phase"] for row in rows)
            out.append(
                Cell(
                    population=sector.key,
                    phase=ring["phase"],
                    filled=filled,
                    color=sector.color if filled else encoding["emptyCell"]["color"],
                    opacity=ring["opacity"] if filled else encoding["emptyCell"]["opacity"],
                )
            )
    return out


def markers(
    trials: list[dict[str, str]], encoding: dict[str, Any], sectors: list[Sector]
) -> list[Marker]:
    fills = encoding["geneticEvidenceFill"]
    out: list[Marker] = []
    for sector in sectors:
        rows = _rows_for(trials, sector.key)
        for ring in encoding["rings"]:
            in_cell = [row for row in rows if row["clinicalTrialPhase"] == ring["phase"]]
            thickness = (ring["outerRadius"] - ring["innerRadius"]) * PLATE_RADIUS
            midpoint = (ring["innerRadius"] + ring["outerRadius"]) / 2 * PLATE_RADIUS
            for j, trial in enumerate(in_cell):
                fraction = (j + 1) / (len(in_cell) + 1)
                theta = sector.start_deg + fraction * (sector.end_deg - sector.start_deg)
                anchor = "start" if math.sin(math.radians(theta)) >= 0 else "end"
                out.append(
                    Marker(
                        index=len(out),
                        trial=trial,
                        population=sector.key,
                        phase=ring["phase"],
                        theta_deg=theta,
                        r=midpoint + stagger(j, len(in_cell), thickness),
                        color=encoding["mechanisms"].get(
                            trial["mechanismOfAction"], FALLBACK_COLOR
                        ),
                        label_fill=fills.get(trial["geneticEvidence"], fills["No"]),
                        anchor=anchor,
                    )
                )
    return out


def mechanism_order(trials: list[dict[str, str]]) -> list[str]:
    """Mechanisms in first-appearance table order, as the island's legend lists them."""
    seen: list[str] = []
    for row in trials:
        if row["mechanismOfAction"] not in seen:
            seen.append(row["mechanismOfAction"])
    return seen


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------


def configure_fonts(font: Path | None) -> None:
    from matplotlib import font_manager, rcParams

    # Text stays text: the SVG is editable in Illustrator/Inkscape and the PDF
    # embeds the face as TrueType rather than Type 3 outlines.
    rcParams["svg.fonttype"] = "none"
    rcParams["pdf.fonttype"] = 42
    rcParams["ps.fonttype"] = 42
    if font is not None:
        font_manager.fontManager.addfont(str(font))
        rcParams["font.family"] = font_manager.FontProperties(fname=str(font)).get_name()


def _sector_x(marker: Marker, sector: Sector, sector_size: float) -> float:
    """pyCirclize x within a sector for a marker's absolute angle."""
    span = sector.end_deg - sector.start_deg
    return (marker.theta_deg - sector.start_deg) / span * sector_size


def _nudge_labels(fig: Any, ax: Any, placed: list[tuple[Marker, float, Any]]) -> None:
    """Push any label whose fitted box still touches its marker outward, radially.

    The print twin of the island's nudge pass: matplotlib measures the rendered
    text, and the annotation offsets are in points, so the shove is applied in
    display space without converting back into polar coordinates.
    """
    renderer = fig.canvas.get_renderer()
    marker_radius_px = math.sqrt(MARKER_AREA_PT2) / 2 * fig.dpi / 72
    centre_x, centre_y = ax.transData.transform((0.0, 0.0))
    for _ in range(MAX_NUDGE_PASSES):
        fig.canvas.draw()
        moved = False
        for marker, rad, annotation in placed:
            box = annotation.get_window_extent(renderer)
            marker_x, marker_y = ax.transData.transform((rad, marker.r))
            touching = (
                marker_x + marker_radius_px > box.x0
                and marker_x - marker_radius_px < box.x1
                and marker_y + marker_radius_px > box.y0
                and marker_y - marker_radius_px < box.y1
            )
            if not touching:
                continue
            dx, dy = marker_x - centre_x, marker_y - centre_y
            length = math.hypot(dx, dy) or 1.0
            offset_x, offset_y = annotation.get_position()
            annotation.set_position(
                (offset_x + dx / length * NUDGE_PT, offset_y + dy / length * NUDGE_PT)
            )
            moved = True
        if not moved:
            break


def _add_legends(ax: Any, encoding: dict[str, Any], trials: list[dict[str, str]]) -> None:
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch

    evidence = ax.legend(
        handles=[
            Patch(fc=color, ec="#999999", label=label)
            for label, color in encoding["geneticEvidenceFill"].items()
        ],
        title="Genetic evidence",
        loc="upper left",
        bbox_to_anchor=(1.02, 1.0),
        fontsize=LEGEND_FONT_PT,
        title_fontsize=LEGEND_FONT_PT + 1,
        frameon=False,
    )
    # A second ax.legend() replaces the first unless the first is re-added.
    ax.add_artist(evidence)
    ax.legend(
        handles=[
            Line2D(
                [],
                [],
                marker="o",
                linestyle="",
                markersize=7,
                markerfacecolor=encoding["mechanisms"].get(mechanism, FALLBACK_COLOR),
                markeredgecolor="white",
                label=mechanism,
            )
            for mechanism in mechanism_order(trials)
        ],
        title="Mechanism of action",
        loc="upper left",
        bbox_to_anchor=(1.02, 0.86),
        fontsize=LEGEND_FONT_PT,
        title_fontsize=LEGEND_FONT_PT + 1,
        frameon=False,
    )


def draw(
    trials: list[dict[str, str]], encoding: dict[str, Any], *, font: Path | None = None
) -> Any:
    """Render the radar and return the matplotlib Figure."""
    import matplotlib

    matplotlib.use("Agg")
    from pycirclize import Circos

    configure_fonts(font)
    sectors = sector_spans(trials, encoding)
    cell_list = cells(trials, encoding, sectors)
    marker_list = markers(trials, encoding, sectors)
    sector_by_key = {sector.key: sector for sector in sectors}
    cell_by_key = {(cell.population, cell.phase): cell for cell in cell_list}

    # A population with no drugs has a zero-width sector; pyCirclize rejects
    # zero sizes, and there is nothing to draw for it anyway.
    circos = Circos(
        {sector.key: sector.drug_count for sector in sectors if sector.drug_count > 0},
        start=0,
        end=360,
        space=0,
    )

    tracks: dict[tuple[str, str], Any] = {}
    for circos_sector in circos.sectors:
        sector = sector_by_key[circos_sector.name]
        for ring in encoding["rings"]:
            track = circos_sector.add_track(
                (ring["innerRadius"] * PLATE_RADIUS, ring["outerRadius"] * PLATE_RADIUS)
            )
            cell = cell_by_key[(sector.key, ring["phase"])]
            track.rect(
                circos_sector.start,
                circos_sector.end,
                fc=cell.color,
                alpha=cell.opacity,
                ec="none",
            )
            tracks[(sector.key, ring["phase"])] = track

        sine = math.sin(math.radians((sector.start_deg + sector.end_deg) / 2))
        ha = "left" if sine > SIDE_THRESHOLD else "right" if sine < -SIDE_THRESHOLD else "center"
        circos_sector.text(
            "\n".join(sector.label),
            r=POPULATION_LABEL_RADIUS,
            adjust_rotation=False,
            orientation="horizontal",
            size=POPULATION_FONT_PT,
            ha=ha,
            va="center",
            color=sector.ink,
            bbox={"boxstyle": "round,pad=0.35", "fc": sector.color, "ec": "none"},
            gid=f"population-{sector.key}",
        )

    for marker in marker_list:
        track = tracks[(marker.population, marker.phase)]
        x = _sector_x(marker, sector_by_key[marker.population], track.parent_sector.size)
        track.scatter(
            [x],
            [marker.r],
            vmin=track.r_lim[0],
            vmax=track.r_lim[1],
            color=marker.color,
            edgecolor="white",
            linewidth=0.6,
            s=MARKER_AREA_PT2,
            zorder=5,
            gid=f"marker-{marker.index}",
        )

    for ring in encoding["rings"]:
        circos.text(
            f"Phase {ring['phase']}",
            r=(ring["innerRadius"] + ring["outerRadius"]) / 2 * PLATE_RADIUS,
            deg=sectors[0].start_deg,
            size=PHASE_FONT_PT,
            ha="center",
            va="center",
            bbox={"boxstyle": "round,pad=0.3", "fc": "white", "ec": "none"},
            zorder=4,
        )

    fig = circos.plotfig(figsize=(8, 8))
    ax = circos.ax

    placed: list[tuple[Marker, float, Any]] = []
    for marker in marker_list:
        track = tracks[(marker.population, marker.phase)]
        x = _sector_x(marker, sector_by_key[marker.population], track.parent_sector.size)
        rad = track.x_to_rad(x)
        sign = 1 if marker.anchor == "start" else -1
        annotation = ax.annotate(
            marker.trial["drug"],
            xy=(rad, marker.r),
            xytext=(sign * LABEL_OFFSET_PT, 0),
            textcoords="offset points",
            ha="left" if sign > 0 else "right",
            va="center",
            size=DRUG_FONT_PT,
            bbox={"boxstyle": "round,pad=0.3", "fc": marker.label_fill, "ec": "none"},
            zorder=6,
            gid=f"label-{marker.index}",
        )
        placed.append((marker, rad, annotation))

    _nudge_labels(fig, ax, placed)
    _add_legends(ax, encoding, trials)
    return fig


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--trials", type=Path, default=DEFAULT_TRIALS)
    parser.add_argument("--encoding", type=Path, default=DEFAULT_ENCODING)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--format", nargs="+", choices=FORMATS, default=list(FORMATS))
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument(
        "--font",
        type=Path,
        default=None,
        help="TTF/OTF to register and use (journals often require Arial or Helvetica)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    fig = draw(load_trials(args.trials), load_encoding(args.encoding), font=args.font)
    args.out.mkdir(parents=True, exist_ok=True)
    for fmt in args.format:
        target = args.out / f"timeline.{fmt}"
        fig.savefig(target, format=fmt, dpi=args.dpi, bbox_inches="tight")
        print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Verified against pyCirclize 1.10.1 during planning:
`Circos(sectors, start=0,
end=360, space=0)` sizes sectors proportionally with
deg 0 at the top and deg 90 on the right; `Track.rect/scatter/text` and
`Sector.text` forward `**kwargs` (including `gid` and `bbox`) to matplotlib;
`Track.x_to_rad`, `Track.r_lim`, `Track.parent_sector` exist; `Circos.plotfig()`
returns the Figure and `Circos.ax` the `PolarAxes`;
`ax.annotate(..., textcoords="offset points")` measures with `get_window_extent`
and moves with `set_position`; two legends survive via `add_artist`;
`svg.fonttype="none"` keeps the `gid`s and text.

- [x] **Step 5: Run the tests, lint and type-check the new files**

Run:
`uv run --group figure pytest tests/scripts/test_timeline_figure.py -q && uv run ruff check scripts/timeline_figure.py tests/scripts/test_timeline_figure.py && uv run ruff format --check scripts/timeline_figure.py tests/scripts/test_timeline_figure.py && uv run ty check scripts/timeline_figure.py`
Expected: 7 passed; ruff clean (wrap any line over 88 columns); ty reports
nothing new for the file (unresolved third-party imports are warnings by
config). If `ruff format --check` differs, run `uv run ruff format` on the two
files.

- [x] **Step 6: Draw the figure and look at it**

Run: `deno task figure` then open `figures/timeline.svg`. Expected: four sectors
in the app's order starting at 12 o'clock, greyed cells matching the app,
sixteen labelled markers, no label touching its marker, the two legends to the
right. Compare against `/timeline` in `deno task dev`.

- [x] **Step 7: Document the command**

In `CLAUDE.md`, under **Commands**, after the phenogram sentence from Task 4,
add:

```markdown
`deno task figure` draws the trials timeline for print with
`scripts/timeline_figure.py` (pyCirclize); it needs `uv sync --group figure`
first and writes `figures/timeline.{svg,pdf,png}`, which are not committed.
```

In `README.md`, under **## Pipeline** after the fine-tuning paragraph, add:

````markdown
### Paper figure

`scripts/timeline_figure.py` draws the trials timeline radar with
[pyCirclize](https://github.com/moshi4/pyCirclize) for a manuscript, from the
same `data/table2.json` and `lib/timeline_encoding.json` the dashboard uses:

```bash
uv sync --group figure
deno task figure   # figures/timeline.{svg,pdf,png}
uv run --group figure scripts/timeline_figure.py --font /path/to/Arial.ttf --dpi 600
```

Outputs are regenerated, not committed. The SVG keeps text as text
(`svg.fonttype = none`), so it stays editable; the PDF embeds the font.
````

Run: `deno fmt CLAUDE.md README.md deno.json && deno task check`

- [x] **Step 8: Commit**

```bash
git add scripts/timeline_figure.py tests/scripts/test_timeline_figure.py pyproject.toml uv.lock .gitignore deno.json CLAUDE.md README.md
git commit -m "Add the pyCirclize print renderer for the trials timeline"
```

---

## Self-review

- **Spec coverage.** Encoding + guardrail test → Task 1. Layout module + tests →
  Task 2. Island, route, CSS, e2e replacement, theme spec → Task 3. Deletions,
  `deno.json` exclude, CLAUDE.md/README app-side → Task 4. Python script, tests,
  dependency group, `deno task figure`, `.gitignore`, docs → Task 5. The spec's
  "update the dated pipeline-teardown hazard line" is deliberately **not** done:
  that spec is a dated record owned by the in-flight pipeline branch (it is also
  one of the two files `deno fmt` flags on `main`); CLAUDE.md carries the
  current state instead.
- **Type consistency.** `computeTimelineLayout`, `Marker.labelPoint`,
  `Marker.populationLabel`, `PopulationLabel.lines`, `LegendEntry` are used by
  the island exactly as declared in Task 2. `stagger(j, m, thickness)` has the
  same argument order in both languages; `EMPTY_CELLS` is the same list in both
  test suites.
- **Placeholders.** None; every code step is complete.

## Execution notes (2026-08-29)

Executed inline, all tasks committed on `timeline-radar`. Deviations from the
plan as written, each forced by a test:

- **Cross-cell label collisions.** The stagger only separates markers that share
  a cell; the e2e box check found two neighbouring-cell pairs touching (the
  Stroke III Isosorbide labels, THN391 against Tranexamic acid at the SVD rim).
  Added `separateLabels()` to `lib/timeline.ts` — deterministic vertical
  separation with the population and phase labels as fixed obstacles — with unit
  tests, wired into the island's measurement loop, and mirrored as
  `separate_labels()` in the Python script with the same test cases.
- **`tabindex`, not `tabIndex`.** Preact writes the prop name verbatim and SVG
  attribute names are case-sensitive, so `tabIndex={0}` on the `<g>` produced an
  unfocusable group. Documented in CLAUDE.md.
- **Column layout must stretch.** Below 1100px, `align-items: flex-start` let
  `.timeline-scroll` size itself to the 960px plate and the mobile runtime spec
  caught the document overflowing. The media query now sets
  `align-items: stretch`.
- **Focus restoration moved into the post-commit effect.** The drawer test was
  flaky under the full suite when focus returned to the marker before the drawer
  had actually hidden.
- **pyCirclize's `tight_layout=True`.** Left on, it shrank the plate at save
  time to fit the legends after the label passes had run at full size. The
  script now switches the layout engine off after `plotfig()`, anchors the
  legends at axes-x 1.18 (clear of the "Cognitive Impairment" label) and
  measures the padded label patches rather than the bare text.
- **`deno task check` is red on `main` for unrelated reasons** — two unformatted
  pipeline docs and a `deno check` failure resolving `npm:@types/node` — so
  verification ran `deno lint .`, `deno check <new
  files>` and
  `deno fmt --check <touched files>` individually.
- The dated `pipeline-teardown` spec's hazard line was left as a historical
  record; CLAUDE.md carries the current state.
