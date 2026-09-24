import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { EMPTY_ANSWERS } from "../../lib/adapt/answers.ts";
import { csvLine, jsonText, wrap80 } from "../../lib/adapt/generate/json.ts";
import {
  generateManifest,
  logoPath,
} from "../../lib/adapt/generate/manifest.ts";
import {
  generatePipeline,
  meshHeadings,
} from "../../lib/adapt/generate/pipeline.ts";
import { generateVocabulary } from "../../lib/adapt/generate/vocabulary.ts";
import { generateTimeline } from "../../lib/adapt/generate/timeline.ts";
import { generatePhenogram } from "../../lib/adapt/generate/phenogram.ts";
import { generateOmimCsv } from "../../lib/adapt/generate/omim_csv.ts";
import { generatePrompt } from "../../lib/adapt/generate/prompt.ts";
import { generateRecallCsv } from "../../lib/adapt/generate/recall_csv.ts";
import { generateReadme } from "../../lib/adapt/generate/readme.ts";
import { SECTION_IDS } from "../../lib/adapt/prompt_sections.ts";
import { type Schema, schemaErrors } from "../../lib/adapt/schema.ts";
import { normalizeManifest } from "../../lib/disease/manifest.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

const readSchema = async (name: string): Promise<Schema> =>
  JSON.parse(await Deno.readTextFile(`disease/${name}`));

Deno.test("jsonText is two-space JSON with a trailing newline", () => {
  assertEquals(jsonText({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}\n');
});

Deno.test("csvLine quotes fields holding a comma, a quote, a newline or a CR", () => {
  assertEquals(csvLine(["a", "b,c", 'd"e', "f\ng"]), 'a,"b,c","d""e","f\ng"');
  assertEquals(csvLine(["a\rb"]), '"a\rb"');
});

Deno.test("wrap80 breaks prose at spaces before column 81 and keeps blank lines", () => {
  const word = "abcdefghi";
  const long = Array(12).fill(word).join(" ");
  const wrapped = wrap80(`${long}\n\nshort`);
  for (const line of wrapped.split("\n")) assert(line.length <= 80, line);
  assertEquals(wrapped.split("\n").length, 4);
  assertEquals(wrap80("a\n\n\nb"), "a\n\n\nb");
  const table = `| ${"x".repeat(90)} |`;
  assertEquals(wrap80(table), table);
  const code = `    ${"y ".repeat(50)}`;
  assertEquals(wrap80(code), code);
  const item = `- **Institute:** ${Array(20).fill("word").join(" ")}`;
  const wrappedItem = wrap80(item).split("\n");
  assert(wrappedItem.length > 1);
  for (const line of wrappedItem.slice(1)) {
    assert(line.startsWith("  "), line);
    assert(line.length <= 80, line);
  }
  // A heading broken in two is a heading and a paragraph: never wrapped.
  const heading = `# ${Array(20).fill("Word").join(" ")} (EXD)`;
  assertEquals(wrap80(heading), heading);
  // No line may start with a word that opens a block: the break moves on,
  // and the marker stays at the end of the line before.
  for (const marker of ["+", "-", "*", ">", "#", "12.", "3)"]) {
    // Column 80 falls just before the marker.
    const prose = `${"a".repeat(77)} x ${marker} carriers.`;
    const lines = wrap80(prose).split("\n");
    assertEquals(lines, [`${"a".repeat(77)} x ${marker}`, "carriers."]);
  }
});

Deno.test("the generated manifest validates against the schema and normalises", async () => {
  const text = generateManifest(EXAMPLEITIS);
  const root = await readSchema("manifest.schema.json");
  const value = JSON.parse(text);
  assertEquals(schemaErrors(root, value, root, "manifest.json"), []);
  const manifest = normalizeManifest(value);
  assertEquals(manifest.disease.key, "exampleitis");
  assertEquals(manifest.institute.logo.src, "/institute/logo-light.svg");
  assertEquals(manifest.institute.logo.srcOnDark, null);
  assertEquals(manifest.hosting.url, null);
  assertEquals(manifest.about.additionalSources, []);
  assertEquals(manifest.populations, [
    { key: "Early", label: "Early" },
    { key: "Late", label: "Late stage" },
  ]);
  assertEquals(manifest.cellTypes.glossary, { EC: "Endothelial Cells" });
  assertEquals(manifest.citationStandard, null);
  assert(!text.includes("GENEA"), "gene symbols never reach the manifest");
});

Deno.test("logoPath keeps the extension and names the side", () => {
  assertEquals(
    logoPath({ name: "My Logo.PNG", base64: "" }, "dark"),
    "/institute/logo-dark.png",
  );
  assertEquals(
    logoPath({ name: "noext", base64: "" }, "light"),
    "/institute/logo-light.svg",
  );
});

Deno.test("the manifest carries an empty institute url as null and a dark logo when given", () => {
  const answers = structuredClone(EXAMPLEITIS);
  answers.identity.institute.url = "";
  answers.identity.logoLight = null;
  answers.identity.logoDark = { name: "d.svg", base64: "" };
  answers.vocabulary.citationStandard = {
    name: "STD",
    label: "Std et al.",
    doi: "10.1/x",
    linkLabel: "View STD",
  };
  const value = JSON.parse(generateManifest(answers));
  assertEquals(value.institute.url, null);
  assertEquals(value.institute.logo.src, "/institute/logo-light.svg");
  assertEquals(value.institute.logo.srcOnDark, "/institute/logo-dark.svg");
  assertEquals(value.citationStandard.name, "STD");
});

Deno.test("the generated pipeline document validates and carries the search terms", async () => {
  const text = generatePipeline(EXAMPLEITIS);
  const root = await readSchema("pipeline.schema.json");
  const value = JSON.parse(text);
  assertEquals(schemaErrors(root, value, root, "pipeline.json"), []);
  assertEquals(value.search.pubmed.diseaseTerms, ["exampleitis"]);
  assertEquals(value.search.pubmed.meshTerms, ["Exampleitis"]);
  assertEquals(value.search.pubmed.markerTerms, [
    "example marker",
    "second marker",
  ]);
  assertEquals(value.search.clinicalTrials.conditionPairs, [[
    "example",
    "disease",
  ]]);
  assertEquals(value.monogenicGenes, ["GENEA"]);
  assertEquals(value.geneAliases, { "GENEA/B": ["GENEA", "GENEB"] });
  assertEquals(value.pipeline, {
    runLabel: "EXD Pipeline",
    maxGenesPerPaper: 20,
  });
  // A heading that never resolved is not emitted; a count never taken reads "?".
  const unresolved = structuredClone(EXAMPLEITIS);
  unresolved.search.meshTerms.push({
    phrase: "x",
    heading: null,
    scopeNote: null,
    count: null,
  });
  unresolved.search.meshTerms[0].count = null;
  unresolved.trials.searchTerms[0].count = null;
  const parsed = JSON.parse(generatePipeline(unresolved));
  assertEquals(parsed.search.pubmed.meshTerms, ["Exampleitis"]);
  assertStringIncludes(parsed.search.pubmed.$comment, "Exampleitis: ? papers");
  assertStringIncludes(
    parsed.search.clinicalTrials.$comment,
    "exampleitis: ? studies",
  );
});

Deno.test("the vocabulary lists the traits with empty synonyms and untracked", () => {
  const value = JSON.parse(generateVocabulary(EXAMPLEITIS));
  assertEquals(Object.keys(value), [
    "$comment",
    "traits",
    "synonyms",
    "untracked",
  ]);
  assertEquals(value.traits.length, 4);
  assertEquals(Object.keys(value.traits[0]), [
    "key",
    "label",
    "family",
    "name",
    "definition",
    "xref",
    "xrefNote",
  ]);
  assertEquals(value.synonyms, []);
  assertEquals(value.untracked, []);
  const standard = structuredClone(EXAMPLEITIS);
  standard.vocabulary.traits[0].standard = true;
  // An ontology id typed or pasted by hand is written trimmed.
  standard.vocabulary.traits[0].xref = " HP:0000001 ";
  const [first] = JSON.parse(generateVocabulary(standard)).traits;
  assertEquals(first.standard, true);
  assertEquals(first.xref, "HP:0000001");
});

Deno.test("the timeline's populations match the manifest in order, with palette colours", () => {
  const value = JSON.parse(generateTimeline(EXAMPLEITIS));
  const manifest = JSON.parse(generateManifest(EXAMPLEITIS));
  assertEquals(
    value.populations.map((p: { key: string }) => p.key),
    manifest.populations.map((p: { key: string }) => p.key),
  );
  assertEquals(value.populations[1].label, ["Late", "stage"]);
  assertEquals(value.populations[0].color, "#bf68ae");
  assertEquals(value.unknownMechanism, "#888888");
  assertEquals(value.mechanisms, { "Example receptor antagonist": "#472c6d" });
  assertEquals(value.families, [{
    key: "anti-example",
    label: "Anti-example",
    mechanisms: ["Example receptor antagonist"],
  }]);
});

Deno.test("the phenogram has one family per vocabulary family in order", () => {
  const value = JSON.parse(generatePhenogram(EXAMPLEITIS));
  assertEquals(value.families, [
    { key: "fam-a", label: "Family A", hue: "#2a78d6", tint: "#d8edff" },
    { key: "fam-b", label: "Family B", hue: "#eb6834", tint: "#ffe2d5" },
  ]);
});

Deno.test("the OMIM CSV has the nine columns and the link derived from the number", () => {
  const lines = generateOmimCsv(EXAMPLEITIS).split("\n");
  assertEquals(
    lines[0],
    "omim_num,omim_link,location,phenotype,phenotype_mim_number,inheritance,phenotype_mapping_key,gene_or_locus,gene_or_locus_mim_number",
  );
  assertEquals(
    lines[1],
    "100001,https://www.omim.org/entry/100001?search=100001&highlight=100001,1p36.1,Syndrome one,100001,AD,3,GENEA,100002",
  );
  assertEquals(lines[2], "");
  assertEquals(generateOmimCsv(EMPTY_ANSWERS), lines[0] + "\n");
});

Deno.test("the prompt has every section in order and the computed bodies", () => {
  const text = generatePrompt(EXAMPLEITIS);
  const headings = [...text.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
  assertEquals(headings, [...SECTION_IDS]);
  assertStringIncludes(text, "## strategy.monogenic_genes\n\nGENEA\n");
  assertStringIncludes(text, "## traits.canonical\n\nT1, T2, T3, T4\n");
  assertStringIncludes(
    text,
    '<example type="include_validated">\nPaper states: "GENEC reached genome-wide significance for T1."\nResult: gene_symbol="GENEC", gwas_trait=["T1"], confidence=0.8\nReasoning: GWAS plus TWAS.\n</example>',
  );
  assertStringIncludes(
    text,
    "## strategy.disease_steps\n\nStep one paragraph.\n\nStep two paragraph.\n",
  );
  // A non-empty body is followed by exactly one blank line, not none.
  assertStringIncludes(
    text,
    "- T4 (Trait four)\n\n## strategy.phenotype_shortlist",
  );
  assert(text.startsWith("# Disease sections of the extraction prompt"));
  const none = structuredClone(EXAMPLEITIS);
  none.prompt.examples = [];
  none.monogenic.genes = [];
  const bare = generatePrompt(none);
  assertStringIncludes(bare, "## examples\n\n<!-- examples: none yet -->\n");
  assertStringIncludes(
    bare,
    "## strategy.monogenic_genes\n\n\n## strategy.background_example",
  );
  // A section never typed is emitted empty rather than dropped.
  assertStringIncludes(
    generatePrompt(EMPTY_ANSWERS),
    "## persona.specificity\n\n\n## criteria.phenotypes",
  );
});

Deno.test("the recall CSV lists pmid,note rows", () => {
  const lines = generateRecallCsv(EXAMPLEITIS).split("\n");
  assertEquals(lines[0], "pmid,note");
  assertEquals(lines[1], "10000001,prompt example");
  assertEquals(lines.length, 12);
});

Deno.test("the README names the disease, the traits and the populations, wrapped at 80", () => {
  const raw = generateReadme(EXAMPLEITIS);
  assert(raw.startsWith("# Exampleitis (EXD)\n"));
  const text = raw.replace(/\n/g, " ");
  assertStringIncludes(text, "**Hosted at:** not yet hosted");
  assertStringIncludes(text, "| `T1`");
  assertStringIncludes(text, "**Early**");
  assertStringIncludes(text, "How to cite: pending");
  for (const line of raw.split("\n")) {
    // Table rows are exempt only when actually too wide to pad under 80 --
    // deno fmt does not wrap tables -- and this fixture's table never is.
    if (line.startsWith("|") && line.length > 80) continue;
    assert(line.length <= 80, line);
  }
  const variant = structuredClone(EXAMPLEITIS);
  variant.identity.institute.url = "";
  variant.search.diseaseTerms.push("y", "z");
  variant.search.meshTerms.push({
    phrase: "y",
    heading: "Second Heading",
    scopeNote: "",
    count: 1,
  }, { phrase: "z", heading: null, scopeNote: null, count: null });
  variant.trials.populations.pop();
  const other = generateReadme(variant).replace(/\n/g, " ");
  assertStringIncludes(other, "**Institute:** Example Institute (EI) ");
  assertStringIncludes(other, "MeSH headings");
  assertStringIncludes(other, "under 1 population (");
});

Deno.test("deno fmt --check accepts every generated JSON file and the README", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const files: Record<string, string> = {
      "manifest.json": generateManifest(EXAMPLEITIS),
      "pipeline.json": generatePipeline(EXAMPLEITIS),
      "vocabulary.json": generateVocabulary(EXAMPLEITIS),
      "timeline.json": generateTimeline(EXAMPLEITIS),
      "phenogram.json": generatePhenogram(EXAMPLEITIS),
      "README.md": generateReadme(EXAMPLEITIS),
    };
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(`${dir}/${name}`, text);
    }
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["fmt", "--check", dir],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the traits are grouped by family in the families' own order", () => {
  // tests/phenogram_encoding_test.ts -- which every fork runs -- reads the
  // trait list in file order and fails when a family's traits are not
  // contiguous. The researcher enters them in whatever order they think of.
  const interleaved = structuredClone(EXAMPLEITIS);
  interleaved.vocabulary.traits = [
    interleaved.vocabulary.traits[2],
    interleaved.vocabulary.traits[0],
    interleaved.vocabulary.traits[3],
    interleaved.vocabulary.traits[1],
  ];
  const traits = JSON.parse(generateVocabulary(interleaved)).traits as Array<
    { key: string; family: string }
  >;
  assertEquals(traits.map((t) => t.family), [
    "fam-a",
    "fam-a",
    "fam-b",
    "fam-b",
  ]);
  // Stable within a family: T1 was entered after T3 but before T2.
  assertEquals(traits.map((t) => t.key), ["T1", "T2", "T3", "T4"]);

  // A trait whose family is not listed sorts last rather than splitting a
  // family in two; validate() names it either way.
  const orphan = structuredClone(EXAMPLEITIS);
  orphan.vocabulary.traits[1].family = "fam-z";
  assertEquals(
    (JSON.parse(generateVocabulary(orphan)).traits as Array<{ key: string }>)
      .map((t) => t.key),
    ["T1", "T3", "T4", "T2"],
  );
});

Deno.test("keys, labels, symbols and mechanism names are trimmed on the way out", () => {
  // The forms take what was typed. A padded key reaches one file and is
  // matched against another in the next, where the space is the difference
  // between a family with traits and a family with none.
  const padded = structuredClone(EXAMPLEITIS);
  padded.vocabulary.traits[0].key = " T1 ";
  padded.vocabulary.traits[0].label = " T1 ";
  padded.vocabulary.traits[0].name = " Trait one ";
  padded.vocabulary.traits[0].family = " fam-a ";
  padded.vocabulary.families[0].key = " fam-a ";
  padded.vocabulary.families[0].label = " Family A ";
  padded.trials.populations[0].key = " Early ";
  padded.trials.populations[0].label = " Early ";
  padded.trials.populations[0].lines = [" Early "];
  padded.trials.mechanisms[0].name = " Example receptor antagonist ";
  padded.trials.mechanisms[0].family = " anti-example ";
  padded.trials.mechanismFamilies[0].key = " anti-example ";
  padded.trials.mechanismFamilies[0].label = " Anti-example ";
  padded.monogenic.genes[0].symbol = " GENEA ";
  padded.monogenic.aliases[0].alias = " GENEA/B ";
  padded.monogenic.aliases[0].symbols = [" GENEA ", "GENEB"];
  padded.monogenic.omimRows[0].geneOrLocus = " GENEA ";
  padded.prompt.examples[0].gene = " GENEC ";

  const vocabulary = JSON.parse(generateVocabulary(padded));
  assertEquals(vocabulary.traits[0], {
    key: "T1",
    label: "T1",
    family: "fam-a",
    name: "Trait one",
    definition: "Definition of Trait one.",
    xref: null,
    xrefNote: "no term found",
  });
  const manifest = JSON.parse(generateManifest(padded));
  assertEquals(manifest.populations[0], { key: "Early", label: "Early" });
  const pipeline = JSON.parse(generatePipeline(padded));
  assertEquals(pipeline.monogenicGenes, ["GENEA"]);
  assertEquals(pipeline.geneAliases, { "GENEA/B": ["GENEA", "GENEB"] });
  const timeline = JSON.parse(generateTimeline(padded));
  assertEquals(timeline.populations[0].key, "Early");
  assertEquals(timeline.populations[0].label, ["Early"]);
  assertEquals(Object.keys(timeline.mechanisms), [
    "Example receptor antagonist",
  ]);
  assertEquals(timeline.families[0], {
    key: "anti-example",
    label: "Anti-example",
    mechanisms: ["Example receptor antagonist"],
  });
  const phenogram = JSON.parse(generatePhenogram(padded));
  assertEquals(phenogram.families[0].key, "fam-a");
  assertEquals(phenogram.families[0].label, "Family A");
  assertStringIncludes(generateOmimCsv(padded).split("\n")[1], ",GENEA,");
  const prompt = generatePrompt(padded);
  assertStringIncludes(prompt, "## strategy.monogenic_genes\n\nGENEA\n");
  assertStringIncludes(prompt, 'gene_symbol="GENEC"');
});

Deno.test("a quote inside an example is escaped rather than closing its field", () => {
  const quoted = structuredClone(EXAMPLEITIS);
  quoted.prompt.examples[0].sentence = 'The "risk" allele of GENEC.';
  quoted.prompt.examples[0].gene = 'GENE"C';
  quoted.prompt.examples[0].reasoning = 'The "lead" SNP.';
  const prompt = generatePrompt(quoted);
  assertStringIncludes(
    prompt,
    'Paper states: "The \\"risk\\" allele of GENEC."',
  );
  assertStringIncludes(prompt, 'gene_symbol="GENE\\"C"');
  // The reasoning line is not quoted, so a quote in it is written as is.
  assertStringIncludes(prompt, 'Reasoning: The "lead" SNP.');
});

Deno.test("an example's lines are one line each, whatever the abstract's layout", () => {
  const wrapped = structuredClone(EXAMPLEITIS);
  wrapped.prompt.examples[0].sentence =
    "GENEC reached genome-wide \n  significance for T1. ";
  wrapped.prompt.examples[0].reasoning = "GWAS plus\nTWAS.";
  const prompt = generatePrompt(wrapped);
  assertStringIncludes(
    prompt,
    'Paper states: "GENEC reached genome-wide significance for T1."\n',
  );
  assertStringIncludes(prompt, "Reasoning: GWAS plus TWAS.\n");
});

Deno.test("a typed section is written trimmed", () => {
  const padded = structuredClone(EXAMPLEITIS);
  padded.prompt.sections["persona.specificity"] =
    " You carefully distinguish EXD.\n ";
  assertStringIncludes(
    generatePrompt(padded),
    "## persona.specificity\n\nYou carefully distinguish EXD.\n\n##",
  );
});

Deno.test("traits.canonical lists the keys in vocabulary.json's order", () => {
  const shuffled = structuredClone(EXAMPLEITIS);
  const [t1, t2, t3, t4] = shuffled.vocabulary.traits;
  shuffled.vocabulary.traits = [t3, t1, t4, t2];
  const keys = JSON.parse(generateVocabulary(shuffled)).traits.map(
    (t: { key: string }) => t.key,
  );
  assertStringIncludes(
    generatePrompt(shuffled),
    `## traits.canonical\n\n${keys.join(", ")}\n`,
  );
  assertEquals(keys, ["T1", "T2", "T3", "T4"]);
});

Deno.test("a MeSH heading is written trimmed, once, and never blank", () => {
  const answers = structuredClone(EXAMPLEITIS);
  answers.search.diseaseTerms = ["one", "two", "three"];
  answers.search.meshTerms = [
    { phrase: "one", heading: "Exampleitis ", scopeNote: "", count: 1 },
    { phrase: "two", heading: "Exampleitis", scopeNote: "", count: 1 },
    { phrase: "three", heading: " ", scopeNote: "", count: 1 },
  ];
  assertEquals(meshHeadings(answers).map((m) => m.heading), ["Exampleitis"]);
  const readme = generateReadme(answers);
  assertStringIncludes(readme, '"Exampleitis";');
  assert(!readme.includes('"Exampleitis "'));
});

Deno.test("the README escapes researcher text Markdown would read as markup", async () => {
  const marked = structuredClone(EXAMPLEITIS);
  marked.vocabulary.traits[0].name = "HLA-B*27 and HLA-B*57 carriage";
  marked.vocabulary.traits[1].name = "*type*";
  marked.trials.populations[0].label = "<stage>";
  marked.vocabulary.traits[2].key = "T`3";
  marked.vocabulary.traits[3].key = "`T4";
  const readme = generateReadme(marked);
  assertStringIncludes(readme, "HLA-B\\*27 and HLA-B\\*57 carriage");
  assertStringIncludes(readme, "\\*type\\*");
  assertStringIncludes(readme, "**\\<stage\\>**");
  assertStringIncludes(readme, "``T`3``");
  // A key opening with a backtick is padded inside its fence.
  assertStringIncludes(readme, "`` `T4 ``");
  // deno fmt, which the fork's CI runs, keeps every escape.
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/README.md`;
    await Deno.writeTextFile(path, readme);
    const fmt = await new Deno.Command(Deno.execPath(), {
      args: ["fmt", "--check", path],
      stdout: "null",
      stderr: "null",
    }).output();
    assert(fmt.success, "deno fmt would rewrite the README");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an OMIM field's spaces are written as the export reads them", () => {
  const spaced = structuredClone(EXAMPLEITIS);
  spaced.monogenic.omimRows[0].inheritance = "AD,\u00a0AR";
  spaced.monogenic.omimRows[0].phenotype = "Syndrome  one";
  const row = generateOmimCsv(spaced).split("\n")[1];
  assertStringIncludes(row, '"AD, AR"');
  assertStringIncludes(row, "Syndrome one");
});

Deno.test("the free-text answers are trimmed on the way out too", () => {
  const padded = structuredClone(EXAMPLEITIS);
  padded.identity.disease.name = " exampleitis ";
  padded.identity.disease.abbreviation = " EXD ";
  padded.identity.disease.key = " exampleitis ";
  padded.identity.site.title = " EI Exampleitic Dashboard ";
  padded.identity.site.pages.genes = " Genes. ";
  padded.identity.institute.url = "   ";
  padded.identity.maintainer.email = " ada@example.org ";
  padded.identity.cellTypes.glossary[0].abbrev = " EC ";
  padded.trials.populationField.label = " EXD Population ";
  padded.vocabulary.citationStandard = {
    name: " Standard ",
    label: "Label",
    doi: "10.0000/x",
    linkLabel: "Link",
  };
  padded.search.diseaseTerms = [" exampleitis "];
  padded.search.markerTerms[0].term = " example marker ";
  padded.trials.searchTerms[0].term = " exampleitis ";
  padded.monogenic.omimRows[0].omimNum = " 100001 ";
  padded.gold.rows[0].pmid = " 10000001 ";
  padded.prompt.examples[0].type = " include_validated ";

  const manifest = JSON.parse(generateManifest(padded));
  assertEquals(manifest.disease.name, "exampleitis");
  assertEquals(manifest.site.title, "EI Exampleitic Dashboard");
  assertEquals(manifest.site.pages.genes, "Genes.");
  // A url of spaces is no url, not a link to nowhere.
  assertEquals(manifest.institute.url, null);
  assertEquals(manifest.contact.maintainer.email, "ada@example.org");
  assert("EC" in manifest.cellTypes.glossary);
  assertEquals(manifest.populationField.label, "EXD Population");
  assertEquals(manifest.citationStandard.name, "Standard");
  const pipeline = JSON.parse(generatePipeline(padded));
  assertEquals(pipeline.search.pubmed.diseaseTerms, ["exampleitis"]);
  assertEquals(pipeline.search.pubmed.markerTerms[0], "example marker");
  assertEquals(pipeline.search.clinicalTrials.searchTerms, ["exampleitis"]);
  assertEquals(pipeline.pipeline.runLabel, "EXD Pipeline");
  assert(generateOmimCsv(padded).split("\n")[1].startsWith("100001,"));
  assertEquals(
    generateRecallCsv(padded).split("\n")[1].split(",")[0],
    "10000001",
  );
  assertStringIncludes(
    generatePrompt(padded),
    '<example type="include_validated">',
  );
  const readme = generateReadme(padded);
  assertStringIncludes(readme, "# Exampleitis (EXD)\n");
  assertStringIncludes(readme, "<ada@example.org>");
});

Deno.test("each MeSH heading is written once, and only for a phrase still listed", () => {
  const answers = structuredClone(EXAMPLEITIS);
  const row = answers.search.meshTerms[0];
  answers.search.diseaseTerms = ["exampleitis", "example disease"];
  answers.search.meshTerms = [
    row,
    { ...row, phrase: "example disease" },
    { ...row, phrase: "removed", heading: "Removed" },
  ];
  const pubmed = JSON.parse(generatePipeline(answers)).search.pubmed;
  assertEquals(pubmed.meshTerms, [row.heading]);
  assertEquals(pubmed.$comment.split("; ").length, 1);
  const readme = generateReadme(answers).replace(/\n/g, " ");
  assertStringIncludes(readme, `the MeSH heading "${row.heading}";`);

  // A phrase retyped since its check keeps the old words' row, which is
  // not its answer; a phrase with no row yet has none.
  const retyped = structuredClone(answers);
  retyped.search.diseaseTerms = ["exampleosis", "exampleitis", "third"];
  retyped.search.meshTerms = [
    row,
    { ...row, phrase: "exampleitis", heading: "Other" },
  ];
  assertEquals(meshHeadings(retyped), [{ heading: "Other", count: 1200 }]);
});

Deno.test("condition substrings and pair words are written in lower case", () => {
  // clinical_trials_fetch.py lower-cases the trial's condition before it
  // looks, so a capital here would match nothing.
  const answers = structuredClone(EXAMPLEITIS);
  answers.trials.conditions = [" Exampleitis "];
  answers.trials.conditionPairs = [["Example", " DISEASE"]];
  const trials = JSON.parse(generatePipeline(answers)).search.clinicalTrials;
  assertEquals(trials.conditions, ["exampleitis"]);
  assertEquals(trials.conditionPairs, [["example", "disease"]]);
});

Deno.test("the disease steps reach prompt.md one paragraph each, one blank line apart", () => {
  const answers = structuredClone(EXAMPLEITIS);
  answers.prompt.sections["strategy.disease_steps"] =
    "\n Step one. \n \t\nStep two.\n\n\n\nStep three.\n";
  const prompt = generatePrompt(answers);
  assertStringIncludes(
    prompt,
    "## strategy.disease_steps\n\nStep one.\n\nStep two.\n\nStep three.\n\n## ",
  );
});

Deno.test("a pipe in a README trait cell is escaped rather than ending the cell", () => {
  const answers = structuredClone(EXAMPLEITIS);
  answers.vocabulary.traits[0].name = "Left | right";
  assertStringIncludes(generateReadme(answers), "Left \\| right");
});
