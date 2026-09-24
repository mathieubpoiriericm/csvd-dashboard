import type { Answers, Trait } from "../answers.ts";
import { clean, jsonText } from "./json.ts";

/**
 * The traits grouped by family, in the families' own order.
 *
 * `tests/phenogram_encoding_test.ts` -- a gate every fork runs -- reads
 * the trait list in file order and fails when a family's traits are not
 * contiguous, because the phenogram's legend draws them in that order.
 * The sort is stable, so within a family the researcher's order stands;
 * a trait whose family is not listed sorts last rather than first, where
 * the validation error that already names it is easier to act on.
 */
export function grouped(answers: Answers): Trait[] {
  const order = answers.vocabulary.families.map((f) => clean(f.key));
  const rank = (trait: Trait): number => {
    const index = order.indexOf(clean(trait.family));
    return index === -1 ? order.length : index;
  };
  return [...answers.vocabulary.traits].sort((a, b) => rank(a) - rank(b));
}

export function generateVocabulary(answers: Answers): string {
  return jsonText({
    $comment:
      "Single source of truth for the GWAS trait vocabulary. lib/constants.ts (GWAS_TRAIT_CHOICES), pipeline/export/tables.py (_TRAIT_REWRITES) and both phenogram renderers derive from this file; pipeline/prompts.py is reconciled against it by tests/pipeline/test_prompt_vocabulary.py. Add a trait here and nowhere else. xref is internal -- a curation aid and drift check, never published.",
    traits: grouped(answers).map((t) => ({
      key: clean(t.key),
      label: clean(t.label),
      family: clean(t.family),
      name: clean(t.name),
      ...(t.standard ? { standard: true } : {}),
      definition: clean(t.definition),
      xref: t.xref === null ? null : clean(t.xref),
      xrefNote: clean(t.xrefNote),
    })),
    synonyms: [],
    untracked: [],
  });
}
