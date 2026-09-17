/**
 * The refresh record's normalization boundary.
 *
 * The rule under test is all-or-nothing on identity: a row with no
 * timestamp, an unknown mode or an unknown status is dropped rather than
 * half-rendered, because a refresh that half happened is worse on the page
 * than one that is absent. Everything below that line defaults.
 */

import { assert, assertEquals } from "@std/assert";

import { pipelineSyncs } from "../lib/data.ts";
import {
  normalizeSyncRun,
  normalizeSyncRuns,
} from "../lib/data/pipeline_syncs.ts";

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runTimestamp: "2026-09-02T03:00:00Z",
    mode: "annotation_sync",
    status: "completed",
    ...overrides,
  };
}

Deno.test("a complete refresh normalizes", () => {
  const result = normalizeSyncRun(run({
    durationSeconds: 91.235,
    sources: [{ key: "clinvar", label: "ClinVar", fetched: 3, cached: 60 }],
    apis: [{
      service: "orphadata",
      label: "Orphadata",
      endpoint: "/rd-cross-referencing/orphacodes/:id",
      method: "GET",
      calls: 63,
    }],
    errors: { shown: 1, total: 1, items: ["orphadata timed out"] },
  }));

  assert(result !== null);
  assertEquals(result.mode, "annotation_sync");
  assertEquals(result.status, "completed");
  assertEquals(result.durationSeconds, 91.235);
  assertEquals(result.sources[0].label, "ClinVar");
  assertEquals(result.sources[0].failed, 0);
  assertEquals(result.apis[0].label, "Orphadata");
  assertEquals(result.errors.items, ["orphadata timed out"]);
});

Deno.test("a refresh with no detail still normalizes to empty lists", () => {
  const result = normalizeSyncRun(run());
  assert(result !== null);
  assertEquals(result.durationSeconds, 0);
  assertEquals(result.sources, []);
  assertEquals(result.apis, []);
  assertEquals(result.errors, { shown: 0, total: 0, items: [] });
});

Deno.test("a refresh rejects impossible counts and durations", () => {
  const result = normalizeSyncRun(run({
    durationSeconds: -1,
    sources: [{
      key: "clinvar",
      fetched: -1,
      cached: 1.5,
      failed: Number.POSITIVE_INFINITY,
    }],
    apis: [{ service: "metrics", calls: -1, totalMs: -1 }],
    errors: { total: 1.5, items: [] },
  }));
  assert(result !== null);
  assertEquals(result.durationSeconds, 0);
  assertEquals(result.sources[0].fetched, 0);
  assertEquals(result.sources[0].cached, 0);
  assertEquals(result.sources[0].failed, 0);
  assertEquals(result.apis[0].calls, 0);
  assertEquals(result.apis[0].totalMs, 0);
  assertEquals(result.errors.total, 0);
});

Deno.test("refresh API rows drop blank identities and keep a safe heading", () => {
  const result = normalizeSyncRun(run({
    apis: [null, {}, { endpoint: " /v1/records ", label: 42 }],
  }));
  assert(result !== null);
  assertEquals(result.apis.length, 1);
  assertEquals(result.apis[0].service, "/v1/records");
  assertEquals(result.apis[0].label, "/v1/records");
  assertEquals(result.apis[0].endpoint, "/v1/records");
});

Deno.test("a source falls back to its key for a label", () => {
  const result = normalizeSyncRun(run({ sources: [{ key: "clinvar" }] }));
  assert(result !== null);
  assertEquals(result.sources[0].label, "clinvar");
  assertEquals(result.sources[0].fetched, 0);
});

Deno.test("sources require a usable key or label and never render blank", () => {
  const result = normalizeSyncRun(run({
    sources: [
      null,
      [],
      {},
      { key: 42, label: " " },
      { label: " ClinVar " },
      { key: " orphadata ", label: 42 },
    ],
  }));
  assert(result !== null);
  assertEquals(result.sources, [
    { key: "ClinVar", label: "ClinVar", fetched: 0, cached: 0, failed: 0 },
    {
      key: "orphadata",
      label: "orphadata",
      fetched: 0,
      cached: 0,
      failed: 0,
    },
  ]);
});

Deno.test("malformed errors are filtered with honest capped-list counts", () => {
  const result = normalizeSyncRun(run({
    errors: {
      shown: 99,
      total: 4,
      items: [null, " ", {}, " orphadata timed out "],
    },
  }));
  assert(result !== null);
  assertEquals(result.errors, {
    shown: 1,
    total: 4,
    items: ["orphadata timed out"],
  });
});

Deno.test("an error total cannot be lower than its readable items", () => {
  const result = normalizeSyncRun(run({
    errors: { total: 1, items: [" first ", 7, "second"] },
  }));
  assert(result !== null);
  assertEquals(result.errors, {
    shown: 2,
    total: 2,
    items: ["first", "second"],
  });
});

Deno.test("a non-object is not a refresh", () => {
  assertEquals(normalizeSyncRun(null), null);
  assertEquals(normalizeSyncRun("annotation_sync"), null);
  assertEquals(normalizeSyncRun(42), null);
});

Deno.test("a refresh missing any part of its identity is dropped", () => {
  assertEquals(normalizeSyncRun(run({ runTimestamp: "  " })), null);
  assertEquals(normalizeSyncRun(run({ mode: null })), null);
  assertEquals(normalizeSyncRun(run({ status: undefined })), null);
});

Deno.test("an unknown mode or status is dropped, not rendered raw", () => {
  // A mode the encoding has no label for would render as its own key, and
  // a status outside the vocabulary has no badge -- both would publish a
  // refresh the dashboard cannot describe.
  assertEquals(normalizeSyncRun(run({ mode: "quarterly_vibes" })), null);
  assertEquals(normalizeSyncRun(run({ status: "probably fine" })), null);
});

Deno.test("the list drops unreadable rows and keeps the rest", () => {
  const result = normalizeSyncRuns([
    run({ mode: "clinical_trials" }),
    { mode: "external_sync" },
    run({ mode: "annotation_sync" }),
  ]);
  assertEquals(result.map((entry) => entry.mode), [
    "clinical_trials",
    "annotation_sync",
  ]);
});

Deno.test("a non-list is an empty list", () => {
  assertEquals(normalizeSyncRuns(null), []);
  assertEquals(normalizeSyncRuns({ mode: "annotation_sync" }), []);
});

Deno.test("the committed file is a list of complete refreshes", () => {
  // Committed as `[]` until a refresh records one, exactly as
  // data/pipeline_run.json was committed as `null`. Both states render.
  assert(Array.isArray(pipelineSyncs));
  for (const entry of pipelineSyncs) {
    assert(entry.runTimestamp.length > 0);
    assert(entry.mode.length > 0);
  }
});
