import { assert, assertEquals } from "@std/assert";

import {
  type Answers,
  blankStep,
  EMPTY_ANSWERS,
} from "../../lib/adapt/answers.ts";
import {
  cardOf,
  cardProgress,
  CARDS,
  cardStates,
  cardSummary,
  entryCard,
  firstOpenCard,
  issueLabel,
} from "../../lib/adapt/cards.ts";
import { covers, stepRequired } from "../../lib/adapt/feedback.ts";
import { STEP_ORDER, validate } from "../../lib/adapt/validate.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

/** Answers that make validate() emit every kind of path it has. */
function variety(): Answers[] {
  const out: Answers[] = [EMPTY_ANSWERS, EXAMPLEITIS];
  for (const step of STEP_ORDER) out.push(blankStep(EXAMPLEITIS, step));
  const computed = structuredClone(EXAMPLEITIS);
  computed.monogenic.genes[0].symbol = "{{x";
  computed.vocabulary.traits[0].key = "## x";
  computed.prompt.examples[0].sentence = "a {{ b";
  computed.search.diseaseTerms.push("unchecked");
  computed.vocabulary.citationStandard = {
    name: "",
    label: "",
    doi: "",
    linkLabel: "",
  };
  computed.vocabulary.traits[0].standard = true;
  out.push(computed);
  return out;
}

Deno.test("every path validate() emits belongs to exactly one card", () => {
  for (const answers of variety()) {
    for (const issue of validate(answers)) {
      const owners = CARDS[issue.step].filter((card) =>
        card.owns.some((own) => covers(own, issue.field))
      );
      assertEquals(owners.length, 1, `${issue.step}:${issue.field}`);
      assertEquals(cardOf(issue.step, issue.field), owners[0].id);
    }
  }
  assertEquals(cardOf("identity", "nowhere"), null);
});

Deno.test("a step opens on its first unfinished card, and Continue moves past it", () => {
  const issues = validate(EMPTY_ANSWERS);
  const progress = cardProgress(
    issues,
    "identity",
    stepRequired(EMPTY_ANSWERS, "identity"),
  );
  assertEquals(firstOpenCard(progress, "identity"), "disease");
  assertEquals(firstOpenCard(progress, "identity", "disease"), "institute");
  assertEquals(firstOpenCard(progress, "identity", "cells"), "disease");
  const done = cardProgress(
    validate(EXAMPLEITIS),
    "identity",
    stepRequired(EXAMPLEITIS, "identity"),
  );
  assertEquals(firstOpenCard(done, "identity"), null);
  // Search opens past its optional NCBI card.
  const search = cardProgress(
    issues,
    "search",
    stepRequired(EMPTY_ANSWERS, "search"),
  );
  assertEquals(firstOpenCard(search, "search"), "phrases");
});

Deno.test("a step's opening card is worked out from the answers it is entered with", () => {
  // The island asks once, on entry, and holds the answer: recomputing it on
  // every render folded a card the moment its last key was typed.
  assertEquals(entryCard(EMPTY_ANSWERS, "identity"), "disease");
  assertEquals(entryCard(EMPTY_ANSWERS, "search"), "phrases");
  assertEquals(entryCard(EXAMPLEITIS, "identity"), null);
  const partial = structuredClone(EXAMPLEITIS);
  partial.identity.maintainer.email = "";
  assertEquals(entryCard(partial, "identity"), "maintainer");
});

Deno.test("a finished card summarises its answers in one line", () => {
  assertEquals(
    cardSummary(EXAMPLEITIS, "identity", "disease"),
    "exampleitis · EXD · Exampleitic · key exampleitis",
  );
  assertEquals(
    cardSummary(EXAMPLEITIS, "identity", "site"),
    "10 lines, drafted from the names",
  );
  const edited = structuredClone(EXAMPLEITIS);
  edited.identity.site.title = "Mine";
  assertEquals(
    cardSummary(edited, "identity", "site"),
    "10 lines · 1 edited by you",
  );
  assertEquals(
    cardSummary(EMPTY_ANSWERS, "monogenic", "genes"),
    "No monogenic genes",
  );
  assertEquals(
    cardSummary(EMPTY_ANSWERS, "vocabulary", "standard"),
    "No standard",
  );
  assertEquals(
    cardSummary(EMPTY_ANSWERS, "search", "ncbi"),
    "No key: three requests a second",
  );
  const keyed = structuredClone(EMPTY_ANSWERS);
  keyed.search.ncbi.email = "a@b.org";
  assertEquals(cardSummary(keyed, "search", "ncbi"), "Email set, no API key");
  keyed.search.ncbi.apiKey = "k";
  assertEquals(cardSummary(keyed, "search", "ncbi"), "API key set");
  // An empty list names nothing, so `listed()` falls back to the count alone.
  assertEquals(
    cardSummary(EMPTY_ANSWERS, "vocabulary", "families"),
    "0 families",
  );
  // No sections typed yet: every one of the card's ids reads as unwritten.
  assertEquals(
    cardSummary(EMPTY_ANSWERS, "prompt", "criteria"),
    "0 of 2 sections written",
  );
  // An unkeyed disease still summarises: the "key …" clause just drops out.
  const unkeyed = structuredClone(EXAMPLEITIS);
  unkeyed.identity.disease.key = "";
  assertEquals(
    cardSummary(unkeyed, "identity", "disease"),
    "exampleitis · EXD · Exampleitic",
  );
  // The light logo missing and the dark one present, the reverse of the
  // fixture, so both logo fields are seen both set and unset.
  const swappedLogos = structuredClone(EXAMPLEITIS);
  swappedLogos.identity.logoLight = null;
  swappedLogos.identity.logoDark = {
    name: "logo-dark.svg",
    base64: btoa("<svg/>"),
  };
  assertEquals(
    cardSummary(swappedLogos, "identity", "logos"),
    "logo-dark.svg",
  );
  // A named standard is read out rather than falling back to "No standard".
  const standard = structuredClone(EXAMPLEITIS);
  standard.vocabulary.citationStandard = {
    name: "ICHD-3",
    label: "ICHD-3, 2018",
    doi: "10.1000/example",
    linkLabel: "ICHD-3",
  };
  assertEquals(cardSummary(standard, "vocabulary", "standard"), "ICHD-3");
  for (const step of STEP_ORDER) {
    for (const card of CARDS[step]) {
      assert(
        cardSummary(EXAMPLEITIS, step, card.id) !== "",
        `${step}.${card.id}`,
      );
    }
  }
  assertEquals(cardSummary(EXAMPLEITIS, "identity", "nothing"), "");
});

Deno.test("cardStates carries each card's progress and summary", () => {
  const states = cardStates(
    EXAMPLEITIS,
    validate(EXAMPLEITIS),
    "gold",
    stepRequired(EXAMPLEITIS, "gold"),
  );
  assertEquals(Object.keys(states), ["rows"]);
  assertEquals(states.rows.progress.open, []);
  assert(
    states.rows.summary.startsWith(
      `${EXAMPLEITIS.gold.rows.length} gold PMIDs`,
    ),
  );
});

Deno.test("a Review item names the row or section it is about", () => {
  const label = (field: string, answers = EXAMPLEITIS) =>
    issueLabel(answers, {
      step: "identity",
      field,
      message: "m",
      kind: "missing",
    });
  assertEquals(
    label("sections.persona.specificity"),
    "Section persona.specificity",
  );
  assertEquals(label("traits[2].definition"), "Trait 3 (T3)");
  assertEquals(label("families[1]"), "Family 2 (fam-b)");
  assertEquals(label("rows[5].pmid"), "Gold row 6 (PMID 10000006)");
  assertEquals(label("cellTypes.glossary[0].name"), "Cell type 1 (EC)");
  assertEquals(label("diseaseTerms[0]"), "Phrase 1 (exampleitis)");
  assertEquals(label("meshTerms[0]"), "Phrase 1 (exampleitis)");
  assertEquals(label("markerTerms[1]"), "Marker term 2 (second marker)");
  assertEquals(label("populations[1].label"), "Population 2 (Late)");
  assertEquals(label("searchTerms[0]"), "Search term 1 (exampleitis)");
  assertEquals(label("conditions[0]"), "Condition 1 (exampleitis)");
  assertEquals(label("conditionPairs[0].1"), "Word pair 1 (example + disease)");
  assertEquals(
    label("mechanismFamilies[0].label"),
    "Mechanism family 1 (anti-example)",
  );
  assertEquals(
    label("mechanisms[0].name"),
    "Mechanism 1 (Example receptor antagonist)",
  );
  assertEquals(label("genes[0]"), "Gene 1 (GENEA)");
  assertEquals(label("aliases[0].symbols"), "Alias 1 (GENEA/B)");
  assertEquals(label("omimRows[0].location"), "OMIM row 1 (100001)");
  assertEquals(label("examples[1].type"), "Example 2 (PMID 10000002)");
  // A row not yet named is named by its place alone.
  const blank = structuredClone(EXAMPLEITIS);
  blank.gold.rows[0].pmid = "";
  assertEquals(label("rows[0].pmid", blank), "Gold row 1");
  // A path whose message names its own field needs no label.
  assertEquals(label("disease.name"), null);
  assertEquals(label("maintainer.email"), null);
});
