import type { Answers } from "../../../lib/adapt/answers.ts";
import { draftSite } from "../../../lib/adapt/site_drafts.ts";
import { EXAMPLEITIS } from "./exampleitis.ts";

const disease = {
  key: "behcet_exampleitis",
  name: "Behçet exampleitis",
  short: "AD",
  abbreviation: "AD",
  adjective: "Behçet-exampleitic",
};
const institute = {
  name: "Charité & UCLH Neuro Institute",
  short: "UCL & UCLH",
  url: "https://example.org",
  copyright: "Charité & UCLH Neuro Institute",
  logoAlt: 'Charité & UCLH "Neuro" Institute',
};

/**
 * A valid set of answers that a fork's own checks have tripped on: text
 * the renderer escapes (`&`, `"`), letters outside ASCII, a two-letter
 * abbreviation that is also a common code (OMIM's "AD"), a glossary
 * without cSVD's EC, one trial population and no monogenic gene.
 * scripts/adapt_fork_check.ts runs every gate on a fork built from it.
 */
export const FORK_HARD: Answers = (() => {
  const answers: Answers = JSON.parse(
    JSON.stringify(EXAMPLEITIS).replaceAll("EXD", "AD"),
  );
  answers.identity.disease = disease;
  answers.identity.institute = institute;
  answers.identity.site = draftSite(disease, institute);
  answers.identity.logoLight = EXAMPLEITIS.identity.logoLight;
  answers.identity.cellTypes = {
    label: "Cell Types",
    glossary: [{ abbrev: "MG", name: "Microglia" }],
  };
  answers.trials.populations = [
    { key: "Everyone", label: "All patients", lines: ["All patients"] },
  ];
  answers.monogenic = { genes: [], aliases: [], omimRows: [] };
  const sections = answers.prompt.sections;
  sections["rubric.cell_types"] = "Microglia";
  sections["strategy.background_example"] = "";
  sections["rubric.monogenic_examples"] = "";
  sections["strategy.ortholog_example"] = "mouse Genec → GENEC";
  return answers;
})();
