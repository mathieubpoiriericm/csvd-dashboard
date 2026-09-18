import {
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";

import App from "../routes/_app.tsx";
import Genes from "../routes/genes.tsx";
import About, { AboutContent } from "../routes/index.tsx";
import MapPage from "../routes/map.tsx";
import PhenogramPage from "../routes/phenogram.tsx";
import TimelinePage from "../routes/timeline.tsx";
import Trials from "../routes/trials.tsx";
import { genes, trialLocations, trials } from "../lib/data.ts";
import { RADAR_TITLE, SITE_TITLE } from "../lib/disease.ts";
import { DEFAULT_TRIAL_STATUSES } from "../lib/constants.ts";
import { filterLocationsByStatus, visibleTrials } from "../lib/filters.ts";
import type { PipelineRun, SyncRun } from "../lib/types.ts";

const render = (component: unknown) =>
  renderToString(
    h(component as preact.ComponentType<Record<string, never>>, {}),
  );

interface AppProps {
  Component: preact.ComponentType;
  url: URL;
}

const Shell = App as unknown as preact.ComponentType<AppProps>;

/**
 * A run report is only needed here to pick a branch: the route renders
 * the widget island with no props, so its contents are covered by
 * tests/pipeline_widget_test.tsx rather than through the route.
 */
const RECORDED_RUN = {
  runTimestamp: "2026-08-31T02:17:55+00:00",
  status: "completed",
} as unknown as PipelineRun;

Deno.test("a recorded run replaces the summary card with the widget", () => {
  // Two accounts of the same run on one page would invite them to
  // disagree, which is the failure the widget exists to remove.
  //
  // This asserts the *branch* only. The island is rendered with no props
  // (Fresh cannot serialise a run report across hydration), so under a
  // committed `null` it renders nothing and there is no markup here to
  // assert on -- which means this test would also pass with the island
  // deleted. That gap is covered where it can be: the island's own
  // rendering in tests/pipeline_widget_test.tsx, and its presence on a
  // real page by e2e/tests/about.spec.ts, which builds the app and
  // asserts six step rows when a report exists.
  const html = renderToString(<AboutContent run={RECORDED_RUN} />);
  assertNotMatch(html, /value-box-row/);
  assertNotMatch(html, /pipeline-status-timestamp/);
});

Deno.test("the summary card is the fallback when no report was recorded", () => {
  const html = renderToString(
    <AboutContent
      run={null}
      status={{
        runTimestamp: "2026-08-30T12:00:00Z",
        papersProcessed: 9,
        fulltextRetrieved: 1,
        genesExtracted: 6,
        genesValidated: 0,
      }}
    />,
  );
  assertStringIncludes(html, "Last Pipeline Run");
  assertStringIncludes(html, "value-box-row");
});

Deno.test("neither block renders when the pipeline has recorded nothing", () => {
  const html = renderToString(<AboutContent run={null} status={null} />);
  assertNotMatch(html, /Last Pipeline Run/);
  assertStringIncludes(html, "Data update date unavailable");
});

/**
 * A refresh is a different event from a run, so its block is a sibling of
 * the two above rather than a third branch of the same choice.
 */
const RECORDED_REFRESH = {
  runTimestamp: "2026-09-02T03:00:00Z",
  mode: "annotation_sync",
  status: "completed",
  durationSeconds: 91.235,
  sources: [],
  apis: [],
  errors: { shown: 0, total: 0, items: [] },
} as unknown as SyncRun;

Deno.test("the refreshes block renders beside the widget", () => {
  const html = renderToString(
    <AboutContent run={RECORDED_RUN} syncs={[RECORDED_REFRESH]} />,
  );
  assertStringIncludes(html, "Reference Data Refreshes");
  assertStringIncludes(html, "Disease annotations");
});

Deno.test("the refreshes block renders beside the fallback card too", () => {
  // "Exactly one of the two" is about two accounts of one run. A refresh
  // is not one of them, so it does not have to wait for a run report.
  const html = renderToString(
    <AboutContent
      run={null}
      status={{
        runTimestamp: "2026-08-30T12:00:00Z",
        papersProcessed: 9,
        fulltextRetrieved: 1,
        genesExtracted: 6,
        genesValidated: 0,
      }}
      syncs={[RECORDED_REFRESH]}
    />,
  );
  assertStringIncludes(html, "value-box-row");
  assertStringIncludes(html, "Reference Data Refreshes");
});

Deno.test("no refresh recorded means no refreshes block", () => {
  const html = renderToString(
    <AboutContent run={RECORDED_RUN} syncs={[]} />,
  );
  assertNotMatch(html, /Reference Data Refreshes/);
});

Deno.test("About route renders its warning, totals, and the recorded run", () => {
  const html = render(About);
  assertStringIncludes(html, "still a work in progress");
  assertStringIncludes(html, "Dashboard totals");
  assertStringIncludes(html, "Putative Causal Genes");
  assertStringIncludes(html, "Publications");
  assertStringIncludes(html, "mathieu.poirier@icm-institute.org");
  // data/pipeline_status.json held `null` until the pipeline recorded its
  // first run, so this used to assert the card's absence.
  assertStringIncludes(html, "Last Pipeline Run");
  assertNotMatch(html, /Data update date unavailable/);
});

Deno.test("About content reports an unavailable date when no run is recorded", () => {
  // Injected rather than read from data/pipeline_status.json: that file now
  // carries a real run, so the empty-database branch would otherwise be
  // covered only by whatever the committed data happens to hold. `run` is
  // injected for the same reason and must stay explicit -- these three
  // tests are about the *fallback* card, which only renders when no report
  // was recorded, and they passed for a while only because
  // data/pipeline_run.json happened to be `null`.
  const html = renderToString(<AboutContent status={null} run={null} />);
  assertStringIncludes(html, "Data update date unavailable");
  assertNotMatch(html, /Last Pipeline Run/);
});

Deno.test("About content renders a complete pipeline run summary", () => {
  const html = renderToString(
    <AboutContent
      run={null}
      status={{
        runTimestamp: "2026-08-30T12:00:00Z",
        papersProcessed: 1234,
        fulltextRetrieved: 1000,
        genesExtracted: 80,
        genesValidated: 63,
      }}
    />,
  );
  assertStringIncludes(html, "Last Pipeline Run");
  assertStringIncludes(html, "August 30, 2026");
  assertStringIncludes(html, "1,234");
  assertStringIncludes(html, "1,000");
  assertStringIncludes(html, "80");
  assertStringIncludes(html, "63");
});

Deno.test("About content keeps a complete run visible when its date is invalid", () => {
  const html = renderToString(
    <AboutContent
      run={null}
      status={{
        runTimestamp: "invalid",
        papersProcessed: 1,
        fulltextRetrieved: 2,
        genesExtracted: 3,
        genesValidated: 4,
      }}
    />,
  );
  assertStringIncludes(html, "Data update date unavailable");
  assertStringIncludes(html, "Date unavailable");
  assertStringIncludes(html, "Last Pipeline Run");
});

Deno.test("Genes route server-renders filters, readout, and the first table page", () => {
  const html = render(Genes);
  assertStringIncludes(html, "Putative Causal Genes");
  assertStringIncludes(html, "Genes by chromosome");
  assertStringIncludes(html, `showing ${genes.length} of ${genes.length} rows`);
  assertStringIncludes(html, 'aria-label="Putative causal genes pagination"');
  assertStringIncludes(html, "Chromosomal Location");
  assertStringIncludes(html, "Search genes");
  assertMatch(html, /Showing 1–10 of \d+/);
});

Deno.test("Trials route server-renders grouped rows and its controls", () => {
  const html = render(Trials);
  assertStringIncludes(html, "Clinical Trials");
  assertStringIncludes(html, "Trials by phase");
  const shown = visibleTrials(trials).length;
  assertStringIncludes(html, `showing ${shown} of ${trials.length} rows`);
  assertStringIncludes(html, "Study status");
  assertStringIncludes(html, "Study Status");
  assertStringIncludes(html, 'aria-label="Clinical trials pagination"');
  assertStringIncludes(html, 'aria-sort="ascending"');
  assertStringIncludes(html, "Search trials");
});

Deno.test("Phenogram route server-renders every placed gene and both legends", () => {
  const html = render(PhenogramPage);
  assertStringIncludes(html, "Genes by chromosomal position");
  assertStringIncludes(html, "Supporting evidence");
  assertStringIncludes(html, "GWAS phenotypes");
  assertEquals(
    (html.match(/class="phenogram-block"/g) ?? []).length,
    genes.length,
  );
  assertNotMatch(html, /phenogram-unplaced/);
});

Deno.test("Timeline route server-renders the visible trial markers and its legends", () => {
  const html = render(TimelinePage);
  assertStringIncludes(html, RADAR_TITLE);
  assertStringIncludes(html, "Mechanism of action");
  assertStringIncludes(html, "Genetic evidence");
  assertStringIncludes(html, "Study status");
  assertStringIncludes(html, 'aria-label="Trial details"');
  assertEquals(
    (html.match(/class="drug"/g) ?? []).length,
    visibleTrials(trials).length,
  );
  assertEquals(
    (html.match(/aria-controls="timeline-drawer"/g) ?? []).length,
    visibleTrials(trials).length,
  );
  assertEquals(
    (html.match(/aria-expanded="false"/g) ?? []).length,
    visibleTrials(trials).length,
  );
  assertNotMatch(html, /aria-expanded="true"/);
});

Deno.test("Map route includes map statistics and a complete text alternative", () => {
  const html = render(MapPage);
  assertStringIncludes(html, "ClinicalTrials.gov (NCT IDs only)");
  assertStringIncludes(html, `${trialLocations.length}</b>sites`);
  assertStringIncludes(html, "registered trials");
  assertStringIncludes(html, "Locations resolved");
  assertStringIncludes(html, "Trial facility locations");
  assertStringIncludes(html, 'role="application"');
  assertStringIncludes(html, "Study status");
  assertEquals(
    (html.match(/<li/g) ?? []).length,
    filterLocationsByStatus(trialLocations, DEFAULT_TRIAL_STATUSES).length,
  );
  assertNotMatch(html, /map-error/);
});

Deno.test("application shell derives nested-route titles and active navigation", () => {
  const Content = () => <p>Route body</p>;
  const html = renderToString(
    h(Shell, {
      Component: Content,
      url: new URL("https://example.test/genes/details"),
    }),
  );

  assertStringIncludes(html, `<title>Genes | ${SITE_TITLE}</title>`);
  assertStringIncludes(html, "Route body");
  assertStringIncludes(html, 'href="/genes" aria-current="page"');
  // Scoped to an anchor tag's own attributes, not a bare substring match:
  // the nav-scroll script's inline `<script>` carries the same
  // `aria-current="page"` text as a CSS selector, and a plain match would
  // count that too. See the comment beside the script in routes/_app.tsx.
  assertEquals(
    (html.match(/<a\b[^>]*\baria-current="page"/g) ?? []).length,
    1,
  );
  assertStringIncludes(html, 'localStorage.getItem("svd-theme")');
  assertStringIncludes(html, "Skip to main content");
  assertStringIncludes(html, "MIT License");
});

Deno.test("application shell falls back to the site title for unknown routes", () => {
  const Content = () => <p>Missing</p>;
  const html = renderToString(
    h(Shell, {
      Component: Content,
      url: new URL("https://example.test/unknown"),
    }),
  );
  assertStringIncludes(html, `<title>${SITE_TITLE}</title>`);
  assertEquals(
    (html.match(/<a\b[^>]*\baria-current="page"/g) ?? []).length,
    0,
  );
});
