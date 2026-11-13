/**
 * The review queue, rendered as the server draws it from a synthetic round:
 * one row per changed gene, filtered by links, with the committee's standing.
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

import ReviewQueuePage, {
  queueFilters,
  ReviewQueueContent,
} from "../routes/review/index.tsx";
import { ReviewQueue } from "../components/review/ReviewQueue.tsx";
import { StandingBadge } from "../components/review/StandingBadge.tsx";
import { TallyBar } from "../components/review/TallyBar.tsx";
import { currentReview, REVIEW } from "../lib/review/current.ts";
import {
  geneHref,
  STANDING_LABELS,
  tallyWords,
} from "../lib/review/display.ts";
import { SIMULATED_NOTE } from "../lib/review/copy.ts";
import { formatLongDate } from "../lib/constants.ts";
import type { ReviewState } from "../lib/review/summary.ts";
import type { GeneReview, Standing } from "../lib/review/rules.ts";
import type { ReviewKind } from "../lib/types.ts";
import { sampleRound } from "./fixtures/review.ts";
import { escapeHtml } from "./helpers/html.ts";

const s = currentReview(true, sampleRound(12))!;

const queue = (
  state: ReviewState,
  kind: ReviewKind | null = null,
  standing: Standing | null = null,
) =>
  renderToString(
    <ReviewQueue state={state} kind={kind} standing={standing} />,
  );

/** The body rows of the queue's table, each as its own HTML. */
const rows = (html: string): string[] => {
  const body = html.match(/<tbody>(.*)<\/tbody>/s)?.[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>.*?<\/tr>/gs)].map((m) => m[0])
    .filter((row) => !row.includes("empty-state"));
};

/** A filter link's text with its tags dropped: "New gene 4". */
const linkText = (link: string) =>
  link.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/** The links of the filter row with the given accessible name. */
const filterLinks = (html: string, label: string): string[] => {
  const nav = html.match(
    new RegExp(`<nav[^>]*aria-label="${label}"[^>]*>(.*?)</nav>`, "s"),
  )?.[1] ?? "";
  return [...nav.matchAll(/<a [^>]*>.*?<\/a>/gs)].map((m) => m[0]);
};

const genesOf = (html: string) =>
  rows(html).map((row) =>
    row.match(/href="\/review\/gene\?g=([^"]*)"/)?.[1] ?? ""
  );

Deno.test("every gene of the round has a row", () =>
  assertEquals(
    rows(renderToString(
      <ReviewQueue state={s} kind={null} standing={null} />,
    )).length,
    12,
  ));

Deno.test("a filter keeps only its kind and says how many", () => {
  const html = queue(s, "new");
  // Kinds cycle new, claims, citation: GENE1, 4, 7 and 10 are new.
  assertEquals(genesOf(html), ["GENE1", "GENE4", "GENE7", "GENE10"]);
  const kinds = filterLinks(html, "Filter by kind");
  assertEquals(kinds.map(linkText), [
    "All 12",
    "New gene 4",
    "Claims changed 4",
    "Citation only 4",
  ]);
  // The active link, and only it, says so.
  const current = kinds.filter((k) => k.includes('aria-current="true"'));
  assertEquals(current.map(linkText), ["New gene 4"]);
  // The rest say "false" outright: left unset, Fresh would mark every link
  // to /review as the current page or its ancestor.
  for (const link of kinds.filter((k) => !current.includes(k))) {
    assertStringIncludes(link, 'aria-current="false"');
  }
  // The standing row counts the whole round, not the kind's share.
  const standings = filterLinks(html, "Filter by standing");
  assertEquals(standings.length, 7);
  assertEquals(linkText(standings[0]), "All 12");
  assertStringIncludes(standings[0], 'aria-current="true"');
  const listed = standings.slice(1).map(linkText);
  const order: Standing[] = [
    "not_started",
    "in_review",
    "conflict",
    "accepted",
    "rejected",
    "no_quorum",
  ];
  assertEquals(
    listed,
    order.map((st) =>
      `${STANDING_LABELS[st]} ${
        s.reviews.filter((r) => r.standing === st).length
      }`
    ),
  );
});

Deno.test("the two filters combine", () => {
  // The standing of the first new gene, so the pair matches at least one row.
  const standing = s.reviews[0].standing;
  const html = queue(s, "new", standing);
  const expected = s.round.changes
    .filter((c, i) => c.kind === "new" && s.reviews[i].standing === standing)
    .map((c) => c.gene);
  assert(expected.length > 0);
  assertEquals(genesOf(html), expected);
  // A kind link keeps the standing; a standing link keeps the kind; each
  // "All" clears its own row only.
  const kinds = filterLinks(html, "Filter by kind");
  assertStringIncludes(kinds[0], `href="/review?standing=${standing}"`);
  assertStringIncludes(
    kinds[2],
    `href="/review?kind=claims&amp;standing=${standing}"`,
  );
  const standings = filterLinks(html, "Filter by standing");
  assertStringIncludes(standings[0], 'href="/review?kind=new"');
  assertStringIncludes(
    standings[1],
    'href="/review?kind=new&amp;standing=not_started"',
  );
});

Deno.test("each row links to its gene and carries its standing", () => {
  const html = queue(s);
  const all = rows(html);
  s.round.changes.forEach((change, i) => {
    const review = s.reviews[i];
    const row = all[i];
    assertStringIncludes(row, `href="${escapeHtml(geneHref(change.gene))}"`);
    assertStringIncludes(row, `>${change.gene}<`);
    assertStringIncludes(row, STANDING_LABELS[review.standing]);
    assertStringIncludes(row, `aria-label="${tallyWords(review.tally)}"`);
    const { accept, reject, abstain, outstanding } = review.tally;
    const answered = accept + reject + abstain;
    assertStringIncludes(row, `${answered} of ${answered + outstanding}`);
  });
});

Deno.test("the page says the committee is simulated", () => {
  const html = renderToString(
    <ReviewQueueContent state={s} kind={null} standing={null} />,
  );
  assertStringIncludes(html, escapeHtml(SIMULATED_NOTE));
  assertStringIncludes(html, "<h1>Review queue</h1>");
  // The run the round comes from, which is day 0 of the simulated clock.
  assertStringIncludes(
    html,
    `<p class="review-notice-run">Pipeline run of ${
      formatLongDate(s.round.runTimestamp)
    }</p>`,
  );
});

Deno.test("an empty round renders an empty queue", () => {
  const empty = currentReview(true, sampleRound(0))!;
  const html = renderToString(
    <ReviewQueueContent state={empty} kind={null} standing={null} />,
  );
  assertEquals(rows(html).length, 0);
  assertStringIncludes(html, "No genes match");
  assertEquals(
    filterLinks(html, "Filter by kind").map(linkText),
    ["All 0", "New gene 0", "Claims changed 0", "Citation only 0"],
  );
  assert(!/NaN|undefined/.test(html), html);
});

Deno.test("a round too small for every planted case still renders", () => {
  for (const count of [1, 3]) {
    const small = currentReview(true, sampleRound(count))!;
    const html = renderToString(
      <ReviewQueueContent state={small} kind={null} standing={null} />,
    );
    assertEquals(rows(html).length, count);
    assert(!/NaN|undefined/.test(html), html);
  }
});

Deno.test("a filter that matches nothing says so", () => {
  // The simulation rejects no new gene of this round.
  assertEquals(
    s.round.changes.filter((c, i) =>
      c.kind === "new" && s.reviews[i].standing === "rejected"
    ).length,
    0,
  );
  const html = queue(s, "new", "rejected");
  assertEquals(rows(html).length, 0);
  assertStringIncludes(html, "No genes match");
  // The counts stay the whole round's, so the way back is still visible.
  assertEquals(linkText(filterLinks(html, "Filter by kind")[0]), "All 12");
});

Deno.test("an unknown filter value is ignored", () => {
  assertEquals(
    queueFilters(new URLSearchParams("kind=new&standing=conflict")),
    { kind: "new", standing: "conflict" },
  );
  assertEquals(
    queueFilters(new URLSearchParams("kind=bogus&standing=toString")),
    { kind: null, standing: null },
  );
  assertEquals(queueFilters(new URLSearchParams("")), {
    kind: null,
    standing: null,
  });
});

Deno.test("the queue is found only while there is a review", () => {
  // Holds in both states: the committed round is null until one is published.
  const page = () =>
    renderToString(
      h(
        ReviewQueuePage as unknown as preact.ComponentType<{ url: URL }>,
        { url: new URL("http://localhost/review") },
      ),
    );
  if (REVIEW === null) {
    assertEquals(assertThrows(page, HttpError).status, 404);
  } else {
    const html = page();
    assertStringIncludes(html, "<h1>Review queue</h1>");
    assertStringIncludes(html, escapeHtml(REVIEW.reviews[0].gene));
  }
});

const review = (overrides: Partial<GeneReview>): GeneReview => ({
  ...s.reviews[0],
  ...overrides,
});

Deno.test("the badge names the standing and each flag", () => {
  const plain = renderToString(
    <StandingBadge
      review={review({
        standing: "accepted",
        editsToReconcile: false,
        resolvedByChair: false,
      })}
    />,
  );
  assertStringIncludes(plain, ">Accepted<");
  assert(!plain.includes("Edits to reconcile"));
  assert(!plain.includes("Resolved by chair"));
  const flagged = renderToString(
    <StandingBadge
      review={review({
        standing: "accepted",
        editsToReconcile: true,
        resolvedByChair: true,
      })}
    />,
  );
  assertStringIncludes(flagged, ">Edits to reconcile<");
  assertStringIncludes(flagged, ">Resolved by chair<");
});

Deno.test("the tally bar sizes a segment by its count and names itself", () => {
  const tally = { accept: 3, reject: 1, abstain: 0, outstanding: 2 };
  const html = renderToString(<TallyBar tally={tally} />);
  assertStringIncludes(html, `aria-label="${tallyWords(tally)}"`);
  assertStringIncludes(html, 'role="img"');
  const grows = [...html.matchAll(/flex-grow:\s*(\d+)"/g)].map((m) =>
    Number(m[1])
  );
  assertEquals(grows, [3, 1, 0, 2]);
});
