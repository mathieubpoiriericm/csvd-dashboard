import { assert, assertEquals } from "@std/assert";

import { parseDraft, serialiseDraft } from "../../lib/adapt/answers.ts";
import {
  addDiseaseTerm,
  addExamplePapers,
  applyTitles,
  checkedMeshRow,
  dropMeshHeading,
  parseConfidence,
  phrasesToCheck,
  pmidsToCheck,
  removeDiseaseTerm,
  removeFamily,
  renameFamily,
  setDiseaseTerm,
  spaced,
  writeMeshRow,
} from "../../lib/adapt/edits.ts";
import {
  applyAbstract,
  applyGeneCheck,
  applyMarkerCount,
  applyTrialCount,
  genesToCheck,
  hasOmimRow,
  lookupSummary,
  markerCountQuery,
  renameGene,
  replacesChoice,
  setTrialTerm,
  setXref,
  xrefAnswer,
} from "../../lib/adapt/edits.ts";
import { forgetRemoved } from "../../lib/adapt/feedback.ts";
import type { Fetch } from "../../lib/adapt/lookups.ts";
import { symbolFinder, validate } from "../../lib/adapt/validate.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

Deno.test("retyping or removing any phrase clears the marker counts it anchored", () => {
  // Every phrase anchors every marker count (markerCountQuery), so a count
  // taken before a phrase changed describes another query.
  const draft = structuredClone(EXAMPLEITIS);
  draft.search.diseaseTerms = ["one", "two"];
  const counted = () => draft.search.markerTerms.map((m) => m.count);
  assert(counted().every((c) => c !== null));

  setDiseaseTerm(draft, 1, "second");
  assertEquals(draft.search.diseaseTerms, ["one", "second"]);
  assert(counted().every((c) => c === null));

  draft.search.markerTerms[0].count = 5;
  draft.search.meshTerms = [
    { phrase: "one", heading: "One", scopeNote: null, count: 1 },
    { phrase: "second", heading: "Second", scopeNote: null, count: 2 },
  ];
  removeDiseaseTerm(draft, 1);
  assertEquals(draft.search.diseaseTerms, ["one"]);
  assertEquals(draft.search.meshTerms.map((m) => m.phrase), ["one"]);
  assertEquals(draft.search.markerTerms[0].count, null);
});

Deno.test("a marker count is anchored on every phrase, and lands only while they stand", () => {
  assertEquals(
    markerCountQuery(["one", " ", "two", "one "], " marker "),
    '("one"[Title/Abstract] OR "two"[Title/Abstract]) AND "marker"[Title/Abstract]',
  );
  const draft = structuredClone(EXAMPLEITIS);
  draft.search.diseaseTerms = ["one", "two"];
  draft.search.markerTerms = [
    { term: "marker", count: null },
    { term: "other", count: null },
    { term: " marker", count: null },
  ];
  assert(applyMarkerCount(draft, ["one", "two"], "marker", 7));
  assertEquals(draft.search.markerTerms.map((m) => m.count), [7, null, 7]);
  // Counted against phrases since changed: nothing lands.
  assert(!applyMarkerCount(draft, ["one"], "other", 3));
  assertEquals(draft.search.markerTerms[1].count, null);
  // A term removed or retyped meanwhile has no row.
  assert(!applyMarkerCount(draft, ["one", "two"], "gone", 3));
});

Deno.test("renaming a family carries its members, and only its own", () => {
  const families = [{ key: "fam-a" }, { key: "fam-b" }, { key: "" }];
  const members = [
    { family: "fam-a" },
    { family: " fam-a " },
    { family: "fam-b" },
    { family: "" },
  ];
  renameFamily(families, members, 0, "fam-c");
  assertEquals(families[0].key, "fam-c");
  assertEquals(members.map((m) => m.family), ["fam-c", "fam-c", "fam-b", ""]);
  // A blank key names no members: the unassigned stay unassigned.
  renameFamily(families, members, 2, "fam-d");
  assertEquals(members.map((m) => m.family), ["fam-c", "fam-c", "fam-b", ""]);
  // A family typed into another's key takes none of that family's members:
  // renaming the family that had the key first carries them away with it,
  // and the newcomer keeps the key with its own.
  renameFamily(families, members, 1, "fam-c");
  renameFamily(families, members, 0, "fam-e");
  assertEquals(members.map((m) => m.family), ["fam-e", "fam-e", "fam-c", ""]);
  assertEquals(families.map((f) => f.key), ["fam-e", "fam-c", "fam-d"]);
});

Deno.test("two families sharing a key each keep their own members", () => {
  const families = [{ key: "mri" }, { key: "vasc" }];
  const members = [{ family: "mri" }, { family: "mri" }, { family: "vasc" }];
  // Neither family's members name the shared key while both hold it: it
  // says nothing about which of the two they belong to.
  renameFamily(families, members, 1, " mri");
  assert(members.every((m) => m.family.trim() !== "mri"));
  // The newcomer leaves with its own; the first family gets its back.
  renameFamily(families, members, 1, "mri_b");
  assertEquals(members.map((m) => m.family), ["mri", "mri", "mri_b"]);
  // Removing the newcomer instead releases its own and returns the first
  // family's to it.
  renameFamily(families, members, 1, "mri");
  removeFamily(families, members, 1);
  assertEquals(members.map((m) => m.family), ["mri", "mri", ""]);
  // A key two others already share names none of them: its members stay.
  const shared = [{ key: "a" }, { key: "a" }, { key: "b" }];
  const onA = [{ family: "a" }];
  renameFamily(shared, onA, 2, "a");
  assertEquals(onA.map((m) => m.family), ["a"]);
});

Deno.test("a key retyped through blank or another family's key keeps its members", () => {
  // Backspaced to nothing and typed anew: the members are neither lost
  // among the unassigned nor left behind.
  const families = [{ key: "vasc" }, { key: "mri" }];
  const members = [
    { family: "vasc" },
    { family: "vasc" },
    { family: "" },
    { family: "mri" },
  ];
  for (const key of ["vas", "va", "v", ""]) {
    renameFamily(families, members, 0, key);
  }
  // Parked while the key is blank: no family's select option matches.
  assert(members.slice(0, 2).every((m) => m.family !== ""));
  assert(members.slice(0, 2).every((m) => m.family !== "mri"));
  for (const key of ["s", "small"]) renameFamily(families, members, 0, key);
  assertEquals(members.map((m) => m.family), ["small", "small", "", "mri"]);

  // Through another family's key on the way to a new one: not given to it.
  for (const key of ["smal", "mri", "mri_", "mri_c"]) {
    renameFamily(families, members, 0, key);
  }
  assertEquals(members.map((m) => m.family), ["mri_c", "mri_c", "", "mri"]);
  assertEquals(families.map((f) => f.key), ["mri_c", "mri"]);
});

Deno.test("removing a family releases the members parked on it, and no other row inherits them", () => {
  // Backspaced to nothing, the key parks its members on the row; removed,
  // the row's members go back to no family rather than waiting for whatever
  // family next takes the row's place.
  const families = [{ key: "fam-a" }, { key: "fam-b" }];
  const members = [
    { family: "fam-a" },
    { family: "fam-b" },
    { family: "fam-b" },
  ];
  renameFamily(families, members, 1, "");
  removeFamily(families, members, 1);
  assertEquals(members.map((m) => m.family), ["fam-a", "", ""]);
  families.push({ key: "" });
  for (const key of ["f", "fam-c"]) renameFamily(families, members, 1, key);
  assertEquals(members.map((m) => m.family), ["fam-a", "", ""]);
});

Deno.test("a removed family's members are released, however the next key is entered", () => {
  // Left naming the removed key, they were taken up by any family whose
  // key passed through it a keystroke at a time, and by none pasted whole.
  const start = () => ({
    families: [{ key: "mri" }, { key: "clin" }],
    members: [{ family: "mri" }, { family: " mri " }, { family: "clin" }],
  });
  const typed = start();
  removeFamily(typed.families, typed.members, 0);
  assertEquals(typed.members.map((m) => m.family), ["", "", "clin"]);
  typed.families.push({ key: "" });
  for (const key of ["m", "mr", "mri", "mri_", "mri_free"]) {
    renameFamily(typed.families, typed.members, 1, key);
  }
  const pasted = start();
  removeFamily(pasted.families, pasted.members, 0);
  pasted.families.push({ key: "" });
  renameFamily(pasted.families, pasted.members, 1, "mri_free");
  assertEquals(typed, pasted);
  assertEquals(typed.members.map((m) => m.family), ["", "", "clin"]);
});

Deno.test("a park follows its row when a family above it is removed", () => {
  const families = [{ key: "a" }, { key: "b" }, { key: "c" }];
  const members = [{ family: "a" }, { family: "b" }, { family: "c" }];
  renameFamily(families, members, 0, "");
  renameFamily(families, members, 1, "");
  removeFamily(families, members, 0);
  // The removed row's member is released; the next row's moved up with it,
  // and follows its key out of the blank.
  renameFamily(families, members, 0, "b2");
  assertEquals(members.map((m) => m.family), ["", "b2", "c"]);
  assertEquals(families.map((f) => f.key), ["b2", "c"]);
  // The removed family's member is released with it and another family's
  // is not touched; one parked on a row the list does not have stays parked.
  members.push({ family: "\u00009" });
  removeFamily(families, members, 0);
  assertEquals(members.map((m) => m.family), ["", "", "c", "\u00008"]);
  // A row the list does not have removes nothing.
  removeFamily(families, members, 9);
  assertEquals(members.map((m) => m.family), ["", "", "c", "\u00008"]);
  assertEquals(families.map((f) => f.key), ["c"]);
});

Deno.test("dropping a MeSH heading keeps its phrase checked", () => {
  const draft = structuredClone(EXAMPLEITIS);
  dropMeshHeading(draft, 0);
  assertEquals(draft.search.meshTerms[0], {
    phrase: "exampleitis",
    heading: null,
    scopeNote: null,
    count: null,
  });
  // No row there yet: nothing to drop.
  dropMeshHeading(draft, 3);
  assertEquals(draft.search.meshTerms.length, 1);
});

const meshAnswer = (phrase: string, count: number | null = 7) => ({
  phrase,
  heading: `${phrase} heading`,
  scopeNote: null,
  count,
});

Deno.test("a check looks up only the phrases no row answers, each once", () => {
  const draft = structuredClone(EXAMPLEITIS);
  draft.search.diseaseTerms = [" one ", "two", "", "one", "three", "four"];
  draft.search.meshTerms = [
    meshAnswer("one"),
    { ...meshAnswer("retyped"), phrase: "since retyped" },
    { phrase: "", heading: null, scopeNote: null, count: null },
  ];
  draft.search.meshTerms[4] = { ...meshAnswer("three"), heading: null };
  draft.search.meshTerms[5] = meshAnswer("four", null);
  // "one" is answered at 0 but not at 3; "two" names a row resolved for
  // other words; the blank is a query for everything; "three" has no
  // heading, which is an answer; "four"'s count never came back, so it is
  // asked again for it.
  assertEquals(phrasesToCheck(draft.search), ["two", "one", "four"]);
});

Deno.test("a row answers the phrase beside it while it names it as the files write it", () => {
  // The lookup stores the spelling it asked about, composed and with no
  // separator at an end; the field keeps what was pasted.
  const draft = structuredClone(EXAMPLEITIS);
  draft.search.diseaseTerms = ["oné", "two\u0085", "three", " ", "five"];
  draft.search.meshTerms = [
    meshAnswer("oné"),
    meshAnswer("two"),
    meshAnswer("since retyped"),
    { phrase: "", heading: null, scopeNote: null, count: null },
  ];
  assertEquals(
    draft.search.diseaseTerms.map((_, i) =>
      checkedMeshRow(draft.search, i)?.phrase
    ),
    ["oné", "two", undefined, undefined, undefined],
  );
  assertEquals(phrasesToCheck(draft.search), ["three", "five"]);
});

Deno.test("a MeSH answer lands on the phrase that asked, found by its words", () => {
  const draft = structuredClone(EXAMPLEITIS);
  draft.search.diseaseTerms = ["", "one", "two", "three"];
  draft.search.meshTerms = [];
  // Behind a blank first phrase: no hole before the row, which a reload
  // would read as null.
  assert(writeMeshRow(draft, "two", meshAnswer("two")));
  assertEquals(draft.search.meshTerms.map((m) => m.phrase), [
    "",
    "",
    "two",
    "",
  ]);
  assert(
    draft.search.meshTerms.every((m) => typeof m === "object" && m !== null),
  );
  // A phrase removed above it while the lookup ran: the answer lands on its
  // own phrase at its new index.
  removeDiseaseTerm(draft, 1);
  assert(writeMeshRow(draft, " three", meshAnswer("three")));
  assertEquals(draft.search.meshTerms.map((m) => m.heading), [
    null,
    "two heading",
    "three heading",
  ]);
  // Removed or retyped while it was out, or answered meanwhile: no write.
  const before = structuredClone(draft.search.meshTerms);
  assert(!writeMeshRow(draft, "one", meshAnswer("one")));
  assert(!writeMeshRow(draft, "two", meshAnswer("two")));
  assert(!writeMeshRow(draft, "", meshAnswer("")));
  assertEquals(draft.search.meshTerms, before);
});

Deno.test("a dropped heading stays dropped through the next check", () => {
  const draft = structuredClone(EXAMPLEITIS);
  dropMeshHeading(draft, 0);
  addDiseaseTerm(draft);
  setDiseaseTerm(draft, 1, "second");
  assertEquals(phrasesToCheck(draft.search), ["second"]);
  // Even an answer for its words that comes back finds nothing to fill.
  assert(!writeMeshRow(draft, "exampleitis", meshAnswer("exampleitis")));
  assertEquals(draft.search.meshTerms[0].heading, null);
  // A heading whose count failed is asked again, and its answer lands.
  draft.search.meshTerms[0] = meshAnswer("exampleitis", null);
  assert(writeMeshRow(draft, "exampleitis", meshAnswer("exampleitis")));
  assertEquals(draft.search.meshTerms[0].count, 7);
});

Deno.test("the MeSH rows move with their phrases, checked or not", () => {
  // One row per phrase from the moment a phrase is added, so removing one
  // shortens both lists at the same index: the row goes with its phrase,
  // and the touched state under meshTerms shifts with it.
  const draft = structuredClone(EXAMPLEITIS);
  draft.search.diseaseTerms = ["a", "b", "c"];
  draft.search.meshTerms = [meshAnswer("a")];
  removeDiseaseTerm(draft, 1);
  assertEquals(draft.search.meshTerms.map((m) => m.phrase), ["a", ""]);
  addDiseaseTerm(draft);
  assertEquals(draft.search.diseaseTerms, ["a", "c", ""]);
  assertEquals(draft.search.meshTerms.length, 3);
  const before = structuredClone(draft);
  removeDiseaseTerm(draft, 0);
  const seen = new Set(["search:meshTerms[1]", "search:diseaseTerms[1]"]);
  assertEquals([...forgetRemoved(seen, before, draft)].sort(), [
    "search:diseaseTerms[0]",
    "search:meshTerms[0]",
  ]);
  // A draft saved before the rows were kept aligned catches up on the
  // first phrase typed.
  draft.search.diseaseTerms = ["x", "y"];
  draft.search.meshTerms = [];
  setDiseaseTerm(draft, 1, "z");
  assertEquals(draft.search.meshTerms.length, 2);
});

Deno.test("the example papers join the gold list once each, as the files write them", () => {
  const draft = structuredClone(EXAMPLEITIS);
  draft.gold.rows = [{
    pmid: "10000001",
    note: "n",
    title: null,
    exists: null,
  }];
  draft.prompt.examples[0].pmid = " 10000001 ";
  draft.prompt.examples[1].pmid = "10000002 ";
  draft.prompt.examples.push(
    { ...draft.prompt.examples[1], pmid: "10000002" },
    { ...draft.prompt.examples[1], pmid: "" },
    { ...draft.prompt.examples[1], pmid: "0123" },
  );
  addExamplePapers(draft);
  // The padded one already listed, the repeat, the blank and the one no
  // lookup could confirm add nothing; the other arrives trimmed, once.
  assertEquals(draft.gold.rows, [
    { pmid: "10000001", note: "n", title: null, exists: null },
    { pmid: "10000002", note: "prompt example", title: null, exists: null },
  ]);
});

Deno.test("looked-up titles land on the rows they answer, by trimmed PMID", () => {
  const draft = structuredClone(EXAMPLEITIS);
  draft.gold.rows = [
    { pmid: " 1", note: "", title: null, exists: null },
    { pmid: "2", note: "", title: "kept", exists: true },
    { pmid: "3", note: "", title: null, exists: null },
  ];
  // An answer for a PMID no row holds any more is counted, not lost silently.
  assertEquals(
    applyTitles(draft, { "1": "Paper one", "3": null, "4": "Gone" }),
    1,
  );
  assertEquals(draft.gold.rows.map((r) => [r.title, r.exists]), [
    ["Paper one", true],
    ["kept", true],
    [null, false],
  ]);
});

Deno.test("a PMID lookup asks about every PMID validate() takes for one, once", () => {
  // Read as the files write them, like the write-backs and validate(): a
  // PMID with a separator at its end is one to validate(), which waits on
  // its check, so a lookup that trimmed it any other way could never run.
  const values = [" 10000001 ", "10000002\u0085", "\u001f10000001", "", "0123"];
  assertEquals(pmidsToCheck(values), ["10000001", "10000002"]);
  const draft = structuredClone(EXAMPLEITIS);
  draft.gold.rows = values.map((pmid) => ({
    pmid,
    note: "n",
    title: null,
    exists: null,
  }));
  draft.prompt.examples[0].pmid = "10000002\u0085";
  draft.prompt.examples[0].abstract = null;
  const pending = validate(draft).filter((i) => i.kind === "pending");
  assertEquals(pending.map((i) => `${i.step}:${i.field}`), [
    "prompt:examples[0].pmid",
    "gold:rows[0].pmid",
    "gold:rows[1].pmid",
  ]);
  // Each answer lands on the rows that asked, and nothing is left waiting.
  const [example] = pmidsToCheck([draft.prompt.examples[0].pmid]);
  assert(applyAbstract(draft, example, "Text."));
  const asked = pmidsToCheck(draft.gold.rows.map((row) => row.pmid));
  applyTitles(draft, Object.fromEntries(asked.map((pmid) => [pmid, "T"])));
  assertEquals(validate(draft).filter((i) => i.kind === "pending"), []);
});

Deno.test("an empty confidence is no answer, and any other text is its number", () => {
  assert(Number.isNaN(parseConfidence("")));
  assert(Number.isNaN(parseConfidence("  ")));
  assert(Number.isNaN(parseConfidence("abc")));
  assertEquals(parseConfidence("0.5"), 0.5);
  assertEquals(parseConfidence("0."), 0);
});

Deno.test("spaced holds one host's requests apart and passes the rest through", async () => {
  let clock = 1000;
  const waits: number[] = [];
  const seen: string[] = [];
  const f: Fetch = (input) => {
    seen.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("ok"));
  };
  let gap = 350;
  const paced = spaced(f, "eutils.example", () => gap, (ms) => {
    waits.push(ms);
    clock += ms;
    return Promise.resolve();
  }, () => clock);

  await paced("https://eutils.example/a");
  await paced(new URL("https://eutils.example/b"));
  gap = 110;
  await paced(new Request("https://eutils.example/c"));
  await paced("https://other.example/d");
  // Started at once, then a full gap, then the gap set when the previous
  // request started; the other host never waits.
  assertEquals(waits, [350, 350]);
  assertEquals(seen, [
    "https://eutils.example/a",
    "https://eutils.example/b",
    "https://eutils.example/c",
    "https://other.example/d",
  ]);
  // Time already passed counts towards the gap.
  clock += 1000;
  await paced("https://eutils.example/e");
  assertEquals(waits.length, 2);
});

Deno.test("spaced waits with a real timer by default", async () => {
  const f: Fetch = () => Promise.resolve(new Response("ok"));
  const paced = spaced(f, "eutils.example", () => 5);
  const started = Date.now();
  await paced("https://eutils.example/a");
  await paced("https://eutils.example/b");
  assert(Date.now() - started >= 4);
});

Deno.test("spaced waits at most one gap when the clock is set back", async () => {
  let clock = 10_000_000;
  const waits: number[] = [];
  const f: Fetch = () => Promise.resolve(new Response("ok"));
  const paced = spaced(f, "eutils.example", () => 350, (delay) => {
    waits.push(delay);
    return Promise.resolve();
  }, () => clock);
  await paced("https://eutils.example/a");
  clock -= 3_600_000;
  await paced("https://eutils.example/b");
  assertEquals(waits, [350]);
});

Deno.test("a study count lands on the rows holding its term, and a retyped term forgets its samples", () => {
  const draft = structuredClone(EXAMPLEITIS);
  draft.trials.searchTerms.push({
    term: "second",
    count: null,
    sampleConditions: [],
    sampleInterventions: [],
  });
  const sample = { conditions: ["C"], interventions: ["I"] };
  assert(applyTrialCount(draft, " second ", 4, sample));
  assertEquals(draft.trials.searchTerms[1].count, 4);
  assertEquals(draft.trials.searchTerms[1].sampleConditions, ["C"]);
  assert(!applyTrialCount(draft, "gone", 4, sample));
  setTrialTerm(draft, 0, "retyped");
  assertEquals(draft.trials.searchTerms[0], {
    term: "retyped",
    count: null,
    sampleConditions: [],
    sampleInterventions: [],
  });
});

Deno.test("a gene check lands on the unchecked row that asked, and its new spelling travels", () => {
  const draft = structuredClone(EXAMPLEITIS);
  draft.monogenic.genes = [
    { symbol: "genea", verified: null, clinvarTraits: [], clinvarSample: null },
    { symbol: "genea", verified: null, clinvarTraits: [], clinvarSample: null },
  ];
  draft.monogenic.omimRows[0].geneOrLocus = "genea ";
  draft.monogenic.aliases = [{ alias: "GENEA/B", symbols: ["genea", "GENEB"] }];
  const traits = [{ name: "Syndrome one", omim: "100001" }];
  assert(applyGeneCheck(draft, " genea", "GENEA", traits));
  assertEquals(draft.monogenic.genes[0], {
    symbol: "GENEA",
    verified: true,
    clinvarTraits: traits,
    clinvarSample: null,
  });
  // The second, still unchecked, is the next to take an answer.
  assertEquals(draft.monogenic.genes[1].verified, null);
  assertEquals(draft.monogenic.omimRows[0].geneOrLocus, "GENEA");
  assertEquals(draft.monogenic.aliases[0].symbols, ["GENEA", "GENEB"]);
  assert(applyGeneCheck(draft, "genea", null, []));
  assertEquals(draft.monogenic.genes[1].verified, false);
  // Nobody left to answer.
  assert(!applyGeneCheck(draft, "genea", "GENEA", []));
  // A rename to the same spelling, or from a blank, moves nothing.
  renameGene(draft, "GENEA", "GENEA ");
  renameGene(draft, " ", "X");
  assertEquals(draft.monogenic.omimRows[0].geneOrLocus, "GENEA");
});

Deno.test("a gene listed from a sample keeps that with its row", () => {
  const draft = structuredClone(EXAMPLEITIS);
  draft.monogenic.genes = [
    { symbol: "genea", verified: null, clinvarTraits: [], clinvarSample: null },
  ];
  const traits = [{ name: "Syndrome one", omim: "100001" }];
  const sample = { total: 612, read: 500 };
  // Said only on the status line, the next press or a reload left a
  // truncated list looking complete.
  assert(applyGeneCheck(draft, "genea", "GENEA", traits, sample));
  assertEquals(draft.monogenic.genes[0].clinvarSample, sample);
  assertEquals(
    parseDraft(serialiseDraft(draft))!.monogenic.genes[0].clinvarSample,
    sample,
  );
  // A lookup that did not answer read nothing, so it sampled nothing; and
  // a whole list clears what an earlier one left.
  draft.monogenic.genes[0].clinvarTraits = null;
  assert(applyGeneCheck(draft, "GENEA", "GENEA", null, sample));
  assertEquals(draft.monogenic.genes[0].clinvarSample, null);
  draft.monogenic.genes[0].clinvarSample = sample;
  assert(applyGeneCheck(draft, "GENEA", "GENEA", traits));
  assertEquals(draft.monogenic.genes[0].clinvarSample, null);
});

Deno.test("a gene whose ClinVar lookup failed keeps NCBI Gene's answer and is asked again", () => {
  const draft = structuredClone(EXAMPLEITIS);
  draft.monogenic.genes = [
    { symbol: "genea", verified: null, clinvarTraits: [], clinvarSample: null },
    { symbol: "GENEB", verified: true, clinvarTraits: [], clinvarSample: null },
    {
      symbol: "GENEC",
      verified: false,
      clinvarTraits: [],
      clinvarSample: null,
    },
    { symbol: " ", verified: null, clinvarTraits: [], clinvarSample: null },
    {
      symbol: " genea",
      verified: null,
      clinvarTraits: [],
      clinvarSample: null,
    },
  ];
  // The unchecked rows alone, each symbol once: a gene ClinVar attests
  // nothing for is answered, and so is one NCBI Gene refused.
  assertEquals(genesToCheck(draft.monogenic.genes), ["genea"]);
  // ClinVar failed. The verdict and the official spelling stay, so the
  // outage does not hold the step open, and the diseases are recorded as
  // not read rather than as none.
  assert(applyGeneCheck(draft, "genea", "GENEA", null));
  assertEquals(draft.monogenic.genes[0], {
    symbol: "GENEA",
    verified: true,
    clinvarTraits: null,
    clinvarSample: null,
  });
  assertEquals(draft.monogenic.omimRows[0].geneOrLocus, "GENEA");
  assert(!validate(draft).some((i) => i.field === "genes[0]"));
  // So the next press asks about it again, and the answer lands on it
  // rather than on the unchecked row below that types the same gene.
  assertEquals(genesToCheck(draft.monogenic.genes), ["GENEA", "genea"]);
  const traits = [{ name: "Syndrome one", omim: "100001" }];
  assert(applyGeneCheck(draft, "GENEA", "GENEA", traits));
  assertEquals(draft.monogenic.genes[0].clinvarTraits, traits);
  assertEquals(draft.monogenic.genes[4].verified, null);
  assertEquals(genesToCheck(draft.monogenic.genes), ["genea"]);
  // An answered row takes no second answer.
  assert(!applyGeneCheck(draft, "GENEB", "GENEB", traits));
  assertEquals(draft.monogenic.genes[1].clinvarTraits, []);
});

Deno.test("an OMIM row suggested by ClinVar is recognised once added", () => {
  assert(
    hasOmimRow(EXAMPLEITIS, "GENEA", { name: "Syndrome one", omim: "100001" }),
  );
  assert(
    !hasOmimRow(EXAMPLEITIS, "GENEA", { name: "Syndrome two", omim: "100009" }),
  );
  assert(
    hasOmimRow(EXAMPLEITIS, " GENEA", { name: "Syndrome one ", omim: null }),
  );
  assert(
    !hasOmimRow(EXAMPLEITIS, "GENEB", { name: "Syndrome one", omim: null }),
  );
});

Deno.test("a term search replaces a chosen term or a note of one's own only on a yes", () => {
  const trait = structuredClone(EXAMPLEITIS.vocabulary.traits[0]);
  const top = xrefAnswer("Trait one", [
    { id: "HP:1", label: "One" },
    { id: "HP:2", label: "Two" },
  ]);
  assertEquals(top, {
    xref: "HP:1",
    xrefNote: "OLS4 top hit: One; alternatives: HP:2 Two",
  });
  assertEquals(xrefAnswer("Trait one", []), {
    xref: null,
    xrefNote: 'no term in EFO, HP or MONDO for "Trait one"',
  });
  assertEquals(
    xrefAnswer("x", [{ id: "HP:1", label: "One" }]).xrefNote,
    "OLS4 top hit: One; alternatives: none",
  );
  // A hit named after a listed gene is given by its id: the note is public,
  // and with the label in it validate() refused what the search had written.
  const genes = symbolFinder(EXAMPLEITIS)!;
  const [gene] = EXAMPLEITIS.monogenic.genes;
  const named = xrefAnswer("Trait one", [
    { id: "MONDO:1", label: `${gene.symbol}-related exampleitis` },
    { id: "HP:2", label: "Two" },
    { id: "MONDO:3", label: `Exampleitis, ${gene.symbol} type` },
  ], genes);
  assertEquals(named, {
    xref: "MONDO:1",
    xrefNote: "OLS4 top hit: MONDO:1; alternatives: HP:2 Two; MONDO:3",
  });
  const draft = structuredClone(EXAMPLEITIS);
  Object.assign(draft.vocabulary.traits[0], named);
  assertEquals(
    validate(draft).filter((issue) => issue.field.startsWith("traits[0]")),
    [],
  );
  assertEquals(xrefAnswer("x", [{ id: "HP:1", label: "One" }], genes), {
    xref: "HP:1",
    xrefNote: "OLS4 top hit: One; alternatives: none",
  });
  // No term yet, and the fixture's note is its own words.
  assert(replacesChoice(trait, top));
  trait.xrefNote = "";
  assert(!replacesChoice(trait, top));
  trait.xref = "HP:1";
  trait.xrefNote = top.xrefNote;
  assert(!replacesChoice(trait, top));
  trait.xref = "HP:2";
  assert(replacesChoice(trait, top));
  trait.xref = null;
  trait.xrefNote = 'no term in EFO, HP or MONDO for "Trait one"';
  assert(!replacesChoice(trait, top));
  // Clearing the term takes the search's note about it along.
  trait.xref = "HP:1";
  trait.xrefNote = top.xrefNote;
  setXref(trait, " ");
  assertEquals([trait.xref, trait.xrefNote], [null, ""]);
  trait.xrefNote = "searched HP, nothing fits";
  setXref(trait, "");
  assertEquals(trait.xrefNote, "searched HP, nothing fits");
  setXref(trait, "HP:3");
  assertEquals(trait.xref, "HP:3");
});

Deno.test("a fetched abstract lands on the examples citing its PMID", () => {
  const draft = structuredClone(EXAMPLEITIS);
  assert(applyAbstract(draft, " 10000002 ", "Text."));
  assertEquals(draft.prompt.examples[1].abstract, "Text.");
  assert(!applyAbstract(draft, "999", null));
});

Deno.test("a lookup's line says what it did", () => {
  assertEquals(
    lookupSummary("mesh", 3, 1, 0),
    "Checked 3 phrases; 1 with no MeSH heading.",
  );
  assertEquals(lookupSummary("markers", 1, 0, 0), "Counted 1 marker term.");
  assertEquals(
    lookupSummary("trials", 2, 0, 1),
    "Counted 2 search terms. 1 row changed while checking; check again.",
  );
  assertEquals(
    lookupSummary("genes", 2, 2, 2),
    "Checked 2 symbols; 2 not the official symbol of a human gene. 2 rows changed while checking; check again.",
  );
  assertEquals(
    lookupSummary("gold", 10, 1, 0),
    "Checked 10 PMIDs; 1 not found in PubMed.",
  );
  assertEquals(
    lookupSummary("gold", 0, 0, 0),
    "Nothing to check: every row is checked or blank.",
  );
});

Deno.test("retyping a family's key as itself parks nobody", () => {
  // A trailing space is the same key as the files write it, and takes the
  // other family's members nowhere.
  const draft = structuredClone(EXAMPLEITIS);
  renameFamily(draft.vocabulary.families, draft.vocabulary.traits, 0, "fam-a ");
  assertEquals(draft.vocabulary.families[0].key, "fam-a ");
  assertEquals(
    draft.vocabulary.traits.map((t) => t.family),
    ["fam-a ", "fam-a ", "fam-b", "fam-b"],
  );
});
