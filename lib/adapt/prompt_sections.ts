import type { Answers } from "./answers.ts";
import { clean } from "./generate/json.ts";
import { grouped } from "./generate/vocabulary.ts";

/** The `## id` headings of disease/prompt.md, in the file's order. */
export const SECTION_IDS: readonly string[] = [
  "persona.specificity",
  "criteria.phenotypes",
  "strategy.phenotype_shortlist",
  "strategy.neighbouring_conditions",
  "strategy.monogenic_genes",
  "strategy.background_example",
  "strategy.causal_gene_example",
  "strategy.mr_example",
  "strategy.ortholog_example",
  "strategy.disease_steps",
  "strategy.convergence_example",
  "traits.canonical",
  "guidance.specificity_note",
  "rubric.subgroup_example",
  "rubric.monogenic_examples",
  "rubric.cell_types",
  "rubric.neighbour_gwas_gene",
  "rubric.modifiers",
  "examples",
];

/** Sections the wizard computes and never shows as a field. */
export const COMPUTED_SECTION_IDS: readonly string[] = [
  "strategy.monogenic_genes",
  "traits.canonical",
  "examples",
];

/** Sections shown as fields with a prefill derived from earlier steps. */
export const PREFILLED_SECTION_IDS: readonly string[] = [
  "criteria.phenotypes",
  "strategy.phenotype_shortlist",
  "rubric.monogenic_examples",
  "rubric.cell_types",
];

/** Every section shown as a field, blank or prefilled: all but the computed three. */
export const TYPED_SECTION_IDS: readonly string[] = SECTION_IDS.filter((id) =>
  !COMPUTED_SECTION_IDS.includes(id)
);

/** What each field is spliced into, in generic words. */
export const SECTION_HELP: Record<string, string> = {
  "persona.specificity":
    "One full sentence, spliced into the system prompt as written, e.g. 'You carefully distinguish <abbreviation>-specific evidence (<core phenotypes>) from <neighbouring condition> findings.'",
  "criteria.phenotypes":
    "The inclusion criteria's phenotype list: 'Primary … phenotypes:' followed by one bullet per trait, and a 'Secondary' list if any.",
  "strategy.phenotype_shortlist":
    "A short comma-separated list of the core phenotypes, used mid-sentence: '… tested in a disease-specific analysis (<shortlist>, or another phenotype)'.",
  "strategy.neighbouring_conditions":
    "The conditions a gene must not be extracted from by mistake, used mid-sentence: '… not just <neighbouring conditions>'.",
  "strategy.background_example":
    "One background sentence a paper might write about a known monogenic gene, quoted as what NOT to extract. With no monogenic gene the pipeline leaves this step out, so it may stay empty.",
  "strategy.causal_gene_example":
    "One sentence showing a locus label versus the causal gene a TWAS names, in your field's terms.",
  "strategy.mr_example":
    "A short Mendelian-randomization exposure phrase, e.g. 'genetically proxied <drug target> reduces <trait>'.",
  "strategy.ortholog_example":
    "Animal-model to human symbol mappings, e.g. 'mouse Abc1 → ABC1'.",
  "strategy.disease_steps":
    "Extra extraction steps specific to this disease. One paragraph per step; a blank line separates steps. May be empty.",
  "strategy.convergence_example":
    "Two or more independent phenotypes a gene could converge on, e.g. 'both T1 and T2'.",
  "guidance.specificity_note":
    "One sentence telling the model what specificity to note in the evidence summary.",
  "rubric.subgroup_example":
    "Two trait keys that are subgroups of one phenotype rather than independent, e.g. 'T1/T1-deep'.",
  "rubric.monogenic_examples":
    "The established monogenic genes named as examples of validated causality. With no monogenic gene the pipeline drops the examples, so it may stay empty.",
  "rubric.cell_types": "The disease-relevant cell types, comma separated.",
  "rubric.neighbour_gwas_gene":
    "A phrase describing a gene from a neighbouring condition's GWAS with no disease-specific evidence.",
  "rubric.modifiers":
    "Bulleted scoring modifiers specific to the disease (penalties and exceptions).",
};

/**
 * The prefilled bodies, empty where the answers give nothing to draw on.
 * Each value is written as the generated files spell it, trimmed, so the
 * prompt names a trait key exactly as `## traits.canonical` does.
 */
export function prefillSections(answers: Answers): Record<string, string> {
  const abbreviation = clean(answers.identity.disease.abbreviation);
  // In vocabulary.json's order, as traits.canonical lists them.
  const traits = grouped(answers);
  const phenotypes = traits.length === 0 ? "" : [
    `Primary ${abbreviation} phenotypes:`,
    ...traits.map((t) => `- ${clean(t.key)} (${clean(t.name)})`),
  ].join("\n");
  const shortlist = traits.slice(0, 5).map((t) => clean(t.key)).join(", ");
  const cellTypes = answers.identity.cellTypes.glossary.map((g) =>
    clean(g.name)
  ).join(", ");
  const genes = [
    ...new Set(
      answers.monogenic.omimRows.map((row) => clean(row.geneOrLocus)),
    ),
  ].join(", ");
  return {
    "criteria.phenotypes": phenotypes,
    "strategy.phenotype_shortlist": shortlist,
    "rubric.monogenic_examples": genes,
    "rubric.cell_types": cellTypes,
  };
}
