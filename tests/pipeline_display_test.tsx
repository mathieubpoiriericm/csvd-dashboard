/**
 * The widget's formatting layer.
 *
 * Every number, duration and failure in the pipeline widget goes through
 * these functions, which is what makes a rejected gene, an API timing
 * and a byte count read as one system rather than as whatever their
 * source happened to produce.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";

import encoding from "../lib/pipeline_encoding.json" with { type: "json" };
import { ApiList } from "../components/ApiList.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";

import {
  describeError,
  describeRefusal,
  describeRejection,
  describeSourceCounts,
  describeTruncation,
  field,
  formatBytes,
  formatConfidence,
  formatCount,
  formatDuration,
  formatMilliseconds,
  formatPercent,
  formatRunTimestamp,
  isTruncated,
  paperSourceLabel,
  runModeLabel,
  runStatusBadge,
  runWhen,
  stepIcon,
  stepStatusBadge,
  syncModeLabel,
  warningIcon,
} from "../lib/pipeline_display.ts";
import type { ApiService } from "../lib/types.ts";

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

Deno.test("formatDuration reads an hour or more in hours", () => {
  // A timed-out refresh records a flat 3600 s; a `--batch` poll can run
  // for a day. "60m 0s" and "1440m 0s" were what these printed.
  assertEquals(formatDuration(3600), "1h 0m");
  assertEquals(formatDuration(86_400), "24h 0m");
  assertEquals(formatDuration(90_061), "25h 1m");
  // Rounded before the branch: 3599.6 s is an hour, not "60m 0s".
  assertEquals(formatDuration(3599.6), "1h 0m");
  assertEquals(formatDuration(3570), "59m 30s");
});

Deno.test("formatDuration never prints ten seconds with a decimal", () => {
  assertEquals(formatDuration(9.96), "10 s");
  assertEquals(formatDuration(9.94), "9.9 s");
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
  // Decided on the printed value: 999,960 B is not "1000.0 kB".
  assertEquals(formatBytes(999_960), "1.0 MB");
  assertEquals(formatBytes(999_940), "999.9 kB");
  assertEquals(formatBytes(0), "—");
  assertEquals(formatBytes(Number.NaN), "—");
});

Deno.test("describeSourceCounts names cache hits as cache hits", () => {
  const source = { key: "ncbi_gene", label: "NCBI Gene" };
  assertEquals(
    describeSourceCounts({ ...source, fetched: 1, cached: 111, failed: 1 }),
    "1 fetched · 111 from cache · 1 failed",
  );
  assertEquals(
    describeSourceCounts({
      key: "clinicaltrials",
      label: "ClinicalTrials.gov",
      fetched: 1_381,
      cached: 141,
      failed: 0,
    }),
    "1,381 fetched · 141 written",
  );
  assertEquals(
    describeSourceCounts({ ...source, fetched: 0, cached: 0, failed: 0 }),
    "nothing to do",
  );
});

Deno.test("formatCount separates thousands", () => {
  assertEquals(formatCount(175584), "175,584");
  assertEquals(formatCount(0), "0");
  assertEquals(formatCount(Number.NaN), "—");
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

const heads = (markup: string) =>
  [...markup.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);

Deno.test("ApiList is a table whose trouble columns appear only when there was trouble", () => {
  // A clean inventory stays narrow, and a troubled one is visibly wider.
  const clean = renderToString(<ApiList apis={[API]} />);
  assertMatch(clean, /<table[^>]*role="table"/);
  assertEquals(heads(clean), ["Service", "Request", "Calls", "Time", "Data"]);
  const troubled = renderToString(
    <ApiList apis={[API, { ...API, retries: 2, errors: 1 }]} />,
  );
  assertEquals(heads(troubled), [
    "Service",
    "Request",
    "Calls",
    "Retries",
    "Failed",
    "Time",
    "Data",
  ]);
});

Deno.test("a 404 has a column of its own, apart from a failure", () => {
  // Both lookups that can return one treat it as the normal "no
  // open-access copy" answer, so counting it as an error made a clean
  // inventory unreachable on any run with an abstract-only paper.
  const markup = renderToString(
    <ApiList apis={[{ ...API, calls: 9, ok: 1, notFound: 8 }]} />,
  );
  assertEquals(heads(markup), [
    "Service",
    "Request",
    "Calls",
    "Not found",
    "Time",
    "Data",
  ]);
  assertMatch(markup, />9<\/td><td[^>]*>8<\/td>/);
});

Deno.test("ApiList gives a service's time and data their units, and nothing where there was none", () => {
  const timed = renderToString(
    <ApiList apis={[{ ...API, totalMs: 4100, bytes: 2048 }]} />,
  );
  assertMatch(timed, />4\.1 s<\/td><td[^>]*>2\.0 kB<\/td>/);
  // No request was timed and nothing was counted: two empty cells, not
  // "0 ms" and "0 B".
  const bare = renderToString(<ApiList apis={[API]} />);
  assertNotMatch(bare, /0 ms|0 B/);
});

Deno.test("a service row has no glyph: its name is the name", () => {
  // Every row carried the same two-arrows icon, which told thirteen
  // services apart from nothing.
  assertNotMatch(renderToString(<ApiList apis={[API]} />), /<svg/);
});

Deno.test("ApiList writes a request as one line of code, method first", () => {
  // The verb was a chip of its own beside the path, so on a phone the two
  // wrapped apart: "GET" at the end of the service's line, its path below.
  assertStringIncludes(
    renderToString(<ApiList apis={[API]} />),
    '<code class="pipeline-api-endpoint"><span class="pipeline-method">GET</span> /uniprotkb/:id</code>',
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

Deno.test("describeRefusal labels bio and falls back for an unseen category", () => {
  assertEquals(describeRefusal("bio").label, "Biology safety classifier");
  assertEquals(
    describeRefusal("cyber").label,
    "Cybersecurity safety classifier",
  );
  // A category the API adds later is still a refusal, not a blank chip.
  assertEquals(describeRefusal("zzz").label, "Safety classifier");
  assertEquals(describeRefusal("zzz"), describeRefusal("unspecified"));
});

Deno.test("runWhen gives the card its date and its time apart", () => {
  // The card sets the date in ink and the time muted beside it. Both come
  // from the one formatter, so they cannot name two different clocks.
  assertEquals(runWhen("2026-08-31T02:17:55Z"), {
    date: "August 31, 2026",
    time: "at 02:17 UTC",
  });
  assertEquals(runWhen("not a date"), null);
});

Deno.test("a rejection kind is headed for a group of them, by its label unless it says otherwise", () => {
  // The run details list rejected findings under their kind. "Low
  // confidence" is right on one finding's pill and wrong over fourteen of
  // them, where the heading says what they have in common.
  assertEquals(
    describeRejection("Low confidence: 0.30 < 0.45").heading,
    "Under the confidence floor",
  );
  assertEquals(
    describeRejection("Quote not found in the paper").heading,
    "Quote not in paper",
  );
  assertEquals(describeRejection("something unforeseen").heading, "Error");
});
