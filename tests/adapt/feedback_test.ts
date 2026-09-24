import { assert, assertEquals } from "@std/assert";

import { type Answers, EMPTY_ANSWERS } from "../../lib/adapt/answers.ts";
import { entryCard } from "../../lib/adapt/cards.ts";
import {
  covers,
  fieldView,
  firstInPage,
  forgetRemoved,
  isSeen,
  ownIssues,
  progressOf,
  reveal,
  seenKey,
  stepRequired,
  stepState,
  targetField,
  valueAt,
} from "../../lib/adapt/feedback.ts";
import { type Issue, STEP_ORDER, validate } from "../../lib/adapt/validate.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

const issue = (
  field: string,
  message = "The disease name is required.",
): Issue => ({
  step: "identity",
  field,
  message,
  kind: "missing",
});

Deno.test("covers matches the path, its rows and its fields, not a prefix of a word", () => {
  assert(covers("conditions", "conditions"));
  assert(covers("conditions", "conditions[2]"));
  assert(covers("disease", "disease.key"));
  assert(!covers("disease", "diseaseTerms[0]"));
  // A row's first control answers for the row, not for the controls beside
  // it, which carry their own paths.
  assert(covers("families[0]", "families[0]"));
  assert(!covers("families[0]", "families[0].label"));
  assert(!covers("conditionPairs[1]", "conditionPairs[1].1"));
  assert(covers("families", "families[0].label"));
});

Deno.test("an untouched blank required field is marked, not red", () => {
  const own = [issue("disease.name")];
  assertEquals(
    fieldView({
      field: "disease.name",
      text: "",
      own,
      seen: false,
      required: true,
    }).state,
    "required",
  );
  const seen = fieldView({
    field: "disease.name",
    text: "",
    own,
    seen: true,
    required: true,
  });
  assertEquals([seen.state, seen.message], [
    "error",
    "The disease name is required.",
  ]);
  assertEquals(
    fieldView({
      field: "institute.url",
      text: "",
      own: [],
      seen: true,
      required: false,
    }).state,
    "idle",
  );
  assertEquals(
    fieldView({
      field: "families[0].label",
      text: "",
      own: [],
      seen: true,
      required: true,
    }).message,
    "This is required.",
  );
});

Deno.test("an offending character is red at once, seen or not", () => {
  const view = fieldView({
    field: "disease.key",
    text: "Example-itis",
    own: [issue("disease.key", "x")],
    seen: false,
    required: true,
  });
  assertEquals(view.state, "error");
  assertEquals(view.fix, "example_itis");
  assertEquals(view.offences.length, 2);
});

Deno.test("an incomplete value is a note while typed and an error once left", () => {
  const own = [
    issue(
      "maintainer.email",
      "Enter a valid email address for the maintainer.",
    ),
  ];
  const typing = fieldView({
    field: "maintainer.email",
    text: "ada@",
    own,
    seen: false,
    required: true,
  });
  assertEquals([typing.state, typing.message], [
    "note",
    'Still needed: the domain after the "@", e.g. example.org.',
  ]);
  const left = fieldView({
    field: "maintainer.email",
    text: "ada@",
    own,
    seen: true,
    required: true,
  });
  assertEquals([left.state, left.message, left.note], [
    "error",
    "Enter a valid email address for the maintainer.",
    'Still needed: the domain after the "@", e.g. example.org.',
  ]);
  // A rule with no note falls back to validate()'s message, muted.
  const dup = fieldView({
    field: "traits[1].key",
    text: "T1",
    own: [issue("traits[1].key", '"T1" is used twice.')],
    seen: false,
    required: true,
  });
  assertEquals([dup.state, dup.message], ["note", '"T1" is used twice.']);
  assertEquals(
    fieldView({
      field: "disease.name",
      text: "x",
      own: [],
      seen: false,
      required: true,
    }).state,
    "valid",
  );
});

// A field with no character rule (ruleFor returns null) still has to report
// an issue validate() already found once it has been seen -- fieldView must
// not assume a diagnosis exists before reading its note or fix off it.
Deno.test("a field with no character rule still reports an issue once seen", () => {
  const view = fieldView({
    field: "disease.name",
    text: "x",
    own: [issue("disease.name")],
    seen: true,
    required: true,
  });
  assertEquals([view.state, view.message, view.note, view.fix], [
    "error",
    "The disease name is required.",
    null,
    null,
  ]);
});

Deno.test("a control owning several issues shows every distinct message", () => {
  // A comma list answers for each of its items, and each item can fail on
  // its own; showing only the first message lost the rest once the step's
  // own issue list was gone.
  const own = [
    issue("conditions[1]", "A condition substring cannot be empty."),
    issue("conditions[2]", "A condition substring cannot be empty."),
    issue("conditions[3]", '"x y" is odd.'),
  ];
  const seen = fieldView({
    field: "conditions",
    text: "a, x y",
    own,
    seen: true,
    required: true,
  });
  assertEquals([seen.state, seen.message, seen.more], [
    "error",
    "A condition substring cannot be empty.",
    ['"x y" is odd.'],
  ]);
  // Muted while typed, all of them, when the rule has no note to say instead.
  const typing = fieldView({
    field: "conditions",
    text: "a, x y",
    own,
    seen: false,
    required: true,
  });
  assertEquals([typing.state, typing.message, typing.more], [
    "note",
    "A condition substring cannot be empty.",
    ['"x y" is odd.'],
  ]);
  // A note stands for the whole verdict while typed; validate()'s messages
  // wait for the reveal.
  const email = [
    issue("maintainer.email", "Enter a valid email address."),
    issue("maintainer.email", "Another rule."),
  ];
  assertEquals(
    fieldView({
      field: "maintainer.email",
      text: "ada@",
      own: email,
      seen: false,
      required: true,
    }).more,
    [],
  );
  const blank = fieldView({
    field: "conditions",
    text: "",
    own: [issue("conditions", "Add one."), issue("conditions[0]", "Empty.")],
    seen: true,
    required: true,
  });
  assertEquals([blank.message, blank.more], ["Add one.", ["Empty."]]);
  // An offence names its characters at once; once the field is left, the
  // messages about the rest of the list follow it, so an item that fails for
  // another reason is not lost behind it. The offending item's own message
  // would only say the same fault again, so it stays unsaid.
  const offended = [
    issue("conditions[0]", "A condition substring cannot be empty."),
    issue("conditions[1]", '"a-b" can never match.'),
  ];
  const values: Record<string, string> = {
    "conditions[0]": "",
    "conditions[1]": "a-b",
  };
  const typed = fieldView({
    field: "conditions",
    text: ", a-b",
    own: offended,
    seen: false,
    required: true,
    valueOf: (path) => values[path],
  });
  assertEquals([typed.state, typed.more], ["error", []]);
  const left = fieldView({
    field: "conditions",
    text: ", a-b",
    own: offended,
    seen: true,
    required: true,
    valueOf: (path) => values[path],
  });
  assertEquals([left.state, left.message, left.more], [
    "error",
    typed.message,
    ["A condition substring cannot be empty."],
  ]);
  // With no way to read an item, only the control's own path is known to
  // restate the offence.
  assertEquals(
    fieldView({
      field: "conditions",
      text: ", a-b",
      own: [...offended, issue("conditions", "Restated.")],
      seen: true,
      required: true,
    }).more,
    [
      "A condition substring cannot be empty.",
      '"a-b" can never match.',
    ],
  );
});

Deno.test("an offending value, once left, says its fault once", () => {
  // validate()'s wording of the same fault under the named characters was
  // the second of two lines saying one thing; the spec's timing table holds
  // an offence the same after leaving as while typing.
  for (
    const [field, text, message] of [
      ["disease.key", "Example-itis", "The key must be lower-case letters."],
      ["maintainer.email", "a b@x.org", "Enter a valid email address."],
    ]
  ) {
    const view = fieldView({
      field,
      text,
      own: [issue(field, message)],
      seen: true,
      required: true,
      valueOf: () => text,
    });
    assertEquals([view.state, view.more], ["error", []], field);
  }
});

Deno.test("seen is keyed by step and path, and covers the issues a control owns", () => {
  const own = ownIssues(
    [issue("disease.key"), issue("disease.name"), {
      step: "search",
      field: "disease.key",
      message: "m",
      kind: "missing",
    }],
    "identity",
    "disease.key",
  );
  assertEquals(own.length, 1);
  assert(
    isSeen(
      new Set([seenKey("identity", "disease.key")]),
      "identity",
      "disease.key",
      [],
    ),
  );
  const conditions: Issue[] = [{
    step: "trials",
    field: "conditions[1]",
    message: "m",
    kind: "wrong",
  }];
  assert(
    isSeen(
      reveal(new Set(), "trials", ["conditions[1]"]),
      "trials",
      "conditions",
      conditions,
    ),
  );
  assert(!isSeen(new Set(), "trials", "conditions", conditions));
});

Deno.test("forgetRemoved drops a removed row's keys and shifts the rows below", () => {
  const before = structuredClone(EXAMPLEITIS);
  const after = structuredClone(EXAMPLEITIS);
  after.vocabulary.traits.splice(1, 1);
  const keys = new Set([
    seenKey("vocabulary", "traits[0].key"),
    seenKey("vocabulary", "traits[1].key"),
    seenKey("vocabulary", "traits[2].label"),
    seenKey("identity", "disease.key"),
  ]);
  assertEquals([...forgetRemoved(keys, before, after)].sort(), [
    "identity:disease.key",
    "vocabulary:traits[0].key",
    "vocabulary:traits[1].label",
  ]);
  // Nothing removed: nothing moves.
  assertEquals(forgetRemoved(keys, before, before), keys);
  // The last row removed.
  const last = structuredClone(EXAMPLEITIS);
  last.vocabulary.traits.pop();
  assertEquals(
    forgetRemoved(
      new Set([seenKey("vocabulary", "traits[3].key")]),
      before,
      last,
    ).size,
    0,
  );
});

Deno.test("valueAt reads a step-relative path, sections included", () => {
  assertEquals(valueAt(EXAMPLEITIS, "identity", "disease.key"), "exampleitis");
  assertEquals(valueAt(EXAMPLEITIS, "vocabulary", "traits[1].key"), "T2");
  assertEquals(
    valueAt(EXAMPLEITIS, "prompt", "sections.persona.specificity"),
    EXAMPLEITIS.prompt.sections["persona.specificity"],
  );
  assertEquals(
    valueAt(EXAMPLEITIS, "identity", "disease.key.nothing"),
    undefined,
  );
});

Deno.test("progress counts what is asked, answered and wrongly typed", () => {
  const required = stepRequired(EMPTY_ANSWERS, "identity");
  assertEquals(required.length, 24);
  const empty = progressOf(
    validate(EMPTY_ANSWERS),
    "identity",
    required,
  );
  assertEquals([empty.asked, empty.answered, empty.toFix], [24, 0, 0]);
  const typed = structuredClone(EMPTY_ANSWERS);
  typed.identity.disease.name = "exampleitis";
  typed.identity.disease.key = "Example-itis";
  const p = progressOf(
    validate(typed),
    "identity",
    stepRequired(typed, "identity"),
  );
  assertEquals([p.asked, p.answered, p.toFix], [24, 2, 1]);
  const clean = progressOf(
    validate(EXAMPLEITIS),
    "identity",
    stepRequired(EXAMPLEITIS, "identity"),
  );
  assertEquals(clean.open, []);
  // A card's slice of the same count.
  const disease = progressOf(
    validate(typed),
    "identity",
    stepRequired(typed, "identity"),
    (path) => covers("disease", path),
  );
  assertEquals([disease.asked, disease.answered], [5, 2]);
});

// A number field wrongly typed (not blank, not NaN) still counts toward
// toFix: the count reads validate()'s kind, not the value's shape.
Deno.test("progress counts a wrongly typed number as answered and to fix", () => {
  const typed = structuredClone(EXAMPLEITIS);
  typed.prompt.examples[0].confidence = 5;
  const required = stepRequired(typed, "prompt");
  const p = progressOf(validate(typed), "prompt", required);
  assertEquals(p.open, ["examples[0].confidence"]);
  assertEquals([p.toFix, p.answered], [1, p.asked]);
});

Deno.test("stepState reads a progress count as the stepper shows it", () => {
  assertEquals(stepState({ asked: 0, answered: 0, toFix: 0, open: [] }), {
    state: "done",
    detail: "Done",
  });
  assertEquals(
    stepState({ asked: 5, answered: 2, toFix: 1, open: ["a", "b", "c", "d"] }),
    { state: "fix", detail: "1 to fix" },
  );
  assertEquals(stepState({ asked: 5, answered: 2, toFix: 0, open: ["a"] }), {
    state: "progress",
    detail: "2/5",
  });
  assertEquals(stepState({ asked: 5, answered: 0, toFix: 0, open: ["a"] }), {
    state: "todo",
    detail: "Not started",
  });
});

Deno.test("firstInPage picks the first candidate in page order that answers for any of the paths", () => {
  // The disease card: validate() checks the key before the name, but the
  // name sits first on screen, so it is the one focus should reach.
  assertEquals(
    firstInPage(
      ["disease.name", "disease.short", "disease.adjective", "disease.key"],
      ["disease.key", "disease.name", "disease.short", "disease.adjective"],
    ),
    0,
  );
  // A page-order candidate that only covers a path, rather than naming it
  // exactly, still wins over one appearing later that matches it exactly.
  assertEquals(
    firstInPage(["conditions", "disease.name"], [
      "conditions[2]",
      "disease.name",
    ]),
    0,
  );
  assertEquals(
    firstInPage(["traits", "traits[0].key"], ["traits[0].key"]),
    0,
  );
  // No candidate answers for any of the paths.
  assertEquals(firstInPage(["disease.name"], ["meshTerms[0]"]), -1);
});

/** A bare object shaped enough like an HTMLElement for targetField(). */
function fakeElement(
  field: string | undefined,
  nearest: { field: string | undefined } | null,
): HTMLElement {
  const nearestElement: Partial<HTMLElement> | null = nearest === null
    ? null
    : { dataset: { field: nearest.field } as DOMStringMap };
  return {
    dataset: { field } as DOMStringMap,
    // Only the selectors targetField() is meant to ask answer: a mutant
    // reaching for another container or control finds nothing.
    closest: (selector: string) =>
      nearest === null || selector !== ".adapt-field" ? null : {
        querySelector: (inner: string) =>
          inner === "[data-field]" ? nearestElement : null,
      } as unknown as Element,
  } as unknown as HTMLElement;
}

Deno.test("targetField reads a control's own field, else the one its nearest .adapt-field names", () => {
  // Its own data-field wins even when a container carries a different one.
  assertEquals(
    targetField(fakeElement("disease.name", { field: "institute.name" })),
    "disease.name",
  );
  // The "Use …" fix button carries none of its own: the field is the one
  // the surrounding .adapt-field marks on its actual control.
  assertEquals(
    targetField(fakeElement(undefined, { field: "disease.name" })),
    "disease.name",
  );
  // No .adapt-field at all -- the control answers for nothing.
  assertEquals(targetField(fakeElement(undefined, null)), undefined);
  // A .adapt-field with no field-marked control inside it either.
  assertEquals(
    targetField(fakeElement(undefined, { field: undefined })),
    undefined,
  );
});

const progress = (answers: Answers, step: Parameters<typeof stepRequired>[1]) =>
  progressOf(validate(answers), step, stepRequired(answers, step));

Deno.test("to fix counts what validate() calls wrong, whatever the value's shape", () => {
  const withChange = (change: (a: Answers) => void) => {
    const copy = structuredClone(EXAMPLEITIS);
    change(copy);
    return copy;
  };
  const comma = progress(
    withChange((a) =>
      a.monogenic.genes.push({
        symbol: "A,",
        verified: null,
        clinvarTraits: [],
      })
    ),
    "monogenic",
  );
  assertEquals([comma.toFix, stepState(comma).state], [1, "fix"]);
  assertEquals(
    progress(
      withChange((a) => a.search.markerTerms[0].term = '"marker"'),
      "search",
    ).toFix,
    1,
  );
  assertEquals(
    progress(
      withChange((a) => a.trials.conditionPairs = [["a", "b-c"]]),
      "trials",
    ).toFix,
    1,
  );
  assertEquals(
    progress(
      withChange((a) =>
        a.identity.cellTypes.glossary.push({ abbrev: "EC", name: "Again" })
      ),
      "identity",
    ).toFix,
    1,
  );
  // Ten valid PMIDs still to be checked are work left, not mistakes.
  const unchecked = progress(
    withChange((a) => a.gold.rows.forEach((row) => row.exists = null)),
    "gold",
  );
  assertEquals(unchecked.toFix, 0);
  assert(stepState(unchecked).state !== "fix");
  for (const step of STEP_ORDER) {
    assertEquals(progress(EMPTY_ANSWERS, step).toFix, 0, step);
  }
});

Deno.test("answering a cross-reference raises answered and leaves asked alone", () => {
  const unpicked = structuredClone(EXAMPLEITIS);
  unpicked.vocabulary.traits[1].family = "";
  const before = progress(unpicked, "vocabulary");
  const after = progress(EXAMPLEITIS, "vocabulary");
  assertEquals([after.asked, after.answered], [
    before.asked,
    before.answered + 1,
  ]);
  const unchecked = structuredClone(EXAMPLEITIS);
  unchecked.search.meshTerms = [];
  const phrase = progress(unchecked, "search");
  const checked = progress(EXAMPLEITIS, "search");
  assertEquals(checked.asked, phrase.asked);
  assert(checked.answered > phrase.answered);
  const geneless = structuredClone(EXAMPLEITIS);
  geneless.monogenic.omimRows[0].geneOrLocus = "";
  const row = progress(geneless, "monogenic");
  const named = progress(EXAMPLEITIS, "monogenic");
  assertEquals([named.asked, named.answered], [row.asked, row.answered + 1]);
});

Deno.test("the empty draft asks for a family, and the Traits step opens on its card", () => {
  assert(stepRequired(EMPTY_ANSWERS, "vocabulary").includes("families"));
  assertEquals(entryCard(EMPTY_ANSWERS, "vocabulary"), "families");
});

Deno.test("forgetRemoved keeps no state it cannot place", () => {
  // Identical neighbours: either could have gone, so neither keeps it.
  const two = structuredClone(EMPTY_ANSWERS);
  two.search.diseaseTerms = ["", ""];
  const one = structuredClone(EMPTY_ANSWERS);
  one.search.diseaseTerms = [""];
  assertEquals(
    forgetRemoved(
      new Set([
        seenKey("search", "diseaseTerms[0]"),
        seenKey("search", "meshTerms"),
      ]),
      two,
      one,
    ),
    new Set([seenKey("search", "meshTerms")]),
  );
  // A list shrunk by several rows, or replaced by a shorter one.
  const shrunk = structuredClone(EXAMPLEITIS);
  shrunk.vocabulary.traits.splice(1, 2);
  assertEquals(
    forgetRemoved(
      new Set([
        seenKey("vocabulary", "traits[0].key"),
        seenKey("vocabulary", "traits[3].label"),
        seenKey("vocabulary", "families[0]"),
      ]),
      EXAMPLEITIS,
      shrunk,
    ),
    new Set([seenKey("vocabulary", "families[0]")]),
  );
  // A record set to null: its fields keep nothing, so a standard named
  // again later is not red before it is touched.
  const named = structuredClone(EXAMPLEITIS);
  named.vocabulary.citationStandard = {
    name: "",
    label: "",
    doi: "",
    linkLabel: "",
  };
  const unnamed = structuredClone(named);
  unnamed.vocabulary.citationStandard = null;
  assertEquals(
    forgetRemoved(
      new Set([seenKey("vocabulary", "citationStandard.name")]),
      named,
      unnamed,
    ).size,
    0,
  );
  // One row removed from distinct ones still shifts the rows below.
  const removed = structuredClone(EXAMPLEITIS);
  removed.vocabulary.traits.splice(0, 1);
  assertEquals(
    forgetRemoved(
      new Set([seenKey("vocabulary", "traits[2].key")]),
      EXAMPLEITIS,
      removed,
    ),
    new Set([seenKey("vocabulary", "traits[1].key")]),
  );
});
