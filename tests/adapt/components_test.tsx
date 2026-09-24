import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";
import type * as preact from "preact";

import { Card } from "../../components/adapt/Card.tsx";
import { CodeBlock } from "../../components/adapt/CodeBlock.tsx";
import {
  FieldNote,
  LogoInput,
  noteId,
} from "../../components/adapt/FieldNote.tsx";
import { SelectField, TextField } from "../../components/adapt/Field.tsx";
import { ListEditor } from "../../components/adapt/ListEditor.tsx";
import { Stepper } from "../../components/adapt/Stepper.tsx";
import { StepSummary } from "../../components/adapt/StepSummary.tsx";
import { familyOptions } from "../../components/adapt/steps/helpers.ts";
import {
  type Wizard,
  WizardContext,
} from "../../components/adapt/wizard_context.ts";
import { EMPTY_ANSWERS } from "../../lib/adapt/answers.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";
import { wizardFor } from "./wizard_fixture.ts";

const count = (html: string, needle: string) => html.split(needle).length - 1;

Deno.test("TextField labels its input, shows a hint and an explicit error, and can be multiline", () => {
  const single = renderToString(
    <TextField
      label="Disease name"
      value="x"
      onInput={() => {}}
      hint="lower case"
      error="required"
    />,
  );
  assertStringIncludes(single, '<div class="adapt-field is-error"><label>');
  assertStringIncludes(
    single,
    '<span class="adapt-field-label">Disease name</span>',
  );
  assertStringIncludes(single, '<input class="adapt-input"');
  assertStringIncludes(single, 'value="x"');
  const id = single.match(/<span class="adapt-field-hint" id="([^"]+)-hint">/)
    ?.[1];
  assert(id !== undefined, single);
  assertStringIncludes(single, `id="${id}-message"`);
  assertStringIncludes(single, ">required</span>");
  assertStringIncludes(single, `aria-describedby="${id}-message ${id}-hint"`);
  assertStringIncludes(single, 'aria-invalid="true"');
  assertStringIncludes(single, 'aria-required="true"');
  const multi = renderToString(
    <TextField
      label="Definition"
      value="d"
      onInput={() => {}}
      multiline
      optional
    />,
  );
  assertStringIncludes(multi, '<textarea class="adapt-textarea"');
  assertEquals(count(multi, "adapt-field-hint"), 0);
  assertEquals(count(multi, "adapt-field-message"), 0);
  assertEquals(count(multi, "aria-describedby"), 0);
  assertEquals(count(multi, "aria-invalid"), 0);
  assertEquals(count(multi, "aria-required"), 0);
});

const inside = (wizard: Wizard, node: preact.ComponentChildren) =>
  renderToString(
    <WizardContext.Provider value={wizard}>{node}</WizardContext.Provider>,
  );

Deno.test("a field in the wizard waits to be left before it turns red", () => {
  const field = (
    answers = EMPTY_ANSWERS,
    seen: ReadonlySet<string> = new Set(),
  ) =>
    inside(
      wizardFor(answers, "identity", { seen }),
      <TextField
        label="Disease name"
        value={answers.identity.disease.name}
        onInput={() => {}}
        field="disease.name"
      />,
    );
  const untouched = field();
  assertStringIncludes(untouched, 'data-field="disease.name"');
  assertStringIncludes(untouched, 'aria-required="true"');
  assertStringIncludes(untouched, ">Required</span>");
  assertEquals(count(untouched, "aria-invalid"), 0);
  const left = field(EMPTY_ANSWERS, new Set(["identity:disease.name"]));
  assertStringIncludes(left, 'aria-invalid="true"');
  assertStringIncludes(left, "The disease name is required.");
  const valid = field(EXAMPLEITIS);
  assertStringIncludes(valid, '<div class="adapt-field is-valid">');
});

Deno.test("an offending character is marked in an echo, with a fix to use", () => {
  const answers = structuredClone(EMPTY_ANSWERS);
  answers.identity.disease.key = "Example-itis";
  const html = inside(
    wizardFor(answers, "identity"),
    <TextField
      label="Key"
      value="Example-itis"
      onInput={() => {}}
      field="disease.key"
    />,
  );
  assertStringIncludes(html, 'aria-invalid="true"');
  assertStringIncludes(html, "&quot;E&quot; and &quot;-&quot; can");
  // The echo: E and - marked, the rest plain. (A precompiled element can
  // leave a space where a dropped `key` was, so the tags are matched loosely.)
  assertMatch(
    html,
    /<span class="adapt-echo" aria-hidden="true"><mark\s*>E<\/mark>xample<mark\s*>-<\/mark>itis<\/span>/,
  );
  assertStringIncludes(html, "<code>example_itis</code>");
});

Deno.test("a non-breaking space is marked in the echo, not drawn invisibly", () => {
  // Fix round 1: visible() wrote both space patterns as a plain U+0020 (a
  // hex dump of the source confirmed it), so the second replace -- meant
  // for U+00A0 -- matched nothing, and a non-breaking space rendered
  // invisibly in the echo instead of as a mark. This pins the fix: the
  // offence still names itself in the message, and now marks visibly too.
  const answers = structuredClone(EMPTY_ANSWERS);
  const key = "example\u00a0itis";
  answers.identity.disease.key = key;
  const html = inside(
    wizardFor(answers, "identity"),
    <TextField
      label="Key"
      value={key}
      onInput={() => {}}
      field="disease.key"
    />,
  );
  assertStringIncludes(html, "non-breaking space can");
  assertMatch(
    html,
    /<span class="adapt-echo" aria-hidden="true">example<mark\s*>\u237d<\/mark>itis<\/span>/,
  );
});

Deno.test("FieldNote shows what a path with no control carries, muted until seen", () => {
  const empty = wizardFor(EMPTY_ANSWERS, "identity");
  const muted = inside(empty, <FieldNote field="logoLight" />);
  assertStringIncludes(muted, 'class="adapt-field-message is-note"');
  assertStringIncludes(muted, "Upload a logo (SVG or PNG).");
  const seen = inside(
    wizardFor(EMPTY_ANSWERS, "identity", {
      seen: new Set(["identity:logoLight"]),
    }),
    <FieldNote field="logoLight" />,
  );
  assertStringIncludes(seen, 'class="adapt-field-message is-error"');
  assertEquals(
    inside(wizardFor(EXAMPLEITIS, "identity"), <FieldNote field="logoLight" />),
    "",
  );
  assertEquals(renderToString(<FieldNote field="logoLight" />), "");
});

Deno.test("SelectField renders its options with the selected one marked", () => {
  const html = renderToString(
    <SelectField
      label="Family"
      value="b"
      options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]}
      onChange={() => {}}
    />,
  );
  // preact-render-to-string's precompiled output leaves the whitespace of a
  // dropped prop's placeholder behind: the doubled space before `value="b"`
  // is `key`'s.
  assertStringIncludes(html, '<select class="adapt-select"');
  assertStringIncludes(html, '<option  value="b" selected>B</option>');
  // With no hint and no error, the select points at nothing.
  assertEquals(count(html, "aria-describedby"), 0);
  assertEquals(count(html, "aria-invalid"), 0);
  const invalid = renderToString(
    <SelectField
      label="Family"
      value=""
      options={[{ value: "", label: "— pick —" }]}
      onChange={() => {}}
      error="Pick a family."
    />,
  );
  assertStringIncludes(invalid, 'aria-invalid="true"');
  const id = invalid.match(/id="([^"]+)-message"/)?.[1];
  assert(id !== undefined, invalid);
  assertStringIncludes(invalid, `aria-describedby="${id}-message"`);
});

Deno.test("familyOptions lists each named family once after the placeholder", () => {
  // A family added but not yet keyed would repeat the placeholder's empty
  // value; one with a key and no label yet shows its key.
  assertEquals(
    familyOptions([
      { key: "", label: "" },
      { key: "a", label: "Family A" },
      { key: " ", label: "Blank" },
      { key: "a", label: "Again" },
      { key: "b", label: " " },
    ]),
    [
      { value: "", label: "— pick a family —" },
      { value: "a", label: "Family A" },
      { value: "b", label: "b" },
    ],
  );
});

Deno.test("Stepper draws a labelled segment per step, its state written underneath", () => {
  const html = renderToString(
    <Stepper
      steps={[
        { id: "a", label: "One", state: "done", detail: "Done", fill: 100 },
        { id: "b", label: "Two", state: "fix", detail: "1 to fix", fill: 40 },
        {
          id: "c",
          label: "Three",
          state: "todo",
          detail: "Not started",
          fill: 0,
        },
      ]}
      current="b"
      onSelect={() => {}}
    />,
  );
  assertStringIncludes(html, '<ol class="adapt-stepper" aria-label="Steps">');
  assertStringIncludes(html, 'class="adapt-stepper-item is-done"');
  assertStringIncludes(
    html,
    'class="adapt-stepper-item is-fix is-current" aria-current="step"',
  );
  assertEquals(count(html, "<button"), 3);
  // The button's name is the step's name; the state is its description.
  assertStringIncludes(html, 'aria-describedby="adapt-stepper-b"');
  // The detail says the state in words, once.
  assertStringIncludes(html, 'id="adapt-stepper-b">1 to fix</span>');
  assertStringIncludes(html, "width:40%");
});

Deno.test("CodeBlock renders its content", () => {
  assertEquals(
    // deno-lint-ignore jsx-curly-braces -- the braces carry a real newline
    renderToString(<CodeBlock>{"a\nb"}</CodeBlock>),
    '<pre class="code-block">a\nb</pre>',
  );
});

Deno.test("a card folds to its summary and opens on its fields", () => {
  const folded = inside(
    wizardFor(EXAMPLEITIS, "identity", { openCard: "institute" }),
    <Card step="identity" id="disease">
      <span>fields</span>
    </Card>,
  );
  assertStringIncludes(folded, 'class="adapt-card is-done"');
  assertStringIncludes(folded, 'aria-expanded="false"');
  assertStringIncludes(
    folded,
    "exampleitis · EXD · Exampleitic · key exampleitis",
  );
  assertStringIncludes(folded, ">Complete</span>");
  // The body itself is hidden, not merely somewhere in the card.
  assertMatch(folded, /class="adapt-card-body"[^>]*\shidden/);
  const open = inside(
    wizardFor(EMPTY_ANSWERS, "identity", { openCard: "disease" }),
    <Card step="identity" id="disease">
      <span>fields</span>
    </Card>,
  );
  assertStringIncludes(open, 'class="adapt-card is-open"');
  assert(!/class="adapt-card-body"[^>]*\shidden/.test(open));
  assertStringIncludes(open, 'aria-expanded="true"');
  assertStringIncludes(open, "5 to go");
  assertStringIncludes(open, ">Continue</button>");
  // Outside the wizard every card is open and has no Continue.
  const bare = renderToString(
    <Card step="identity" id="disease">
      <span>fields</span>
    </Card>,
  );
  assertEquals(count(bare, "Continue"), 0);
  assertEquals(count(bare, " hidden"), 0);
  // A step's only card is always open.
  const fixed = inside(
    wizardFor(EMPTY_ANSWERS, "gold"),
    <Card step="gold" id="rows">
      <span>rows</span>
    </Card>,
  );
  assertEquals(count(fixed, "aria-expanded"), 0);
  assertEquals(count(fixed, "Continue"), 0);
});

Deno.test("the step summary counts what is answered and offers what is left", () => {
  const typed = structuredClone(EMPTY_ANSWERS);
  typed.identity.disease.key = "Example-itis";
  const html = inside(wizardFor(typed, "identity"), <StepSummary />);
  assertStringIncludes(html, "<strong>1</strong> of 24 answered");
  assertStringIncludes(html, "1 to fix");
  assertStringIncludes(html, "23 to go");
  assertStringIncludes(html, ">Show what");
  const done = inside(wizardFor(EXAMPLEITIS, "identity"), <StepSummary />);
  assertStringIncludes(done, "Nothing left in this step");
  assertEquals(renderToString(<StepSummary />), "");
});

Deno.test("ListEditor renders one row per item, the add button and the empty text", () => {
  const html = renderToString(
    <ListEditor
      items={["x", "y"]}
      render={(item, i) => <span>{`${i}:${item}`}</span>}
      add={() => {}}
      addLabel="Add term"
      remove={() => {}}
    />,
  );
  assertStringIncludes(html, "<span>0:x</span>");
  assertStringIncludes(html, "<span>1:y</span>");
  assertStringIncludes(html, ">Add term</button>");
  assertEquals(count(html, "Remove"), 2);
  // With nothing to call, a Remove button would be one that does nothing.
  const fixed = renderToString(
    <ListEditor
      items={["x"]}
      render={() => null}
      add={() => {}}
      addLabel="Add"
    />,
  );
  assertEquals(count(fixed, "Remove"), 0);
  const empty = renderToString(
    <ListEditor
      items={[]}
      render={() => null}
      add={() => {}}
      addLabel="Add"
      empty="Nothing yet."
    />,
  );
  assertStringIncludes(empty, "Nothing yet.");
  const noted = inside(
    wizardFor(EMPTY_ANSWERS, "vocabulary"),
    <ListEditor
      items={[]}
      render={() => null}
      add={() => {}}
      addLabel="Add trait"
      field="traits"
    />,
  );
  assertStringIncludes(noted, "Define between four and sixteen traits.");
  assertStringIncludes(noted, 'data-field="traits"');
});

Deno.test("a list's rows are drawn afresh when one is added or removed", () => {
  // Keyed by the list's length too, so a field keeping what was typed in
  // one row never hands it to the row that took the removed row's place.
  const keys = (items: string[]) => {
    const found: unknown[] = [];
    // A precompiled template keeps its dynamic parts in `exprs`.
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      const vnode = node as { key?: unknown; props?: Record<string, unknown> };
      if (typeof vnode.key === "string") found.push(vnode.key);
      walk(vnode.props?.exprs);
      walk(vnode.props?.children);
    };
    walk(ListEditor({
      items,
      render: (item) => <span>{item}</span>,
      add: () => {},
      addLabel: "Add",
      remove: () => {},
    }));
    return found;
  };
  assertEquals(keys(["a", "b"]), ["2:0", "2:1"]);
  assertEquals(keys(["b"]), ["1:0"]);
});

Deno.test("each row is a group named for a screen reader", () => {
  const html = renderToString(
    <ListEditor
      items={["T1", "T2"]}
      render={(item) => <span>{item}</span>}
      add={() => {}}
      addLabel="Add trait"
      rowLabel={(item, i) => `Trait ${i + 1}: ${item}`}
    />,
  );
  assertStringIncludes(html, 'role="group" aria-label="Trait 1: T1"');
  assertStringIncludes(html, 'role="group" aria-label="Trait 2: T2"');
});

Deno.test("a list's add button and a logo input are described by their note", () => {
  const wizard = wizardFor(EMPTY_ANSWERS, "trials");
  const list = inside(
    wizard,
    <ListEditor
      items={[]}
      render={() => null}
      add={() => {}}
      addLabel="Add population"
      field="populations"
    />,
  );
  const id = noteId("trials", "populations");
  assertStringIncludes(list, `id="${id}"`);
  assertStringIncludes(list, `aria-describedby="${id}"`);
  // A note with nothing to say is not pointed at.
  const quiet = inside(
    wizardFor(EXAMPLEITIS, "trials"),
    <ListEditor
      items={[]}
      render={() => null}
      add={() => {}}
      addLabel="Add population"
      field="populations"
    />,
  );
  assertEquals(count(quiet, "aria-describedby"), 0);
  const calm = inside(
    wizardFor(EMPTY_ANSWERS, "identity"),
    <LogoInput field="logoLight" required onFile={() => {}} />,
  );
  assertStringIncludes(calm, 'aria-required="true"');
  assertStringIncludes(
    calm,
    `aria-describedby="${noteId("identity", "logoLight")}"`,
  );
  assertEquals(count(calm, "aria-invalid"), 0);
  const seen = inside(
    wizardFor(EMPTY_ANSWERS, "identity", {
      seen: new Set(["identity:logoLight"]),
    }),
    <LogoInput field="logoLight" required onFile={() => {}} />,
  );
  assertStringIncludes(seen, 'aria-invalid="true"');
  // Two paths never share an id.
  assert(noteId("search", "meshTerms[1]") !== noteId("search", "meshTerms_1"));
});

Deno.test("a key's field is kept from spelling services", () => {
  const html = renderToString(
    <TextField
      label="NCBI API key"
      value=""
      onInput={() => {}}
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="off"
    />,
  );
  assertStringIncludes(html, 'spellcheck="false"');
  assertStringIncludes(html, 'autocomplete="off"');
  assertStringIncludes(html, 'autocapitalize="off"');
});

Deno.test("the echo draws an invisible offence, and keeps a far one in view", () => {
  const zeroWidth = inside(
    wizardFor(EMPTY_ANSWERS, "identity"),
    <TextField
      label="Site title"
      value={`Example\u200bsite`}
      onInput={() => {}}
      field="site.title"
    />,
  );
  assertMatch(zeroWidth, /<mark\s*>U\+200B<\/mark>/);
  const long = "a ".repeat(125) + "{{x" + " b".repeat(25);
  const section = inside(
    wizardFor(EMPTY_ANSWERS, "prompt"),
    <TextField
      label="rubric.modifiers"
      value={long}
      onInput={() => {}}
      multiline
      field="sections.rubric.modifiers"
    />,
  );
  const echo = section.match(/<span class="adapt-echo"[^>]*>(.*?)<\/span>/)![1];
  // The mark sits in a window of context, the rest elided on either side.
  assertMatch(echo, /^\u2026a a a .*<mark\s*>\{\{<\/mark>x b b .*\u2026$/);
  assert(echo.length < long.length);
});
