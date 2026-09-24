import { type Answers, DRAFT_VERSION } from "../../../lib/adapt/answers.ts";

/** One pixel, so the dark logo holds real PNG bytes. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

/**
 * Answers with every field away from its empty value, and every field that
 * can be null both set and null somewhere, for the round trips a draft and
 * an export make. A shape line parseDraft lost would lose its field here,
 * where an empty draft would read back the same without it. Not a valid
 * set of answers: validate() is not what it is for.
 */
export const MAXIMAL: Answers = {
  version: DRAFT_VERSION,
  identity: {
    disease: {
      key: "exampleitis",
      name: "exampleitis",
      short: "EXD",
      abbreviation: "EXD",
      adjective: "Exampleitic",
    },
    site: {
      title: "Exampleitis Dashboard",
      heading: "EXD Dashboard",
      metaDescription: "Genes and trials in exampleitis.",
      aboutTitle: "About the EXD Dashboard",
      aboutLede: "What the dashboard holds and where it comes from.",
      loginLede: "Enter the passphrase to read the dashboard.",
      pages: {
        genes: "Genes implicated in exampleitis.",
        trials: "Trials in exampleitis.",
        timeline: "Trials by population and mechanism.",
        map: "Where the trials recruit.",
      },
    },
    institute: {
      name: "Example Institute",
      short: "EI",
      url: "https://example.org",
      copyright: "Example Institute (EI)",
      logoAlt: "Example Institute logo",
    },
    logoLight: {
      name: "logo-light.svg",
      base64: btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      ),
    },
    logoDark: { name: "logo-dark.png", base64: PNG },
    maintainer: { name: "Ada Example", email: "ada@example.org" },
    cellTypes: {
      label: "Cell Types",
      glossary: [
        { abbrev: "EC", name: "Endothelial Cells" },
        { abbrev: "PC", name: "Pericytes" },
      ],
    },
  },
  search: {
    diseaseTerms: ["exampleitis", "example disease"],
    meshTerms: [
      {
        phrase: "exampleitis",
        heading: "Exampleitis",
        scopeNote: "A made-up disease.",
        count: 1200,
      },
      {
        phrase: "example disease",
        heading: null,
        scopeNote: null,
        count: null,
      },
    ],
    markerTerms: [
      { term: "example marker", count: 300 },
      { term: "second marker", count: null },
    ],
    ncbi: { email: "ada@example.org", apiKey: "0123456789abcdef" },
  },
  vocabulary: {
    traits: [
      {
        key: "T1",
        label: "Trait one",
        name: "Trait one in full",
        family: "fam_a",
        definition: "Definition of trait one.",
        standard: true,
        xref: "HP:0000001",
        xrefNote: "OLS4 top hit: trait one",
      },
      {
        key: "T2",
        label: "Trait two",
        name: "Trait two in full",
        family: "fam_a",
        definition: "Definition of trait two.",
        standard: false,
        xref: null,
        xrefNote: "no term found",
      },
    ],
    families: [{ key: "fam_a", label: "Family A" }],
    citationStandard: {
      name: "STANDARD-1",
      label: "Author A, et al. Journal 2020",
      doi: "10.1000/example",
      linkLabel: "View STANDARD-1 (Journal 2020)",
    },
  },
  trials: {
    populations: [
      { key: "early", label: "Early stage", lines: ["Early", "stage"] },
    ],
    populationField: {
      label: "EXD Population",
      detailsLabel: "EXD Population Details",
    },
    searchTerms: [
      {
        term: "exampleitis",
        count: 12,
        sampleConditions: ["Exampleitis"],
        sampleInterventions: ["examplumab"],
      },
      {
        term: "example disease",
        count: null,
        sampleConditions: ["Example Disease"],
        sampleInterventions: ["placebo"],
      },
    ],
    conditions: ["exampleitis"],
    conditionPairs: [["example", "disease"]],
    mechanismFamilies: [{ key: "anti_example", label: "Anti-example" }],
    mechanisms: [{
      name: "Example receptor antagonist",
      family: "anti_example",
    }],
  },
  monogenic: {
    genes: [
      {
        symbol: "GENEA",
        verified: true,
        clinvarTraits: [
          { name: "Syndrome one", omim: "100001" },
          { name: "Syndrome two", omim: null },
        ],
      },
      { symbol: "GENEB", verified: false, clinvarTraits: [] },
      { symbol: "GENEC", verified: null, clinvarTraits: [] },
    ],
    aliases: [{ alias: "GENEA/B", symbols: ["GENEA", "GENEB"] }],
    omimRows: [{
      omimNum: "100001",
      location: "1p36.1",
      phenotype: "Syndrome one",
      phenotypeMimNumber: "100001",
      inheritance: "AD",
      phenotypeMappingKey: "3",
      geneOrLocus: "GENEA",
      geneOrLocusMimNumber: "100002",
    }],
  },
  prompt: {
    sections: {
      "persona.specificity": "EXD-specific evidence from general findings.",
      "rubric.modifiers": "- Penalty: apply -0.1 for general evidence only.",
    },
    examples: [
      {
        pmid: "10000001",
        type: "include_validated",
        abstract: "An abstract naming GENEC.",
        gene: "GENEC",
        traits: ["T1"],
        sentence: "GENEC reached genome-wide significance for T1.",
        confidence: 0.8,
        reasoning: "GWAS plus TWAS.",
      },
      {
        pmid: "10000002",
        type: "exclude_positional",
        abstract: null,
        gene: "GENED",
        traits: ["T1", "T2"],
        sentence: "GENED is the nearest gene to the lead SNP.",
        confidence: 0.2,
        reasoning: "Positional only.",
      },
    ],
  },
  gold: {
    rows: [
      {
        pmid: "10000001",
        note: "prompt example",
        title: "Paper one",
        exists: true,
      },
      { pmid: "10000002", note: "landmark paper", title: null, exists: false },
      { pmid: "10000003", note: "landmark paper", title: null, exists: null },
    ],
  },
};
