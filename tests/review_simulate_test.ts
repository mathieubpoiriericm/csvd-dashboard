import { assert, assertEquals, assertNotEquals } from "@std/assert";

import { PIPELINE_ACTOR } from "../lib/review/events.ts";
import type { AnswerEvent, ReviewEvent } from "../lib/review/events.ts";
import { reviewGene } from "../lib/review/rules.ts";
import { reviewState } from "../lib/review/summary.ts";
import {
  ABSTAIN_REASONS,
  ACCOUNTS,
  EDIT_REASONS,
  plantings,
  REJECT_REASONS,
  RULING_REASONS,
  SEED,
  simulate,
} from "../lib/review/simulate.ts";
import { sampleChange, sampleRound } from "./fixtures/review.ts";

const DAY_MS = 86_400_000;
const RUN = Date.parse("2026-01-05T10:00:00+00:00");
const MIDNIGHT = Date.UTC(2026, 0, 5);

Deno.test("the committee is ten members, a chair and an observer", () => {
  assertEquals(ACCOUNTS.length, 12);
  assertEquals(ACCOUNTS.filter((a) => a.role === "chair").length, 1);
  assertEquals(ACCOUNTS.filter((a) => a.role === "observer").length, 1);
  assertEquals(ACCOUNTS.filter((a) => a.role === "member").length, 10);
  assertEquals(ACCOUNTS[0], { id: "r01", name: "Reviewer A", role: "chair" });
  assertEquals(ACCOUNTS[11], {
    id: "r12",
    name: "Reviewer L",
    role: "observer",
  });
});

Deno.test("the same round and seed give the same history", () => {
  assertEquals(simulate(sampleRound(20)), simulate(sampleRound(20)));
  assertEquals(simulate(sampleRound(20)), simulate(sampleRound(20), SEED));
});

Deno.test("another seed gives another history", () => {
  assertNotEquals(simulate(sampleRound(20)), simulate(sampleRound(20), 1));
});

Deno.test("a round of twelve or more shows every standing and both flags", () => {
  const round = sampleRound(12);
  const events = simulate(round);
  const reviews = round.changes.map((c) => reviewGene(c, ACCOUNTS, events));
  for (
    const s of [
      "not_started",
      "in_review",
      "conflict",
      "accepted",
      "rejected",
      "no_quorum",
    ]
  ) {
    assert(reviews.some((r) => r.standing === s), s);
  }
  assert(reviews.some((r) => r.editsToReconcile));
  assert(reviews.some((r) => r.resolvedByChair));
  assert(
    reviews.some((r) =>
      r.history.filter((e) => e.type === "answer").length > r.answers.size
    ),
  );
});

Deno.test("the planted changes land on their planted standings", () => {
  // Kinds cycle new, claims, citation: the first change adds nothing, so the
  // edits go to the second; the adverse cases count back from the last.
  const round = sampleRound(8);
  assertEquals([...plantings(round.changes)].sort((a, b) => a[0] - b[0]), [
    [0, "accepted"],
    [1, "edits_to_reconcile"],
    [2, "in_review"],
    [3, "not_started"],
    [4, "no_quorum"],
    [5, "resolved_by_chair"],
    [6, "conflict"],
    [7, "rejected"],
  ]);
  const events = simulate(round);
  const reviews = round.changes.map((c) => reviewGene(c, ACCOUNTS, events));
  assertEquals(reviews.map((r) => r.standing), [
    "accepted",
    "accepted",
    "in_review",
    "not_started",
    "no_quorum",
    "accepted",
    "conflict",
    "rejected",
  ]);
  assertEquals(reviews[5].voted, "conflict");
  assert(reviews[5].ruling?.reason);
  assert(reviews[1].editsToReconcile);
  assertEquals(reviews[1].answers.get("r03")?.edits.length, 1);
  assertEquals(reviews[7].answers.get("r02")?.answer, "reject");
});

Deno.test("the adverse cases land on the last changes, never the first", () => {
  const round = sampleRound(30);
  const planted = plantings(round.changes);
  const adverse = ["rejected", "conflict", "resolved_by_chair", "no_quorum"];
  const at = (kind: string) =>
    [...planted].find(([, k]) => k === kind)?.[0] ?? -1;
  assertEquals(adverse.map(at), [29, 28, 27, 26]);
  const events = simulate(round);
  const reviews = round.changes.map((c) => reviewGene(c, ACCOUNTS, events));
  for (const i of [26, 27, 28, 29]) assert(reviews[i].voted !== "accepted");
  for (let i = 0; i < 10; i++) {
    assert(!adverse.includes(planted.get(i) ?? ""), `change ${i}`);
    assert(
      !["rejected", "conflict", "no_quorum"].includes(reviews[i].standing),
      `change ${i} stands at ${reviews[i].standing}`,
    );
  }
});

Deno.test("only a planted change ends at conflict, rejected or no quorum", () => {
  // The random answers alone must never read as a verdict against a gene,
  // whatever the seed and wherever the change sits in the round.
  const adverse = ["conflict", "rejected", "no_quorum"];
  const stray: string[] = [];
  for (const n of [9, 30, 80]) {
    const round = sampleRound(n);
    const planted = plantings(round.changes);
    for (let seed = SEED; seed < SEED + 500; seed++) {
      const events = simulate(round, seed);
      round.changes.forEach((c, i) => {
        if (planted.has(i)) return;
        const r = reviewGene(c, ACCOUNTS, events);
        if (adverse.includes(r.standing) || adverse.includes(r.voted)) {
          stray.push(`${n} changes, seed ${seed}, change ${i}: ${r.voted}`);
        }
      });
    }
  }
  assertEquals(stray, []);
});

Deno.test("a small round plants what fits, benign first, once per change", () => {
  const expected: Record<number, string[]> = {
    0: [],
    1: ["accepted"],
    3: ["accepted", "edits_to_reconcile", "in_review"],
    8: [
      "accepted",
      "edits_to_reconcile",
      "in_review",
      "not_started",
      "no_quorum",
      "resolved_by_chair",
      "conflict",
      "rejected",
    ],
  };
  for (const [n, kinds] of Object.entries(expected)) {
    const round = sampleRound(Number(n));
    const planted = plantings(round.changes);
    assertEquals(
      [...planted].sort((a, b) => a[0] - b[0]).map(([, k]) => k),
      kinds,
    );
    const events = simulate(round);
    assertEquals(
      events.filter((e) => e.type === "proposal").length,
      Number(n),
    );
  }
});

Deno.test("edits to reconcile go to the first change that adds a value", () => {
  const round = sampleRound(12);
  // The first seven are new genes: nothing added until the eighth.
  for (let i = 0; i < 7; i++) {
    round.changes[i] = sampleChange({
      gene: `GENE${i + 1}`,
      version: `v${i + 1}`,
      kind: "new",
      before: null,
      fields: [],
    });
  }
  const planted = plantings(round.changes);
  assertEquals(planted.get(7), "edits_to_reconcile");
  const events = simulate(round);
  assert(reviewGene(round.changes[7], ACCOUNTS, events).editsToReconcile);
});

Deno.test("the observer never answers and only the chair rules", () => {
  const events = simulate(sampleRound(30));
  assert(events.some((e) => e.type === "ruling"));
  for (const e of events) {
    assert(e.actor !== "r12");
    if (e.type === "ruling") assertEquals(e.actor, "r01");
    if (e.type === "proposal") assertEquals(e.actor, PIPELINE_ACTOR);
  }
});

Deno.test("every event names the round and the change's current version", () => {
  const round = sampleRound(20);
  const versions = new Map(round.changes.map((c) => [c.gene, c.version]));
  for (const e of simulate(round)) {
    assertEquals(e.roundId, round.id);
    assertEquals(e.version, versions.get(e.gene));
  }
});

Deno.test("no event precedes the run, and events come in time order", () => {
  const events = simulate(sampleRound(30));
  events.forEach((e, i) => {
    assertEquals(e.id, `e${String(i + 1).padStart(4, "0")}`);
    assert(Date.parse(e.at) >= RUN);
    if (i > 0) assert(Date.parse(events[i - 1].at) <= Date.parse(e.at));
  });
  assertEquals(new Set(events.map((e) => e.id)).size, events.length);
});

Deno.test("answers fall on days 1 to 6, in working hours, rulings on day 7", () => {
  for (const e of simulate(sampleRound(30))) {
    if (e.type === "proposal") continue;
    const offset = Date.parse(e.at) - MIDNIGHT;
    const day = Math.floor(offset / DAY_MS);
    const minute = (offset % DAY_MS) / 60_000;
    assert(minute >= 480 && minute <= 1080, e.at);
    if (e.type === "ruling") assertEquals(day, 7);
    else assert(day >= 1 && day <= 6, e.at);
  }
});

Deno.test("a change of mind is later than the answer it replaces", () => {
  const events = simulate(sampleRound(8));
  const mine = events.filter((e): e is AnswerEvent =>
    e.type === "answer" && e.gene === "GENE8" && e.actor === "r02"
  );
  assertEquals(mine.map((e) => e.answer), ["accept", "reject"]);
  assert(Date.parse(mine[0].at) < Date.parse(mine[1].at));
});

Deno.test("edits remove the last added value of the first field that has one", () => {
  const round = sampleRound(5);
  const events = simulate(round);
  const edited = events.find((e): e is AnswerEvent =>
    e.type === "answer" && e.gene === "GENE2" &&
    e.answer === "accept_with_edits"
  );
  assertEquals(edited?.edits, [{
    field: "gwasTrait",
    before: ["TRAIT-A"],
    after: [],
  }]);
  const plain = events.filter((e): e is AnswerEvent =>
    e.type === "answer" && e.answer === "accept"
  );
  assert(plain.every((e) => e.edits.length === 0));
});

Deno.test("a round that adds nothing plants no edits and accepts plainly", () => {
  const round = sampleRound(40);
  round.changes = round.changes.map((c) => ({ ...c, fields: [] }));
  assertEquals(
    [...plantings(round.changes).values()].includes("edits_to_reconcile"),
    false,
  );
  const events = simulate(round);
  const answers = events.filter((e): e is AnswerEvent => e.type === "answer");
  assert(answers.length > 0);
  assert(answers.every((e) => e.answer !== "accept_with_edits"));
  assert(answers.every((e) => e.edits.length === 0));
  assert(
    round.changes.every((c) =>
      !reviewGene(c, ACCOUNTS, events).editsToReconcile
    ),
  );
});

Deno.test("about half of an 80-change round is settled, members at different stages", () => {
  const round = sampleRound(80);
  const s = reviewState(round, ACCOUNTS, simulate(round)).summary;
  const share = s.settled / s.total;
  assert(share >= .35 && share <= .6, `settled ${s.settled} of ${s.total}`);
  // The chair answers every change but the one planted as not started.
  assertEquals(s.members[0].answered, s.total - s.notStarted);
  const answered = s.members.slice(0, 11).map((m) => m.answered / m.owed);
  assert(answered.filter((f) => f < .5).length >= 2, String(answered));
  assert(answered.filter((f) => f > .8).length >= 6, String(answered));
});

Deno.test("random changes use every kind of answer and give reasons", () => {
  const events: ReviewEvent[] = simulate(sampleRound(200));
  const kinds = new Set(
    events.flatMap((e) => e.type === "answer" ? [e.answer] : []),
  );
  assertEquals(kinds.size, 4);
  for (const e of events) {
    if (e.type === "answer") {
      assertEquals(e.reason === null, e.answer === "accept");
    }
    if (e.type === "ruling") assert(e.reason.length > 0);
  }
});

Deno.test("each reason comes from its own answer's list, and the lists share none", () => {
  const lists = {
    reject: REJECT_REASONS,
    abstain: ABSTAIN_REASONS,
    accept_with_edits: EDIT_REASONS,
  };
  const events = simulate(sampleRound(200));
  const seen = { reject: 0, abstain: 0, accept_with_edits: 0, ruling: 0 };
  for (const e of events) {
    if (e.type === "answer" && e.answer !== "accept") {
      assert(lists[e.answer].includes(e.reason!), `${e.answer}: ${e.reason}`);
      seen[e.answer]++;
    }
    if (e.type === "ruling") {
      assert(RULING_REASONS.includes(e.reason), e.reason);
      seen.ruling++;
    }
  }
  assert(Object.values(seen).every((n) => n > 0), JSON.stringify(seen));
  const all = [
    ...REJECT_REASONS,
    ...ABSTAIN_REASONS,
    ...EDIT_REASONS,
    ...RULING_REASONS,
  ];
  assertEquals(new Set(all).size, all.length);
});
