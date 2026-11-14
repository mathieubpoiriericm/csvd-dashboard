import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";

import App, { pageTitle } from "../routes/_app.tsx";
import AdaptPage, { AdaptTip } from "../routes/adapt.tsx";
import Genes from "../routes/genes.tsx";
import About, {
  AboutContent,
  handler as aboutHandler,
} from "../routes/index.tsx";
import MapPage from "../routes/map.tsx";
import PhenogramPage from "../routes/phenogram.tsx";
import TimelinePage from "../routes/timeline.tsx";
import Trials from "../routes/trials.tsx";
import { DEFAULT_PAGE_SIZE } from "../components/TableShell.tsx";
import { genes, trialLocations, trials } from "../lib/data.ts";
import { pipelineStatus } from "../lib/data/pipeline.ts";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import { previewCookie } from "../lib/pipeline_preview.ts";
import { MAINTAINER, RADAR_TITLE, SITE_TITLE } from "../lib/disease.ts";
import { DEFAULT_TRIAL_STATUSES } from "../lib/constants.ts";
import { placeGene } from "../lib/cytobands.ts";
import { locationsWithTableStatus } from "../lib/trials.ts";
import { GOLD_ONLY, GOLD_ONLY_NOTICE } from "../lib/gold_only.ts";
import { filterLocationsByStatus, visibleTrials } from "../lib/filters.ts";
import type { PipelineRun, SyncRun } from "../lib/types.ts";
import { LOGIN_PATH } from "../lib/auth.ts";
import { currentReview } from "../lib/review/current.ts";
import { goldOf, sampleChange, sampleRound } from "./fixtures/review.ts";
import { escapeHtml } from "./helpers/html.ts";

const render = (component: unknown) =>
  renderToString(
    h(component as preact.ComponentType<Record<string, never>>, {}),
  );

interface AppProps {
  Component: preact.ComponentType;
  url: URL;
}

/**
 * The About route, rendered for a request: it reads the preview cookie off
 * the request's headers, so it is given one, with `cookie` when the test
 * needs it.
 */
const renderAbout = (cookie?: string) =>
  renderToString(
    h(
      About as unknown as preact.ComponentType<{ req: Request }>,
      {
        req: new Request(
          "http://localhost/",
          cookie ? { headers: { cookie } } : {},
        ),
      },
    ),
  );

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
  const html = renderToString(
    <AboutContent goldOnly={false} run={RECORDED_RUN} />,
  );
  assertNotMatch(html, /value-box-row/);
  assertNotMatch(html, /pipeline-status-timestamp/);
});

Deno.test("the summary card is the fallback when no report was recorded", () => {
  const html = renderToString(
    <AboutContent
      goldOnly={false}
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
  const html = renderToString(
    <AboutContent goldOnly={false} run={null} status={null} />,
  );
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
    <AboutContent
      goldOnly={false}
      run={RECORDED_RUN}
      syncs={[RECORDED_REFRESH]}
    />,
  );
  assertStringIncludes(html, "Reference Data Refreshes");
  assertStringIncludes(html, "Disease annotations");
});

Deno.test("the refreshes block renders beside the fallback card too", () => {
  // "Exactly one of the two" is about two accounts of one run. A refresh
  // is not one of them, so it does not have to wait for a run report.
  const html = renderToString(
    <AboutContent
      goldOnly={false}
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
    <AboutContent goldOnly={false} run={RECORDED_RUN} syncs={[]} />,
  );
  assertNotMatch(html, /Reference Data Refreshes/);
});

Deno.test("About route renders its warning, totals, and the gold-only notice", () => {
  const html = renderAbout();
  assertStringIncludes(html, "still a work in progress");
  assertStringIncludes(html, "Dashboard totals");
  assertStringIncludes(html, "Putative Causal Genes");
  assertStringIncludes(html, "Publications");
  assertStringIncludes(html, escapeHtml(MAINTAINER.email));
  // The route renders whichever branch the switch selects; the run branch
  // is covered above through `goldOnly={false}`.
  if (GOLD_ONLY) {
    assertStringIncludes(html, GOLD_ONLY_NOTICE);
    assertNotMatch(html, /Last Pipeline Run/);
  } else if (pipelineStatus === null) {
    // data/pipeline_status.json is `null` until the pipeline records its
    // first run -- which is where a fork starts -- so which card renders is
    // read off the committed file rather than assumed.
    assertStringIncludes(html, "Data update date unavailable");
    assertNotMatch(html, /Last Pipeline Run/);
  } else {
    assertStringIncludes(html, "Last Pipeline Run");
    assertNotMatch(html, /Data update date unavailable/);
  }
});

Deno.test("the About route draws the preview the visitor's cookie asked for", () => {
  // The cookie is honoured only where there is something to preview: the
  // notice is gold-only's, and the widget needs a recorded run.
  const on = renderAbout(previewCookie(true).split(";")[0]);
  const off = renderAbout();
  if (GOLD_ONLY) {
    // Under gold-only the widget is the preview's alone, so without the
    // cookie there is none.
    assertNotMatch(off, /pipeline-card/);
    if (pipelineRun !== null) {
      assertStringIncludes(on, "pipeline-card");
      assertStringIncludes(on, 'aria-checked="true"');
      assertStringIncludes(off, 'aria-checked="false"');
    } else {
      assertNotMatch(on, /pipeline-card|about-preview-switch/);
    }
  } else {
    // The run branch renders its own widget whenever a run is recorded, and
    // the cookie changes nothing.
    assertEquals(on, off);
  }
});

Deno.test("the About route renews the preview cookie it drew the preview for", () => {
  // The switch writes its cookie from script, which WebKit keeps for seven
  // days at most; the route that honours it sends it back as a header, so
  // it lasts the year the switch asked for.
  const get = (cookie?: string) =>
    new Headers(
      (aboutHandler.GET({
        req: new Request(
          "http://localhost/",
          cookie ? { headers: { cookie } } : {},
        ),
      } as never) as { headers?: HeadersInit }).headers,
    ).get("set-cookie");
  const on = get(previewCookie(true).split(";")[0]);
  if (GOLD_ONLY && pipelineRun !== null) {
    assertEquals(
      on,
      "pipeline_preview=1; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  } else {
    // No preview is offered, so there is no cookie to keep.
    assertEquals(on, null);
  }
  // The server never switches the preview on by itself.
  assertEquals(get(), null);
  assertEquals(get("other=1"), null);
});

Deno.test("About content reports an unavailable date when no run is recorded", () => {
  // Injected rather than read from data/pipeline_status.json: that file now
  // carries a real run, so the empty-database branch would otherwise be
  // covered only by whatever the committed data happens to hold. `run` is
  // injected for the same reason and must stay explicit -- these three
  // tests are about the *fallback* card, which only renders when no report
  // was recorded, and they passed for a while only because
  // data/pipeline_run.json happened to be `null`.
  const html = renderToString(
    <AboutContent goldOnly={false} status={null} run={null} />,
  );
  assertStringIncludes(html, "Data update date unavailable");
  assertNotMatch(html, /Last Pipeline Run/);
});

Deno.test("About content renders a complete pipeline run summary", () => {
  const html = renderToString(
    <AboutContent
      goldOnly={false}
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
      goldOnly={false}
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
  if (genes.length === 0) {
    assertStringIncludes(html, "No rows match the current filters.");
  } else {
    // The first page is as long as the table's page size, or as the table:
    // a disease's first export may publish fewer rows than a page holds.
    assertStringIncludes(
      html,
      `Showing 1–${
        Math.min(DEFAULT_PAGE_SIZE, genes.length)
      } of ${genes.length}`,
    );
  }
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
  // A location with no hg38 band (the gold table publishes one verbatim) is
  // left off the figure and named in the note beneath it instead.
  const unplaced = genes.filter((gene) =>
    placeGene(gene.chromosomalLocation) === null
  );
  assertEquals(
    (html.match(/class="phenogram-block"/g) ?? []).length,
    genes.length - unplaced.length,
  );
  if (unplaced.length === 0) {
    assertNotMatch(html, /phenogram-unplaced/);
  } else {
    assertStringIncludes(html, 'class="phenogram-unplaced"');
    for (const gene of unplaced) assertStringIncludes(html, gene.gene);
  }
});

Deno.test("Timeline route server-renders the visible trial markers and its legends", () => {
  const html = render(TimelinePage);
  assertStringIncludes(html, escapeHtml(RADAR_TITLE));
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
    filterLocationsByStatus(
      locationsWithTableStatus(trialLocations, trials),
      DEFAULT_TRIAL_STATUSES,
    ).length,
  );
  // The error panel is for a Leaflet that failed to load; an empty facility
  // list is not an error and must not render as one.
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

  assertStringIncludes(
    html,
    `<title>Genes | ${escapeHtml(SITE_TITLE)}</title>`,
  );
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
  assertStringIncludes(html, `<title>${escapeHtml(SITE_TITLE)}</title>`);
  assertEquals(
    (html.match(/<a\b[^>]*\baria-current="page"/g) ?? []).length,
    0,
  );
});

Deno.test("Adapt route renders the intro, the prerequisites and the wizard's first step", () => {
  const html = render(AdaptPage);
  assertStringIncludes(html, "Adapt this dashboard to another disease");
  assertStringIncludes(html, "Before you start");
  assertStringIncludes(html, "Anthropic API key");
  assertStringIncludes(html, 'class="adapt-stepper"');
  assertStringIncludes(html, "Disease name");
  // Without JavaScript the page says where the same interview lives.
  assertMatch(
    html,
    /<noscript>.*docs\/adapting-to-your-disease\.md.*<\/noscript>/s,
  );
  // What remains after the download is more than commands.
  assert(!html.includes("every remaining step is one command"));
  assertStringIncludes(html, "a few hand edits and the deploy settings");
});

Deno.test("Adapt route renders with sessions off while ADAPT_SESSIONS_DIR is unset", () => {
  // The store is opened once per process from the environment; the suite
  // sets no directory, so the page renders without the session controls.
  assertEquals(Deno.env.get("ADAPT_SESSIONS_DIR"), undefined);
  const html = render(AdaptPage);
  assertStringIncludes(html, 'data-sessions="off"');
  // Nor does it designate a machine, so the page names none.
  assertEquals(Deno.env.get("ADAPT_SESSIONS_MACHINE"), undefined);
  assert(!html.includes("data-sessions-machine"), html);
  // Neither the bar nor the tip names a button the page does not show.
  assert(!/<button[^>]*>Save session/.test(html), html);
  assert(!html.includes("Save session"), html);
  assertStringIncludes(
    html,
    "Nothing is sent anywhere except the lookups to NCBI, the EBI Ontology Lookup Service and ClinicalTrials.gov.",
  );
});

Deno.test("the adapt tip names Save session only when sessions are on", () => {
  const off = renderToString(<AdaptTip sessions={false} />);
  assertStringIncludes(
    off,
    "Your answers are saved in this browser as you go. Nothing is sent anywhere except the lookups to NCBI, the EBI Ontology Lookup Service and ClinicalTrials.gov.",
  );
  assert(!off.includes("Save session"), off);
  assert(!off.includes("server"), off);

  const on = renderToString(<AdaptTip sessions />);
  assertStringIncludes(
    on,
    "Nothing leaves it except the lookups to NCBI, the EBI Ontology Lookup Service and ClinicalTrials.gov, and, if you press Save session, a copy of your answers kept on this server for 14 days.",
  );
});

Deno.test("the About page links to the adapt page", () => {
  const html = renderAbout();
  assertMatch(html, /<a[^>]*href="\/adapt"[^>]*>/);
  assertStringIncludes(html, "Reuse this dashboard for another disease");
});

/** The shell around an empty page at `path`. */
const shellAt = (path: string) =>
  renderToString(
    <Shell
      Component={() => <p>x</p>}
      url={new URL(`http://localhost${path}`)}
    />,
  );

/**
 * The navbar's previews link on a page: its opening tag's attributes and its
 * contents. Each attribute is matched on its own, as the order they render in
 * is not fixed.
 */
const previewsLink = (html: string) => {
  const match = html.match(
    /<a\b([^>]*\bhref="\/previews"[^>]*)>([\s\S]*?)<\/a>/,
  );
  return { tag: match?.[1] ?? "", body: match?.[2] ?? "" };
};

Deno.test("application shell lights the previews entry on every preview page", () => {
  const titles: ReadonlyArray<[string, string]> = [
    ["/previews", "New Feature Previews"],
    ["/previews/pipeline", "Pipeline Run"],
    ["/adapt", "Adapt"],
    ["/review", "Review"],
    ["/review/gene", "Review"],
    ["/review/progress", "Review"],
  ];
  for (const [path, title] of titles) {
    const html = shellAt(path);
    assertStringIncludes(
      html,
      `<title>${title} | ${escapeHtml(SITE_TITLE)}</title>`,
    );
    // None of them is a tab: the one entry for all of them is the one link
    // marked current.
    const current = html.match(/<a\b[^>]*\baria-current="page"[^>]*>/g) ?? [];
    assertEquals(current.length, 1, path);
    assertStringIncludes(current[0] ?? "", 'href="/previews"', path);
  }
});

Deno.test("application shell puts the described previews entry before the tabs", () => {
  const html = shellAt("/");
  const { tag, body } = previewsLink(html);
  assertStringIncludes(tag, 'aria-describedby="nav-previews-tip"');
  assert(!tag.includes("aria-current"), tag);
  const dot = body.indexOf('class="nav-previews-dot" aria-hidden="true"');
  assert(dot >= 0, body);
  assert(dot < body.indexOf("<svg"), body);
  assertStringIncludes(body, "New Feature Previews");
  assertMatch(
    html,
    /<span[^>]*id="nav-previews-tip"[^>]*>New\. Three features in preview/,
  );
  // First in the row, so it sits to the left of About.
  const hrefs = [...html.matchAll(/<a [^>]*class="nav-link[^>]*>/g)].map((m) =>
    m[0].match(/href="([^"]*)"/)?.[1]
  );
  assertEquals(hrefs.slice(0, 2), ["/previews", "/"]);
  // The guide is reached through the hub, not from the bar.
  const nav = html.match(/<ul class="navbar-nav">[\s\S]*?<\/ul>/)?.[0] ?? "";
  assert(nav.length > 0, html);
  assert(!nav.includes('href="/adapt"'), nav);
  assert(!html.includes("Build Your Own"), html);
});

Deno.test("the previews entry is not current off the preview pages", () => {
  // `/previewsx` and `/reviewers` only start with a preview root's name.
  for (const path of ["/genes", "/previewsx", "/reviewers"]) {
    const { tag } = previewsLink(shellAt(path));
    assert(tag.length > 0, path);
    assert(!tag.includes("aria-current"), `${path}: ${tag}`);
  }
});

Deno.test("the shell draws no Review control, signed in or on the login page", () => {
  for (const path of ["/", LOGIN_PATH]) {
    const html = shellAt(path);
    assert(!html.includes("review-control"), path);
    assert(!html.includes("review-button"), path);
  }
  assert(!shellAt(LOGIN_PATH).includes('class="navbar"'));
});

Deno.test("application shell titles the review pages without a tab", () => {
  for (const path of ["/review", "/review/gene", "/review/progress"]) {
    const html = renderToString(
      <Shell
        Component={() => <p>x</p>}
        url={new URL(`http://localhost${path}`)}
      />,
    );
    assertStringIncludes(
      html,
      `<title>Review | ${escapeHtml(SITE_TITLE)}</title>`,
    );
  }
  // A page whose name only starts with the word is not one of them.
  const other = renderToString(
    <Shell
      Component={() => <p>x</p>}
      url={new URL("http://localhost/reviewers")}
    />,
  );
  assertStringIncludes(other, `<title>${escapeHtml(SITE_TITLE)}</title>`);
});

Deno.test("a gene's review page is titled by its gene", () => {
  const round = sampleRound(3);
  round.changes.push(sampleChange({ gene: "AB1/2", version: "v9" }));
  const review = currentReview(true, round, goldOf(round))!;
  const title = (query: string, path = "/review/gene") =>
    pageTitle(path, new URLSearchParams(query), review);
  assertEquals(title("g=GENE2"), `GENE2 | Review | ${SITE_TITLE}`);
  // The key arrives as the queue's link encodes it.
  assertEquals(title("g=AB1%2F2"), `AB1/2 | Review | ${SITE_TITLE}`);
  // A gene the round does not hold, or none at all, keeps the plain title.
  for (const query of ["g=GENE99", "g=", ""]) {
    assertEquals(title(query), `Review | ${SITE_TITLE}`);
  }
  // Without a review no gene is named.
  assertEquals(
    pageTitle("/review/gene", new URLSearchParams("g=GENE2"), null),
    `Review | ${SITE_TITLE}`,
  );
  // The other review pages are unchanged, whatever their query says.
  for (const path of ["/review", "/review/progress"]) {
    assertEquals(title("g=GENE2", path), `Review | ${SITE_TITLE}`);
  }
});

Deno.test("the shell does not echo an unknown gene into the title", () => {
  // Through the shell with the committed review, round or none: a key no
  // round holds keeps the plain title, so markup in the query is not echoed.
  const html = renderToString(
    <Shell
      Component={() => <p>x</p>}
      url={new URL(
        "http://localhost/review/gene?g=%3C/title%3E%3Cscript%3E",
      )}
    />,
  );
  assertStringIncludes(
    html,
    `<title>Review | ${escapeHtml(SITE_TITLE)}</title>`,
  );
});
