import { assertEquals } from "@std/assert";

import { redraftPrompt } from "../../lib/adapt/prompt_redraft.ts";
import { prefillSections } from "../../lib/adapt/prompt_sections.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

Deno.test("a derived section still on its draft follows the answers it came from", () => {
  const before = structuredClone(EXAMPLEITIS);
  const drafted = prefillSections(before);
  for (const [id, body] of Object.entries(drafted)) {
    before.prompt.sections[id] = body;
  }
  const after = structuredClone(before);
  after.vocabulary.traits[0].key = "T1b";
  redraftPrompt(before, after);
  const now = prefillSections(after);
  assertEquals(
    after.prompt.sections["strategy.phenotype_shortlist"],
    now["strategy.phenotype_shortlist"],
  );
  assertEquals(
    after.prompt.sections["criteria.phenotypes"],
    now["criteria.phenotypes"],
  );
});

Deno.test("an edited derived section stays the researcher's, and a blank one blank", () => {
  const before = structuredClone(EXAMPLEITIS);
  before.prompt.sections["strategy.phenotype_shortlist"] = "T1, T2 and more";
  before.prompt.sections["rubric.cell_types"] = "";
  const after = structuredClone(before);
  after.vocabulary.traits[0].key = "T1b";
  after.identity.cellTypes.glossary[0].name = "Other Cells";
  redraftPrompt(before, after);
  assertEquals(
    after.prompt.sections["strategy.phenotype_shortlist"],
    "T1, T2 and more",
  );
  assertEquals(after.prompt.sections["rubric.cell_types"], "");
});

Deno.test("an edit that changes no draft rewrites nothing, and an empty draft is no draft", () => {
  const before = structuredClone(EXAMPLEITIS);
  before.vocabulary.traits = [];
  before.prompt.sections["criteria.phenotypes"] = "";
  const after = structuredClone(before);
  after.identity.disease.name = "renamed";
  redraftPrompt(before, after);
  assertEquals(after.prompt.sections, before.prompt.sections);
});
