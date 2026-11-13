import { assertEquals } from "@std/assert";

import { PIPELINE_ACTOR } from "../lib/review/events.ts";
import type { AnswerEvent, ReviewEvent } from "../lib/review/events.ts";
import { ACCOUNTS, simulate } from "../lib/review/simulate.ts";
import { reviewState } from "../lib/review/summary.ts";
import { sampleRound } from "./fixtures/review.ts";

const state = (round = sampleRound(20)) =>
  reviewState(round, ACCOUNTS, simulate(round));

Deno.test("the summary's parts add up", () => {
  const s = state(sampleRound(20)).summary;
  assertEquals(
    s.accepted + s.rejected + s.conflict + s.inReview + s.notStarted +
      s.noQuorum,
    20,
  );
  assertEquals(s.settled, s.accepted + s.rejected);
  assertEquals(s.answersOwed, 11 * 20);
  assertEquals(s.answersIn, s.members.reduce((n, m) => n + m.answered, 0));
  const kinds = Object.values(s.byKind).flatMap((row) => Object.values(row));
  assertEquals(kinds.reduce((a, b) => a + b, 0), 20);
});

Deno.test("a member's answers add up and the observer owes none", () => {
  const { summary, reviews } = state();
  assertEquals(summary.members.map((m) => m.account), [...ACCOUNTS]);
  for (const m of summary.members) {
    assertEquals(m.accept + m.withEdits + m.reject + m.abstain, m.answered);
    assertEquals(m.owed, m.account.role === "observer" ? 0 : 20);
    const mine = reviews.filter((r) => r.answers.has(m.account.id)).length;
    assertEquals(m.answered, mine);
  }
  const observer = summary.members[11];
  assertEquals(observer.answered, 0);
  assertEquals(observer.lastActive, null);
  const chair = summary.members[0];
  assertEquals(chair.answered > 0, true);
});

Deno.test("a member's counts are of their current answers and last event", () => {
  const round = sampleRound(1);
  const change = round.changes[0];
  const answer = (
    id: string,
    at: string,
    kind: AnswerEvent["answer"],
  ): ReviewEvent => ({
    id,
    at,
    roundId: round.id,
    gene: change.gene,
    version: change.version,
    actor: "r02",
    type: "answer",
    answer: kind,
    edits: [],
    reason: null,
  });
  const events: ReviewEvent[] = [
    answer("e1", "2026-01-07T10:00:00Z", "reject"),
    answer("e2", "2026-01-08T10:00:00Z", "accept"),
    answer("e3", "2026-01-06T10:00:00Z", "abstain"),
  ];
  const m = reviewState(round, ACCOUNTS, events).summary.members[1];
  assertEquals([m.answered, m.accept, m.reject, m.abstain], [1, 1, 0, 0]);
  assertEquals(m.lastActive, "2026-01-08T10:00:00Z");
});

Deno.test("a chair's ruling counts as settled and leaves the conflict count", () => {
  const round = sampleRound(8);
  const { summary, reviews } = state(round);
  // In a round of eight the second-to-last change is a planted conflict and
  // the one before it a conflict the chair rules accepted.
  assertEquals(reviews[6].standing, "conflict");
  assertEquals(reviews[5].voted, "conflict");
  assertEquals(reviews[5].standing, "accepted");
  assertEquals(summary.resolvedByChair, 1);
  assertEquals(summary.conflict, 1);
  assertEquals(summary.settled, summary.accepted + summary.rejected);
  assertEquals(summary.accepted >= 1, true);
});

Deno.test("edits to reconcile are counted", () => {
  const { summary, reviews } = state(sampleRound(8));
  assertEquals(
    summary.editsToReconcile,
    reviews.filter((r) => r.editsToReconcile).length,
  );
  assertEquals(summary.editsToReconcile, 1);
});

Deno.test("an empty round summarizes to zeros", () => {
  const round = sampleRound(0);
  const s = reviewState(round, ACCOUNTS, []).summary;
  assertEquals(s.total, 0);
  assertEquals(s.settled + s.answersIn + s.answersOwed, 0);
  assertEquals(s.members.length, 12);
  assertEquals(
    Object.values(s.byKind).flatMap((r) => Object.values(r)).every((n) =>
      n === 0
    ),
    true,
  );
});

Deno.test("only the proposal events leave a member never active", () => {
  const round = sampleRound(1);
  const proposal: ReviewEvent = {
    id: "e1",
    at: round.runTimestamp,
    roundId: round.id,
    gene: round.changes[0].gene,
    version: "v1",
    actor: PIPELINE_ACTOR,
    type: "proposal",
  };
  const s = reviewState(round, ACCOUNTS, [proposal]).summary;
  assertEquals(s.members.every((m) => m.lastActive === null), true);
  assertEquals(s.notStarted, 1);
});
