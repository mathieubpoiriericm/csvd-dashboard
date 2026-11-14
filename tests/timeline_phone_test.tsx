/**
 * The phone views of the trials radar, rendered to markup. `jsx: "precompile"`
 * keeps handlers out of the vnode tree, so what is asserted is the HTML.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { MiniRadar } from "../components/timeline/MiniRadar.tsx";
import { PhaseList } from "../components/timeline/PhaseList.tsx";
import { computeTimelineLayout, encoding } from "../lib/timeline.ts";
import { sampleTrial } from "./fixtures/rows.ts";
import { escapeHtml } from "./helpers/html.ts";

const POP_A = encoding.populations[0].key;
// Two populations of the test's own, because a disease may declare only one.
const SECOND = { ...encoding.populations[0], key: `${POP_A}-b` };
const POP_B = SECOND.key;
const TWO_POPULATIONS = {
  ...encoding,
  populations: [encoding.populations[0], SECOND],
};
const MECHANISM = Object.keys(encoding.mechanisms)[0];
const [P_OUTER, P_NEXT] = encoding.rings.map((r) => r.phase);

const trial = (drug: string, phase: string, population = POP_A) =>
  sampleTrial({
    drug,
    clinicalTrialPhase: phase,
    targetPopulation: population,
    mechanismOfAction: MECHANISM,
  });

const layout = computeTimelineLayout([
  trial("Beta", P_NEXT),
  trial("Alpha", P_OUTER),
  trial("Gamma", "Ib"),
]);
const empty = computeTimelineLayout([]);

const list = (activeIndex: number | null, l = layout) =>
  renderToString(
    <PhaseList
      layout={l}
      activeIndex={activeIndex}
      onActivate={() => {}}
      rowRef={() => {}}
    />,
  );

Deno.test("the list has one heading per phase, in ring order", () => {
  const html = list(null);
  const headings = [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1]);
  assertEquals(headings, [
    `Phase ${P_OUTER} · 1 trial`,
    `Phase ${P_NEXT} · 1 trial`,
    "Phase I · 1 trial",
  ]);
});

Deno.test("the list has a row per marker, with the sub-phase suffix", () => {
  const html = list(null);
  assertEquals(html.match(/<button /g)?.length, layout.markers.length);
  assertStringIncludes(html, "Gamma (Phase Ib)");
  assert(!html.includes("Alpha ("));
  assertStringIncludes(html, 'aria-controls="timeline-dialog"');
});

Deno.test("only the active row is expanded", () => {
  const html = list(layout.markers[0].index);
  assertEquals(html.match(/aria-expanded="true"/g)?.length, 1);
  assertEquals(html.match(/aria-expanded="false"/g)?.length, 2);
});

Deno.test("an empty layout says so instead of listing", () => {
  const html = list(null, empty);
  assertStringIncludes(
    html,
    '<p class="timeline-list-empty">None of the selected trials sits on a phase ring.</p>',
  );
  assert(!html.includes("<button"));
});

const mini = (activeIndex: number | null, l = layout, scale = 0.3) =>
  renderToString(
    <MiniRadar layout={l} activeIndex={activeIndex} scale={scale} />,
  );

Deno.test("the small radar is a picture: no focus stops, no drug labels", () => {
  const html = mini(null);
  assert(!html.includes("tabindex"));
  assert(!html.includes('data-label="drug-'));
  assertStringIncludes(html, 'role="img"');
  assertStringIncludes(
    html,
    "3 trials across 1 population; the list below names each one",
  );
});

Deno.test("the small radar's summary counts in the singular and the plural", () => {
  const one = computeTimelineLayout([trial("Alpha", P_OUTER)]);
  assertStringIncludes(
    mini(null, one),
    'aria-label="1 trial across 1 population;',
  );
  const two = computeTimelineLayout([
    trial("A", P_OUTER),
    trial("B", P_OUTER, POP_B),
  ], TWO_POPULATIONS);
  assertStringIncludes(
    mini(null, two),
    'aria-label="2 trials across 2 populations;',
  );
});

Deno.test("the small radar marks the active trial only", () => {
  const html = mini(layout.markers[0].index);
  assertEquals(html.match(/class="marker active"/g)?.length, 1);
  assertEquals(html.match(/class="marker"/g)?.length, 2);
});

Deno.test("the small radar's legend omits empty sectors", () => {
  const html = mini(null);
  assertEquals(html.match(/<li[ >]/g)?.length, 1);
  assertStringIncludes(
    html,
    escapeHtml(encoding.populations[0].label.join(" ")),
  );
  const two = computeTimelineLayout([
    trial("A", P_OUTER),
    trial("B", P_OUTER, POP_B),
  ], TWO_POPULATIONS);
  assertEquals(mini(null, two).match(/<li[ >]/g)?.length, 2);
});
