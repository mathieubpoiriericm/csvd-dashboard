import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertMatch,
} from "@std/assert";

import appearance from "../lib/timeline_encoding.json" with { type: "json" };
import diseaseTimeline from "../disease/timeline.json" with { type: "json" };
import { trials } from "../lib/data.ts";
import { encoding, FLAG_REASONS, OUTER_RADIUS } from "../lib/timeline.ts";
import { manifest } from "../lib/disease.ts";

/**
 * `lib/timeline_encoding.json` carries rings and chrome; `disease/timeline.json`
 * carries the disease's populations, mechanisms and families. Two renderers
 * compose them — `lib/timeline.ts` for the island and `scripts/timeline_figure.py`
 * for print — so together they are the one place a new mechanism, population or
 * phase has to be given a colour. These assertions make the committed data and
 * the encoding fail together.
 */

const HEX = /^#[0-9a-f]{6}$/;

const unique = <T>(values: readonly T[]) => new Set(values);

/**
 * The shape both renderers read. Declared here rather than imported so the
 * raw file is checked against the contract, not against whatever the
 * TypeScript side currently believes it to be.
 */
interface ExpectedEncoding {
  populations: { key: string; label: string[]; color: string; band: string }[];
  rings: {
    phase: string;
    innerRadius: number;
    outerRadius: number;
    opacity: number;
  }[];
  rimBand: { gap: number; width: number };
  boundary: { color: string; opacity: number; width: number };
  emptyCell: { opacity: number };
  evidenceStates: {
    key: string;
    ring: string | null;
    dash: string | null;
    field: string;
    legend: string;
  }[];
  recordFlag: {
    label: string;
    legend: string;
    gapRadius: number;
    reasons: Record<string, string>;
  };
  mechanisms: Record<string, string>;
  families: { key: string; label: string; mechanisms: string[] }[];
}

const raw = { ...appearance, ...diseaseTimeline } as unknown as Partial<
  ExpectedEncoding
>;

Deno.test("every population in the data has an encoding entry, in the manifest's order", () => {
  const keys = encoding.populations.map((p) => p.key);
  assertEquals(keys, manifest.populations.map((p) => p.key));
  assertEquals(unique(keys).size, keys.length, "population keys repeat");

  const missing = [...unique(trials.map((t) => t.svdPopulation))]
    .filter((key) => !keys.includes(key));
  assertEquals(missing, [], `populations without an encoding: ${missing}`);

  for (const population of raw.populations ?? []) {
    assert(population.label.length > 0, `${population.key} has no label`);
    assert(HEX.test(population.color), `${population.key}: bad color`);
    assert(HEX.test(population.band ?? ""), `${population.key}: bad band`);
  }
});

Deno.test("the rim band and the cell boundary hairline are encoded", () => {
  const band = raw.rimBand;
  assert(band !== undefined, "no rimBand block");
  assert(band.gap > 0 && band.width > 0, "rim band has no size");
  assert(band.gap + band.width < 0.25, "rim band is not a rim");

  const boundary = raw.boundary;
  assert(boundary !== undefined, "no boundary block");
  assert(HEX.test(boundary.color), "boundary colour");
  assert(boundary.opacity > 0 && boundary.opacity <= 1, "boundary opacity");
  assert(boundary.width > 0, "boundary width");
});

Deno.test("every mechanism belongs to exactly one family, in a fixed family order", () => {
  const families = raw.families ?? [];
  assert(families.length > 0, "no families");
  const members = families.flatMap((f) => f.mechanisms);
  assertEquals(
    unique(members).size,
    members.length,
    "a mechanism is listed in two families",
  );
  assertEquals(
    [...members].sort(),
    Object.keys(encoding.mechanisms).sort(),
    "families and mechanisms disagree",
  );
  for (const family of families) {
    assert(family.key.length > 0 && family.label.length > 0, "unnamed family");
    assert(family.mechanisms.length > 0, `${family.key} is empty`);
  }
});

Deno.test("the unknown-mechanism colour is encoded once and is no family's colour", () => {
  assertMatch(encoding.unknownMechanism, /^#[0-9a-f]{6}$/i);
  assert(
    !Object.values(encoding.mechanisms).includes(encoding.unknownMechanism),
  );
});

Deno.test("every phase in the data has a ring, and the rings tile 0..1", () => {
  const phases = encoding.rings.map((r) => r.phase);
  // Seven bands, ordered inward-to-outward by how far a trial has advanced.
  // A seamless trial gets a band of its own rather than being collapsed onto
  // one of its components: the print figure has no drawer, so a II/III trial
  // drawn on the III ring would state a phase the registry does not.
  assertEquals(phases, [
    "IV",
    "III",
    "II/III",
    "II",
    "I/II",
    "I",
    "(unknown)",
  ]);

  const missing = [...unique(trials.map((t) => t.clinicalTrialPhase))]
    .filter((phase) => !phases.includes(phase));
  assertEquals(missing, [], `phases without a ring: ${missing}`);

  assertEquals(encoding.rings[0].innerRadius, 0);
  assertEquals(encoding.rings.at(-1)?.outerRadius, 1);

  // **The outermost band may not be narrowed.** A marker sits at its ring's
  // midpoint, so a thinner outermost band pushes the outermost markers --
  // and the drug labels outside them -- towards the plate edge, where the
  // margin is only CANVAS/2 - OUTER_RADIUS = 120 units. Narrowing it from
  // 0.15 to 0.10 when the two seamless rings were added moved those markers
  // 6.7 units out and tipped the 22-character "Stellate ganglion block"
  // over the right edge under Linux font metrics, while it still fitted on
  // macOS -- so the local suite passed and CI did not. This pins the
  // resulting radius rather than the width, because that is what the label
  // layout actually has to clear.
  const outermost = encoding.rings.at(-1)!;
  const staggered = ((outermost.innerRadius + outermost.outerRadius) / 2 +
    0.18 * (outermost.outerRadius - outermost.innerRadius)) * OUTER_RADIUS;
  assertAlmostEquals(staggered, 396.032, 1e-9);
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

Deno.test("genetic evidence is three states, and only the unassessed one draws no ring", () => {
  // A ring means somebody assessed this drug's genetics. Solid found evidence,
  // dashed looked and found none, absent never looked. The two-state encoding
  // this replaced drew the last two identically, so a default "No" on a row
  // nobody had read rendered as a negative finding.
  const states = raw.evidenceStates ?? [];
  assertEquals(states.map((s) => s.key), [
    "supported",
    "unsupported",
    "unassessed",
  ]);

  const byKey = new Map(states.map((s) => [s.key, s]));
  for (const key of ["supported", "unsupported"]) {
    assert(
      HEX.test(byKey.get(key)?.ring ?? ""),
      `the ${key} ring is not a colour`,
    );
  }
  assertEquals(
    byKey.get("unassessed")?.ring,
    null,
    "an unassessed drug must draw no ring",
  );
  assertEquals(
    byKey.get("supported")?.dash,
    null,
    "the supported ring must be solid",
  );
  assert(
    (byKey.get("unsupported")?.dash ?? "").length > 0,
    "the unsupported ring must be dashed, or it is the supported one",
  );
  for (const state of states) {
    assert(state.legend.length > 0, `${state.key} has no legend wording`);
    assert(state.field.length > 0, `${state.key} has no drawer wording`);
  }

  assert(
    encoding.emptyCell.opacity > 0 &&
      encoding.emptyCell.opacity <
        Math.min(...encoding.rings.map((r) => r.opacity)),
    "an empty cell is fainter than every filled ring",
  );
});

Deno.test("every record-flag reason a renderer can emit has its wording here", () => {
  // The rules live in `lib/timeline.ts` and `scripts/timeline_figure.py`; the
  // words live here. Adding a rule without its wording would render a bare key
  // in the drawer, so the two are reconciled rather than restated.
  const flag = raw.recordFlag;
  assert(flag !== undefined, "the record flag is not encoded");
  assertEquals(
    Object.keys(flag.reasons).sort(),
    [...FLAG_REASONS].sort(),
    "the encoded reasons and the renderer's reason keys disagree",
  );
  for (const [key, wording] of Object.entries(flag.reasons)) {
    assert(wording.length > 0, `${key} has no wording`);
  }
  assert(flag.label.length > 0 && flag.legend.length > 0);
  // A fraction of the marker radius, like every other radius in this file, so
  // a hollow centre never swallows or vanishes inside its own marker.
  assert(
    flag.gapRadius > 0 && flag.gapRadius < 1,
    "gapRadius is not a usable fraction of the marker radius",
  );
});
