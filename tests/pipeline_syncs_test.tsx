/**
 * The reference-data refreshes block.
 *
 * A plain component rather than an island -- it holds no state -- so it
 * renders here the way the route renders it, with the `runs` prop the
 * route passes. The thing worth pinning is that the providers only the
 * refreshes touch are named on the page at all: before this block they
 * were recorded by the pipeline and then discarded.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { PipelineSyncs } from "../components/PipelineSyncs.tsx";
import type { SyncRun } from "../lib/types.ts";

const ANNOTATIONS: SyncRun = {
  runTimestamp: "2026-09-02T03:00:00Z",
  mode: "annotation_sync",
  status: "completed",
  durationSeconds: 91.235,
  sources: [
    { key: "clinvar", label: "ClinVar", fetched: 3, cached: 60, failed: 0 },
    {
      key: "orphadata",
      label: "Orphadata",
      fetched: 12,
      cached: 12,
      failed: 0,
    },
    {
      key: "opentargets",
      label: "Open Targets",
      fetched: 63,
      cached: 63,
      failed: 0,
    },
  ],
  apis: [
    {
      service: "opentargets",
      label: "Open Targets",
      endpoint: "/api/v4/graphql",
      method: "POST",
      calls: 63,
      ok: 63,
      notFound: 0,
      errors: 0,
      retries: 0,
      totalMs: 4120.5,
      bytes: 51200,
    },
    {
      service: "orphadata",
      label: "Orphadata",
      endpoint: "/rd-cross-referencing/orphacodes/:id",
      method: "GET",
      calls: 12,
      ok: 12,
      notFound: 0,
      errors: 0,
      retries: 0,
      totalMs: 900,
      bytes: 0,
    },
  ],
  errors: { shown: 0, total: 0, items: [] },
};

function render(runs: SyncRun[]): string {
  return renderToString(<PipelineSyncs runs={runs} />);
}

Deno.test("the refresh names its mode, badge and timing", () => {
  const html = render([ANNOTATIONS]);
  assertStringIncludes(html, "Disease annotations");
  assertStringIncludes(html, "Completed");
  assertStringIncludes(html, "1m 31s");
});

Deno.test("a refresh with an invalid date keeps its results visible", () => {
  const html = render([{ ...ANNOTATIONS, runTimestamp: "invalid" }]);
  assertStringIncludes(html, "Date unavailable");
  assertStringIncludes(html, "Disease annotations");
  assertStringIncludes(html, "Completed");
  assertStringIncludes(html, "3 fetched · 60 written");
  assert(!html.includes("Invalid Date"));
});

Deno.test("the providers only a refresh touches are named on the page", () => {
  // The whole point of the block. Both of these resolve through
  // `SERVICES` rather than the hostname fallback, so they must read as
  // display names and never as `api.platform.opentargets.org`.
  const html = render([ANNOTATIONS]);
  assertStringIncludes(html, "Open Targets");
  assertStringIncludes(html, "Orphadata");
  assertStringIncludes(html, "/api/v4/graphql");
  assertStringIncludes(html, "POST");
  assertEquals(html.includes("api.platform.opentargets.org"), false);
});

Deno.test("each upstream reports what it fetched and what it wrote", () => {
  const html = render([ANNOTATIONS]);
  assertStringIncludes(html, "ClinVar");
  assertStringIncludes(html, "3 fetched · 60 written");
});

Deno.test("an upstream with nothing to do says so rather than showing zeros", () => {
  const html = render([{
    ...ANNOTATIONS,
    sources: [
      { key: "clinvar", label: "ClinVar", fetched: 0, cached: 0, failed: 0 },
    ],
  }]);
  assertStringIncludes(html, "nothing to do");
});

Deno.test("a failed refresh reads as failed and shows why", () => {
  const html = render([{
    ...ANNOTATIONS,
    status: "failed",
    errors: { shown: 1, total: 1, items: ["Orphadata returned 503"] },
  }]);
  assertStringIncludes(html, "Failed");
  assertStringIncludes(html, "Orphadata returned 503");
});

Deno.test("a capped error list discloses omitted failures", () => {
  const html = render([{
    ...ANNOTATIONS,
    status: "failed",
    errors: {
      shown: 2,
      total: 5,
      items: ["First failure", "Second failure"],
    },
  }]);
  assertStringIncludes(html, "Showing 2 of 5 errors");
  assertStringIncludes(html, "First failure");
  assertStringIncludes(html, "Second failure");
});

Deno.test("a per-source failure is a warning, not a failure", () => {
  const html = render([{
    ...ANNOTATIONS,
    status: "completed_with_warnings",
    sources: [
      { key: "clinvar", label: "ClinVar", fetched: 3, cached: 60, failed: 2 },
    ],
  }]);
  assertStringIncludes(html, "2 failed");
});

Deno.test("an empty list renders nothing at all", () => {
  // Not an empty heading: a database that has recorded no refresh has
  // nothing to say about one, and the run widget below still stands.
  assertEquals(render([]), "");
});

Deno.test("every refresh in the list is rendered", () => {
  const html = render([
    ANNOTATIONS,
    { ...ANNOTATIONS, mode: "clinical_trials", sources: [], apis: [] },
  ]);
  assertStringIncludes(html, "Disease annotations");
  assertStringIncludes(html, "Clinical trials");
});

Deno.test("a refresh with no detail renders its header and no empty lists", () => {
  const html = render([{ ...ANNOTATIONS, sources: [], apis: [] }]);
  assertStringIncludes(html, "Disease annotations");
  assert(!html.includes("pipeline-sources"));
  assert(!html.includes("pipeline-apis"));
});

Deno.test("F24: the endpoint register sits behind a native disclosure", () => {
  // Regression guard for F24 (Task 21): endpoint paths and HTTP verbs are a
  // maintainer's register (islands/CLAUDE.md), so `ApiList` sits behind a
  // `<details>` rather than rendering inline on the card.
  //
  // tests/styles_contract_test.ts pins the CSS that makes a *closed*
  // disclosure measure as hidden, but nothing asserted the markup itself:
  // e2e/tests/about.spec.ts only checks `.pipeline-api-name` text content,
  // which a plain `<div class="pipeline-apis">` satisfies exactly as well as
  // a `<details>` does. Reverting `Refresh`'s `<details>` back to that `<div>`
  // -- the precise regression F24 fixed -- makes this test fail while every
  // other test in this file and about.spec.ts keeps passing.
  const html = render([ANNOTATIONS]);
  assertStringIncludes(html, '<details class="pipeline-apis">');
  assertStringIncludes(html, "External services consulted");
});
