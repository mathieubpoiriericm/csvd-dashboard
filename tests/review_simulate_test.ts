import { assert, assertEquals, assertNotEquals } from "@std/assert";

import { PIPELINE_ACTOR } from "../lib/review/events.ts";
import type { AnswerEvent, ReviewEvent } from "../lib/review/events.ts";
import { reviewGene } from "../lib/review/rules.ts";
import { ACCOUNTS, SEED, simulate } from "../lib/review/simulate.ts";
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

Deno.test("a round of eight or more shows every standing and both flags", () => {
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
  const round = sampleRound(8);
  const events = simulate(round);
  const reviews = round.changes.map((c) => reviewGene(c, ACCOUNTS, events));
  assertEquals(reviews.map((r) => r.standing), [
    "accepted",
    "rejected",
    "conflict",
    "accepted",
    "accepted",
    "no_quorum",
    "in_review",
    "not_started",
  ]);
  assertEquals(reviews[3].voted, "conflict");
  assert(reviews[3].ruling?.reason);
  assert(reviews[4].editsToReconcile);
  assertEquals(reviews[4].answers.get("r03")?.edits.length, 1);
  assertEquals(reviews[1].answers.get("r02")?.answer, "reject");
});

Deno.test("a small round shows what fits and never throws", () => {
  for (const n of [0, 1, 3]) {
    const events = simulate(sampleRound(n));
    assertEquals(events.filter((e) => e.type === "proposal").length, n);
  }
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
  const events = simulate(sampleRound(2));
  const mine = events.filter((e): e is AnswerEvent =>
    e.type === "answer" && e.gene === "GENE2" && e.actor === "r02"
  );
  assertEquals(mine.map((e) => e.answer), ["accept", "reject"]);
  assert(Date.parse(mine[0].at) < Date.parse(mine[1].at));
});

Deno.test("edits remove the last added value of the first field that has one", () => {
  const round = sampleRound(5);
  const events = simulate(round);
  const edited = events.find((e): e is AnswerEvent =>
    e.type === "answer" && e.gene === "GENE5" &&
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

Deno.test("a change with nothing added gets a plain accept where an edit was planted", () => {
  const round = sampleRound(5);
  round.changes[4] = sampleChange({ gene: "GENE5", version: "v5", fields: [] });
  const events = simulate(round);
  const second = events.find((e): e is AnswerEvent =>
    e.type === "answer" && e.gene === "GENE5" && e.actor === "r03"
  );
  assertEquals(second?.answer, "accept");
  assertEquals(second?.edits, []);
  assert(
    !reviewGene(round.changes[4], ACCOUNTS, events).editsToReconcile,
  );
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
