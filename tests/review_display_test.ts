import { assertEquals } from "@std/assert";

import * as copy from "../lib/review/copy.ts";
import {
  ANSWER_LABELS,
  FIELD_LABELS,
  geneHref,
  KIND_LABELS,
  percent,
  proposalLine,
  settlesWords,
  STANDING_LABELS,
  tallyWords,
} from "../lib/review/display.ts";
import { sampleChange } from "./fixtures/review.ts";
import { sampleGene } from "./fixtures/rows.ts";

const field = (
  name: string,
  added: string[],
) => ({
  field: name as never,
  before: [],
  after: added,
  added,
  removed: [],
});

Deno.test("a change is described by what it adds", () => {
  assertEquals(proposalLine(sampleChange()), "+1 GWAS trait");
  assertEquals(
    proposalLine(sampleChange({ kind: "new", before: null, fields: [] })),
    "1 finding",
  );
  assertEquals(
    proposalLine(
      sampleChange({
        kind: "new",
        fields: [],
        findings: [sampleChange().findings[0], sampleChange().findings[0]],
      }),
    ),
    "2 findings",
  );
  assertEquals(
    proposalLine(sampleChange({
      fields: [
        field("gwasTrait", ["A", "B", "C"]),
        field("evidenceFromOtherOmicsStudies", ["x"]),
        field("linkToMonogenicDisease", ["d1", "d2"]),
        field("references", ["1", "2"]),
      ],
    })),
    "+3 GWAS traits · +1 omics entry · +2 monogenic disease links · +2 references",
  );
  assertEquals(
    proposalLine(sampleChange({
      fields: [
        field("references", ["1"]),
        { ...field("mendelianRandomization", []), before: "No", after: "Yes" },
      ],
    })),
    "+1 reference · Mendelian randomization changed",
  );
});

Deno.test("a change with nothing added says what it carries", () => {
  assertEquals(
    proposalLine(sampleChange({
      fields: [{ ...field("sourceQuote", []), before: "a", after: "b" }],
    })),
    "Quote and confidence for a paper already cited",
  );
  assertEquals(
    proposalLine(sampleChange({ fields: [] })),
    "Quote and confidence for a paper already cited",
  );
  assertEquals(
    proposalLine(sampleChange({
      fields: [{ ...field("mendelianRandomization", []), after: "Yes" }],
    })),
    "Mendelian randomization changed",
  );
});

Deno.test("a tally and its settling point are put in words", () => {
  const tally = { accept: 5, reject: 1, abstain: 1, outstanding: 4 };
  assertEquals(
    tallyWords(tally),
    "5 accept · 1 reject · 1 abstain · 4 to come",
  );
  assertEquals(settlesWords(tally), "Settles at 7 of the 10 not abstaining");
});

Deno.test("a gene's link survives a slash in its key", () => {
  assertEquals(
    new URL(geneHref("AB1/2"), "http://x").searchParams.get("g"),
    "AB1/2",
  );
  assertEquals(geneHref("GENE1"), "/review/gene?g=GENE1");
});

Deno.test("percent is a whole number and zero for an empty whole", () => {
  assertEquals(percent(1, 3), "33%");
  assertEquals(percent(2, 3), "67%");
  assertEquals(percent(5, 5), "100%");
  assertEquals(percent(0, 0), "0%");
  assertEquals(percent(0, 300), "0%");
});

Deno.test("percent shows neither 100% while owed nor 0% once begun", () => {
  assertEquals(percent(199, 200), "99%");
  assertEquals(percent(399, 400), "99%");
  assertEquals(percent(1, 300), "1%");
  assertEquals(percent(1, 1000), "1%");
});

Deno.test("every label table is complete and verbatim", () => {
  assertEquals(KIND_LABELS, {
    new: "New gene",
    claims: "Claims changed",
    citation_protein: "Citation and protein",
    citation: "Citation only",
  });
  assertEquals(STANDING_LABELS, {
    not_started: "Not started",
    in_review: "In review",
    conflict: "Conflict",
    accepted: "Accepted",
    rejected: "Rejected",
    no_quorum: "No quorum",
  });
  assertEquals(Object.values(ANSWER_LABELS), [
    "Accept",
    "Accept with edits",
    "Reject",
    "Abstain",
  ]);
  assertEquals(
    Object.keys(FIELD_LABELS),
    Object.keys(sampleGene({})),
  );
  assertEquals(Object.values(FIELD_LABELS), [
    "Gene",
    "Protein",
    "Chromosomal location",
    "GWAS traits",
    "Mendelian randomization",
    "Omics evidence",
    "Monogenic disease links",
    "Brain cell types",
    "Affected pathway",
    "References",
    "Source quote",
    "Confidence",
  ]);
});

Deno.test("the fixed copy is exported verbatim", () => {
  assertEquals(copy.REQUEST_OPEN, "Request an account");
  assertEquals(copy.ENTER_OBSERVER, "Enter as observer");
  assertEquals(copy.REQUEST_TITLE, "Request an account");
  assertEquals(copy.REQUEST_SUBMIT, "Send request");
  assertEquals(
    copy.REQUEST_DEMO,
    "Demonstration: the committee is not formed yet, so this form collects nothing. What you type is not stored or sent.",
  );
  assertEquals(
    copy.REQUEST_NOTICE,
    "Nothing was sent. Once the committee is formed, a request like this will be evaluated by the administrator and answered within a few working days.",
  );
  // The note's eyebrow and its sentence: together they read as the one line
  // they were.
  assertEquals(copy.SIMULATED_LABEL, "Simulated review:");
  assertEquals(
    copy.SIMULATED_NOTE,
    "The changes come from a real pipeline run, the committee and its verdicts are simulated, and none of it is in the other pages.",
  );
});

Deno.test("every changed field is named, the quote and confidence aside", () => {
  const scalar = (name: string) => ({
    ...field(name, []),
    before: "a",
    after: "b",
  });
  assertEquals(
    proposalLine(sampleChange({
      fields: [scalar("protein"), scalar("sourceQuote"), scalar("confidence")],
    })),
    "Protein changed",
  );
  assertEquals(
    proposalLine(sampleChange({
      fields: [scalar("protein"), field("references", ["1"])],
    })),
    "+1 reference · Protein changed",
  );
  assertEquals(
    proposalLine(sampleChange({
      fields: [
        field("references", ["1"]),
        scalar("sourceQuote"),
        scalar("confidence"),
      ],
    })),
    "+1 reference",
  );
  assertEquals(
    proposalLine(sampleChange({
      fields: [scalar("sourceQuote"), scalar("confidence")],
    })),
    "Quote and confidence for a paper already cited",
  );
  assertEquals(
    proposalLine(sampleChange({ fields: [scalar("confidence")] })),
    "Quote and confidence for a paper already cited",
  );
  // A list that only lost or reordered values is named as changed.
  assertEquals(
    proposalLine(sampleChange({
      fields: [{ ...field("gwasTrait", []), before: ["A"], removed: ["A"] }],
    })),
    "GWAS traits changed",
  );
  // In the change's field order, after the additions and the randomization.
  assertEquals(
    proposalLine(sampleChange({
      fields: [
        scalar("protein"),
        scalar("chromosomalLocation"),
        scalar("mendelianRandomization"),
        field("gwasTrait", ["A"]),
      ],
    })),
    "+1 GWAS trait · Mendelian randomization changed · Protein changed · Chromosomal location changed",
  );
});
