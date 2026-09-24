import { assert, assertEquals } from "@std/assert";

import { EMPTY_ANSWERS } from "../../lib/adapt/answers.ts";
import { GENETIC_TERMS } from "../../lib/adapt/genetic_terms.ts";
import {
  FAMILY_PALETTE,
  MECHANISM_PALETTE,
  POPULATION_PALETTE,
  UNKNOWN_MECHANISM,
} from "../../lib/adapt/palette.ts";
import {
  COMPUTED_SECTION_IDS,
  PREFILLED_SECTION_IDS,
  prefillSections,
  SECTION_HELP,
  SECTION_IDS,
  TYPED_SECTION_IDS,
} from "../../lib/adapt/prompt_sections.ts";
import {
  draftSite,
  redraftSite,
  titleCase,
} from "../../lib/adapt/site_drafts.ts";
import { deltaE, HEX, oklab } from "../helpers/colour.ts";

Deno.test("the genetic terms mirror pipeline/pubmed_search.py", async () => {
  const source = await Deno.readTextFile("pipeline/pubmed_search.py");
  const block = source.match(/GENETIC_TERMS[^(]*\(([^)]*)\)/)![1];
  const python = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assertEquals([...GENETIC_TERMS], python);
});

Deno.test("the section ids are the prompt file's headings in order", async () => {
  const prompt = await Deno.readTextFile("disease/prompt.md");
  const headings = [...prompt.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
  assertEquals([...SECTION_IDS], headings);
  for (const id of TYPED_SECTION_IDS) {
    assert(SECTION_IDS.includes(id), id);
    assert(SECTION_HELP[id].length > 0, `${id} has no help text`);
  }
  assertEquals(
    TYPED_SECTION_IDS.length,
    SECTION_IDS.length - COMPUTED_SECTION_IDS.length,
  );
  for (const id of PREFILLED_SECTION_IDS) {
    assert(TYPED_SECTION_IDS.includes(id), `${id} is prefilled but not typed`);
  }
  for (const id of COMPUTED_SECTION_IDS) {
    assert(!TYPED_SECTION_IDS.includes(id), `${id} is computed but typed`);
  }
});

Deno.test("draftSite follows the interview's templates", () => {
  const site = draftSite(
    {
      key: "exampleitis",
      name: "exampleitis",
      short: "EXD",
      abbreviation: "EXD",
      adjective: "Exampleitic",
    },
    {
      name: "Example Institute",
      short: "EI",
      url: "",
      copyright: "",
      logoAlt: "",
    },
  );
  assertEquals(site.title, "EI Exampleitic Dashboard");
  assertEquals(
    site.heading,
    "Putative Causal Genes and Clinical Trial Drugs for Exampleitis",
  );
  assertEquals(
    site.metaDescription,
    "Interactive dashboard of putative causal genes and clinical trial drugs for exampleitis, from the Example Institute (EI).",
  );
  assertEquals(
    site.aboutTitle,
    "Welcome to the Example Institute's Exampleitic Dashboard",
  );
  assert(site.aboutLede.includes("exampleitis (EXD)"));
  assert(site.loginLede.startsWith("Putative causal genes"));
  assert(site.pages.genes.includes("exampleitis (EXD)"));
  assert(site.pages.trials.includes("exampleitis (EXD)"));
  assert(site.pages.timeline.includes("exampleitis (EXD)"));
  assert(site.pages.map.includes("exampleitis (EXD)"));
});

Deno.test("titleCase capitalises words, not the letter after an apostrophe or an accent", () => {
  assertEquals(titleCase("alzheimer's disease"), "Alzheimer's Disease");
  assertEquals(titleCase("ménière's disease"), "Ménière's Disease");
  assertEquals(
    titleCase("x-linked (familial) form"),
    "X-Linked (Familial) Form",
  );
  assertEquals(titleCase("type 2 exampleitis"), "Type 2 Exampleitis");
});

Deno.test("redraftSite redrafts only the strings still on their draft", () => {
  // From nothing: every string is blank, so each name drafts the lines it
  // completes, and a line still missing a name waits for it.
  const identity = structuredClone(EMPTY_ANSWERS.identity);
  redraftSite(identity, (i) => i.disease.name = "exampleitis");
  assertEquals(
    identity.site,
    draftSite(identity.disease, identity.institute),
  );
  assert(identity.site.heading.endsWith("Exampleitis"));
  assertEquals([identity.site.title, identity.site.pages.map], ["", ""]);
  redraftSite(identity, (i) => {
    i.disease.abbreviation = "EXD";
    i.disease.adjective = "Exampleitic";
  });
  assert(identity.site.pages.map.includes("exampleitis (EXD)"));

  // An edited line is the researcher's: renaming the disease redrafts every
  // other string, including the page descriptions, and leaves that one.
  identity.site.heading = "A heading of my own";
  redraftSite(identity, (i) => i.disease.name = "exampleosis");
  const drafted = draftSite(identity.disease, identity.institute);
  assertEquals(identity.site, { ...drafted, heading: "A heading of my own" });
  assert(identity.site.pages.map.includes("exampleosis"));

  // A line emptied by hand is blank again, which is no answer: it follows
  // the names once more.
  identity.site.pages.genes = "";
  redraftSite(identity, (i) => i.institute.short = "EI");
  assertEquals(
    identity.site.pages.genes,
    draftSite(identity.disease, identity.institute).pages.genes,
  );
  assertEquals(identity.site.heading, "A heading of my own");
  assertEquals(identity.institute.short, "EI");
});

Deno.test("the family palette passes the phenogram encoding gates", () => {
  const hues = FAMILY_PALETTE.map((f) => f.hue);
  for (const family of FAMILY_PALETTE) {
    assert(HEX.test(family.hue) && HEX.test(family.tint));
    const [l] = oklab(family.hue);
    assert(l >= 0.43 && l <= 0.77, family.hue);
    assert(oklab(family.tint)[0] >= 0.9, family.tint);
  }
  assertEquals(new Set(hues).size, hues.length);
  for (let i = 1; i < hues.length; i++) {
    assert(deltaE(hues[i - 1], hues[i]) >= 15, `${hues[i - 1]}/${hues[i]}`);
  }
});

Deno.test("the mechanism and population palettes are distinct and never the unknown colour", () => {
  assertEquals(UNKNOWN_MECHANISM, "#888888");
  assertEquals(new Set(MECHANISM_PALETTE).size, MECHANISM_PALETTE.length);
  assert(MECHANISM_PALETTE.length >= 24);
  assert(!MECHANISM_PALETTE.includes(UNKNOWN_MECHANISM));
  for (const hex of MECHANISM_PALETTE) assert(HEX.test(hex), hex);
  assert(POPULATION_PALETTE.length >= 6);
  for (const p of POPULATION_PALETTE) {
    assert(HEX.test(p.color) && HEX.test(p.band), p.color);
  }
  const colours = POPULATION_PALETTE.map((p) => p.color);
  assertEquals(new Set(colours).size, colours.length);
});

Deno.test("prefillSections derives the four prefilled bodies from the answers", () => {
  const answers = structuredClone(EMPTY_ANSWERS);
  answers.identity.disease.abbreviation = "EXD";
  answers.vocabulary.traits = [
    {
      key: "T1",
      label: "T1",
      name: "Trait one",
      family: "f",
      definition: "",
      standard: false,
      xref: null,
      xrefNote: "",
    },
    {
      key: "T2",
      label: "T2",
      name: "Trait two",
      family: "f",
      definition: "",
      standard: false,
      xref: null,
      xrefNote: "",
    },
  ];
  answers.identity.cellTypes.glossary = [{
    abbrev: "EC",
    name: "Endothelial cells",
  }];
  answers.monogenic.omimRows = [
    {
      omimNum: "1",
      location: "1p1",
      phenotype: "Syndrome one",
      phenotypeMimNumber: "1",
      inheritance: "AD",
      phenotypeMappingKey: "3",
      geneOrLocus: "GENEA",
      geneOrLocusMimNumber: "2",
    },
    {
      omimNum: "3",
      location: "1p1",
      phenotype: "Syndrome two",
      phenotypeMimNumber: "3",
      inheritance: "AD",
      phenotypeMappingKey: "3",
      geneOrLocus: "GENEA ",
      geneOrLocusMimNumber: "2",
    },
  ];
  // Padded as typed, each value is written as the files spell it.
  answers.vocabulary.traits[1].key = " T2 ";
  const sections = prefillSections(answers);
  assertEquals(
    sections["criteria.phenotypes"],
    "Primary EXD phenotypes:\n- T1 (Trait one)\n- T2 (Trait two)",
  );
  assertEquals(sections["strategy.phenotype_shortlist"], "T1, T2");
  assertEquals(sections["rubric.cell_types"], "Endothelial cells");
  assertEquals(sections["rubric.monogenic_examples"], "GENEA");
  // With nothing to draw on, the prefill is empty rather than a placeholder.
  assertEquals(prefillSections(EMPTY_ANSWERS)["rubric.monogenic_examples"], "");
  assertEquals(
    prefillSections(EMPTY_ANSWERS)["strategy.phenotype_shortlist"],
    "",
  );
});

Deno.test("the site is drafted from the names as the files write them", () => {
  const { disease, institute } = EXAMPLE_NAMES;
  const padded = draftSite(
    {
      ...disease,
      name: ` ${disease.name} `,
      abbreviation: `${disease.abbreviation} `,
    },
    { ...institute, name: `${institute.name} ` },
  );
  assertEquals(padded, draftSite(disease, institute));
  // A name passing through a trailing space while typed keeps the lines
  // following it.
  const identity = structuredClone(EMPTY_ANSWERS.identity);
  redraftSite(identity, (i) => Object.assign(i.disease, disease));
  redraftSite(identity, (i) => Object.assign(i.institute, institute));
  redraftSite(identity, (i) => i.institute.name = "Other Institute ");
  redraftSite(identity, (i) => i.institute.name = "Other Institute X");
  assert(identity.site.aboutTitle.includes("Other Institute X's"));
});

Deno.test("a line waits for every name it is drafted from", () => {
  const site = draftSite(
    { ...EMPTY_ANSWERS.identity.disease, name: "exampleitis" },
    EMPTY_ANSWERS.identity.institute,
  );
  assert(site.heading !== "");
  for (const line of [site.title, site.aboutTitle, site.metaDescription]) {
    assertEquals(line, "");
  }
});

Deno.test("titleCase keeps a Greek letter and a word's own capitals", () => {
  assertEquals(titleCase("\u03b2-thalassemia"), "\u03b2-Thalassemia");
  assertEquals(titleCase("mTOR-related disease"), "mTOR-Related Disease");
  assertEquals(
    titleCase("tRNA synthetase disorder"),
    "tRNA Synthetase Disorder",
  );
  assertEquals(titleCase("alzheimer's disease"), "Alzheimer's Disease");
});

Deno.test("an institute named with its article is not given a second one", () => {
  const site = draftSite(EXAMPLE_NAMES.disease, {
    ...EXAMPLE_NAMES.institute,
    name: "The Francis Crick Institute",
  });
  assert(
    site.aboutTitle.startsWith("Welcome to The Francis Crick Institute's"),
  );
  assert(site.metaDescription.includes("from The Francis Crick Institute"));
  assert(!/the the/i.test(site.aboutTitle + site.metaDescription));
});

Deno.test("the persona help asks for a full sentence", () => {
  assert(SECTION_HELP["persona.specificity"].startsWith("One full sentence"));
  assert(SECTION_HELP["persona.specificity"].includes("'You carefully"));
});

Deno.test("the prefilled phenotypes follow vocabulary.json's family order", () => {
  const answers = structuredClone(EMPTY_ANSWERS) as typeof EMPTY_ANSWERS;
  const trait = (key: string, family: string) => ({
    key,
    label: key,
    name: `Trait ${key}`,
    family,
    definition: "",
    standard: false,
    xref: null,
    xrefNote: "",
  });
  answers.vocabulary.families = [
    { key: "fam-a", label: "A" },
    { key: "fam-b", label: "B" },
  ];
  answers.vocabulary.traits = [
    trait("T3", "fam-b"),
    trait("T1", "fam-a"),
    trait("T4", "fam-b"),
    trait("T2", "fam-a"),
  ];
  const prefills = prefillSections(answers);
  assertEquals(prefills["strategy.phenotype_shortlist"], "T1, T2, T3, T4");
  assert(
    prefills["criteria.phenotypes"].indexOf("T2") <
      prefills["criteria.phenotypes"].indexOf("T3"),
  );
});

const EXAMPLE_NAMES = {
  disease: {
    key: "exampleitis",
    name: "exampleitis",
    short: "EXD",
    abbreviation: "EXD",
    adjective: "Exampleitic",
  },
  institute: {
    name: "Example Institute",
    short: "EI",
    url: "https://example.org",
    copyright: "Example Institute (EI)",
    logoAlt: "Example Institute",
  },
};
