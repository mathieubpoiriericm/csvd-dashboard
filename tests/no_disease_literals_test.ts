/**
 * No disease term survives in the web code outside disease/, nor in the
 * generic tests.
 *
 * The terms are the manifest's own, so a fork's test scans for *its*
 * disease. Every hit not on the allow-list fails, comments included: a
 * comment naming "the SVD rim" is reworded rather than listed.
 *
 * Two scans for the manifest's terms. The web code (lib/, routes/, islands/,
 * components/) is scanned everywhere. The tests -- tests/ and the whole e2e/ tree, its
 * helpers, config, screenshot and perf scripts included -- are scanned only
 * where the csvd/ trees are: that scan exists to keep the upstream disease's
 * tests inside them. A fork has deleted those trees, and the generic tests it
 * inherits name their own example disease on purpose (the adapt wizard's
 * tests type one in), which is the disease the wizard's check builds its
 * fork for -- so there the scan is ignored rather than run.
 *
 * The trait vocabulary (disease/vocabulary.json) and the trial populations
 * (the manifest's `populations`) are scanned for as well, in the web code
 * and in the generic tests, and only where the csvd/ trees are, for a second
 * reason: a fork's traits and populations are free text, whatever its
 * curators typed into the wizard, and one of them may be an ordinary word the
 * code uses for something else.
 *
 * The rest of the TypeScript -- server/, scripts/ and the .ts and .tsx files
 * at the root -- is scanned for all three, and only upstream too: the fork
 * check's own script names the example disease it builds a fork for, and a
 * fork's leak sentinels in server/protected_data_build.ts are its own data
 * strings.
 *
 * The monogenic gene symbols live in disease/pipeline.json, not the web
 * manifest -- `lib/disease/manifest.ts`'s `DiseaseManifest` carries no
 * `monogenicGenes` field, because that file is bundled into every island's
 * client chunk and gene symbols belong to the pipeline document instead. This
 * test reads them directly so the scan still covers every disease-specific
 * term.
 */
import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";

import { manifest } from "../lib/disease.ts";

// The web code, scanned for the manifest's terms everywhere.
const ROOTS = ["lib", "routes", "islands", "components"];
// The upstream-only code (see the header): these directories, walked whole,
// and the .ts and .tsx files at the root (main.ts, utils.ts, ...), which are
// not.
const UPSTREAM_ROOTS = ["server", "scripts"];
const CODE_EXTS = [".ts", ".tsx"];

// The generic test trees. tests/pipeline and tests/scripts are Python trees
// with their own scanner, the csvd/ trees are where a test that names the
// disease belongs, this file names terms in its own self-test, and the rest
// is installed or generated (the gitignored e2e/ output directories). Each
// pattern is anchored at the start of the path and also matches the
// directory itself, so walk() does not descend into it.
const TEST_ROOTS = ["tests", "e2e"];
const TEST_EXTS = [".ts", ".tsx", ".mjs"];
const TEST_SKIPS = [
  /^tests\/csvd(\/|$)/,
  /^tests\/pipeline(\/|$)/,
  /^tests\/scripts(\/|$)/,
  /^tests\/no_disease_literals_test\.ts$/,
  /^e2e\/tests\/csvd(\/|$)/,
  /^e2e\/node_modules(\/|$)/,
  /^e2e\/test-results(\/|$)/,
  /^e2e\/playwright-report(\/|$)/,
  /^e2e\/\.auth(\/|$)/,
  /^e2e\/perf\/artifacts(\/|$)/,
];

// The test scan runs only where a csvd/ tree is (see the header). Checked at
// load so a fork reports the test as ignored rather than passing it empty.
function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
const HAS_CSVD_TREE = isDirectory("tests/csvd") ||
  isDirectory("e2e/tests/csvd");

// (path, regex source) -> why it is allowed. The abbreviation and the short
// form match as written, so the lower-case `svd` namespaces -- the --svd-
// custom properties, the theme and draft storage keys, the session cookie
// -- never match and need no entry. An entry here is for text that names a
// term for another reason; a fork adds its own the same way.
const ALLOWED: ReadonlyArray<[RegExp, RegExp, string]> = [
  [
    /^components\/adapt\/steps\/MonogenicStep\.tsx$/,
    /Inheritance \(AD, AR, XL…\)/,
    "OMIM's inheritance codes (autosomal dominant, ...), not a disease",
  ],
  [
    /^server\/protected_data_build\.ts$/,
    /"COL4A1\/2",/,
    "a leak canary: the build fails if this upstream data string reaches a " +
    'public chunk (root CLAUDE.md, "The disease seam")',
  ],
];

const pipelineJson = JSON.parse(
  await Deno.readTextFile("disease/pipeline.json"),
);
const monogenicGenes: string[] = pipelineJson.monogenicGenes;
const geneAliases: Record<string, string[]> = pipelineJson.geneAliases ?? {};

/** A character a word is made of, in any script. */
const WORD = String.raw`[\p{L}\p{M}\p{N}_]`;

/**
 * Whole-word matching of `terms`. The boundaries know every script: `\b`
 * counts only ASCII letters, so a term starting or ending in one it does
 * not know ("Charité", "β-thalassemia") could never match.
 */
function wholeWords(terms: readonly string[], flags = ""): RegExp {
  // Longest first: alternation takes the first alternative that matches at
  // a position, and a trait key can begin with another ("WMH" and
  // "WMH-cortical-atrophy").
  const alternatives = [...new Set(terms.map((term) => term.trim()))]
    .filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  // An empty alternation would match every line.
  if (alternatives.length === 0) return /(?!)/;
  return new RegExp(
    `(?<!${WORD})(?:${alternatives.join("|")})(?!${WORD})`,
    `u${flags}`,
  );
}

/**
 * Whether a line names one of the disease's terms. A name is prose and
 * matches in any case; an abbreviation, a short form or a gene symbol is an
 * identifier whose case is its meaning -- "PD" is not pandas' `pd`, "APP"
 * not "the app", "MS" not a delay in milliseconds -- so it matches as
 * written.
 */
function termFinder(
  caseless: readonly string[],
  exact: readonly string[],
): (line: string) => boolean {
  const loose = wholeWords(caseless, "i");
  const strict = wholeWords(exact);
  return (line) => loose.test(line) || strict.test(line);
}

/** Terms matched in any case, and terms matched as written. */
type Terms = { caseless: readonly string[]; exact: readonly string[] };

const MANIFEST_TERMS: Terms = {
  caseless: [manifest.disease.name, manifest.institute.name],
  exact: [
    manifest.disease.abbreviation,
    manifest.disease.short,
    manifest.institute.short,
    ...monogenicGenes,
    ...Object.keys(geneAliases),
    ...Object.values(geneAliases).flat(),
  ],
};

/**
 * One all-lower-case word: something the code may say for another reason.
 * The vocabulary holds a trait keyed `stroke`, and SVG has an attribute of
 * that name on a hundred lines of the renderers. A key with a capital, a
 * digit, a hyphen or a space is an identifier, and that is what is scanned
 * for.
 */
function isOrdinaryWord(term: string): boolean {
  return /^\p{L}+$/u.test(term) && /\p{Ll}/u.test(term) &&
    !/[\p{Lu}\p{Lt}]/u.test(term);
}

type Vocabulary = {
  traits?: { key: string; label: string; name: string }[];
  synonyms?: { from: string; to: string }[];
  untracked?: { term: string }[];
};

/**
 * The trait vocabulary's terms. A trait's key and label, a synonym's two
 * spellings and an untracked term are identifiers; a trait's spelled-out
 * name is prose, and only a name of several words is distinctive enough to
 * scan for in any case.
 */
function vocabularyTerms(vocabulary: Vocabulary): Terms {
  const traits = vocabulary.traits ?? [];
  const exact = new Set([
    ...traits.flatMap((trait) => [trait.key, trait.label]),
    ...(vocabulary.synonyms ?? []).flatMap((synonym) => [
      synonym.from,
      synonym.to,
    ]),
    ...(vocabulary.untracked ?? []).map((entry) => entry.term),
  ]);
  const names = new Set(
    traits.map((trait) => trait.name).filter((name) =>
      name.trim().includes(" ")
    ),
  );
  // A name that is also a key or label stays caseless: matched in any case,
  // it finds the as-written spelling too.
  return {
    caseless: [...names].sort(),
    exact: [...exact].filter((term) =>
      !names.has(term) && !isOrdinaryWord(term)
    )
      .sort(),
  };
}

/**
 * The trial populations' terms: each population's key and label, as
 * written, an ordinary word aside, as a trait's are.
 */
function populationTerms(
  populations: readonly { key: string; label: string }[],
): Terms {
  const exact = new Set(populations.flatMap((p) => [p.key, p.label]));
  return {
    caseless: [],
    exact: [...exact].filter((term) => !isOrdinaryWord(term)).sort(),
  };
}

const VOCABULARY_TERMS = vocabularyTerms(
  JSON.parse(await Deno.readTextFile("disease/vocabulary.json")),
);
const POPULATION_TERMS = populationTerms(
  JSON.parse(await Deno.readTextFile("disease/manifest.json")).populations ??
    [],
);

/** One finder over the union of several term lists. */
function finderOf(...lists: Terms[]): (line: string) => boolean {
  return termFinder(
    lists.flatMap((terms) => terms.caseless),
    lists.flatMap((terms) => terms.exact),
  );
}

const namesTerm = finderOf(MANIFEST_TERMS);
/** The terms scanned for only where the csvd/ trees are (see the header). */
const namesTraitOrPopulation = finderOf(VOCABULARY_TERMS, POPULATION_TERMS);
const namesAny = finderOf(MANIFEST_TERMS, VOCABULARY_TERMS, POPULATION_TERMS);

Deno.test("the term finder matches names in any case and identifiers as written", () => {
  const find = termFinder(["Paris Brain Institute"], ["PD", "APP", "MS"]);
  assert(!find("import pandas as pd"));
  assert(!find("the Shiny app, and App itself"));
  assert(!find("const ms = 350;"));
  assert(find("APP processing"));
  assert(find("in MS lesions"));
  assert(find("the paris brain institute"));
  // Word boundaries in every script.
  const accented = termFinder(["Charité"], ["β-thalassemia"]);
  assert(accented("Built for the Charité dashboard"));
  assert(accented("a β-thalassemia cohort"));
  assert(!accented("Charités"));
  const upstream = termFinder([], ["cSVD", "SVD"]);
  for (const line of ["SVDPMIDTOKEN", "_svd_started", "cSVDs", "--svd-nav"]) {
    assert(!upstream(line), line);
  }
  assert(upstream("the SVD rim"));
  assert(!termFinder([], [])("anything"));
});

Deno.test("an ordinary word is not a vocabulary term to scan for", () => {
  assert(isOrdinaryWord("stroke"));
  for (
    const identifier of ["Stroke", "WMH", "lacunar stroke", "ICH-lobar", "t1"]
  ) {
    assert(!isOrdinaryWord(identifier), identifier);
  }
  const terms = vocabularyTerms({
    traits: [
      { key: "stroke", label: "Stroke", name: "Stroke" },
      { key: "WMH", label: "WMH", name: "White matter hyperintensities" },
    ],
    synonyms: [{ from: "small vessel stroke", to: "WMH" }],
    untracked: [{ term: "WMH-cortical-atrophy" }],
  });
  assertEquals(terms.caseless, ["White matter hyperintensities"]);
  assertEquals(terms.exact, [
    "Stroke",
    "WMH",
    "WMH-cortical-atrophy",
    "small vessel stroke",
  ]);
  // Longest first, so a key another begins with does not shadow it.
  const find = finderOf(terms);
  assert(!find('<path stroke="currentColor" />'));
  assert(find("the WMH-cortical-atrophy term"));
  assertEquals(
    wholeWords(terms.exact).exec("the WMH-cortical-atrophy term")?.[0],
    "WMH-cortical-atrophy",
  );
  // A term ending in a bracket is matched whole before a quote or a comma.
  const bracketed = finderOf(vocabularyTerms({
    traits: [{ key: "MTAG (all X, Y)", label: "MTAG (all X, Y)", name: "M" }],
  }));
  assert(bracketed('const key = "MTAG (all X, Y)";'));
  assert(bracketed("MTAG (all X, Y), then the rest"));
  assert(!bracketed("MTAG (all X, Y)Z"));
  // A several-word name that is also a label is found in another case too.
  const named = vocabularyTerms({
    traits: [{
      key: "lacunar stroke",
      label: "Lacunar stroke",
      name: "Lacunar stroke",
    }],
  });
  assertEquals(named.caseless, ["Lacunar stroke"]);
  assertEquals(named.exact, ["lacunar stroke"]);
  assert(finderOf(named)("a LACUNAR STROKE cohort"));
});

Deno.test("a population's key and label are scanned for as written", () => {
  const terms = populationTerms([
    { key: "CAA", label: "CAA" },
    { key: "Cognitive Impairment", label: "Cognitive Impairment" },
    { key: "stroke", label: "Stroke" },
  ]);
  assertEquals(terms.exact, ["CAA", "Cognitive Impairment", "Stroke"]);
  const find = finderOf(terms);
  assert(find("emitted for CAA"));
  assert(!find("cognitive impairment, in prose"));
  assert(!find('<path stroke="currentColor" />'));
});

/**
 * Every .ts and .tsx file under `roots`, sorted so a hit prints at the same
 * place every run -- walk() yields in directory order, which the filesystem
 * decides.
 */
async function codeFiles(
  roots: readonly string[],
  { rootLevel = false } = {},
): Promise<string[]> {
  const entries = rootLevel
    ? await Array.fromAsync(
      walk(".", { maxDepth: 1, exts: CODE_EXTS, includeDirs: false }),
    )
    : [];
  for (const root of roots) {
    entries.push(
      ...await Array.fromAsync(
        walk(root, { exts: CODE_EXTS, includeDirs: false }),
      ),
    );
  }
  return entries.map((entry) => entry.path).sort((a, b) => a.localeCompare(b));
}
const webCodeFiles = () => codeFiles(ROOTS);
const upstreamCodeFiles = () => codeFiles(UPSTREAM_ROOTS, { rootLevel: true });

/** Every generic test file, sorted as `webCodeFiles` sorts. */
async function testFiles(): Promise<string[]> {
  const paths: string[] = [];
  for (const root of TEST_ROOTS) {
    for await (
      const entry of walk(root, {
        exts: TEST_EXTS,
        includeDirs: false,
        skip: TEST_SKIPS,
      })
    ) paths.push(entry.path);
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

/** Every line of `files` that `find` flags and ALLOWED does not excuse. */
async function hitsIn(
  files: readonly string[],
  find: (line: string) => boolean,
): Promise<string[]> {
  const hits: string[] = [];
  for (const file of files) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    lines.forEach((line, i) => {
      if (!find(line)) return;
      const allowed = ALLOWED.some(([path, pat]) =>
        path.test(file) && pat.test(line)
      );
      if (!allowed) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

Deno.test("no disease literal remains in lib/, routes/, islands/ or components/", async () => {
  const hits = await hitsIn(await webCodeFiles(), namesTerm);
  assertEquals(
    hits,
    [],
    "Reword each line so it names no term of the disease, or, when the text " +
      "means something else (a code, a quoted measurement), add an entry to " +
      "ALLOWED in tests/no_disease_literals_test.ts: the path, a pattern for " +
      "the line and the reason.",
  );
});

Deno.test({
  name:
    "no trait of the vocabulary or trial population remains in lib/, routes/, islands/ or components/",
  ignore: !HAS_CSVD_TREE,
  fn: async () => {
    assertEquals(
      await hitsIn(await webCodeFiles(), namesTraitOrPopulation),
      [],
      "Reword each line so it names no trait of disease/vocabulary.json and " +
        "no population of disease/manifest.json, or read it from the file. When the text quotes a " +
        "measurement or an incident that the name is part of, add an entry " +
        "to ALLOWED in tests/no_disease_literals_test.ts: the path, a " +
        "pattern for the line and the reason.",
    );
  },
});

Deno.test({
  name:
    "no disease literal, trait or trial population remains in server/, scripts/ or the root-level files",
  ignore: !HAS_CSVD_TREE,
  fn: async () => {
    assertEquals(
      await hitsIn(await upstreamCodeFiles(), namesAny),
      [],
      "Reword each line so it names no term of the disease, no trait of " +
        "disease/vocabulary.json and no population of disease/manifest.json; " +
        "when the text means something else (a leak canary, a quoted " +
        "measurement), add an entry to ALLOWED in " +
        "tests/no_disease_literals_test.ts: the path, a pattern for the line " +
        "and the reason.",
    );
  },
});

Deno.test({
  name: "no disease literal remains in the generic test trees",
  ignore: !HAS_CSVD_TREE,
  fn: async () => {
    const hits = await hitsIn(await testFiles(), namesAny);
    assertEquals(
      hits,
      [],
      "A test that has to name the disease belongs in a csvd/ tree (tests/csvd " +
        "or e2e/tests/csvd), which a fork deletes. Otherwise use a placeholder " +
        "(GENE1, Protein 1, TRAIT-A), derive the value from the manifest, the " +
        "vocabulary or the data, or " +
        "reword the comment so it names no term; when the text means something " +
        "else, add an entry to ALLOWED in tests/no_disease_literals_test.ts: " +
        "the path, a pattern for the line and the reason.",
    );
  },
});

/**
 * Whether an ALLOWED path pattern names a file only an upstream scan reads:
 * one under the test roots or the upstream-only roots, or a root-level file
 * (a pattern with no directory in it).
 */
function upstreamOnly(path: RegExp): boolean {
  return [...TEST_ROOTS, ...UPSTREAM_ROOTS].some((root) =>
    path.source.startsWith(`^${root}\\/`)
  ) || !path.source.includes("\\/");
}

Deno.test("an ALLOWED path is upstream-only by its root", () => {
  assert(upstreamOnly(/^server\/protected_data_build\.ts$/));
  assert(upstreamOnly(/^e2e\/helpers\.ts$/));
  assert(upstreamOnly(/^main\.ts$/));
  assert(!upstreamOnly(/^components\/adapt\/steps\/MonogenicStep\.tsx$/));
});

Deno.test("every ALLOWED entry still names a line it excuses", async () => {
  const files = [
    ...await webCodeFiles(),
    ...await upstreamCodeFiles(),
    ...await testFiles(),
  ];
  for (const [path, pattern, reason] of ALLOWED) {
    // Without the csvd/ trees the scan an upstream-only entry serves does not
    // run, and a fork edits what it names.
    if (!HAS_CSVD_TREE && upstreamOnly(path)) continue;
    let found = false;
    for (const file of files.filter((file) => path.test(file))) {
      const text = await Deno.readTextFile(file);
      if (text.split("\n").some((line) => pattern.test(line))) found = true;
    }
    assert(found, `no line matches ${pattern} (${reason})`);
  }
});
