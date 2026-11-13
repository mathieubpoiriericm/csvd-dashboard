/** The review round's data boundary. */

import { assert, assertEquals } from "@std/assert";

import { normalizeReviewRound } from "../lib/data/review_round.ts";
import { simulate } from "../lib/review/simulate.ts";
import {
  sampleChange,
  sampleFinding,
  sampleRound,
  withEveryKind,
} from "./fixtures/review.ts";

function viaJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

Deno.test("a bare null is no round", () => {
  assertEquals(normalizeReviewRound(null), null);
  assertEquals(normalizeReviewRound("round"), null);
  assertEquals(normalizeReviewRound([]), null);
});

Deno.test("a round without its identity is no round", () => {
  for (const key of ["id", "runTimestamp", "base", "state"]) {
    assertEquals(normalizeReviewRound({ ...sampleRound(1), [key]: 7 }), null);
  }
  assertEquals(
    normalizeReviewRound({ ...sampleRound(1), state: "frozen" }),
    null,
  );
});

Deno.test("a round whose timestamp is not a date is no round", () => {
  // The simulated history is dated from the stamp, and an invalid date throws
  // where the app imports the review.
  for (const runTimestamp of ["garbage", "2026-13-45"]) {
    assertEquals(
      normalizeReviewRound({ ...sampleRound(1), runTimestamp }),
      null,
    );
  }
  const round = normalizeReviewRound({
    ...sampleRound(1),
    runTimestamp: "2026-01-05T10:00:00+00:00",
  });
  assertEquals(round?.runTimestamp, "2026-01-05T10:00:00+00:00");
  assert(round !== null);
  simulate(round);
});

Deno.test("a sound round survives unchanged", () => {
  const round = sampleRound(3);
  assertEquals(normalizeReviewRound(viaJson(round)), round);
  assertEquals(round.changes.map((c) => c.kind), ["new", "claims", "citation"]);
});

Deno.test("a citation and protein change is a kind the round knows", () => {
  const round = withEveryKind(3);
  assertEquals(normalizeReviewRound(viaJson(round)), round);
  assertEquals(round.changes[3].kind, "citation_protein");
});

Deno.test("a finding keeps the protein name it extracted", () => {
  const change = {
    ...sampleChange(),
    findings: [sampleFinding({ proteinName: "Protein one" })],
  };
  const round = normalizeReviewRound(
    viaJson({ ...sampleRound(1), changes: [change] }),
  );
  assertEquals(round?.changes[0].findings[0].proteinName, "Protein one");
});

Deno.test("a change that cannot be shown is dropped, not thrown on", () => {
  const round = {
    ...sampleRound(2),
    changes: [{ gene: "GENE1" }, 4, sampleChange()],
  };
  assertEquals(normalizeReviewRound(round)?.changes.length, 1);
});

Deno.test("a change needs a kind it knows and an after row", () => {
  const round = {
    ...sampleRound(1),
    changes: [
      { ...sampleChange(), kind: "other" },
      { ...sampleChange(), after: null },
      { ...sampleChange(), after: [] },
      { ...sampleChange(), version: 3 },
      sampleChange(),
    ],
  };
  assertEquals(normalizeReviewRound(viaJson(round))?.changes.length, 1);
});

Deno.test("a before row that is not an object reads as no gold row", () => {
  const round = {
    ...sampleRound(1),
    changes: [{ ...sampleChange(), before: 5 }],
  };
  assertEquals(normalizeReviewRound(round)?.changes[0].before, null);
});

Deno.test("an unknown field and a non-list addition are dropped", () => {
  const change = {
    ...sampleChange(),
    fields: [
      { field: "notAColumn", before: "a", after: "b", added: [], removed: [] },
      {
        field: "gwasTrait",
        before: { odd: true },
        after: true,
        added: "TRAIT-A",
        removed: ["TRAIT-B", 7],
      },
      { field: "confidence", before: 0.5, after: 0.7 },
      { field: "protein", before: "  P1 ", after: ["x", 3] },
      null,
    ],
  };
  const fields = normalizeReviewRound({ ...sampleRound(1), changes: [change] })
    ?.changes[0].fields;
  assertEquals(fields, [
    {
      field: "gwasTrait",
      before: null,
      after: null,
      added: [],
      removed: [],
    },
    { field: "confidence", before: 0.5, after: 0.7, added: [], removed: [] },
    { field: "protein", before: "P1", after: ["x"], added: [], removed: [] },
  ]);
});

Deno.test("an addition beside a non-list value is dropped, so the history builds", () => {
  for (const after of ["TRAIT-A; TRAIT-B", null, 3]) {
    const change = {
      ...sampleChange(),
      fields: [{
        field: "gwasTrait",
        before: ["TRAIT-A"],
        after,
        added: ["TRAIT-B"],
        removed: ["TRAIT-C"],
      }],
    };
    const round = normalizeReviewRound({
      ...sampleRound(1),
      changes: [change],
    });
    assert(round !== null);
    assertEquals(round.changes[0].fields[0].added, []);
    assertEquals(round.changes[0].fields[0].removed, []);
    simulate(round);
  }
});

Deno.test("findings default what they lack and never invent a flag", () => {
  const change = {
    ...sampleChange(),
    findings: [{}, {
      confidence: 3,
      mendelianRandomization: "yes",
      fulltext: 1,
      // An older file has no protein name; a malformed one is not text.
      proteinName: 7,
    }],
  };
  const findings = normalizeReviewRound({
    ...sampleRound(1),
    changes: [change],
  })
    ?.changes[0].findings;
  const bare = {
    pmid: null,
    confidence: null,
    gwasTraits: [],
    proteinName: null,
    mendelianRandomization: null,
    omicsEvidence: [],
    causalEvidenceSummary: null,
    sourceQuote: null,
    citationOnly: false,
    fulltext: null,
    extractionModel: null,
  };
  assertEquals(findings, [bare, bare]);
});

Deno.test("a gene row of a change goes through the gene normalizer", () => {
  const change = { ...sampleChange(), after: { gene: "GENE1" } };
  const after = normalizeReviewRound({ ...sampleRound(1), changes: [change] })
    ?.changes[0].after;
  assertEquals(after?.gwasTrait, ["(none found)"]);
  assertEquals(after?.references, ["(reference needed)"]);
});

Deno.test("the committed round normalizes or is null", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL("../data/review_round.json", import.meta.url),
    ),
  );
  const result = normalizeReviewRound(raw);
  if (raw === null) {
    assertEquals(result, null);
    return;
  }
  assert(result !== null, "a non-null review_round.json must normalize");
});
