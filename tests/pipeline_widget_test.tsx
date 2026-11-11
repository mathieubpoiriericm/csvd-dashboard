/**
 * The pipeline widget's rendering.
 *
 * The island is rendered directly here rather than through the route,
 * because the route renders it with no props at all: Fresh serialises
 * island props for hydration, and every island in this repo reads its own
 * data instead. The `run` prop exists for these tests.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { RunDetails } from "../components/pipeline/RunDetails.tsx";
import PipelineRunView from "../islands/PipelineRun.tsx";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import { detailTabs, type TabId } from "../lib/pipeline_details.ts";
import { formatDuration } from "../lib/pipeline_display.ts";
import { RUN, runWith, step, warning } from "./fixtures/pipeline_run.ts";
import type { PipelineRun } from "../lib/types.ts";

/**
 * The run details of `run`: one tab's panel, or every tab's in turn. The
 * dialog shows one panel at a time, so a test that asks what the details
 * hold, without caring where, reads them all.
 */
const detailsOf = (run: PipelineRun, tab?: TabId) =>
  (tab ? [tab] : detailTabs(run).map((entry) => entry.id))
    .map((id) => renderToString(<RunDetails run={run} tab={id} />))
    .join("");
const details = (tab?: TabId) => detailsOf(RUN, tab);
const html = () => renderToString(<PipelineRunView run={RUN} />);

const render = (run: PipelineRun) =>
  renderToString(<PipelineRunView run={run} />);

Deno.test("the committed report renders", () => {
  // Whatever `data/pipeline_run.json` holds -- a report stored before the
  // accounting was fixed, a fork's first run -- the card prints it as
  // recorded. `null` in a repository generated for another disease.
  if (pipelineRun === null) return;
  const markup = renderToString(<PipelineRunView />);
  assertStringIncludes(markup, "pipeline-card");
  assertNotMatch(markup, /NaN|undefined|\[object/);
});

Deno.test("the card says when the run was and how long it took", () => {
  const markup = html();
  assertStringIncludes(markup, "August 31, 2026");
  assertStringIncludes(markup, "UTC");
  assertStringIncludes(markup, "2m 47s");
});

Deno.test("the card states its status once, and what is left to review", () => {
  const markup = html();
  assertStringIncludes(markup, "Completed");
  assertNotMatch(markup, /Completed with warnings|Passed/);
  // RUN: one routine note (24 genes under the floor) and one that needs a
  // look (a paper with no text). Notes are counted, not what they name.
  assertMatch(markup, /pipeline-tint-ember[^>]*>.*?1 to review/s);
});

Deno.test("a run with only routine notes has nothing to review", () => {
  const run = runWith({
    steps: [
      step({ status: "warning", warnings: [warning("model_fallback", 34)] }),
    ],
  });
  assertNotMatch(render(run), /to review/);
});

Deno.test("a failed run's status is Failed, with nothing softer beside it", () => {
  const markup = render(runWith({ status: "failed" }));
  assertMatch(markup, /pipeline-when.*?pipeline-tint-danger[^>]*>.*?Failed/s);
  assertNotMatch(markup, /Completed/);
});

Deno.test("the verdict row carries three figures and no stat grid", () => {
  const markup = html();
  for (
    const label of [
      "new papers read",
      "genes written",
      "source quotes verified",
    ]
  ) {
    assertStringIncludes(markup, label);
  }
  assertEquals(markup.match(/class="pipeline-figure"/g)?.length, 3);
  assertNotMatch(
    markup,
    /pipeline-stats|pipeline-provenance|pipeline-tokens|pipeline-head-meta/,
  );
});

Deno.test("the method and the cost are not on the card", () => {
  const card = html();
  assertNotMatch(card, /claude-opus-5|high effort|Prompt v6|PubMed search/);
  assertNotMatch(html(), /1\.38/);
});

Deno.test("each step is one row: its outcome, a flag only if one is due, its time", () => {
  const markup = html();
  assertEquals(
    markup.match(/class="pipeline-step"/g)?.length,
    RUN.steps.length,
  );
  assertStringIncludes(markup, "Retrieve &amp; extract");
  assertStringIncludes(markup, "papers matched");
  assertStringIncludes(markup, "findings extracted");
  assertStringIncludes(markup, "1 paper failed");
  assertStringIncludes(markup, formatDuration(131.4));
  assertNotMatch(markup, /pipeline-step-glyph|pipeline-badge-count/);
});

Deno.test("a row with a note is a button, a failed one starts open, and one without is not a control", () => {
  // RUN: step 3 holds notes, the merge failed, steps 1 and 2 hold nothing.
  const markup = html();
  const heads = markup.match(/<button[^>]*class="pipeline-step-head"[^>]*>/g) ??
    [];
  assertEquals(heads.length, RUN.steps.length);
  assertEquals(heads.filter((h) => /\sdisabled/.test(h)).length, 2);
  assertEquals(
    heads.filter((h) => h.includes('aria-expanded="false"')).length,
    1,
  );
  assertEquals(
    heads.filter((h) => h.includes('aria-expanded="true"')).length,
    1,
  );
  // A row that does not open names no panel.
  assertEquals(heads.filter((h) => h.includes("aria-controls")).length, 2);
});

Deno.test("a note is prose with linked papers, tinted by whether it needs a look", () => {
  const markup = html();
  assertMatch(
    markup,
    /class="pipeline-note pipeline-tint-muted"[^>]*>.*?24 genes did not clear/s,
  );
  assertMatch(
    markup,
    /class="pipeline-note pipeline-tint-ember"[^>]*>.*?1 paper had no retrievable text/s,
  );
  assertStringIncludes(
    markup,
    'href="https://pubmed.ncbi.nlm.nih.gov/19539236/"',
  );
  assertNotMatch(markup, /pipeline-actions|and \d+ more/);
});

Deno.test("subjects past the eighth sit behind a disclosure", () => {
  const many = Array.from({ length: 34 }, (_, i) => String(42000000 + i));
  const run = runWith({
    steps: [
      step({
        status: "warning",
        warnings: [warning("model_fallback", 34, many)],
      }),
    ],
  });
  const markup = render(run);
  assertMatch(markup, /<details[^>]*>\s*<summary[^>]*>Show all 34<\/summary>/);
  assertEquals(markup.match(/pubmed\.ncbi\.nlm\.nih\.gov/g)?.length, 34);
});

Deno.test("a subject that is not a paper is plain text", () => {
  const run = runWith({
    steps: [
      step({
        status: "warning",
        warnings: [warning("genes_rejected", 2, ["GENE1", "GENE2"])],
      }),
    ],
  });
  const markup = render(run);
  assertStringIncludes(markup, "GENE1, GENE2");
  assertNotMatch(markup, /pubmed/);
});

Deno.test("a failed run trades its verdict for a statement of what stopped", () => {
  const markup = render(runWith({ status: "failed", database: null }));
  assertStringIncludes(
    markup,
    "The run stopped at step 5, Merge to database.",
  );
  assertStringIncludes(markup, "Nothing was written to the database");
  assertNotMatch(markup, /pipeline-figure/);
});

Deno.test("a failure reads as a sentence, a meaning, then the raw detail", () => {
  // The console text is kept but demoted; it is never the headline.
  const markup = html();
  assertStringIncludes(
    markup,
    "The service asked us to slow down (E-utilities fetch)",
  );
  assertStringIncludes(markup, "Runs back off and retry");
  assertStringIncludes(markup, "HTTP 429 Too Many Requests");
  assertMatch(markup, /pipeline-error-detail/);
});

Deno.test("a run that wrote nothing calls its genes validated, not accepted", () => {
  // Accepted means what reached the database. A run that failed before
  // its merge has `database: null` and still lists the genes its papers
  // validated -- they are what it has to show -- so "Accepted 24" over a
  // run that wrote no row was a claim the report itself contradicts.
  const unmerged = { ...RUN, status: "failed" as const, database: null };
  const drawer = detailsOf(unmerged);
  assertStringIncludes(drawer, "Genes validated, not written");
  assert(!drawer.includes("Genes accepted"));
  assertStringIncludes(drawer, "2 validated");
  assert(!drawer.includes("2 accepted"));

  // A run that merged keeps the word it earned.
  assertStringIncludes(details(), "Genes accepted");
  assertStringIncludes(details(), "2 accepted");
});

Deno.test("the API inventory names the service, method and endpoint", () => {
  const markup = details();
  assertStringIncludes(markup, "E-utilities fetch");
  assertStringIncludes(markup, "GET");
  assertStringIncludes(markup, "/entrez/eutils/efetch.fcgi");
  assertStringIncludes(
    markup,
    "32 calls · 1 retried · 1 failed · 4.1 s · 51.2 kB",
  );
});

Deno.test("run details is a closed dialog that holds nothing until it opens", () => {
  const markup = html();
  assertMatch(markup, /<dialog[^>]*aria-labelledby="[^"]+"/);
  assertNotMatch(markup, /<dialog[^>]* open/);
  // Its content mounts on first opening: a closed dialog costs the page a
  // heading and a close button, not a thousand records.
  assertNotMatch(markup, /pipeline-record|role="tab"/);
  // The drawer it replaces sat inside the card and made the card inert.
  assertNotMatch(markup, /<aside|class="pipeline-drawer"| inert/);
});

Deno.test("the title row holds the heading and the trigger, whatever the run recorded", () => {
  // A run that failed before it read a paper has no findings, papers or
  // services, and still has a method: Setup is always there, so the
  // trigger is too.
  const bare = runWith({
    papersDetail: { shown: 0, total: 0, items: [] },
    acceptedGenes: { shown: 0, total: 0, items: [] },
    rejectedGenes: { shown: 0, total: 0, items: [] },
    apis: [],
  });
  for (const markup of [html(), render(bare)]) {
    const open = markup.indexOf('class="pipeline-title-row"');
    assert(open > -1, "the title row renders");
    const row = markup.slice(open, markup.indexOf("</div>", open));
    assertStringIncludes(row, "Last Pipeline Run");
    assertMatch(row, /<button[^>]*aria-haspopup="dialog"[^>]*>\s*Run details/);
    assertNotMatch(row, /aria-expanded|aria-controls/);
  }
});

Deno.test("the tabs are a tablist with one selected, and only its panel is in the page", () => {
  const markup = details("findings");
  assertEquals(markup.match(/role="tablist"/g)?.length, 1);
  assertEquals(markup.match(/role="tab"/g)?.length, 4);
  assertEquals(markup.match(/aria-selected="true"/g)?.length, 1);
  assertEquals(markup.match(/aria-selected="false"/g)?.length, 3);
  assertEquals(markup.match(/role="tabpanel"/g)?.length, 1);
  assertMatch(markup, /role="tab"[^>]*aria-selected="true"[^>]*>.*?Findings/s);
  // One tab stop: the arrows move between tabs.
  assertEquals(markup.match(/role="tab"[^>]*tabindex="-1"/g)?.length, 3);
  // Each tab says what it counts, by the list's total.
  assertMatch(markup, />Papers.*?15</s);
});

Deno.test("a run with nothing listed has Setup alone", () => {
  const empty = runWith({
    acceptedGenes: { total: 0, shown: 0, items: [] },
    rejectedGenes: { total: 0, shown: 0, items: [] },
    papersDetail: { total: 0, shown: 0, items: [] },
    apis: [],
  });
  const markup = detailsOf(empty);
  assertEquals(markup.match(/role="tab"/g)?.length, 1);
  assertStringIncludes(markup, "Setup");
  assertNotMatch(markup, /pipeline-record|pipeline-api/);
});

Deno.test("the services are in the run details, not on the card", () => {
  // Endpoint paths and HTTP verbs are a maintainer's register, and the
  // card sits above a Data Sources panel that names the same class of
  // thing in prose.
  assertNotMatch(html(), /efetch\.fcgi|pipeline-api/);
  const services = details("services");
  assertStringIncludes(services, "E-utilities fetch");
  assertStringIncludes(services, "/entrez/eutils/efetch.fcgi");
  // A run that reached only an API still has that tab.
  const apisOnly = runWith({
    papersDetail: { shown: 0, total: 0, items: [] },
    acceptedGenes: { shown: 0, total: 0, items: [] },
    rejectedGenes: { shown: 0, total: 0, items: [] },
  });
  assertEquals(detailTabs(apisOnly).map((entry) => entry.id), [
    "services",
    "setup",
  ]);
});

Deno.test("Setup holds what left the card: the method, the usage, the step log", () => {
  const markup = details("setup");
  for (
    const text of [
      "PubMed search",
      "claude-opus-5",
      "high effort",
      "v6",
      "0.45 to update, 0.65 to add",
      "Searched PubMed over the last 7 days: 40 papers matched",
      "Retrieved full text for 10, abstract only for 5",
    ]
  ) {
    assertStringIncludes(markup, text);
  }
  // A step that recorded no sentence still has its line in the log.
  assertStringIncludes(markup, "Nothing to report");
});

Deno.test("Setup names the fallback, the Batch API and the prompt's bytes only when the run recorded them", () => {
  assertNotMatch(details("setup"), /Fallback|Batch API|<code/);
  const full = runWith({
    config: {
      ...RUN.config,
      fallbackModel: "claude-opus-4-8",
      batch: true,
      disease: "csvd",
      promptSha256: "70908abc0302" + "0".repeat(52),
    },
  });
  const markup = detailsOf(full, "setup");
  assertStringIncludes(markup, "Fallback model");
  assertStringIncludes(markup, "claude-opus-4-8");
  assertStringIncludes(markup, "Batch API");
  // The whole hash: the card showed its first twelve characters.
  assertMatch(markup, /<code[^>]*>csvd 70908abc03020{52}<\/code>/);
});

Deno.test("the two quote numbers are reported as two numbers", () => {
  // `verbatim` asks whether the sentence is in the paper, of every finding;
  // `cited` asks whether the API attested to that span, which is bounded
  // by how much prose the model wrote. One averaged rate would report a
  // quality figure the second number cannot carry.
  const markup = details("setup");
  assertStringIncludes(markup, "25 of 26 found in their paper");
  assertMatch(markup, /8 attested by the model(&#39;|')s own citations/);
});

Deno.test("token use is reported and the cost is not", () => {
  const markup = details("setup");
  assertStringIncludes(markup, "175,584");
  // The rate is of the input, not of the count beside it: `totalTokens` is
  // the uncached input plus the output, so "175,584 tokens, 47% served
  // from cache" read as a share of a number that holds no cached token.
  assertStringIncludes(markup, "47% of input served from cache");
  assertNotMatch(details() + html(), /1\.38/);
});

Deno.test("a step that did the same thing twice lists it twice", () => {
  // A re-entered step merges its visits' actions, and two visits that
  // did the same thing produce the same sentence; a text-keyed list
  // collapsed them.
  const twice = runWith({
    steps: [{
      ...RUN.steps[0],
      actions: ["Recorded 9 processed PMIDs", "Recorded 9 processed PMIDs"],
    }],
  });
  const rows = detailsOf(twice, "setup").match(/Recorded 9 processed PMIDs/g);
  assertEquals(rows?.length, 2);
});

Deno.test("the drawer carries a gene's evidence, not just its name", () => {
  const markup = details();
  assertStringIncludes(markup, "HTRA1");
  assertStringIncludes(markup, "HtrA serine peptidase 1");
  assertStringIncludes(markup, "extreme-cSVD");
  assertStringIncludes(markup, "MAGMA");
  assertStringIncludes(markup, "Validated monogenic cause of cSVD.");
  assertStringIncludes(
    markup,
    "The diagnosis is established by molecular testing.",
  );
});

Deno.test("a rejection is badged by kind and keeps its own numbers", () => {
  // The badge says the category, so the detail must not repeat it -- and
  // the comparison the pipeline recorded has to survive the split.
  const markup = details();
  assertStringIncludes(markup, "Low confidence</span>0.60 &lt; 0.65");
  assert(!markup.includes("Low confidence: 0.60"));
});

Deno.test("an unrecognised rejection reason is shown whole", () => {
  // The fallback badge must not cut a sentence it does not understand.
  const odd = {
    ...RUN,
    rejectedGenes: {
      ...RUN.rejectedGenes,
      items: [{
        ...RUN.rejectedGenes.items[0],
        reasons: ["Something the encoding has never seen"],
      }],
    },
  };
  const markup = detailsOf(odd);
  assertStringIncludes(
    markup,
    "Error</span>Something the encoding has never seen",
  );
});

Deno.test("a rejected gene's PMID links to the paper like an accepted one's", () => {
  const links = details().match(/pubmed\.ncbi\.nlm\.nih\.gov\/32517579\//g) ??
    [];
  // Once from the rejected card, once from the paper row.
  assertEquals(links.length, 2);
});

Deno.test("a gene's Mendelian randomization support is shown when it has it", () => {
  // Recorded on every gene and rendered on none. "Yes" only: "No" on
  // every row would be noise.
  const shown = /Mendelian randomization<\/dt><dd\s*>Yes<\/dd>/;
  assertNotMatch(details(), shown);
  const supported = {
    ...RUN,
    acceptedGenes: {
      ...RUN.acceptedGenes,
      items: [{ ...RUN.acceptedGenes.items[0], mendelianRandomization: true }],
    },
  };
  const markup = detailsOf(supported);
  assertMatch(markup, shown);
});

Deno.test("a citation-only gene says so in place of the claims it did not make", () => {
  // The merge gave it a PMID, a quote and a score and withheld the rest,
  // so the record carries no trait or omics pill; without a word for it
  // the gene would read as one the model found nothing about.
  const cited = {
    ...RUN,
    acceptedGenes: {
      shown: 1,
      total: 1,
      items: [{
        ...RUN.acceptedGenes.items[0],
        gwasTraits: [],
        omicsEvidence: [],
        mendelianRandomization: null,
        citationOnly: true,
      }],
    },
  };
  const drawer = detailsOf(cited);
  assertStringIncludes(drawer, "Written as");
  assertStringIncludes(drawer, "Citation only");
  assert(!details().includes("Citation only"));
});

Deno.test("a record names its fields in a column of labels, not in chips", () => {
  // Every field name used to be a chip of its own, the same shape as the
  // values beside it, so a line read as five pills with nothing to say
  // which was the label. The names are the terms of a description list now,
  // each beside its value.
  const markup = details();
  for (
    const name of [
      "Protein",
      "GWAS trait",
      "Omics evidence",
      "Causal evidence",
      "Source quote",
      "Reason",
    ]
  ) {
    assertMatch(
      markup,
      new RegExp(`<dt>(?:<svg[\\s\\S]*?</svg>)?${name}</dt><dd`),
      `"${name}" is a term beside its value`,
    );
  }
});

Deno.test("the drawer says what each number is, in words", () => {
  // A confidence, a PMID, a duration and two gene counts were glyphs with
  // visually hidden names, so a sighted reader decoded a bar chart and a
  // check mark to learn what "1.00" and "2" were.
  const markup = details();
  assertNotMatch(markup, /visually-hidden/);
  const text = markup.replace(/<[^>]+>/g, "");
  assertStringIncludes(text, "Confidence 1.00");
  assertStringIncludes(text, "PMID 20437615");
  assertStringIncludes(text, "11 s · 2 accepted · 1 rejected");
});

Deno.test("only a verdict carries a colour; a listed value is a neutral pill", () => {
  const markup = details();
  // The rejection reason is the verdict: glyph, word and its own tint.
  assertMatch(
    markup,
    /<span class="pipeline-chip pipeline-tint-highlight"><svg[\s\S]*?<\/svg>Low confidence<\/span>/,
  );
  // A trait, an omics method and a paper's source are values from a fixed
  // vocabulary: a neutral pill, and no glyph to decode.
  for (
    const value of ["extreme-cSVD", "MAGMA", "Full text from Europe PMC"]
  ) {
    assertStringIncludes(
      markup,
      `<span class="pipeline-chip pipeline-tint-muted">${value}</span>`,
    );
  }
});

Deno.test("a paper's source reads as words, and its time is shown", () => {
  const markup = details();
  assertStringIncludes(markup, "Full text from Europe PMC");
  assert(!markup.includes(">europepmc<"));
  assertStringIncludes(markup, "11 s");
});

Deno.test("a paper with no retrievable text does not read as 'none'", () => {
  const none = {
    ...RUN,
    papersDetail: {
      ...RUN.papersDetail,
      items: [{
        ...RUN.papersDetail.items[0],
        source: "none",
        fulltext: false,
      }],
    },
  };
  const markup = detailsOf(none);
  assertStringIncludes(markup, "No text retrieved");
  assert(!markup.includes(">none<"));
});

Deno.test("one identifier reads one way: every PMID is named and linked alike", () => {
  // The paper rows once carried a bare <a>, so the same PMID rendered
  // ember at 16px in one drawer section and indigo at 13px in another.
  // Every PubMed link is now the same element, and each says what it is.
  const markup = details();
  const pubmed = (markup.match(/<a\b[^>]*>/g) ?? []).filter((tag) =>
    tag.includes("pubmed.ncbi.nlm.nih.gov")
  );
  assert(pubmed.length > 0, "the drawer links out to PubMed");
  for (const tag of pubmed) {
    assertStringIncludes(tag, 'class="pipeline-pmid"');
  }
  const named = markup.match(/PMID <a\b[^>]*class="pipeline-pmid"/g) ?? [];
  assertEquals(named.length, pubmed.length);
});

Deno.test("a truncated list says so rather than reading as complete", () => {
  const markup = details();
  assertStringIncludes(markup, "Showing 1 of 24");
  assertStringIncludes(markup, "Showing 1 of 24");
  assertStringIncludes(markup, "Showing 1 of 15");
});

Deno.test("no run renders nothing at all", () => {
  assertEquals(renderToString(<PipelineRunView run={null} />), "");
});

Deno.test("step warnings preserve the detail explaining the flagged record", () => {
  const run = {
    ...RUN,
    steps: [{
      ...RUN.steps[0],
      warnings: [{
        kind: "batch_validation",
        title: "1 batch check flagged something",
        count: 1,
        detail: "Gene NOTCH3 extracted from 4 different papers",
        subjects: [],
      }],
    }],
  };
  assertStringIncludes(
    renderToString(<PipelineRunView run={run} />),
    "Gene NOTCH3 extracted from 4 different papers",
  );
});

Deno.test("duplicate step ordinals still reference distinct detail panels", () => {
  const run = {
    ...RUN,
    steps: [
      { ...RUN.steps[0], warnings: [warning("api_retried")] },
      {
        ...RUN.steps[0],
        label: "Second visit",
        warnings: [warning("api_retried")],
      },
    ],
  };
  const markup = renderToString(<PipelineRunView run={run} />);
  const controls = [...markup.matchAll(/aria-controls="([^"]+-step-[^"]+)"/g)]
    .map((match) => match[1]);
  assertEquals(controls.length, 2);
  assertEquals(new Set(controls).size, 2);
  for (const id of controls) {
    assertEquals(markup.split(`id="${id}"`).length - 1, 1);
  }
});

Deno.test("deferred paper records preserve retrieval failures", () => {
  const failed = {
    ...RUN,
    papersDetail: {
      ...RUN.papersDetail,
      items: [{
        ...RUN.papersDetail.items[0],
        error: "Publisher request timed out",
      }],
    },
  };
  const markup = detailsOf(failed);
  assertStringIncludes(markup, "Publisher request timed out");
  assertStringIncludes(markup, "Reason");
});

const withPaper = (
  paper: Partial<PipelineRun["papersDetail"]["items"][0]>,
) => ({
  ...RUN,
  papersDetail: {
    ...RUN.papersDetail,
    items: [{ ...RUN.papersDetail.items[0], ...paper }],
  },
});

Deno.test("a refused paper names the classifier that declined it", () => {
  const markup = detailsOf(withPaper({
    error: "Refused by safety classifier for PMID 32517579 (category: bio)",
    refusal: "bio",
    extractionModel: null,
    geneCount: 0,
    rejectedCount: 0,
  }));
  assertStringIncludes(markup, "Biology safety classifier");
  assertStringIncludes(markup, "Declined by");
});

Deno.test("a paper the fallback served names its model, and only that one", () => {
  const served = detailsOf(
    withPaper({ extractionModel: "claude-opus-4-8", refusal: "bio" }),
  );
  assertStringIncludes(served, "claude-opus-4-8");
  assertStringIncludes(served, "Biology safety classifier");
  // A paper the requested model extracted carries no pill: it would repeat
  // the header on every row.
  assert(!details().includes("Extracted by"));
});

Deno.test("a gene's omics evidence reads as the table prints it, without the wire form", () => {
  const [gene] = RUN.acceptedGenes.items;
  const markup = detailsOf({
    ...RUN,
    acceptedGenes: {
      ...RUN.acceptedGenes,
      items: [{ ...gene, omicsEvidence: ["TWAS;Q: a*, b", "MAGMA"] }],
    },
  });
  assertStringIncludes(markup, "TWAS (Q: a, b)");
  assertStringIncludes(markup, "MAGMA");
  assert(!markup.includes("TWAS;Q"));
  assert(!markup.includes("a*"));
});
