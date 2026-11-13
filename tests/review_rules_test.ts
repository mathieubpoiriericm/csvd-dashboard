import { assertEquals } from "@std/assert";

import type {
  Account,
  AnswerEvent,
  Edit,
  ProposalEvent,
  ReviewEvent,
  RulingEvent,
} from "../lib/review/events.ts";
import { PIPELINE_ACTOR, votes } from "../lib/review/events.ts";
import { reviewGene, settlesAt, standingOf } from "../lib/review/rules.ts";
import { sampleChange } from "./fixtures/review.ts";

const t = (
  accept: number,
  reject: number,
  abstain: number,
  outstanding: number,
) => ({ accept, reject, abstain, outstanding });

/** Ten members, one chair (`v0`), and an observer. */
const accounts: Account[] = [
  { id: "v0", name: "Chair", role: "chair" },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `v${i + 1}`,
    name: `Member ${i + 1}`,
    role: "member" as const,
  })),
  { id: "obs", name: "Observer", role: "observer" },
];

const change = sampleChange();
let counter = 0;
function answer(
  actor: string,
  kind: AnswerEvent["answer"],
  at: string,
  extra: Partial<AnswerEvent> = {},
): AnswerEvent {
  return {
    id: `e${++counter}`,
    at,
    roundId: "round-1",
    gene: "GENE1",
    version: "v1",
    actor,
    type: "answer",
    answer: kind,
    edits: [],
    reason: null,
    ...extra,
  };
}
function ruling(
  actor: string,
  outcome: RulingEvent["outcome"],
  at: string,
  extra: Partial<RulingEvent> = {},
): RulingEvent {
  return {
    id: `e${++counter}`,
    at,
    roundId: "round-1",
    gene: "GENE1",
    version: "v1",
    actor,
    type: "ruling",
    outcome,
    edits: [],
    reason: "because",
    ...extra,
  };
}
const edit = (after: string[]): Edit => ({
  field: "gwasTrait",
  before: ["(none found)"],
  after,
});

Deno.test("the spec's worked examples, eleven voters", () => {
  assertEquals(standingOf(t(5, 1, 1, 4)), "in_review");
  assertEquals(standingOf(t(8, 1, 1, 1)), "accepted");
  assertEquals(standingOf(t(4, 4, 1, 2)), "conflict");
});

Deno.test("every standing has its condition", () => {
  assertEquals(standingOf(t(0, 0, 0, 11)), "not_started");
  assertEquals(standingOf(t(0, 0, 11, 0)), "no_quorum");
  assertEquals(standingOf(t(0, 0, 3, 8)), "in_review");
  assertEquals(standingOf(t(1, 8, 2, 0)), "rejected");
  assertEquals(standingOf(t(1, 1, 9, 0)), "conflict");
  assertEquals(standingOf(t(6, 3, 2, 0)), "accepted");
  assertEquals(standingOf(t(5, 3, 2, 1)), "in_review");
});

Deno.test("a gene settles at two thirds of those not abstaining", () =>
  assertEquals(settlesAt(t(5, 1, 1, 4)), { needed: 7, of: 10 }));

Deno.test("only voters vote", () => {
  assertEquals(votes(accounts[0]), true);
  assertEquals(votes(accounts[1]), true);
  assertEquals(votes(accounts[11]), false);
  assertEquals(PIPELINE_ACTOR, "pipeline");
});

Deno.test("with no events a gene is not started and everyone is outstanding", () => {
  const review = reviewGene(change, accounts, []);
  assertEquals(review.tally, t(0, 0, 0, 11));
  assertEquals(review.standing, "not_started");
  assertEquals(review.voted, "not_started");
  assertEquals(review.ruling, null);
  assertEquals(review.resolvedByChair, false);
  assertEquals(review.editsToReconcile, false);
  assertEquals(review.history, []);
});

Deno.test("a later answer replaces an earlier one and both stay in the history", () => {
  const first = answer("v1", "reject", "2026-01-01T10:00:00Z");
  const second = answer("v1", "accept", "2026-01-01T11:00:00Z");
  const review = reviewGene(change, accounts, [first, second]);
  assertEquals(review.tally, t(1, 0, 0, 10));
  assertEquals(review.answers.get("v1"), second);
  assertEquals(review.history, [second, first]);
});

Deno.test("an equal timestamp is decided by position", () => {
  const first = answer("v1", "reject", "2026-01-01T10:00:00Z");
  const second = answer("v1", "abstain", "2026-01-01T10:00:00Z");
  const review = reviewGene(change, accounts, [first, second]);
  assertEquals(review.answers.get("v1"), second);
  assertEquals(review.history, [second, first]);
  assertEquals(review.tally, t(0, 0, 1, 10));
});

Deno.test("an answer listed out of order still counts by its time", () => {
  const early = answer("v1", "reject", "2026-01-01T10:00:00Z");
  const late = answer("v1", "accept", "2026-01-01T11:00:00Z");
  const review = reviewGene(change, accounts, [late, early]);
  assertEquals(review.answers.get("v1"), late);
});

Deno.test("a stale answer is in the history and in no tally", () => {
  const stale = answer("v1", "accept", "2026-01-01T10:00:00Z", {
    version: "v0",
  });
  const staleRuling = ruling("v0", "accepted", "2026-01-01T10:00:00Z", {
    version: "v0",
  });
  const review = reviewGene(change, accounts, [stale, staleRuling]);
  assertEquals(review.tally, t(0, 0, 0, 11));
  assertEquals(review.answers.size, 0);
  assertEquals(review.ruling, null);
  assertEquals(review.standing, "not_started");
  assertEquals(review.history.length, 2);
});

Deno.test("another gene's events count for nothing and are not in the history", () => {
  const other = answer("v1", "accept", "2026-01-01T10:00:00Z", {
    gene: "GENE2",
  });
  const review = reviewGene(change, accounts, [other]);
  assertEquals(review.tally, t(0, 0, 0, 11));
  assertEquals(review.history, []);
});

Deno.test("a proposal is history and nothing else", () => {
  const proposal: ProposalEvent = {
    id: "p1",
    at: "2026-01-01T09:00:00Z",
    roundId: "round-1",
    gene: "GENE1",
    version: "v1",
    actor: PIPELINE_ACTOR,
    type: "proposal",
  };
  const review = reviewGene(change, accounts, [proposal]);
  assertEquals(review.history, [proposal]);
  assertEquals(review.tally, t(0, 0, 0, 11));
});

Deno.test("an observer's or a stranger's answer counts for nothing", () => {
  const review = reviewGene(change, accounts, [
    answer("obs", "accept", "2026-01-01T10:00:00Z"),
    answer("nobody", "reject", "2026-01-01T10:00:00Z"),
  ]);
  assertEquals(review.tally, t(0, 0, 0, 11));
  assertEquals(review.answers.size, 0);
  assertEquals(review.history.length, 2);
});

Deno.test("accept with edits counts as accept; abstain and reject are tallied", () => {
  const review = reviewGene(change, accounts, [
    answer("v1", "accept", "2026-01-01T10:00:00Z"),
    answer("v2", "accept_with_edits", "2026-01-01T10:00:00Z", {
      edits: [edit(["TRAIT-A"])],
    }),
    answer("v3", "reject", "2026-01-01T10:00:00Z"),
    answer("v4", "abstain", "2026-01-01T10:00:00Z"),
  ]);
  assertEquals(review.tally, t(2, 1, 1, 7));
});

function accepting(
  edits: (Edit[] | null)[],
): ReviewEvent[] {
  return edits.map((e, i) =>
    e === null
      ? answer(`v${i + 1}`, "accept", "2026-01-01T10:00:00Z")
      : answer(`v${i + 1}`, "accept_with_edits", "2026-01-01T10:00:00Z", {
        edits: e,
      })
  );
}

Deno.test("accepted with differing edits is flagged to reconcile", () => {
  const review = reviewGene(
    change,
    accounts,
    accepting([null, [edit(["TRAIT-A"])], null, null, null, null, null, null]),
  );
  assertEquals(review.voted, "accepted");
  assertEquals(review.editsToReconcile, true);
});

Deno.test("two different edit lists are flagged even when neither accept is bare", () => {
  const review = reviewGene(
    change,
    accounts,
    accepting([
      [edit(["TRAIT-A"])],
      [edit(["TRAIT-B"])],
      null,
      null,
      null,
      null,
      null,
      null,
    ]),
  );
  assertEquals(review.editsToReconcile, true);
});

Deno.test("identical edits from every accepter need no reconciling", () => {
  const other: Edit = {
    field: "references",
    before: ["10000001"],
    after: ["10000001", "10000002"],
  };
  const events = accepting([
    [edit(["TRAIT-A"]), other],
    [other, edit(["TRAIT-A"])],
    [edit(["TRAIT-A"]), other],
    [edit(["TRAIT-A"]), other],
    [edit(["TRAIT-A"]), other],
    [edit(["TRAIT-A"]), other],
    [edit(["TRAIT-A"]), other],
    [edit(["TRAIT-A"]), other],
  ]);
  const review = reviewGene(change, accounts, events);
  assertEquals(review.voted, "accepted");
  assertEquals(review.editsToReconcile, false);
});

Deno.test("plain accepts need no reconciling", () => {
  const review = reviewGene(
    change,
    accounts,
    accepting([null, null, null, null, null, null, null, null]),
  );
  assertEquals(review.editsToReconcile, false);
});

Deno.test("a chair's ruling becomes the standing and clears the flag", () => {
  const events: ReviewEvent[] = [
    ...Array.from(
      { length: 4 },
      (_, i) => answer(`v${i + 1}`, "accept", "2026-01-01T10:00:00Z"),
    ),
    ...Array.from(
      { length: 4 },
      (_, i) => answer(`v${i + 5}`, "reject", "2026-01-01T10:00:00Z"),
    ),
    answer("v9", "abstain", "2026-01-01T10:00:00Z"),
  ];
  const before = reviewGene(change, accounts, events);
  assertEquals(before.voted, "conflict");
  assertEquals(before.standing, "conflict");
  const r = ruling("v0", "accepted", "2026-01-02T10:00:00Z");
  const review = reviewGene(change, accounts, [...events, r]);
  assertEquals(review.voted, "conflict");
  assertEquals(review.standing, "accepted");
  assertEquals(review.resolvedByChair, true);
  assertEquals(review.ruling, r);
  assertEquals(review.editsToReconcile, false);
});

Deno.test("a ruling clears the reconcile flag of an accepted gene", () => {
  const events = accepting([
    null,
    [edit(["TRAIT-A"])],
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  const review = reviewGene(change, accounts, [
    ...events,
    ruling("v0", "rejected", "2026-01-02T10:00:00Z"),
  ]);
  assertEquals(review.voted, "accepted");
  assertEquals(review.standing, "rejected");
  assertEquals(review.editsToReconcile, false);
});

Deno.test("the latest ruling by a chair is the ruling", () => {
  const first = ruling("v0", "accepted", "2026-01-02T10:00:00Z");
  const second = ruling("v0", "rejected", "2026-01-03T10:00:00Z");
  const review = reviewGene(change, accounts, [second, first]);
  assertEquals(review.ruling, second);
  assertEquals(review.standing, "rejected");
});

Deno.test("a member's ruling is not a ruling", () => {
  const review = reviewGene(change, accounts, [
    ruling("v1", "accepted", "2026-01-02T10:00:00Z"),
    ruling("obs", "accepted", "2026-01-02T10:00:00Z"),
    ruling("nobody", "accepted", "2026-01-02T10:00:00Z"),
  ]);
  assertEquals(review.ruling, null);
  assertEquals(review.resolvedByChair, false);
  assertEquals(review.standing, "not_started");
  assertEquals(review.history.length, 3);
});

Deno.test("an answer after a ruling is recorded and does not move the standing", () => {
  const r = ruling("v0", "rejected", "2026-01-02T10:00:00Z");
  const late = answer("v1", "accept", "2026-01-03T10:00:00Z");
  const review = reviewGene(change, accounts, [r, late]);
  assertEquals(review.standing, "rejected");
  assertEquals(review.tally, t(1, 0, 0, 10));
  assertEquals(review.history, [late, r]);
});

Deno.test("the history is newest first", () => {
  const a = answer("v1", "accept", "2026-01-01T10:00:00Z");
  const b = answer("v2", "reject", "2026-01-03T10:00:00Z");
  const c = ruling("v0", "accepted", "2026-01-02T10:00:00Z");
  const review = reviewGene(change, accounts, [a, b, c]);
  assertEquals(review.history, [b, c, a]);
});
