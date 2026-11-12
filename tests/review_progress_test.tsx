/**
 * The committee progress page, rendered as the server draws it from a
 * synthetic round: the state of the whole review, where the genes stand by
 * kind of change, and each account's progress.
 */

import {
  assert,
  assertEquals,
  assertNotMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";
import type { VNode } from "preact";
import { h } from "preact";
import { HttpError } from "fresh";

import ReviewProgressPage, {
  ReviewProgressContent,
} from "../routes/review/progress.tsx";
import { ProgressKpis } from "../components/review/ProgressKpis.tsx";
import {
  BAR_STANDINGS,
  StandingBars,
} from "../components/review/StandingBars.tsx";
import { MembersTable } from "../components/review/MembersTable.tsx";
import { currentReview, REVIEW } from "../lib/review/current.ts";
import {
  ANSWER_LABELS,
  KIND_LABELS,
  percent,
  STANDING_LABELS,
} from "../lib/review/display.ts";
import { simulatedTime } from "../lib/review/time.ts";
import { SIMULATED_NOTE } from "../lib/review/copy.ts";
import type { Standing } from "../lib/review/rules.ts";
import type { ReviewKind } from "../lib/types.ts";
import { sampleRound } from "./fixtures/review.ts";
import { escapeHtml } from "./helpers/html.ts";

const render = (node: VNode) => renderToString(node);
const s = currentReview(true, sampleRound(20))!;

/** Text with its tags dropped and its spaces collapsed. */
const text = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** The KPI cards, each as its own HTML. */
const cards = (html: string): string[] =>
  [...html.matchAll(
    /<div class="review-kpi">.*?<\/div>(?=<div class="review-kpi">|<\/section>)/gs,
  )]
    .map((m) => m[0]);

/** The stacked bars: each one's accessible name and its segments. */
const bars = (html: string) =>
  [
    ...html.matchAll(
      /<span class="review-standing-bar" role="img" aria-label="([^"]*)">(.*?)<\/span><\/span>/gs,
    ),
  ].map((m) => ({
    label: m[1],
    segments: [
      ...`${m[2]}</span>`.matchAll(
        /<span[^>]*class="review-standing-(\w+)" style="flex-grow: (\d+)"><\/span>/g,
      ),
    ].map((seg) => [seg[1], Number(seg[2])] as [string, number]),
  }));

/** The body rows of the members table, each as its own HTML. */
const rows = (html: string): string[] => {
  const body = html.match(/<tbody>(.*?)<\/tbody>/s)?.[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>.*?<\/tr>/gs)].map((m) => m[0]);
};

const cells = (row: string): string[] =>
  [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[0]);

Deno.test("the cards read off the summary", () => {
  const { summary } = s;
  const html = render(<ProgressKpis summary={summary} />);
  assertStringIncludes(html, `${summary.settled}`);
  assertStringIncludes(html, `${summary.answersIn} of ${summary.answersOwed}`);
  assertStringIncludes(html, percent(summary.answersIn, summary.answersOwed));

  const all = cards(html).map(text);
  assertEquals(all.length, 4);
  assertEquals(all, [
    `Settled ${summary.settled} of ${summary.total} genes ${summary.accepted} accepted · ${summary.rejected} rejected`,
    `In conflict ${summary.conflict} Waiting on the chair's ruling`,
    `Verdicts in ${
      percent(summary.answersIn, summary.answersOwed)
    } ${summary.answersIn} of ${summary.answersOwed}`,
    `Edits to reconcile ${summary.editsToReconcile} Accepted, but the edits asked for differ`,
  ]);
});

Deno.test("a kind's bar has a segment per standing it holds, sized by count", () => {
  const html = render(<StandingBars summary={s.summary} />);
  const drawn = bars(html);
  const kinds: ReviewKind[] = ["new", "claims", "citation"];
  assertEquals(drawn.length, 3);
  kinds.forEach((kind, i) => {
    const row = s.summary.byKind[kind];
    const held = BAR_STANDINGS.filter((st) => row[st] > 0);
    // Only the standings the kind holds, in the bar's order, each grown by
    // its count.
    assertEquals(
      drawn[i].segments,
      held.map((st) => [st, row[st]]),
    );
    assertEquals(
      drawn[i].label,
      `${KIND_LABELS[kind]}: ${
        held.map((st) => `${row[st]} ${STANDING_LABELS[st].toLowerCase()}`)
          .join(", ")
      }`,
    );
  });
  // The fixture is varied enough that some kind leaves a standing out.
  assert(drawn.some((b) => b.segments.length < BAR_STANDINGS.length));
  // Each row says its kind and its total in text, beside the bar.
  for (const kind of kinds) {
    const total = Object.values(s.summary.byKind[kind]).reduce(
      (a, b) => a + b,
      0,
    );
    assertStringIncludes(
      html,
      `<span class="review-standing-kind">${KIND_LABELS[kind]}</span>`,
    );
    assertStringIncludes(
      html,
      `<span class="review-standing-total">${total}</span>`,
    );
  }
});

Deno.test("the legend counts every standing over the round, zeros included", () => {
  const html = render(<StandingBars summary={s.summary} />);
  const legend = html.match(
    /<ul class="review-tally-legend review-standing-legend">(.*?)<\/ul>/s,
  )
    ?.[1] ?? "";
  const items = [...legend.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => m[1]);
  const counts: Record<Standing, number> = {
    accepted: s.summary.accepted,
    rejected: s.summary.rejected,
    conflict: s.summary.conflict,
    in_review: s.summary.inReview,
    not_started: s.summary.notStarted,
    no_quorum: s.summary.noQuorum,
  };
  assertEquals(
    BAR_STANDINGS,
    [
      "accepted",
      "rejected",
      "conflict",
      "in_review",
      "not_started",
      "no_quorum",
    ],
  );
  assertEquals(
    items.map(text),
    BAR_STANDINGS.map((st) => `${STANDING_LABELS[st]} ${counts[st]}`),
  );
  // Each swatch wears its standing's colour, so the legend keys the bars.
  BAR_STANDINGS.forEach((st, i) =>
    assertStringIncludes(items[i], `review-standing-${st}`)
  );
});

Deno.test("a kind with no genes has no bar", () => {
  // Two changes: one new, one claims, no citation.
  const two = currentReview(true, sampleRound(2))!;
  const html = render(<StandingBars summary={two.summary} />);
  const drawn = bars(html);
  assertEquals(drawn.length, 2);
  assert(drawn[0].label.startsWith(`${KIND_LABELS.new}:`));
  assert(drawn[1].label.startsWith(`${KIND_LABELS.claims}:`));
  assert(!html.includes(KIND_LABELS.citation), html);
});

Deno.test("every account has a row and the observer's is read only", () => {
  const html = render(
    <MembersTable summary={s.summary} runTimestamp={s.round.runTimestamp} />,
  );
  const all = rows(html);
  assertEquals(all.length, s.accounts.length);
  // The four count columns are headed with the answers' own words.
  const head = html.match(/<thead>(.*?)<\/thead>/s)?.[1] ?? "";
  for (const label of Object.values(ANSWER_LABELS)) {
    assertStringIncludes(head, `>${label}<`);
  }
  const roles = {
    chair: "Chair",
    member: "Voting member",
    observer: "Observer",
  };
  s.summary.members.forEach((m, i) => {
    const row = all[i];
    const td = cells(row).map(text);
    assertEquals(td[0], m.account.name);
    assertEquals(td[1], roles[m.account.role]);
    const last = m.lastActive === null
      ? "No activity"
      : simulatedTime(m.lastActive, s.round.runTimestamp);
    if (m.account.role === "observer") {
      assertEquals(td, [
        m.account.name,
        "Observer",
        "Read only",
        "Read only",
        last,
      ]);
      assertStringIncludes(row, 'colspan="4"');
      assert(!row.includes(" of 0"), row);
    } else {
      assertEquals(td, [
        m.account.name,
        roles[m.account.role],
        `${m.answered} of ${m.owed}`,
        `${m.accept}`,
        `${m.withEdits}`,
        `${m.reject}`,
        `${m.abstain}`,
        last,
      ]);
      // The bar's width is the share answered, and its name says so.
      assertStringIncludes(
        row,
        `style="width: ${percent(m.answered, m.owed)}"`,
      );
      assertStringIncludes(
        row,
        `aria-label="${m.answered} of ${m.owed} answered"`,
      );
    }
  });
  // The fixture has one chair, one observer and voting members.
  assertEquals(all.filter((r) => r.includes(">Chair<")).length, 1);
  assertEquals(all.filter((r) => r.includes(">Observer<")).length, 1);
});

Deno.test("an account with no event reads as no activity", () => {
  const html = render(
    <MembersTable
      summary={{
        ...s.summary,
        members: [{ ...s.summary.members[1], lastActive: null }],
      }}
      runTimestamp={s.round.runTimestamp}
    />,
  );
  assertEquals(cells(rows(html)[0]).map(text).at(-1), "No activity");
});

Deno.test("an empty round renders zeros, not NaN", () => {
  const empty = currentReview(true, sampleRound(0))!;
  const html = render(<ReviewProgressContent state={empty} />);
  assertNotMatch(html, /NaN|undefined|Infinity/);
  assertEquals(cards(html).map(text), [
    "Settled 0 of 0 genes 0 accepted · 0 rejected",
    "In conflict 0 Waiting on the chair's ruling",
    "Verdicts in 0% 0 of 0",
    "Edits to reconcile 0 Accepted, but the edits asked for differ",
  ]);
  // No kind holds a gene, so no bar is drawn and none divides by zero.
  assertEquals(bars(html).length, 0);
  assertStringIncludes(html, "No genes in this round");
  // Every account still has its row, answered "0 of 0" at 0%.
  assertEquals(rows(html).length, empty.accounts.length);
  assertStringIncludes(html, 'style="width: 0%"');
});

Deno.test("the page says the committee is simulated", () => {
  const html = render(<ReviewProgressContent state={s} />);
  assertStringIncludes(html, "<h1>Committee progress</h1>");
  assertStringIncludes(html, escapeHtml(SIMULATED_NOTE));
  // The three blocks, in order.
  const kpis = html.indexOf('class="review-kpis"');
  const standing = html.indexOf('class="review-standing-bars"');
  const members = html.indexOf('class="data-table review-members"');
  assert(0 < kpis && kpis < standing && standing < members);
});

Deno.test("the route is found only while there is a review", () => {
  // Holds in both states: the committed round is null until one is published.
  const page = () =>
    renderToString(
      h(
        ReviewProgressPage as unknown as preact.ComponentType<{ url: URL }>,
        { url: new URL("http://localhost/review/progress") },
      ),
    );
  if (REVIEW === null) {
    assertEquals(assertThrows(page, HttpError).status, 404);
  } else {
    assertStringIncludes(page(), "<h1>Committee progress</h1>");
  }
});
