/**
 * Each step's questions as cards, one open at a time.
 *
 * A card owns issue paths by prefix (covers()), and every path validate()
 * emits belongs to exactly one card -- tests/adapt/cards_test.ts holds that,
 * so no message can lose its place when the step-level list is gone.
 */
import type { Answers } from "./answers.ts";
import { covers, type Progress, progressOf, stepRequired } from "./feedback.ts";
import { meshHeadings } from "./generate/pipeline.ts";
import { GENETIC_TERMS } from "./genetic_terms.ts";
import { TYPED_SECTION_IDS } from "./prompt_sections.ts";
import { draftSite } from "./site_drafts.ts";
import { type Issue, type StepId, validate } from "./validate.ts";

export interface CardDef {
  id: string;
  title: string;
  /** One line saying what the card is for, shown while it is unfinished. */
  purpose: string;
  /** The issue-path prefixes the card answers for. */
  owns: readonly string[];
  /** Always open, with no Continue: a step with one card. */
  fixed?: boolean;
}

export interface CardState {
  progress: Progress;
  summary: string;
}

export const CARDS: Readonly<Record<StepId, readonly CardDef[]>> = {
  identity: [
    {
      id: "disease",
      title: "The disease",
      purpose: "How every page names it.",
      owns: ["disease"],
    },
    {
      id: "institute",
      title: "Institute",
      purpose: "Who publishes the dashboard.",
      owns: ["institute"],
    },
    {
      id: "logos",
      title: "Logos",
      purpose: "Drawn on the navigation bar and on the login card.",
      owns: ["logoLight", "logoDark"],
    },
    {
      id: "maintainer",
      title: "Maintainer",
      purpose: "Who answers for the data.",
      owns: ["maintainer"],
    },
    {
      id: "site",
      title: "Site text",
      purpose:
        "Drafted from the names above; a line you edit stops following them.",
      owns: ["site"],
    },
    {
      id: "cells",
      title: "Cell types",
      purpose: "The cell-type column and its abbreviations.",
      owns: ["cellTypes"],
    },
  ],
  search: [
    {
      id: "ncbi",
      title: "NCBI access (optional)",
      purpose:
        "An NCBI API key lifts the limit from three to ten requests a second; the email identifies you to NCBI.",
      owns: ["ncbi"],
    },
    {
      id: "phrases",
      title: "Disease phrases",
      purpose:
        "The phrases a paper about the disease writes, checked against MeSH.",
      owns: ["diseaseTerms", "meshTerms"],
    },
    {
      id: "markers",
      title: "Marker terms",
      purpose:
        "Terms that keep a paper naming a disease phrase but no genetics term.",
      owns: ["markerTerms"],
    },
    {
      id: "genetic",
      title: "Genetic terms",
      purpose: "Fixed in code; nothing to answer.",
      owns: [],
    },
  ],
  vocabulary: [
    {
      id: "families",
      title: "Families",
      purpose: "Groups of traits that share a colour.",
      owns: ["families"],
    },
    {
      id: "traits",
      title: "Traits",
      purpose: "Four to sixteen traits, each with a definition.",
      owns: ["traits"],
    },
    {
      id: "standard",
      title: "Phenotype standard (optional)",
      purpose: "The standard the definitions quote, if the field has one.",
      owns: ["citationStandard"],
    },
  ],
  trials: [
    {
      id: "populations",
      title: "Populations",
      purpose: "The populations the trials page files a trial under.",
      owns: ["populations", "populationField"],
    },
    {
      id: "search",
      title: "Search terms and conditions",
      purpose:
        "What ClinicalTrials.gov is searched with, and what a kept trial's condition holds.",
      owns: ["searchTerms", "conditions", "conditionPairs"],
    },
    {
      id: "mechanisms",
      title: "Mechanisms of action",
      purpose: "Mechanisms already being tested, each in a family.",
      owns: ["mechanismFamilies", "mechanisms"],
    },
  ],
  monogenic: [
    {
      id: "genes",
      title: "Genes",
      purpose:
        "Genes whose rare variants cause a Mendelian form; none is a valid answer.",
      owns: ["genes"],
    },
    {
      id: "aliases",
      title: "Aliases",
      purpose:
        "Dashboard names that genes are filed under instead of their HGNC symbols.",
      owns: ["aliases"],
    },
    {
      id: "omim",
      title: "OMIM entries",
      purpose: "One row per confirmed phenotype entry.",
      owns: ["omimRows"],
    },
  ],
  prompt: [
    {
      id: "criteria",
      title: "Persona and criteria",
      purpose: "Who the model is, and what it includes.",
      owns: ["sections.persona", "sections.criteria"],
    },
    // The computed sections a gene symbol or a trait key feeds are reported
    // here, beside the strategy they sit in.
    {
      id: "strategy",
      title: "Strategy",
      purpose: "How the model reads a paper, in your field's terms.",
      owns: ["sections.strategy", "strategy", "traits"],
    },
    {
      id: "rubric",
      title: "Guidance and rubric",
      purpose: "What the model notes, and how it scores.",
      owns: ["sections.guidance", "sections.rubric"],
    },
    {
      id: "examples",
      title: "Example papers",
      purpose: "Two to four worked papers, or none.",
      owns: ["examples"],
    },
  ],
  gold: [
    {
      id: "rows",
      title: "Gold papers",
      purpose: "Ten to thirty PMIDs the query must retrieve.",
      owns: ["rows"],
      fixed: true,
    },
  ],
};

export function cardOf(step: StepId, path: string): string | null {
  return CARDS[step].find((card) => card.owns.some((own) => covers(own, path)))
    ?.id ?? null;
}

export function cardProgress(
  issues: Issue[],
  step: StepId,
  required: readonly string[],
): Record<string, Progress> {
  return Object.fromEntries(
    CARDS[step].map((card) => [
      card.id,
      progressOf(
        issues,
        step,
        required,
        (path) => cardOf(step, path) === card.id,
      ),
    ]),
  );
}

export function cardStates(
  answers: Answers,
  issues: Issue[],
  step: StepId,
  required: readonly string[],
): Record<string, CardState> {
  const progress = cardProgress(issues, step, required);
  return Object.fromEntries(
    CARDS[step].map((card) => [card.id, {
      progress: progress[card.id],
      summary: cardSummary(answers, step, card.id),
    }]),
  );
}

/** The first unfinished card after `after` (from the top when omitted), wrapping round. */
export function firstOpenCard(
  progress: Record<string, Progress>,
  step: StepId,
  after?: string,
): string | null {
  const cards = CARDS[step];
  const start = after === undefined
    ? 0
    : cards.findIndex((c) => c.id === after) + 1;
  const open = (card: CardDef) => progress[card.id].open.length > 0;
  return cards.slice(start).find(open)?.id ?? cards.find(open)?.id ?? null;
}

/**
 * The card a step opens on as it is entered with these answers: its first
 * unfinished one. Decided once, on entry, and then held: worked out afresh
 * on every render, it folded a card the moment its last required key was
 * typed and left focus in a field that had just been hidden.
 */
export function entryCard(answers: Answers, step: StepId): string | null {
  return firstOpenCard(
    cardProgress(
      validate(answers),
      step,
      stepRequired(answers, step),
    ),
    step,
  );
}

/** "3 traits · T1, T2, T3", at most three named and an ellipsis after. */
function listed(values: string[], noun: string, plural = `${noun}s`): string {
  const named = values.map((v) => v.trim()).filter((v) => v !== "");
  const head = named.slice(0, 3).join(", ") + (named.length > 3 ? " …" : "");
  const count = `${values.length} ${values.length === 1 ? noun : plural}`;
  return head === "" ? count : `${count} · ${head}`;
}

const joined = (...parts: string[]) =>
  parts.map((p) => p.trim()).filter((p) => p !== "").join(" · ");

const SITE_LINES = [
  "title",
  "heading",
  "metaDescription",
  "aboutTitle",
  "aboutLede",
  "loginLede",
] as const;
const PAGE_LINES = ["genes", "trials", "timeline", "map"] as const;

/** What a folded, finished card says about its answers. */
export function cardSummary(
  answers: Answers,
  step: StepId,
  id: string,
): string {
  const { identity, search, vocabulary, trials, monogenic, prompt, gold } =
    answers;
  switch (`${step}.${id}`) {
    case "identity.disease": {
      const d = identity.disease;
      return joined(
        d.name,
        d.short,
        d.adjective,
        d.key.trim() === "" ? "" : `key ${d.key}`,
      );
    }
    case "identity.institute":
      return joined(
        `${identity.institute.name.trim()} (${identity.institute.short.trim()})`,
        identity.institute.url,
      );
    case "identity.logos":
      return joined(
        identity.logoLight?.name ?? "",
        identity.logoDark?.name ?? "",
      );
    case "identity.maintainer":
      return joined(identity.maintainer.name, identity.maintainer.email);
    case "identity.site": {
      const draft = draftSite(identity.disease, identity.institute);
      const edited =
        SITE_LINES.filter((k) => identity.site[k] !== draft[k]).length +
        PAGE_LINES.filter((k) => identity.site.pages[k] !== draft.pages[k])
          .length;
      return edited === 0
        ? "10 lines, drafted from the names"
        : `10 lines · ${edited} edited by you`;
    }
    case "identity.cells":
      return joined(
        identity.cellTypes.label,
        listed(identity.cellTypes.glossary.map((g) => g.abbrev), "cell type"),
      );
    case "search.ncbi":
      return search.ncbi.apiKey.trim() !== ""
        ? "API key set"
        : search.ncbi.email.trim() !== ""
        ? "Email set, no API key"
        : "No key: three requests a second";
    case "search.phrases": {
      // The headings the file will hold: two phrases can resolve to one.
      const headings = meshHeadings(answers).length;
      return joined(
        listed(search.diseaseTerms, "phrase"),
        `${headings} MeSH heading${headings === 1 ? "" : "s"}`,
      );
    }
    case "search.markers":
      return listed(search.markerTerms.map((m) => m.term), "marker term");
    case "search.genetic":
      return GENETIC_TERMS.join(", ");
    case "vocabulary.families":
      return listed(
        vocabulary.families.map((f) => f.label),
        "family",
        "families",
      );
    case "vocabulary.traits":
      return listed(vocabulary.traits.map((t) => t.key), "trait");
    case "vocabulary.standard":
      return vocabulary.citationStandard?.name.trim() || "No standard";
    case "trials.populations":
      return listed(trials.populations.map((p) => p.label), "population");
    case "trials.search":
      return joined(
        listed(trials.searchTerms.map((s) => s.term), "search term"),
        listed(trials.conditions, "condition"),
      );
    case "trials.mechanisms":
      return joined(
        listed(trials.mechanisms.map((m) => m.name), "mechanism"),
        listed(
          trials.mechanismFamilies.map((f) => f.label),
          "family",
          "families",
        ),
      );
    case "monogenic.genes":
      return monogenic.genes.length === 0
        ? "No monogenic genes"
        : listed(monogenic.genes.map((g) => g.symbol), "gene");
    case "monogenic.aliases":
      return listed(monogenic.aliases.map((a) => a.alias), "alias", "aliases");
    case "monogenic.omim":
      return listed(monogenic.omimRows.map((r) => r.phenotype), "OMIM row");
    case "prompt.criteria":
    case "prompt.strategy":
    case "prompt.rubric": {
      // The disease steps may be empty, so they count only once written.
      const typed = (section: string) =>
        (prompt.sections[section] ?? "").trim() !== "";
      const ids = TYPED_SECTION_IDS.filter((section) =>
        cardOf("prompt", `sections.${section}`) === id &&
        (section !== "strategy.disease_steps" || typed(section))
      );
      return `${ids.filter(typed).length} of ${ids.length} sections written`;
    }
    case "prompt.examples":
      return listed(prompt.examples.map((e) => e.pmid), "example paper");
    case "gold.rows":
      return listed(gold.rows.map((r) => r.pmid), "gold PMID");
  }
  return "";
}

/**
 * Each list's row, as the Review step names it: the noun and what names a
 * row. An issue's index names a row of the answers it was found in.
 */
const ROWS: Record<string, [string, (a: Answers, i: number) => string]> = {
  "cellTypes.glossary": [
    "Cell type",
    (a, i) => a.identity.cellTypes.glossary[i].abbrev,
  ],
  diseaseTerms: ["Phrase", (a, i) => a.search.diseaseTerms[i]],
  meshTerms: ["Phrase", (a, i) => a.search.diseaseTerms[i]],
  markerTerms: ["Marker term", (a, i) => a.search.markerTerms[i].term],
  traits: ["Trait", (a, i) => a.vocabulary.traits[i].key],
  families: ["Family", (a, i) => a.vocabulary.families[i].key],
  populations: ["Population", (a, i) => a.trials.populations[i].key],
  searchTerms: ["Search term", (a, i) => a.trials.searchTerms[i].term],
  conditions: ["Condition", (a, i) => a.trials.conditions[i]],
  conditionPairs: [
    "Word pair",
    (a, i) => a.trials.conditionPairs[i].join(" + "),
  ],
  mechanismFamilies: [
    "Mechanism family",
    (a, i) => a.trials.mechanismFamilies[i].key,
  ],
  mechanisms: ["Mechanism", (a, i) => a.trials.mechanisms[i].name],
  genes: ["Gene", (a, i) => a.monogenic.genes[i].symbol],
  aliases: ["Alias", (a, i) => a.monogenic.aliases[i].alias],
  omimRows: ["OMIM row", (a, i) => a.monogenic.omimRows[i].omimNum],
  examples: ["Example", (a, i) => pmidOf(a.prompt.examples[i].pmid)],
  rows: ["Gold row", (a, i) => pmidOf(a.gold.rows[i].pmid)],
};

const pmidOf = (pmid: string) =>
  pmid.trim() === "" ? "" : `PMID ${pmid.trim()}`;

/**
 * What an issue on the Review step is about, when its message alone does
 * not say: "The trait definition is required." three times names no trait,
 * and "This section is required" fifteen times no section. Null for a
 * path whose message names its own field.
 */
export function issueLabel(answers: Answers, issue: Issue): string | null {
  if (issue.field.startsWith("sections.")) {
    return `Section ${issue.field.slice("sections.".length)}`;
  }
  const row = /^([A-Za-z.]+)\[(\d+)\]/.exec(issue.field);
  if (row === null || !Object.hasOwn(ROWS, row[1])) return null;
  const [noun, name] = ROWS[row[1]];
  const i = Number(row[2]);
  const named = name(answers, i).trim();
  return `${noun} ${i + 1}${named === "" ? "" : ` (${named})`}`;
}
