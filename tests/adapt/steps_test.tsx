import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { Card } from "../../components/adapt/Card.tsx";
import {
  ParsedTextField,
  SelectField,
  TextField,
} from "../../components/adapt/Field.tsx";
import {
  FieldNote,
  LogoInput,
  NotedCheckbox,
} from "../../components/adapt/FieldNote.tsx";
import { AddButton } from "../../components/adapt/ListEditor.tsx";
import { StepSummary } from "../../components/adapt/StepSummary.tsx";
import { GoldStep } from "../../components/adapt/steps/GoldStep.tsx";
import { IdentityStep } from "../../components/adapt/steps/IdentityStep.tsx";
import { MonogenicStep } from "../../components/adapt/steps/MonogenicStep.tsx";
import { PromptStep } from "../../components/adapt/steps/PromptStep.tsx";
import { ReviewStep } from "../../components/adapt/steps/ReviewStep.tsx";
import { SearchStep } from "../../components/adapt/steps/SearchStep.tsx";
import { TrialsStep } from "../../components/adapt/steps/TrialsStep.tsx";
import { VocabularyStep } from "../../components/adapt/steps/VocabularyStep.tsx";
import { WizardContext } from "../../components/adapt/wizard_context.ts";
import {
  type Answers,
  blankStep,
  EMPTY_ANSWERS,
  isRecord,
  parseDraft,
  serialiseDraft,
} from "../../lib/adapt/answers.ts";
import { diagnose, ruleFor } from "../../lib/adapt/characters.ts";
import {
  addDiseaseTerm,
  dropMeshHeading,
  phrasesToCheck,
  setDiseaseTerm,
  writeMeshRow,
} from "../../lib/adapt/edits.ts";
import { covers, reveal, valueAt } from "../../lib/adapt/feedback.ts";
import { meshHeadings } from "../../lib/adapt/generate/pipeline.ts";
import { type Fetch, meshRow } from "../../lib/adapt/lookups.ts";
import { issuesFor, STEP_ORDER, validate } from "../../lib/adapt/validate.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";
import { wizardFor } from "./wizard_fixture.ts";

const noop = () => {};
const props = (answers = EXAMPLEITIS) => ({
  answers,
  update: noop,
  issues: validate(answers),
  fetch: globalThis.fetch,
  setStatus: noop,
  busy: false,
  lookup: noop,
});

Deno.test("every step renders its fields from the fixture", () => {
  const identity = renderToString(<IdentityStep {...props()} />);
  assertStringIncludes(identity, 'value="exampleitis"');
  assertStringIncludes(identity, "Example Institute");
  assertStringIncludes(identity, "Endothelial Cells");
  const search = renderToString(<SearchStep {...props()} />);
  assertStringIncludes(search, "Exampleitis");
  assertStringIncludes(search, "1200");
  assertStringIncludes(search, "gene, genetic, GWAS");
  const vocabulary = renderToString(<VocabularyStep {...props()} />);
  assertStringIncludes(vocabulary, 'value="T1"');
  assertStringIncludes(vocabulary, "Family A");
  const trials = renderToString(<TrialsStep {...props()} />);
  assertStringIncludes(trials, "Late stage");
  assertStringIncludes(trials, "Example receptor antagonist");
  const monogenic = renderToString(<MonogenicStep {...props()} />);
  assertStringIncludes(monogenic, 'value="GENEA"');
  assertStringIncludes(monogenic, "Syndrome one");
  const prompt = renderToString(<PromptStep {...props()} />);
  assertStringIncludes(prompt, "persona.specificity");
  assertStringIncludes(prompt, "GENEC reached genome-wide significance");
  const gold = renderToString(<GoldStep {...props()} />);
  assertStringIncludes(gold, 'value="10000001"');
  assertStringIncludes(gold, "Paper 1");
});

Deno.test("an empty step is calm until revealed, and red after", () => {
  for (
    const [step, Step] of [
      ["identity", IdentityStep],
      ["search", SearchStep],
      ["vocabulary", VocabularyStep],
      ["trials", TrialsStep],
      ["prompt", PromptStep],
      ["gold", GoldStep],
    ] as const
  ) {
    const wizard = wizardFor(EMPTY_ANSWERS, step);
    const calm = renderToString(
      <WizardContext.Provider value={wizard}>
        <Step {...props(EMPTY_ANSWERS)} />
      </WizardContext.Provider>,
    );
    assert(!calm.includes('aria-invalid="true"'), step);
    assertStringIncludes(calm, "adapt-summary");
    const revealed = {
      ...wizard,
      seen: reveal(new Set(), step, wizard.progress.open),
      openCard: null,
    };
    const red = renderToString(
      <WizardContext.Provider value={revealed}>
        <Step {...props(EMPTY_ANSWERS)} />
      </WizardContext.Provider>,
    );
    assert(red.includes("is-error"), step);
  }
  const monogenic = renderToString(<MonogenicStep {...props(EMPTY_ANSWERS)} />);
  assertStringIncludes(
    monogenic,
    "No monogenic genes. That is a valid answer.",
  );
});

/**
 * Answers that trip the row-level, duplicate and computed-section rules as
 * well as the plain "required" ones, so a step renders more than one message
 * on a single control and messages on paths no control owns.
 */
function tripwires(): Answers {
  const answers = structuredClone(EXAMPLEITIS);
  const vocabulary = answers.vocabulary;
  vocabulary.families.push({ ...vocabulary.families[0] });
  vocabulary.families.push({ key: "lonely", label: "No trait here" });
  vocabulary.traits.push(structuredClone(vocabulary.traits[1]));
  vocabulary.traits[0].key = "## x";
  const glossary = answers.identity.cellTypes.glossary;
  glossary.push({ ...glossary[0] });
  glossary.push({ abbrev: "", name: "" });
  answers.search.diseaseTerms.push("unchecked");
  answers.monogenic.genes[0].symbol = "{{x";
  answers.prompt.examples[0].sentence = "a {{ b";
  // One control, three messages: an empty item and one no condition can
  // match, behind a character that is flagged the moment it is typed.
  answers.trials.conditions.push("", "bad-one");
  return answers;
}

const escaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;");

Deno.test("every message validate() writes is on the page once its step is revealed", () => {
  // The step-level list of issues is gone; a message now shows only where a
  // field, a note or the summary puts it, and one that lands nowhere is
  // silently lost. Every step, over answers that trip every kind of rule.
  const Steps = {
    identity: IdentityStep,
    search: SearchStep,
    vocabulary: VocabularyStep,
    trials: TrialsStep,
    monogenic: MonogenicStep,
    prompt: PromptStep,
    gold: GoldStep,
  } as const;
  const cases = [
    EMPTY_ANSWERS,
    tripwires(),
    ...STEP_ORDER.map((step) => blankStep(EXAMPLEITIS, step)),
  ];
  let checked = 0;
  const missing: string[] = [];
  for (const answers of cases) {
    const issues = validate(answers);
    for (const step of STEP_ORDER) {
      const own = issuesFor(issues, step);
      if (own.length === 0) continue;
      const Step = Steps[step];
      const wizard = wizardFor(answers, step);
      const revealed = {
        ...wizard,
        seen: reveal(new Set(), step, own.map((i) => i.field)),
      };
      const html = renderToString(
        <WizardContext.Provider value={revealed}>
          <Step {...props(answers)} />
        </WizardContext.Provider>,
      );
      for (const issue of own) {
        checked += 1;
        // An item holding a character it can never hold is named by its
        // characters, in the echo; validate()'s wording of that same fault
        // is not repeated under it.
        const value = valueAt(answers, step, issue.field);
        const rule = ruleFor(issue.field) ??
          ruleFor(issue.field.replace(/\[\d+\]$/, ""));
        if (
          typeof value === "string" && rule !== null &&
          diagnose(rule, value).offences.length > 0
        ) {
          if (!html.includes('class="adapt-echo"')) {
            missing.push(`${step}:${issue.field}: no echo for the offence`);
          }
          continue;
        }
        // The message sits with the control or note that answers for its
        // path: after that element's data-field anchor and before the next
        // control's, so a per-row message shown on another row is caught.
        const anchors = [...html.matchAll(/data-field="([^"]*)"/g)];
        const placed = anchors.some((anchor, at) =>
          covers(anchor[1], issue.field) &&
          html.slice(anchor.index, anchors[at + 1]?.index ?? html.length)
            .includes(escaped(issue.message))
        );
        if (!placed) {
          missing.push(`${step}:${issue.field}: ${issue.message}`);
        }
      }
    }
  }
  assertEquals([...new Set(missing)], []);
  assert(checked > 100, `only ${checked} messages checked`);
});

Deno.test("the review step lists the files, the checklist and the download button when clean", () => {
  const html = renderToString(
    <ReviewStep
      {...props()}
      allIssues={[]}
      onShow={noop}
      onDownload={noop}
      onExport={noop}
      onImport={noop}
      onReset={noop}
    />,
  );
  assertStringIncludes(html, "disease/manifest.json");
  assertStringIncludes(html, "deno fmt disease/");
  assertStringIncludes(html, ">Download disease-adaptation.zip</button>");
  // The import control is a button; the file input beside it is reachable
  // and named but is not what anyone tabs to.
  assertStringIncludes(html, ">Import answers</button>");
  assertStringIncludes(html, 'aria-label="Import answers file"');
  const blocked = renderToString(
    <ReviewStep
      {...props(EMPTY_ANSWERS)}
      allIssues={validate(EMPTY_ANSWERS)}
      onShow={noop}
      onDownload={noop}
      onExport={noop}
      onImport={noop}
      onReset={noop}
    />,
  );
  assertStringIncludes(blocked, "disabled");
});

/**
 * A pass with the optional phenotype standard turned on; the fixture
 * leaves it null, so its four fields render in no other case.
 */
const WITH_STANDARD: Answers = {
  ...structuredClone(EXAMPLEITIS),
  vocabulary: {
    ...structuredClone(EXAMPLEITIS.vocabulary),
    citationStandard: {
      name: "Example standard",
      label: "Example et al., 2020",
      doi: "10.0000/example",
      linkLabel: "Example standard",
    },
  },
};

type Callback = (argument: string) => void;
interface VNode {
  type: unknown;
  props: Record<string, unknown>;
}

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null &&
    typeof (value as VNode).props === "object" &&
    (value as VNode).props !== null;
}

/**
 * Every component vnode a step renders, in render order.
 *
 * A precompiled element is a template whose dynamic parts are `exprs`, so
 * an element's own handler never lands in the tree; a component's props
 * do, which is where the fields keep theirs.
 */
function components(node: unknown): VNode[] {
  const found: VNode[] = [];
  const seen = new Set<unknown>();
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (!isVNode(current) || seen.has(current)) return;
    seen.add(current);
    const props = current.props;
    if (Array.isArray(props.exprs)) {
      walk(props.exprs);
      return;
    }
    if (typeof current.type !== "function") {
      walk(props.children);
      return;
    }
    // A card is a frame: its children are the step's controls. It reads the
    // wizard's context, so it is walked into rather than called.
    if (current.type === Card) {
      walk(props.children);
      return;
    }
    found.push(current);
    // A field uses hooks -- its own typed text, the ids tying its hint and
    // error to the control -- which run only inside a render; its props are
    // the whole of what it writes, and they are collected above.
    if (
      current.type === ParsedTextField || current.type === TextField ||
      current.type === SelectField || current.type === FieldNote ||
      current.type === StepSummary || current.type === AddButton ||
      current.type === LogoInput || current.type === NotedCheckbox
    ) return;
    walk((current.type as (p: unknown) => unknown)(props));
  };
  walk(node);
  return found;
}

/**
 * The data paths two answers differ at: a leaf's own path, or a list's
 * when its length changed.
 */
function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [path];
    return before.flatMap((entry, i) =>
      changedPaths(entry, after[i], `${path}[${i}]`)
    );
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      changedPaths(
        before[key],
        after[key],
        path === "" ? key : `${path}.${key}`,
      )
    );
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
}

/**
 * A control's field as a data path: a pair word's ".1" is its index, and
 * every other path already is one. A row's first control (`families[0]`)
 * writes a field of its row (`families[0].key`).
 */
const dataPath = (field: string) => field.replace(/\.(\d+)$/, "[$1]");
const writes = (field: string, path: string) => {
  const own = dataPath(field);
  return path === own || path.startsWith(`${own}[`) ||
    path.startsWith(`${own}.`);
};

/**
 * The edits a control makes beyond its own field, each with its reason:
 * the control's path, the path it may also change.
 */
const CROSS_FIELD: ReadonlyArray<readonly [RegExp, RegExp, string]> = [
  [
    /^diseaseTerms(\[\d+\])?$/,
    /^(meshTerms|markerTerms\[\d+\]\.count)/,
    "a phrase has its MeSH row beside it, and anchors every marker count",
  ],
  [
    /^families(\[\d+\])?$/,
    /^traits\[\d+\]\.family$/,
    "a family's key carries its members (renameFamily, removeFamily)",
  ],
  [
    /^mechanismFamilies(\[\d+\])?$/,
    /^mechanisms\[\d+\]\.family$/,
    "a mechanism family's key carries its mechanisms",
  ],
  [
    /^populations\[\d+\]\.label$/,
    /^populations\[\d+\]\.lines/,
    "the radar lines follow a label while they are its draft",
  ],
  [
    /^(disease|institute)\./,
    /^site\./,
    "the site strings follow the names while on their draft (redraftSite)",
  ],
  [
    /^rows\[\d+\]\.pmid$/,
    /^rows\[\d+\]\.(exists|title)$/,
    "a retyped PMID's lookup answered the old one",
  ],
  [
    /^examples\[\d+\]\.pmid$/,
    /^examples\[\d+\]\.abstract$/,
    "an example's abstract answered its old PMID",
  ],
  [
    /^traits\[\d+\]\.xref$/,
    /^traits\[\d+\]\.xrefNote$/,
    "a cleared term takes the search's note about it along (setXref)",
  ],
];

/** Callbacks that write nothing at once by design, with their reason. */
const DEFERRED: Record<string, string> = {
  "LogoInput.onFile": "reads the file before it writes, asynchronously",
};

/** The path of the list `items` is, found by identity in the step's slice. */
function listPath(slice: unknown, items: unknown, path = ""): string | null {
  if (slice === items) return path;
  const entries = Array.isArray(slice)
    ? slice.map((entry, i) => [`${path}[${i}]`, entry] as const)
    : isRecord(slice)
    ? Object.entries(slice).map(([key, entry]) =>
      [path === "" ? key : `${path}.${key}`, entry] as const
    )
    : [];
  for (const [inner, entry] of entries) {
    const found = listPath(entry, items, inner);
    if (found !== null) return found;
  }
  return null;
}

Deno.test("every control a step renders writes back into its own answer", () => {
  // The markup shows the value a field starts with; it cannot show where
  // that field writes. Driving each callback over a clone does: a control
  // closed over the wrong slice or the wrong row leaves its own answer
  // untouched, or changes one it does not name, and nothing else would say
  // so. A list's add and remove change only their list, and the edits one
  // answer makes to another are the reasoned ones in CROSS_FIELD.
  const Steps = [
    ["identity", IdentityStep],
    ["search", SearchStep],
    ["vocabulary", VocabularyStep],
    ["trials", TrialsStep],
    ["monogenic", MonogenicStep],
    ["prompt", PromptStep],
    ["gold", GoldStep],
  ] as const;
  const problems: string[] = [];
  let driven = 0;
  for (const answers of [EXAMPLEITIS, WITH_STANDARD]) {
    for (const [step, Step] of Steps) {
      let draft: Answers | null = null;
      const update = (change: (d: Answers) => void) => {
        const next = structuredClone(answers);
        change(next);
        draft = next;
      };
      const rendered = Step({
        answers,
        update,
        issues: validate(answers),
        fetch: globalThis.fetch,
        setStatus: noop,
        busy: false,
        lookup: noop,
      });
      for (const vnode of components(rendered)) {
        const name = (vnode.type as { name: string }).name;
        const own = typeof vnode.props.field === "string"
          ? vnode.props.field
          : listPath(answers[step], vnode.props.items);
        for (const [key, value] of Object.entries(vnode.props)) {
          if (typeof value !== "function") continue;
          // `canonical` and `rowLabel` format text and write nothing by
          // design; `render` is called by the list editor itself; `fetch`
          // would reach the network.
          if (
            key === "render" || key === "fetch" || key === "canonical" ||
            key === "rowLabel"
          ) continue;
          const label = `${Step.name}: ${name}.${key} (${own ?? "no field"})`;
          driven += 1;
          draft = null;
          (value as Callback)("x");
          const after = draft as Answers | null;
          if (
            after === null || JSON.stringify(after) === JSON.stringify(answers)
          ) {
            if (!Object.hasOwn(DEFERRED, `${name}.${key}`)) {
              problems.push(`${label}: writes nothing`);
            }
            continue;
          }
          for (const other of STEP_ORDER) {
            if (
              other !== step &&
              JSON.stringify(after[other]) !== JSON.stringify(answers[other])
            ) problems.push(`${label}: changes the ${other} step`);
          }
          for (const path of changedPaths(answers[step], after[step])) {
            if (own !== null && writes(own, path)) continue;
            const reasoned = own !== null &&
              CROSS_FIELD.some(([control, also]) =>
                control.test(own) && also.test(path)
              );
            if (!reasoned) problems.push(`${label}: changes ${path}`);
          }
        }
      }
    }
  }
  assertEquals(problems, []);
  // A floor, so a walk that stops finding controls fails rather than passes.
  assert(driven > 100, `only ${driven} controls driven`);
});

Deno.test("renaming a population redrafts only a radar label still on the draft", () => {
  // The fixture wraps "Late stage" over two rows by hand and leaves
  // "Early" on the one line the label drafted; renaming each must keep the
  // hand-wrapped one and redraft the other.
  let draft: Answers | null = null;
  const step = TrialsStep({
    answers: EXAMPLEITIS,
    update: (change) => {
      const next = structuredClone(EXAMPLEITIS);
      change(next);
      draft = next;
    },
    issues: [],
    fetch: globalThis.fetch,
    setStatus: noop,
    busy: false,
    lookup: noop,
  });
  // Each TextField renders a Field carrying the same label, so the type
  // is part of the match.
  const labels = components(step).filter((vnode) =>
    (vnode.type as { name: string }).name === "TextField" &&
    vnode.props.label === "Label"
  );
  assertEquals(labels.length, EXAMPLEITIS.trials.populations.length);

  (labels[0].props.onInput as Callback)("Earliest");
  assertEquals(draft!.trials.populations[0], {
    key: "Early",
    label: "Earliest",
    lines: ["Earliest"],
  });

  (labels[1].props.onInput as Callback)("Later stage");
  assertEquals(draft!.trials.populations[1], {
    key: "Late",
    label: "Later stage",
    lines: ["Late", "stage"],
  });

  // Lines emptied by hand hold one blank line, which is no wrapping of the
  // researcher's: the label fills them again.
  const cleared = structuredClone(EXAMPLEITIS);
  cleared.trials.populations[1].lines = [""];
  const again = TrialsStep({
    answers: cleared,
    update: (change) => {
      const next = structuredClone(cleared);
      change(next);
      draft = next;
    },
    issues: [],
    fetch: globalThis.fetch,
    setStatus: noop,
    busy: false,
    lookup: noop,
  });
  const second =
    components(again).filter((vnode) =>
      (vnode.type as { name: string }).name === "TextField" &&
      vnode.props.label === "Label"
    )[1];
  (second.props.onInput as Callback)("Later stage");
  assertEquals(draft!.trials.populations[1].lines, ["Later stage"]);
});

/**
 * NCBI as the MeSH lookup sees it: every phrase resolves to the heading
 * "One", and a phrase in `failing` cannot be reached. Each esearch term is
 * recorded, so a test can say which phrases a check asked about.
 */
function meshStub(failing: string[] = []) {
  const asked: string[] = [];
  const fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    const term = url.searchParams.get("term");
    if (url.searchParams.get("db") === "mesh" && term !== null) {
      asked.push(term);
    }
    if (term !== null && failing.includes(term)) {
      return Promise.reject(new Error("offline"));
    }
    if (url.searchParams.get("db") === "mesh" && url.searchParams.has("id")) {
      return Promise.resolve(
        Response.json({
          // An entry term for each phrase the tests check, so each names
          // the heading rather than merely sharing a page of hits with it.
          result: {
            "1": {
              ds_meshterms: ["One", "one", "two", "second phrase"],
              ds_scopenote: "Note.",
            },
          },
        }),
      );
    }
    if (url.searchParams.get("db") === "mesh") {
      return Promise.resolve(
        Response.json({ esearchresult: { count: "1", idlist: ["1"] } }),
      );
    }
    return Promise.resolve(
      Response.json({ esearchresult: { count: "7" } }),
    );
  }) as unknown as Fetch;
  return { fetch, asked };
}

/**
 * "Check MeSH headings" as SearchStep runs it. The handler is an element
 * prop, and `jsx: "precompile"` renders those as attributes rather than
 * putting them in the tree, so its loop is replayed here over the lib
 * functions it calls; everything it decides lives in those.
 */
async function checkHeadings(answers: Answers, fetch: Fetch): Promise<string> {
  for (const phrase of phrasesToCheck(answers.search)) {
    const row = await meshRow(fetch, phrase, answers.search.ncbi);
    if (!row.ok) return row.error;
    writeMeshRow(answers, phrase, row.value);
  }
  return "";
}

Deno.test("a second phrase whose lookup fails leaves a draft that still loads", async () => {
  // The second phrase's lookup fails through the injected fetch, which is
  // the case that used to leave a hole at index 1.
  const { fetch: fetchStub } = meshStub(["two"]);
  const answers = structuredClone(EXAMPLEITIS);
  answers.search.diseaseTerms = ["one", "two"];
  answers.search.meshTerms = [];
  assertEquals(await checkHeadings(answers, fetchStub), "offline");

  const reloaded = parseDraft(serialiseDraft(answers));
  assert(reloaded !== null);
  assertEquals(reloaded.search.meshTerms.length, 2);
  for (const row of reloaded.search.meshTerms) {
    assertEquals(typeof row, "object");
    assert(row !== null);
  }
  assertEquals(reloaded.search.meshTerms[1].heading, null);
  // The whole page hangs on these two: validate() runs over every answer
  // before anything renders, and the step lists one result per row.
  const issues = validate(reloaded);
  assert(issues.some((i) => i.field === "meshTerms[1]"), "the hole is named");
  const html = renderToString(
    <WizardContext.Provider value={wizardFor(reloaded, "search")}>
      <SearchStep
        answers={reloaded}
        update={noop}
        issues={issues}
        fetch={fetchStub}
        setStatus={noop}
        busy={false}
        lookup={noop}
      />
    </WizardContext.Provider>,
  );
  // The stand-in row is not an answer: "two" was never looked up, so it
  // must not read as a phrase MeSH has no heading for.
  assert(!html.includes("&quot;two&quot; has no MeSH heading"), html);
  assertStringIncludes(
    html,
    "&quot;two&quot; has not been checked against MeSH yet.",
  );
});

Deno.test("a dropped heading survives the next check, which asks only about new phrases", async () => {
  const answers = structuredClone(EXAMPLEITIS);
  dropMeshHeading(answers, 0);
  addDiseaseTerm(answers);
  setDiseaseTerm(answers, 1, "second phrase");
  const { fetch: fetchStub, asked } = meshStub();
  assertEquals(await checkHeadings(answers, fetchStub), "");
  assertEquals(asked, ["second phrase"]);
  const html = renderToString(
    <WizardContext.Provider value={wizardFor(answers, "search")}>
      <SearchStep {...props(answers)} />
    </WizardContext.Provider>,
  );
  assertStringIncludes(html, "&quot;exampleitis&quot; has no MeSH heading");
  assertStringIncludes(
    html,
    "&quot;second phrase&quot; → <strong>One</strong>",
  );
  // The heading reaching pipeline.json is the new phrase's alone.
  assertEquals(meshHeadings(answers).map((m) => m.heading), ["One"]);
});
