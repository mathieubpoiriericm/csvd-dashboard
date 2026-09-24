import { assert, assertEquals } from "@std/assert";

import {
  alignMeshTerms,
  blankStep,
  DRAFT_STORAGE_KEY,
  DRAFT_VERSION,
  EMPTY_ANSWERS,
  type MeshChoice,
  parseDraft,
  parseDraftReport,
  serialiseDraft,
} from "../../lib/adapt/answers.ts";
import { exportableAnswers, importedAnswers } from "../../lib/adapt/bundle.ts";
import { jsonText } from "../../lib/adapt/generate/json.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";
import { MAXIMAL } from "./fixtures/maximal.ts";

const row = (phrase: string, heading: string | null): MeshChoice => ({
  phrase,
  heading,
  scopeNote: null,
  count: null,
});

Deno.test("the storage key stays in the svd- namespace the literal scan allows", () => {
  assertEquals(DRAFT_STORAGE_KEY, "svd-adapt-draft");
  assertEquals(DRAFT_VERSION, 1);
});

// MAXIMAL holds every field away from its empty value, so a field whose
// line parseDraft's shape lacks is missing from what it reads back.
Deno.test("every answer survives a draft's round trip", () => {
  assertEquals(parseDraft(serialiseDraft(MAXIMAL)), MAXIMAL);
});

Deno.test("every answer survives an export and its import, credentials included", () => {
  const exported = jsonText(exportableAnswers(MAXIMAL));
  // The export carries no credentials; the import keeps this browser's.
  assertEquals(exported.includes(MAXIMAL.search.ncbi.apiKey), false);
  assertEquals(importedAnswers(parseDraft(exported)!, MAXIMAL), MAXIMAL);
});

Deno.test("an unset confidence is written as null and read back as NaN", () => {
  const unset = structuredClone(MAXIMAL);
  unset.prompt.examples[0].confidence = NaN;
  const text = serialiseDraft(unset);
  assert(text.includes('"confidence":null'));
  const reloaded = parseDraft(text)!;
  assert(Number.isNaN(reloaded.prompt.examples[0].confidence));
  assertEquals(reloaded, unset);
});

Deno.test("a draft with a missing step falls back to the empty step", () => {
  const partial = JSON.stringify({
    version: 1,
    identity: EMPTY_ANSWERS.identity,
  });
  assertEquals(parseDraft(partial), EMPTY_ANSWERS);
});

Deno.test("a draft of another version, malformed JSON or a non-object is refused", () => {
  assertEquals(parseDraft(JSON.stringify({ version: 2 })), null);
  assertEquals(parseDraft("{not json"), null);
  assertEquals(parseDraft("[]"), null);
  assertEquals(parseDraft("null"), null);
});

Deno.test("alignMeshTerms holds one object per phrase and drops the tail", () => {
  const resolved = row("one", "One");
  // A phrase with no row yet gets a stand-in naming no phrase -- it was
  // not looked up, so it must not read as "MeSH has no heading for two"
  // -- and a row whose phrase is gone is dropped.
  assertEquals(alignMeshTerms(["one", "two"], [resolved]), [
    resolved,
    row("", null),
  ]);
  assertEquals(alignMeshTerms(["one"], [resolved, row("two", "Two")]), [
    resolved,
  ]);
  assertEquals(alignMeshTerms([], [resolved]), []);
  // The hole an array stretched by its length leaves, and the null it
  // serialises to, both become the placeholder rather than staying unread.
  const holed: MeshChoice[] = [resolved];
  holed.length = 2;
  assertEquals(alignMeshTerms(["one", "two"], holed), [
    resolved,
    row("", null),
  ]);
  assertEquals(
    alignMeshTerms(["one"], [null as unknown as MeshChoice]),
    [row("", null)],
  );
});

Deno.test("a draft with a null or a mistyped list entry loads, rows kept in place", () => {
  // A draft written before alignMeshTerms existed holds a null where a row
  // was never resolved; every step reads a property off each entry, so one
  // null renders nothing at all -- "Start over" included. The phrases and
  // their MeSH rows are matched by index, so an unreadable entry of either
  // keeps its place rather than moving every row below it onto another's.
  const draft = JSON.stringify({
    version: 1,
    search: {
      diseaseTerms: ["one", 7, "two", "three"],
      meshTerms: [
        null,
        row("", null),
        row("two", "Two"),
        row("three", "Three"),
      ],
      markerTerms: "not a list",
      ncbi: { email: "", apiKey: "" },
    },
    trials: {
      ...EMPTY_ANSWERS.trials,
      conditions: ["ok", null],
      searchTerms: { term: "one term", count: 3 },
    },
    gold: { rows: [null, { pmid: "1", note: "n", title: null, exists: true }] },
  });
  const report = parseDraftReport(draft)!;
  const parsed = report.answers;
  assertEquals(parsed.search.diseaseTerms, ["one", "", "two", "three"]);
  assertEquals(parsed.search.meshTerms.map((m) => m.heading), [
    null,
    null,
    "Two",
    "Three",
  ]);
  assertEquals(parsed.search.meshTerms[2].phrase, "two");
  // A list that is not a list is the empty one, not a value that throws;
  // one entry where a list belongs is a list of it.
  assertEquals(parsed.search.markerTerms, []);
  assertEquals(parsed.trials.searchTerms.map((t) => t.term), ["one term"]);
  assertEquals(parsed.trials.conditions, ["ok"]);
  assertEquals(parsed.gold.rows.length, 1);
  // Only what was there and could not be read is reported.
  assertEquals(report.dropped, [
    "search.diseaseTerms[1]",
    "search.markerTerms",
  ]);
  // The fallback slices are fresh objects equal to the empty step.
  assertEquals(parsed.identity, EMPTY_ANSWERS.identity);
  assert(parsed.identity !== EMPTY_ANSWERS.identity);
  assert(parsed.gold !== EMPTY_ANSWERS.gold);
  // A slice that is not an object at all is the empty step.
  assertEquals(parseDraft('{"version":1,"gold":3}')!.gold, EMPTY_ANSWERS.gold);
});

Deno.test("the empty answers are frozen all the way down", () => {
  const frozen = (value: unknown): boolean =>
    value === null || typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(frozen));
  assert(frozen(EMPTY_ANSWERS));
});

Deno.test("a draft's values are held to what a field could have written", () => {
  const draft = structuredClone(EXAMPLEITIS) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const answers = draft as unknown as typeof EXAMPLEITIS;
  answers.vocabulary.traits[0].xref = " ";
  answers.search.markerTerms[0].count = -3;
  answers.trials.searchTerms[0].count = 2.5;
  answers.identity.logoDark = { name: "logo.png", base64: "" };
  const text = JSON.stringify(answers).replace(
    '"count":1200',
    '"count":1e400',
  );
  const parsed = parseDraft(text)!;
  assertEquals(parsed.vocabulary.traits[0].xref, null);
  assertEquals(parsed.search.meshTerms[0].count, null);
  assertEquals(parsed.search.markerTerms[0].count, null);
  assertEquals(parsed.trials.searchTerms[0].count, null);
  assertEquals(parsed.identity.logoDark, null);
  // A logo over the cap reads as none.
  const big = structuredClone(EXAMPLEITIS);
  big.identity.logoLight = {
    name: "logo.svg",
    base64: btoa("x".repeat(1_000_001)),
  };
  assertEquals(parseDraft(serialiseDraft(big))!.identity.logoLight, null);
});

Deno.test("a draft is rebuilt field by field against the answers' shape", () => {
  const draft = JSON.stringify({
    version: 1,
    identity: {
      disease: { key: 7, name: "exampleitis" },
      site: null,
      siteEdited: "yes",
      logoLight: { name: "logo.svg", base64: "PHN2Zy8+" },
      logoDark: { name: "logo.png", base64: "not base64!" },
      cellTypes: { label: "Cells", glossary: [{ abbrev: "EC" }, "EC"] },
    },
    search: {
      diseaseTerms: ["one"],
      meshTerms: [{ phrase: "one", heading: 3, count: "12" }],
      markerTerms: [],
      ncbi: { email: "", apiKey: "" },
    },
    vocabulary: {
      traits: [{ key: "T1", standard: "yes" }],
      families: [],
      citationStandard: "none",
    },
    trials: { conditionPairs: [["a"], "b", ["c", "d"]] },
    monogenic: { genes: [{ symbol: "GENEA", verified: "true" }] },
    prompt: {
      sections: { "persona.specificity": "text", "rubric.modifiers": 4 },
      examples: [{ pmid: "1", confidence: null, traits: ["T1", 2] }],
    },
  });
  const parsed = parseDraft(draft)!;
  assertEquals(parsed.identity.disease, {
    ...EMPTY_ANSWERS.identity.disease,
    name: "exampleitis",
  });
  assertEquals(parsed.identity.site, EMPTY_ANSWERS.identity.site);
  // A field the answers no longer have, from an older draft, is dropped.
  assertEquals("siteEdited" in parsed.identity, false);
  assertEquals(parsed.identity.logoLight, {
    name: "logo.svg",
    base64: "PHN2Zy8+",
  });
  // A logo the archive could not decode is no logo, not a broken Review.
  assertEquals(parsed.identity.logoDark, null);
  assertEquals(parsed.identity.cellTypes.glossary, [{
    abbrev: "EC",
    name: "",
  }]);
  assertEquals(parsed.search.meshTerms, [row("one", null)]);
  assertEquals(parsed.vocabulary.citationStandard, null);
  // A flag of the wrong type is unset, not truthy.
  assertEquals(parsed.vocabulary.traits[0].standard, false);
  assertEquals(parsed.vocabulary.traits[0].key, "T1");
  assertEquals(parsed.trials.conditionPairs, [["a", ""], ["c", "d"]]);
  assertEquals(parsed.trials.populationField, { label: "", detailsLabel: "" });
  assertEquals(parsed.monogenic.genes, [
    { symbol: "GENEA", verified: null, clinvarTraits: [] },
  ]);
  assertEquals(parsed.prompt.sections, { "persona.specificity": "text" });
  const [example] = parsed.prompt.examples;
  assertEquals(example.traits, ["T1"]);
  assert(Number.isNaN(example.confidence));
  assertEquals(example.abstract, null);
});

Deno.test("blankStep empties one step and keeps its lists' lengths", () => {
  const blank = blankStep(EXAMPLEITIS, "identity");
  assertEquals(blank.identity.disease.name, "");
  assertEquals(blank.identity.logoLight, null);
  assertEquals(blank.identity.cellTypes.glossary, [{ abbrev: "", name: "" }]);
  assertEquals(blank.search, EXAMPLEITIS.search);
  const prompt = blankStep(EXAMPLEITIS, "prompt");
  assert(Number.isNaN(prompt.prompt.examples[0].confidence));
  assertEquals(prompt.prompt.examples[0].abstract, null);
  const vocabulary = blankStep(EXAMPLEITIS, "vocabulary");
  assertEquals(vocabulary.vocabulary.traits[0].xref, null);
  assertEquals(vocabulary.vocabulary.traits[0].standard, false);
});

// Every path NULLED names, by the full step-relative path a bare leaf key
// cannot tell apart from an ordinary text field (identity.site.title and
// .heading share their key with gold's rows.title and search's
// meshTerms.heading).
Deno.test("blankStep nulls every lookup result, by its full path", () => {
  const search = blankStep(EXAMPLEITIS, "search");
  assertEquals(search.search.meshTerms[0].heading, null);
  assertEquals(search.search.meshTerms[0].scopeNote, null);
  assertEquals(search.search.meshTerms[0].count, null);
  assertEquals(search.search.markerTerms[0].count, null);
  const trials = blankStep(EXAMPLEITIS, "trials");
  assertEquals(trials.trials.searchTerms[0].count, null);
  const monogenic = blankStep(EXAMPLEITIS, "monogenic");
  assertEquals(monogenic.monogenic.genes[0].verified, null);
  assertEquals(monogenic.monogenic.genes[0].clinvarTraits[0].omim, null);
  const gold = blankStep(EXAMPLEITIS, "gold");
  assertEquals(gold.gold.rows[0].title, null);
  assertEquals(gold.gold.rows[0].exists, null);
});
