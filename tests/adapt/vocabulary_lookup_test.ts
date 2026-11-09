import { assertEquals } from "@std/assert";

import { lookupXref } from "../../components/adapt/steps/VocabularyStep.tsx";
import type { Answers } from "../../lib/adapt/answers.ts";
import type { Fetch } from "../../lib/adapt/lookups.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

/** OLS answering every search with one hit. */
const ols: Fetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        response: { docs: [{ obo_id: "EFO:0000001", label: "Trait one" }] },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );

/** The answers with trait 0's term and note set. */
function withTrait0(
  xref: string | null,
  xrefNote: string,
  name = "Trait one",
): Answers {
  const answers = structuredClone(EXAMPLEITIS);
  Object.assign(answers.vocabulary.traits[0], { xref, xrefNote, name });
  return answers;
}

/**
 * Run the search pressed on `asked` while the wizard holds `live` by the
 * time it lands, the island's update applying to `live`.
 */
async function search(asked: Answers, live: Answers, yes: boolean) {
  const asks: string[] = [];
  const statuses: string[] = [];
  let written: Answers | null = null;
  const confirm = globalThis.confirm;
  globalThis.confirm = (message?: string) => {
    asks.push(String(message));
    return yes;
  };
  try {
    await lookupXref({
      answers: asked,
      latest: () => live,
      update: (change) => {
        const next = structuredClone(live);
        change(next);
        written = next;
      },
      fetch: ols,
      setStatus: (text) => statuses.push(text),
    }, 0);
  } finally {
    globalThis.confirm = confirm;
  }
  const trait = (written as Answers | null)?.vocabulary.traits[0];
  return {
    asks: asks.length,
    status: statuses.at(-1),
    xref: trait?.xref,
    xrefNote: trait?.xrefNote,
  };
}

Deno.test("a term typed while the search was out is replaced only on a yes", async () => {
  // Pressed on an empty term, so the answer would replace nothing then;
  // by the time it lands the researcher has typed a term and a note.
  const asked = withTrait0(null, "");
  const typed = withTrait0("HP:0001234", "chosen by hand");
  const no = await search(asked, typed, false);
  assertEquals(no.asks, 1, "the typed term is asked about");
  assertEquals(no.status, "Kept the term and note you chose.");
  assertEquals(no.xref, undefined, "nothing is written on a no");
  const yes = await search(asked, typed, true);
  assertEquals(yes.asks, 1);
  assertEquals([yes.xref, yes.status], [
    "EFO:0000001",
    'Found EFO:0000001 for "Trait one".',
  ]);
});

Deno.test("an untouched trait takes the search's hit without asking", async () => {
  const asked = withTrait0(null, "");
  const result = await search(asked, asked, false);
  assertEquals(result.asks, 0);
  assertEquals(result.xref, "EFO:0000001");
});

Deno.test("a long name edited while the search was out takes no answer", async () => {
  const result = await search(
    withTrait0(null, ""),
    withTrait0(null, "", "Trait one, renamed"),
    true,
  );
  assertEquals(result.asks, 0);
  assertEquals(result.xref, undefined);
  assertEquals(
    result.status,
    'The trait changed while "Trait one" was searched; search again.',
  );
});

Deno.test("the write-back leaves a term typed after the answer was weighed", async () => {
  // The wizard renders an untouched trait when the answer lands, but its
  // update applies to answers where a term has since been typed.
  const asked = withTrait0(null, "");
  const typed = withTrait0("HP:0001234", "chosen by hand");
  let written: Answers | null = null;
  await lookupXref({
    answers: asked,
    latest: () => asked,
    update: (change) => {
      const next = structuredClone(typed);
      change(next);
      written = next;
    },
    fetch: ols,
    setStatus: () => {},
  }, 0);
  const trait = (written as Answers | null)?.vocabulary.traits[0];
  assertEquals([trait?.xref, trait?.xrefNote], [
    "HP:0001234",
    "chosen by hand",
  ]);
});
