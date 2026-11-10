import type { Answers } from "../../../lib/adapt/answers.ts";
import { draftSite } from "../../../lib/adapt/site_drafts.ts";
import { EXAMPLEITIS } from "./exampleitis.ts";

const disease = {
  key: "behcet_exampleitis",
  name: "Behçet exampleitis",
  short: "AD",
  abbreviation: "AD",
  adjective: "Head & neck Behçet-exampleitic",
};
const institute = {
  name: "Charité & UCLH Neuro Institute",
  short: "UCL & UCLH",
  url: "https://example.org",
  copyright: "Charité & UCLH Neuro Institute",
  logoAlt: 'Charité & UCLH "Neuro" Institute',
};

/**
 * A valid set of answers that a fork's own checks have tripped on, each one
 * an input the wizard accepts and a generic test once took for granted:
 *
 * - text the renderer escapes (`&`, `"`) in the institute, the adjective,
 *   the maintainer's address, the first trait and family labels and the one
 *   population, and letters outside ASCII;
 * - a two-letter abbreviation that is also a common code (OMIM's "AD");
 * - a glossary without cSVD's EC, whose first abbreviation holds a space;
 * - a first trait whose label is not its key, and a last trait keyed with
 *   the micro sign, which upper-casing turns into a Greek mu for good;
 * - one trial population, no condition pair, and a first mechanism filed
 *   under the `uncharacterised` family the radar flags;
 * - no monogenic gene.
 *
 * scripts/adapt_fork_check.ts runs every gate on a fork built from it.
 */
export const FORK_HARD: Answers = (() => {
  const answers: Answers = JSON.parse(
    JSON.stringify(EXAMPLEITIS).replaceAll("EXD", "AD")
      // U+00B5, the keyboard's micro sign, not the Greek letter.
      .replaceAll("T4", "\u00b5FA"),
  );
  answers.identity.disease = disease;
  answers.identity.institute = institute;
  answers.identity.site = draftSite(disease, institute);
  answers.identity.logoLight = EXAMPLEITIS.identity.logoLight;
  answers.identity.maintainer.email = "r&d@example.org";
  answers.identity.cellTypes = {
    label: "Cell Types",
    glossary: [
      { abbrev: "T cells", name: "T lymphocytes" },
      { abbrev: "MG", name: "Microglia" },
    ],
  };
  answers.vocabulary.traits[0].label = "Speech & gait";
  answers.vocabulary.families[0].label = "Motor & cognitive";
  answers.trials.populations = [{
    key: "Children & adults",
    label: "Children & adults",
    lines: ["Children &", "adults"],
  }];
  answers.trials.conditionPairs = [];
  answers.trials.mechanismFamilies = [
    { key: "uncharacterised", label: "Uncharacterised" },
    ...answers.trials.mechanismFamilies,
  ];
  answers.trials.mechanisms = [
    { name: "Mechanism not stated", family: "uncharacterised" },
    ...answers.trials.mechanisms,
  ];
  answers.monogenic = { none: true, genes: [], aliases: [], omimRows: [] };
  const sections = answers.prompt.sections;
  sections["rubric.cell_types"] = "Microglia";
  sections["strategy.background_example"] = "";
  sections["rubric.monogenic_examples"] = "";
  sections["strategy.ortholog_example"] = "mouse Genec → GENEC";
  return answers;
})();
