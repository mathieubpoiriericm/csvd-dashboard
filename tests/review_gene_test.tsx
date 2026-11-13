/**
 * One gene's review page, rendered as the server draws it from a synthetic
 * round: the change against gold, the findings behind it, the committee's
 * answers and the gene's whole history.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";
import { h } from "preact";
import { HttpError } from "fresh";

import ReviewGenePage, { ReviewGeneContent } from "../routes/review/gene.tsx";
import { GeneDiff } from "../components/review/GeneDiff.tsx";
import { Findings } from "../components/review/Findings.tsx";
import { CommitteeVotes } from "../components/review/CommitteeVotes.tsx";
import { History } from "../components/review/History.tsx";
import { currentReview } from "../lib/review/current.ts";
import {
  FIELD_LABELS,
  geneHref,
  settlesWords,
  STANDING_LABELS,
  tallyWords,
} from "../lib/review/display.ts";
import { reviewGene } from "../lib/review/rules.ts";
import { reviewState } from "../lib/review/summary.ts";
import { ACCOUNTS, plantings } from "../lib/review/simulate.ts";
import type { Planted } from "../lib/review/simulate.ts";
import type { AnswerEvent, ReviewEvent } from "../lib/review/events.ts";
import { PIPELINE_ACTOR } from "../lib/review/events.ts";
import { simulatedTime } from "../lib/review/time.ts";
import { SIMULATED_NOTE } from "../lib/review/copy.ts";
import { sampleChange, sampleFinding, sampleRound } from "./fixtures/review.ts";
import { sampleGene } from "./fixtures/rows.ts";
import { escapeHtml } from "./helpers/html.ts";

const s = currentReview(true, sampleRound(12))!;
const run = s.round.runTimestamp;

/** The body rows of the first table in `html`, each as its own HTML. */
const rows = (html: string): string[] => {
  const body = html.match(/<tbody>(.*?)<\/tbody>/s)?.[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>.*?<\/tr>/gs)].map((m) => m[0]);
};

/** The items of the first `<ol>` or `<ul>` with the given class. */
const items = (html: string, cls: string): string[] => {
  const list = html.match(
    new RegExp(`<(ol|ul) class="${cls}"[^>]*>(.*?)</\\1>`, "s"),
  )?.[2] ?? "";
  return [...list.matchAll(/<li[^>]*>.*?<\/li>(?=<li|$)/gs)].map((m) => m[0]);
};

/** Text with its tags dropped and its spaces collapsed. */
const text = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const indexOf = (gene: string) =>
  s.round.changes.findIndex((c) => c.gene === gene);

/** The gene the simulator planted a scripted case on. */
const planted = (kind: Planted): string => {
  const at = [...plantings(s.round.changes)].find(([, k]) => k === kind)![0];
  return s.round.changes[at].gene;
};

Deno.test("the whole stored row is in view, changed fields marked", () => {
  const html = renderToString(<GeneDiff change={sampleChange()} />);
  const all = rows(html);
  assertEquals(all.length, 12);
  assertEquals(
    all.map((row) => row.match(/<th scope="row"[^>]*>(.*?)<\/th>/s)?.[1]),
    Object.values(FIELD_LABELS),
  );
  // Only the GWAS traits changed: that row is marked, the eleven others muted.
  const traits = all[Object.keys(FIELD_LABELS).indexOf("gwasTrait")];
  assertStringIncludes(traits, "<ins>TRAIT-A</ins>");
  assert(!traits.includes("review-diff-same"));
  // The sentinel the run replaced is shown as it is, never struck.
  assertStringIncludes(traits, "(none found)");
  assert(!traits.includes("<del>"), traits);
  const muted = all.filter((row) => row.includes('class="review-diff-same"'));
  assertEquals(muted.length, 11);
  // The gene's own name is a row, in both columns.
  assertEquals(
    (all[0].match(/>GENE1</g) ?? []).length,
    2,
  );
});

Deno.test("a changed list keeps its unchanged values and strikes a removed one", () => {
  const change = sampleChange({
    after: sampleGene({ references: ["10000001", "10000003"] }),
    before: sampleGene({
      references: ["10000001", "10000002"],
      confidence: null,
      sourceQuote: "(not yet extracted)",
    }),
    fields: [{
      field: "references",
      before: ["10000001", "10000002"],
      after: ["10000001", "10000003"],
      added: ["10000003"],
      removed: ["10000002"],
    }, {
      field: "confidence",
      before: null,
      after: 0.65,
      added: [],
      removed: [],
    }, {
      field: "sourceQuote",
      before: "(not yet extracted)",
      after: "A new quote.",
      added: [],
      removed: [],
    }],
  });
  const all = rows(renderToString(<GeneDiff change={change} />));
  const keys = Object.keys(FIELD_LABELS);
  const refs = all[keys.indexOf("references")];
  const after = refs.match(/<td[^>]*>.*?<\/td>\s*<td[^>]*>(.*?)<\/td>/s)?.[1];
  // Unchanged first, then the added one, then the removed one.
  assertEquals(
    [...(after ?? "").matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]),
    ["10000001", "<ins>10000003</ins>", "<del>10000002</del>"],
  );
  // A changed scalar shows both its values.
  const score = all[keys.indexOf("confidence")];
  assertStringIncludes(score, "<ins>0.65</ins>");
  assertStringIncludes(score, "not recorded");
  const quote = all[keys.indexOf("sourceQuote")];
  assertStringIncludes(quote, "(not yet extracted)");
  assertStringIncludes(quote, "<ins>A new quote.</ins>");
  assert(!quote.includes("<del>(not yet extracted)"));
  assertEquals(
    all.filter((row) => row.includes("review-diff-same")).length,
    9,
  );
});

Deno.test("a new gene has no gold column value", () => {
  const change = s.round.changes.find((c) => c.kind === "new")!;
  const all = rows(renderToString(<GeneDiff change={change} />));
  assertEquals(all.length, 12);
  for (const row of all) {
    assertStringIncludes(row, "Not in the gold data");
    // Nothing of a new gene is unchanged.
    assert(!row.includes("review-diff-same"), row);
  }
  assertStringIncludes(all[3], "TRAIT-A");
});

Deno.test("a finding shows its paper, score, quote and how it was read", () => {
  const html = renderToString(
    <Findings
      findings={[
        sampleFinding({ confidence: 0.65, causalEvidenceSummary: "Summary." }),
        sampleFinding({
          pmid: "10000002",
          fulltext: false,
          citationOnly: true,
        }),
      ]}
    />,
  );
  const [first, second] = items(html, "review-findings");
  assertStringIncludes(
    first,
    'href="https://pubmed.ncbi.nlm.nih.gov/10000001/"',
  );
  assertStringIncludes(text(first), "PMID 10000001");
  assertStringIncludes(text(first), "full text");
  assertStringIncludes(text(first), "confidence 0.65");
  assertStringIncludes(text(first), "extracted by model-a");
  assertStringIncludes(first, "Summary.");
  assertStringIncludes(
    first,
    `<blockquote class="review-quote">${
      escapeHtml(sampleFinding().sourceQuote!)
    }</blockquote>`,
  );
  assert(!first.includes("citation only"));
  assertStringIncludes(text(second), "abstract only");
  assertStringIncludes(text(second), "citation only");
});

Deno.test("a finding with nothing known about its paper says nothing of it", () => {
  const html = renderToString(
    <Findings
      findings={[sampleFinding({
        pmid: null,
        confidence: null,
        fulltext: null,
        extractionModel: null,
        causalEvidenceSummary: null,
        sourceQuote: null,
      })]}
    />,
  );
  const [only] = items(html, "review-findings");
  for (
    const absent of [
      "PMID",
      "full text",
      "abstract only",
      "confidence",
      "extracted by",
      "<blockquote",
      "null",
      "undefined",
    ]
  ) {
    assert(!only.includes(absent), `${absent} in ${only}`);
  }
  // No findings at all says so rather than drawing an empty list.
  assertStringIncludes(
    renderToString(<Findings findings={[]} />),
    "No findings",
  );
});

Deno.test("each voter's answer is listed and the observer is not", () => {
  const i = indexOf(planted("rejected"));
  const review = s.reviews[i];
  const html = renderToString(
    <CommitteeVotes review={review} accounts={s.accounts} />,
  );
  assertStringIncludes(html, tallyWords(review.tally));
  const voters = items(html, "review-votes");
  assertEquals(voters.length, 11);
  assert(!html.includes("Reviewer L"), "the observer is listed");
  // The chair, and only the chair, is marked.
  assertStringIncludes(text(voters[0]), "Reviewer A chair");
  assertEquals(voters.filter((v) => v.includes(">chair<")).length, 1);
  // Reviewer B changed their mind: the current answer is the one shown.
  assertStringIncludes(text(voters[1]), "Reviewer B Reject");
  assertStringIncludes(text(voters[8]), "Reviewer I Accept");
  assertStringIncludes(text(voters[9]), "Reviewer J Abstain");
  // A gene nobody has answered says "Not yet" for every voter.
  const idle = renderToString(
    <CommitteeVotes
      review={s.reviews[indexOf(planted("not_started"))]}
      accounts={s.accounts}
    />,
  );
  assertEquals(
    items(idle, "review-votes").filter((v) => v.includes("Not yet")).length,
    11,
  );
});

Deno.test("an in-review gene says what would settle it", () => {
  const i = indexOf(planted("in_review"));
  const review = s.reviews[i];
  assertEquals(review.standing, "in_review");
  const html = renderToString(
    <CommitteeVotes review={review} accounts={s.accounts} />,
  );
  assertStringIncludes(html, settlesWords(review.tally));
  // A settled gene does not.
  const settled = s.reviews[indexOf(planted("accepted"))];
  assertEquals(settled.standing, "accepted");
  assert(
    !renderToString(
      <CommitteeVotes review={settled} accounts={s.accounts} />,
    ).includes("Settles at"),
  );
});

Deno.test("the history is newest first, in simulated days, with edits and reasons", () => {
  // One voter accepts with an edit that drops the trait it added.
  const review = s.reviews[indexOf(planted("edits_to_reconcile"))];
  const html = renderToString(
    <History review={review} accounts={s.accounts} runTimestamp={run} />,
  );
  const entries = items(html, "review-history");
  assertEquals(entries.length, review.history.length);
  review.history.forEach((event, k) => {
    assertStringIncludes(
      entries[k],
      `<span class="review-history-time">${
        simulatedTime(event.at, run)
      }</span>`,
    );
  });
  // A simulated time is never given as a calendar date.
  assert(!html.includes("<time"), "a <time> element");
  assert(!html.includes("datetime="), "a datetime attribute");
  const times = review.history.map((e) => Date.parse(e.at));
  assertEquals(times, [...times].sort((a, b) => b - a));
  // The oldest is the run's proposal.
  const last = entries[entries.length - 1];
  assertStringIncludes(text(last), "Pipeline run proposed");
  assertStringIncludes(last, "Day 0, 10:00");
  // The edit names its field, strikes what it drops, and carries the reason.
  const k = review.history.findIndex((e) =>
    e.type === "answer" && e.answer === "accept_with_edits"
  );
  const edited = review.history[k] as AnswerEvent;
  const entry = entries[k];
  assertStringIncludes(text(entry), "accepted with edits");
  assertStringIncludes(text(entry), `${FIELD_LABELS.gwasTrait}:`);
  assertStringIncludes(entry, "<del>TRAIT-A</del>");
  assertStringIncludes(entry, escapeHtml(edited.reason!));
  // The plain verbs of a first answer.
  assertStringIncludes(text(html), "Reviewer A accepted");
});

Deno.test("a ruling reads as one", () => {
  const review = s.reviews[indexOf(planted("resolved_by_chair"))];
  const html = renderToString(
    <History review={review} accounts={s.accounts} runTimestamp={run} />,
  );
  const [newest] = items(html, "review-history");
  assertStringIncludes(text(newest), "Reviewer A ruled: accepted");
  assertStringIncludes(text(html), "rejected");
  assertStringIncludes(text(html), "abstained");
});

Deno.test("a change of mind reads as one", () => {
  const review = s.reviews[indexOf(planted("rejected"))];
  const html = text(renderToString(
    <History review={review} accounts={s.accounts} runTimestamp={run} />,
  ));
  assertStringIncludes(html, "Reviewer B changed answer: Accept to Reject");
  // The first answer is still there, as a first answer.
  assertStringIncludes(html, "Reviewer B accepted");
  assert(!html.includes("changed answer: Reject"));
});

Deno.test("a stale answer is shown as superseded", () => {
  const change = sampleChange({ gene: "GENE1", version: "v2" });
  const stale: ReviewEvent = {
    id: "e9999",
    at: "2026-01-06T09:12:00Z",
    roundId: "round-1",
    gene: "GENE1",
    version: "v1",
    actor: "r03",
    type: "answer",
    answer: "reject",
    edits: [],
    reason: "Written against the earlier version.",
  };
  const current: ReviewEvent = {
    ...stale,
    id: "e9998",
    at: "2026-01-07T09:12:00Z",
    version: "v2",
    actor: "r04",
    answer: "accept",
    reason: null,
  };
  const proposal: ReviewEvent = {
    id: "e9997",
    at: "2026-01-05T10:00:00Z",
    roundId: "round-1",
    gene: "GENE1",
    version: "v2",
    actor: PIPELINE_ACTOR,
    type: "proposal",
  };
  const review = reviewGene(change, ACCOUNTS, [proposal, stale, current]);
  const html = renderToString(
    <History review={review} accounts={ACCOUNTS} runTimestamp={run} />,
  );
  const [newest, older, oldest] = items(html, "review-history");
  assert(!newest.includes("superseded"));
  assertStringIncludes(text(older), "Reviewer C rejected");
  assertStringIncludes(text(older), "Day 1, 09:12");
  assertStringIncludes(text(older), "superseded");
  assert(!oldest.includes("superseded"));
  // The stale answer is in the history and out of the tally.
  assertEquals(review.tally.reject, 0);
});

Deno.test("a gene whose key holds a slash has a page", () => {
  const round = sampleRound(3);
  round.changes.push(sampleChange({ gene: "AB1/2", version: "v9" }));
  const state = reviewState(round, ACCOUNTS, []);
  // The queue's link carries the key through the query string intact.
  const gene = new URL(geneHref("AB1/2"), "http://localhost").searchParams
    .get("g");
  assertEquals(gene, "AB1/2");
  const html = renderToString(<ReviewGeneContent state={state} gene={gene} />);
  assertStringIncludes(html, "<h1>AB1/2</h1>");
  assertStringIncludes(html, ">Claims changed<");
  assertStringIncludes(html, STANDING_LABELS.not_started);
});

Deno.test("the page says the committee is simulated and leads back", () => {
  const html = renderToString(<ReviewGeneContent state={s} gene="GENE5" />);
  assertStringIncludes(html, escapeHtml(SIMULATED_NOTE));
  assertStringIncludes(html, "<h1>GENE5</h1>");
  assertStringIncludes(
    html,
    '<a class="review-back" href="/review" aria-current="false">Back to the review queue</a>',
  );
  for (const heading of ["Findings", "Committee", "History"]) {
    assertStringIncludes(html, `>${heading}</h2>`);
  }
  assert(!/NaN|undefined/.test(html), html);
});

Deno.test("an unknown gene is not found", () => {
  const err = assertThrows(
    () => renderToString(<ReviewGeneContent state={s} gene="GENE99" />),
    HttpError,
  );
  assertEquals(err.status, 404);
  assertThrows(
    () => renderToString(<ReviewGeneContent state={s} gene={null} />),
    HttpError,
  );
});

Deno.test("the route is not found without a gene it knows", () => {
  // Whether or not a round is published: with none every gene is a 404, and
  // with one these two are still not in it.
  for (const query of ["", "?g=", "?g=NOT-A-GENE-0"]) {
    const err = assertThrows(() =>
      renderToString(
        h(
          ReviewGenePage as unknown as preact.ComponentType<{ url: URL }>,
          { url: new URL(`http://localhost/review/gene${query}`) },
        ),
      ), HttpError);
    assertEquals(err.status, 404);
  }
});

Deno.test("a finding cited by DOI is labelled and linked as a DOI", () => {
  const html = renderToString(
    <Findings findings={[sampleFinding({ pmid: "10.1000/xyz123" })]} />,
  );
  const [only] = items(html, "review-findings");
  assertStringIncludes(text(only), "DOI 10.1000/xyz123");
  assertStringIncludes(only, 'href="https://doi.org/10.1000/xyz123"');
  assert(!only.includes("PMID"), only);
  assert(!only.includes("pubmed"), only);
});

Deno.test("omics entries print as the Genes page prints them", () => {
  const change = sampleChange({
    before: sampleGene({ evidenceFromOtherOmicsStudies: ["TWAS;tissue-a"] }),
    after: sampleGene({
      evidenceFromOtherOmicsStudies: ["TWAS;tissue-a", "PWAS;tissue-b"],
    }),
    fields: [{
      field: "evidenceFromOtherOmicsStudies",
      before: ["TWAS;tissue-a"],
      after: ["TWAS;tissue-a", "PWAS;tissue-b"],
      added: ["PWAS;tissue-b"],
      removed: [],
    }],
  });
  const all = rows(renderToString(<GeneDiff change={change} />));
  const omics =
    all[Object.keys(FIELD_LABELS).indexOf("evidenceFromOtherOmicsStudies")];
  assertStringIncludes(omics, ">TWAS (tissue-a)</li>");
  assertStringIncludes(omics, "<ins>PWAS (tissue-b)</ins>");
  assert(!omics.includes(";"), omics);
});
