import type { Answers, Trait } from "../../../lib/adapt/answers.ts";
import { EMPTY_ANSWERS } from "../../../lib/adapt/answers.ts";
import { draftSite } from "../../../lib/adapt/site_drafts.ts";

const disease = {
  key: "exampleitis",
  name: "exampleitis",
  short: "EXD",
  abbreviation: "EXD",
  adjective: "Exampleitic",
};
const institute = {
  name: "Example Institute",
  short: "EI",
  url: "https://example.org",
  copyright: "Example Institute (EI)",
  logoAlt: "Example Institute",
};

const trait = (key: string, family: string, name: string): Trait => ({
  key,
  label: key,
  name,
  family,
  definition: `Definition of ${name}.`,
  standard: false,
  xref: null,
  xrefNote: "no term found",
});

/** A complete, valid set of answers for the fictitious disease. */
export const EXAMPLEITIS: Answers = {
  ...structuredClone(EMPTY_ANSWERS),
  identity: {
    disease,
    site: draftSite(disease, institute),
    institute,
    // A standalone SVG: without its namespace a browser draws nothing.
    logoLight: {
      name: "logo-light.svg",
      base64: btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
      ),
    },
    logoDark: null,
    maintainer: { name: "Ada Example", email: "ada@example.org" },
    cellTypes: {
      label: "Cell Types",
      glossary: [{ abbrev: "EC", name: "Endothelial Cells" }],
    },
  },
  search: {
    diseaseTerms: ["exampleitis"],
    meshTerms: [{
      phrase: "exampleitis",
      heading: "Exampleitis",
      scopeNote: "A made-up disease.",
      count: 1200,
    }],
    markerTerms: [{ term: "example marker", count: 300 }, {
      term: "second marker",
      count: 20,
    }],
    ncbi: { email: "", apiKey: "" },
  },
  vocabulary: {
    traits: [
      trait("T1", "fam-a", "Trait one"),
      trait("T2", "fam-a", "Trait two"),
      trait("T3", "fam-b", "Trait three"),
      trait("T4", "fam-b", "Trait four"),
    ],
    families: [{ key: "fam-a", label: "Family A" }, {
      key: "fam-b",
      label: "Family B",
    }],
    citationStandard: null,
  },
  trials: {
    populations: [
      { key: "Early", label: "Early", lines: ["Early"] },
      { key: "Late", label: "Late stage", lines: ["Late", "stage"] },
    ],
    populationField: {
      label: "EXD Population",
      detailsLabel: "EXD Population Details",
    },
    searchTerms: [{
      term: "exampleitis",
      count: 12,
      sampleConditions: ["Exampleitis"],
      sampleInterventions: ["examplumab"],
    }],
    conditions: ["exampleitis"],
    conditionPairs: [["example", "disease"]],
    mechanismFamilies: [{ key: "anti-example", label: "Anti-example" }],
    mechanisms: [{
      name: "Example receptor antagonist",
      family: "anti-example",
    }],
  },
  monogenic: {
    genes: [{
      symbol: "GENEA",
      verified: true,
      clinvarTraits: [{ name: "Syndrome one", omim: "100001" }],
    }],
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
      "persona.specificity":
        "You carefully distinguish EXD-specific evidence (T1, T2) from general findings.",
      "criteria.phenotypes":
        "Primary EXD phenotypes:\n- T1 (Trait one)\n- T2 (Trait two)\n- T3 (Trait three)\n- T4 (Trait four)",
      "strategy.phenotype_shortlist": "T1, T2, T3, T4",
      "strategy.neighbouring_conditions": "general exampleosis",
      "strategy.background_example":
        "Familial exampleitis is caused by GENEA mutations.",
      "strategy.causal_gene_example":
        "For example, if a locus is labeled LOCUS1 but TWAS identifies GENEC, extract GENEC.",
      "strategy.mr_example": "genetically proxied receptor blockade reduces T1",
      "strategy.ortholog_example": "mouse Genea → GENEA",
      "strategy.disease_steps": "Step one paragraph.\n\nStep two paragraph.",
      "strategy.convergence_example": "both T1 and T2",
      "guidance.specificity_note":
        "Note EXD-specificity versus general exampleosis.",
      "rubric.subgroup_example": "T1/T2",
      "rubric.monogenic_examples": "GENEA",
      "rubric.cell_types": "Endothelial Cells",
      "rubric.neighbour_gwas_gene":
        "general exampleosis GWAS gene without EXD-specific evidence",
      "rubric.modifiers":
        "- Penalty: apply −0.1 for exampleosis-only evidence.",
    },
    examples: [
      {
        pmid: "10000001",
        type: "include_validated",
        abstract: "…",
        gene: "GENEC",
        traits: ["T1"],
        sentence: "GENEC reached genome-wide significance for T1.",
        confidence: 0.8,
        reasoning: "GWAS plus TWAS.",
      },
      {
        pmid: "10000002",
        type: "include_twas",
        abstract: "…",
        gene: "GENED",
        traits: ["T2"],
        sentence: "GENED expression was associated with T2 in a TWAS.",
        confidence: 0.6,
        reasoning: "TWAS-supported causal gene.",
      },
    ],
  },
  gold: {
    rows: Array.from({ length: 10 }, (_, i) => ({
      pmid: String(10000001 + i),
      note: i < 2 ? "prompt example" : "landmark paper",
      title: `Paper ${i + 1}`,
      exists: true,
    })),
  },
};
