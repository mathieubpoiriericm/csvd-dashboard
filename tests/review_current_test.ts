import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { currentReview, REVIEW, warnIfStale } from "../lib/review/current.ts";
import { ACCOUNTS, simulate } from "../lib/review/simulate.ts";
import { reviewState } from "../lib/review/summary.ts";
import { genes } from "../lib/data/genes.ts";
import { reviewRound } from "../lib/data/review_round.ts";
import { GOLD_ONLY } from "../lib/gold_only.ts";
import { goldOf, sampleRound } from "./fixtures/review.ts";
import { sampleGene } from "./fixtures/rows.ts";

const round3 = sampleRound(3);
const gold3 = goldOf(round3);

Deno.test("there is a review only under gold-only with a round", () => {
  assertEquals(currentReview(false, round3, gold3), null);
  assertEquals(currentReview(true, null, gold3), null);
  assertEquals(currentReview(true, round3, gold3)?.reviews.length, 3);
});

Deno.test("only an open round is shown", () => {
  for (const state of ["promoted", "closed"] as const) {
    assertEquals(currentReview(true, { ...round3, state }, gold3), null);
  }
});

Deno.test("a stale round is not shown", () => {
  const curated = gold3.map((g) => ({ ...g, affectedPathway: "Pathway A" }));
  assertEquals(currentReview(true, round3, curated), null);
  // A new gene gold now holds is stale too.
  assertEquals(
    currentReview(true, round3, [...gold3, sampleGene({ gene: "GENE1" })]),
    null,
  );
});

Deno.test("the current review is the simulated committee's state", () => {
  const round = sampleRound(5);
  assertEquals(
    currentReview(true, round, goldOf(round)),
    reviewState(round, ACCOUNTS, simulate(round)),
  );
});

Deno.test("the exported review follows the committed round and genes", () => {
  assertEquals(REVIEW, currentReview(GOLD_ONLY, reviewRound, genes));
});

Deno.test("a stale round that would be shown is reported once", () => {
  const said: string[] = [];
  const warn = (message: string) => said.push(message);
  const curated = gold3.map((g) => ({ ...g, references: ["10000009"] }));

  warnIfStale(true, round3, curated, warn);
  assertEquals(said.length, 1);
  assertStringIncludes(said[0], "for 2 of its 3 changes (GENE2, GENE3)");
  assertStringIncludes(said[0], "deno task data:preview");

  // More than five stale genes are cut to the first five.
  const round = sampleRound(9);
  warnIfStale(true, round, [], warn);
  assertStringIncludes(
    said[1],
    "(GENE2, GENE3, GENE5, GENE6, GENE8, ...)",
  );
  assertStringIncludes(said[1], "6 of its 9 changes");
});

Deno.test("nothing is said of a current round or one not shown", () => {
  const said: string[] = [];
  const warn = (message: string) => said.push(message);
  warnIfStale(true, round3, gold3, warn);
  warnIfStale(false, round3, [], warn);
  warnIfStale(true, null, [], warn);
  warnIfStale(true, { ...round3, state: "closed" }, [], warn);
  assertEquals(said, []);
});

Deno.test("the default warning goes to the console", () => {
  const original = console.warn;
  const said: unknown[] = [];
  console.warn = (message: unknown) => said.push(message);
  try {
    warnIfStale(true, round3, []);
  } finally {
    console.warn = original;
  }
  assertEquals(said.length, 1);
  assert(String(said[0]).includes("review area is hidden"));
});
