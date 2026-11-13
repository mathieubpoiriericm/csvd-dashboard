/** A round measured against a gold that has since been curated is stale. */

import { assertEquals } from "@std/assert";

import { staleChanges } from "../lib/review/stale.ts";
import { goldOf, sampleRound, withEveryKind } from "./fixtures/review.ts";
import { sampleGene } from "./fixtures/rows.ts";

Deno.test("a round measured against the gold it is shown with is current", () => {
  const round = withEveryKind(6);
  assertEquals(staleChanges(round, goldOf(round)), []);
  // Gold rows the round does not touch change nothing.
  assertEquals(
    staleChanges(round, [...goldOf(round), sampleGene({ gene: "GENE99" })]),
    [],
  );
  assertEquals(staleChanges(sampleRound(0), []), []);
});

Deno.test("a gold row curated since the round was measured makes it stale", () => {
  const round = sampleRound(6);
  const gold = goldOf(round).map((g) =>
    g.gene === "GENE2" ? { ...g, affectedPathway: "Pathway A" } : g
  );
  assertEquals(staleChanges(round, gold), ["GENE2"]);
});

Deno.test("a list value or a score curated since counts as well", () => {
  const round = sampleRound(3);
  const [claims, citation] = goldOf(round);
  for (
    const edit of [
      { references: ["10000009"] },
      { references: [] },
      { confidence: null },
    ]
  ) {
    assertEquals(
      staleChanges(round, [{ ...claims, ...edit }, citation]),
      ["GENE2"],
    );
  }
});

Deno.test("a changed gene gold no longer holds makes the round stale", () => {
  const round = sampleRound(3);
  assertEquals(staleChanges(round, []), ["GENE2", "GENE3"]);
});

Deno.test("a new gene gold now holds makes the round stale", () => {
  const round = sampleRound(3);
  assertEquals(
    staleChanges(round, [...goldOf(round), sampleGene({ gene: "GENE1" })]),
    ["GENE1"],
  );
});

Deno.test("the stale genes are listed in the round's order", () => {
  const round = sampleRound(6);
  assertEquals(staleChanges(round, [sampleGene({ gene: "GENE4" })]), [
    "GENE2",
    "GENE3",
    "GENE4",
    "GENE5",
    "GENE6",
  ]);
});

Deno.test("a change to a gold gene that carries no gold row is stale", () => {
  const round = sampleRound(3);
  round.changes[1] = { ...round.changes[1], before: null };
  assertEquals(
    staleChanges(round, [sampleGene({ gene: "GENE2" }), ...goldOf(round)]),
    ["GENE2"],
  );
});
