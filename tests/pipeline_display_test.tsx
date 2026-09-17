/**
 * The widget's formatting layer.
 *
 * Every number, duration and failure in the pipeline widget goes through
 * these functions, which is what makes a rejected gene, an API timing
 * and a byte count read as one system rather than as whatever their
 * source happened to produce.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import encoding from "../lib/pipeline_encoding.json" with { type: "json" };
import { ApiList } from "../components/ApiList.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";

import {
  describeApi,
  describeError,
  describeRejection,
  describeTruncation,
  field,
  formatBytes,
  formatConfidence,
  formatCost,
  formatCount,
  formatDuration,
  formatMilliseconds,
  formatPercent,
  formatRunTimestamp,
  isTruncated,
  paperSourceLabel,
  runModeLabel,
  runStatusBadge,
  stepIcon,
  stepStatusBadge,
  syncModeLabel,
  warningCount,
  warningIcon,
} from "../lib/pipeline_display.ts";
import type { ApiService, RunStep } from "../lib/types.ts";

const API: ApiService = {
  service: "uniprot",
  label: "UniProt",
  endpoint: "/uniprotkb/:id",
  method: "GET",
  calls: 12,
  ok: 12,
  notFound: 0,
  errors: 0,
  retries: 0,
  totalMs: 0,
  bytes: 0,
};

const STEP: RunStep = {
  key: "processing_papers",
  label: "Retrieve & extract",
  ordinal: 3,
  status: "warning",
  startedAt: null,
  durationSeconds: 1,
  actions: [],
  warnings: [],
  error: null,
};

Deno.test("formatDuration keeps the precision a reader can act on", () => {
  // A step that took 40ms and one that took 0.9s are different facts.
  assertEquals(formatDuration(0.04), "40 ms");
  assertEquals(formatDuration(0.9), "900 ms");
  assertEquals(formatDuration(2.42), "2.4 s");
  assertEquals(formatDuration(18.4), "18 s");
  assertEquals(formatDuration(131), "2m 11s");
});

Deno.test("formatDuration never prints sixty seconds", () => {
  // Both places the arithmetic can produce 60: the minutes slot (179.6)
  // and the bare-seconds branch (59.6, which used to print "60 s" --
  // only the first was guarded).
  assertEquals(formatDuration(179.6), "3m 0s");
  assertEquals(formatDuration(59.6), "1m 0s");
  assertEquals(formatDuration(59.4), "59 s");
});

Deno.test("formatDuration never prints a thousand milliseconds", () => {
  // 0.9996 s is 1000 ms once rounded; that is the sub-second branch
  // printing a second.
  assertEquals(formatDuration(0.9996), "1.0 s");
  assertEquals(formatDuration(0.9994), "999 ms");
});

Deno.test("formatDuration refuses what it cannot render", () => {
  assertEquals(formatDuration(null), "—");
  assertEquals(formatDuration(-1), "—");
  assertEquals(formatDuration(Number.NaN), "—");
  assertEquals(formatDuration(Number.POSITIVE_INFINITY), "—");
});

Deno.test("formatMilliseconds goes through the same rules as seconds", () => {
  assertEquals(formatMilliseconds(4100), "4.1 s");
  assertEquals(formatMilliseconds(40), "40 ms");
  assertEquals(formatMilliseconds(Number.NaN), "—");
});

Deno.test("formatBytes uses the unit that keeps it under four digits", () => {
  assertEquals(formatBytes(42), "42 B");
  assertEquals(formatBytes(4200), "4.2 kB");
  assertEquals(formatBytes(4_200_000), "4.2 MB");
  assertEquals(formatBytes(4_200_000_000), "4.2 GB");
  assertEquals(formatBytes(0), "—");
  assertEquals(formatBytes(Number.NaN), "—");
});

Deno.test("formatCount separates thousands", () => {
  assertEquals(formatCount(175584), "175,584");
  assertEquals(formatCount(0), "0");
  assertEquals(formatCount(Number.NaN), "—");
});

Deno.test("formatCost never rounds a real cost away to zero", () => {
  assertEquals(formatCost(1.38), "$1.38");
  assertEquals(formatCost(0.004), "<$0.01");
  assertEquals(formatCost(0), "—");
});

Deno.test("formatConfidence uses the decimals the floors are quoted in", () => {
  // The gates say "0.60 < 0.65", so the widget has to agree.
  assertEquals(formatConfidence(0.6), "0.60");
  assertEquals(formatConfidence(1), "1.00");
  assertEquals(formatConfidence(null), "—");
});

Deno.test("formatPercent rounds to whole points", () => {
  assertEquals(formatPercent(0.4676), "47%");
  assertEquals(formatPercent(Number.NaN), "—");
});

Deno.test("formatRunTimestamp states UTC rather than converting", () => {
  // Every pipeline timestamp is UTC; a reader comparing this against a
  // log line needs them to be the same clock.
  const formatted = formatRunTimestamp("2026-08-31T02:17:55Z");
  assert(formatted !== null);
  assert(formatted.includes("August 31, 2026"));
  assert(formatted.endsWith("UTC"));
});

Deno.test("formatRunTimestamp rejects a timestamp it cannot parse", () => {
  assertEquals(formatRunTimestamp("not a date"), null);
});

Deno.test("describeError adds what the category means", () => {
  // "The service returned HTTP 503" says what happened; the hint says
  // what kind of problem that is to someone who does not run this.
  const described = describeError({
    kind: "http_error",
    title: "The service returned HTTP 503",
    detail: "upstream unavailable",
    subject: null,
  });
  assertEquals(described.title, "The service returned HTTP 503");
  assert(described.hint.length > 0);
  assertEquals(described.detail, "upstream unavailable");
});

Deno.test("describeError names the subject when there is one", () => {
  const described = describeError({
    kind: "timeout",
    title: "The request timed out",
    detail: null,
    subject: "32517579",
  });
  assertEquals(described.title, "The request timed out (32517579)");
});

Deno.test("describeError falls back rather than rendering nothing", () => {
  const described = describeError({
    kind: "a kind added later",
    title: "Something happened",
    detail: null,
    subject: null,
  });
  assert(described.hint.length > 0);
  assert(described.icon.length > 0);
});

Deno.test("describeApi names trouble only when there was some", () => {
  assertEquals(describeApi(API), "12 calls");
  assertEquals(
    describeApi({ ...API, calls: 1 }),
    "1 call",
    "singular, so a one-call service does not read as a typo",
  );
  assertEquals(
    describeApi({ ...API, retries: 2, errors: 1, totalMs: 4100, bytes: 2048 }),
    "12 calls · 2 retried · 1 failed · 4.1 s · 2.0 kB",
  );
});

Deno.test("a 404 reads as not found, not as a failure", () => {
  // Both lookups that can return one treat it as the normal "no
  // open-access copy" answer, so counting it as an error made the green
  // badge unreachable on any run with an abstract-only paper.
  assertEquals(
    describeApi({ ...API, calls: 9, ok: 1, notFound: 8 }),
    "9 calls · 8 not found",
  );
  assertEquals(
    describeApi({ ...API, calls: 9, ok: 7, notFound: 1, errors: 1 }),
    "9 calls · 1 not found · 1 failed",
  );
});

Deno.test("ApiList renders one .pipeline-api item per service", () => {
  const markup = renderToString(
    <ApiList apis={[API, { ...API, service: "ncbi", label: "NCBI" }]} />,
  );
  const items = markup.match(/class="pipeline-api"/g) ?? [];
  assertEquals(items.length, 2);
});

/**
 * F28: `islands/PipelineRun.tsx` and `components/PipelineSyncs.tsx` each
 * hand-wrote the `<li class="pipeline-api">` shape, directly under a
 * comment in the latter claiming the two lists were "one component" --
 * they were a copy that had not yet drifted. Comparing two renders of
 * `ApiList` to each other (as the brief originally proposed) cannot catch
 * that: it is true the instant the component exists, whether or not
 * either caller actually uses it. What catches a re-inlined copy is
 * scanning the source both callers live in.
 */
Deno.test("the .pipeline-api markup lives in exactly one file", () => {
  const pattern = /class="pipeline-api"/;
  const offenders: string[] = [];
  for (const dir of ["components", "islands"]) {
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".tsx")) continue;
      const path = `${dir}/${entry.name}`;
      if (path === "components/ApiList.tsx") continue;
      if (pattern.test(Deno.readTextFileSync(path))) offenders.push(path);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("warningCount totals things, not rows", () => {
  assertEquals(
    warningCount({
      ...STEP,
      warnings: [
        {
          kind: "genes_rejected",
          title: "",
          count: 24,
          detail: null,
          subjects: [],
        },
        {
          kind: "paper_retrieval_failed",
          title: "",
          count: 1,
          detail: null,
          subjects: [],
        },
      ],
    }),
    25,
  );
});

Deno.test("badges and labels fall back rather than crashing", () => {
  assertEquals(runStatusBadge("completed").label, "Completed");
  assertEquals(runStatusBadge("invented later").label, "Unknown");
  assertEquals(stepStatusBadge("warning").tint, "ember");
  assertEquals(stepStatusBadge("invented later").tint, "muted");
});

Deno.test("every fallback glyph actually renders", () => {
  // This asserted the names were non-empty strings, which they were:
  // all four were kebab-case ("exclamation-triangle") while Icon.tsx's
  // PATHS keys are camelCase, so `Icon` called .map on undefined and
  // threw — taking the whole About page's render with it. Rendering is
  // the only assertion that catches a name that does not resolve.
  const unknown = [
    warningIcon("invented later"),
    stepIcon("invented later"),
    field("invented later").icon,
    runStatusBadge("invented later").icon,
    stepStatusBadge("invented later").icon,
    describeError({
      kind: "invented later",
      title: "x",
      detail: null,
      subject: null,
    }).icon,
  ];
  for (const name of unknown) {
    const markup = renderToString(<Icon name={name} />);
    assertStringIncludes(markup, "<path");
  }
});

Deno.test("every glyph the encoding names renders", () => {
  // The encoding is cast to IconName on import, so the compiler cannot
  // check its contents. This does.
  const seen = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (key === "icon" && typeof entry === "string") seen.add(entry);
        else walk(entry);
      }
    }
  };
  walk(encoding);
  assert(seen.size > 15, `only found ${seen.size} glyph names`);
  for (const name of seen) {
    const markup = renderToString(<Icon name={name as IconName} />);
    assertStringIncludes(markup, "<path");
  }
});

Deno.test("paper sources read as words rather than sentinels", () => {
  assertEquals(paperSourceLabel("none"), "No text retrieved");
  assertEquals(paperSourceLabel("abstract"), "Abstract only");
  assertEquals(paperSourceLabel("europepmc"), "Full text from Europe PMC");
  // An unlisted source keeps its own name rather than vanishing.
  assertEquals(paperSourceLabel("biorxiv"), "biorxiv");
});

Deno.test("run modes read as words rather than enum values", () => {
  assertEquals(runModeLabel("pmid_list"), "PMID list");
  assertEquals(runModeLabel("standard"), "PubMed search");
  assertEquals(runModeLabel("something_new"), "something_new");
});

Deno.test("refresh modes name what they refreshed", () => {
  // The labels name the data, not the flag that starts the refresh: the
  // reader is looking at disease annotations, not at --sync-annotations.
  assertEquals(syncModeLabel("annotation_sync"), "Disease annotations");
  assertEquals(syncModeLabel("external_sync"), "Gene & citation metadata");
  assertEquals(syncModeLabel("clinical_trials"), "Clinical trials");
  assertEquals(syncModeLabel("something_new"), "something_new");
});

Deno.test("field() gives every key a label and a glyph", () => {
  assertEquals(field("genesAccepted").label, "Accepted");
  assertEquals(field("unlisted").label, "unlisted");
  assert(field("unlisted").icon.length > 0);
});

Deno.test("truncation is stated rather than hidden", () => {
  assert(isTruncated(200, 1412));
  assert(!isTruncated(26, 26));
  assertEquals(describeTruncation(200, 1412), "Showing 200 of 1,412");
  // F29: PipelineSyncs hand-wrote "Showing 3 of 12 errors." -- a noun and
  // a terminal period -- while this function's callers had neither. The
  // noun is optional so PipelineRun's noun-less callers keep reading the
  // same way; the period is never added, so a caller that does supply a
  // noun still reads like every other one-line caption on this page
  // (`.pipeline-provenance`, `.pipeline-tokens`), neither of which ends in
  // one either.
  assertEquals(
    describeTruncation(3, 12, "errors"),
    "Showing 3 of 12 errors",
  );
});

/**
 * Splitting a rejection into a badge and a detail.
 *
 * The reason is a finished sentence built in Python, so the interesting cases
 * are the shapes of that sentence: a prefix the badge now says, a category
 * named in the middle of a clause, and something the encoding has never seen.
 */
Deno.test("a prefixed rejection loses the words the badge repeats", () => {
  const low = describeRejection("Low confidence: 0.30 < 0.45");
  assertEquals(low.kind, "low_confidence");
  assertEquals(low.label, "Low confidence");
  assertEquals(low.tint, "highlight");
  assertEquals(low.detail, "0.30 < 0.45");

  const held = describeRejection(
    "Held below the insert floor: 0.55 < 0.60 (new gene)",
  );
  assertEquals(held.kind, "insert_floor");
  assertEquals(held.tint, "muted");
  assertEquals(held.detail, "0.55 < 0.60 (new gene)");
});

Deno.test("a rejection named mid-sentence keeps all its words", () => {
  // The gene is named before the category is, so cutting at the match would
  // throw away the only part that says which gene.
  const missing = describeRejection("Gene 'FOO1' not found in NCBI Gene");
  assertEquals(missing.kind, "not_in_ncbi");
  assertEquals(missing.tint, "danger");
  assertEquals(missing.detail, "Gene 'FOO1' not found in NCBI Gene");
});

Deno.test("an unrecognised rejection is badged as an error, uncut", () => {
  const odd = describeRejection("  Postgres exploded  ");
  assertEquals(odd.kind, "error");
  assertEquals(odd.label, "Error");
  assertEquals(odd.tint, "danger");
  assertEquals(odd.detail, "Postgres exploded");
  assert(odd.icon.length > 0);
});
