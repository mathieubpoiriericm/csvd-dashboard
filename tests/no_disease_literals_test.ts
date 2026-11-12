/**
 * No disease term survives in the web code outside disease/, nor in the
 * generic tests.
 *
 * The terms are the manifest's own, so a fork's test scans for *its*
 * disease. Every hit not on the allow-list fails, comments included: a
 * comment naming "the SVD rim" is reworded rather than listed.
 *
 * Two scans. The web code (lib/, routes/, islands/, components/) is scanned
 * everywhere. The tests -- tests/ and the whole e2e/ tree, its helpers,
 * config, screenshot and perf scripts included -- are scanned only where the
 * csvd/ trees are: that scan exists to keep the upstream disease's tests
 * inside them. A fork has deleted those trees, and the generic tests it
 * inherits name their own example disease on purpose (the adapt wizard's
 * tests type one in), which is the disease the wizard's check builds its
 * fork for -- so there the scan is ignored rather than run.
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

const ROOTS = ["lib", "routes", "islands", "components"];

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
  const alternatives = terms.map((term) => term.trim()).filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
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

const namesTerm = termFinder(
  [manifest.disease.name, manifest.institute.name],
  [
    manifest.disease.abbreviation,
    manifest.disease.short,
    manifest.institute.short,
    ...monogenicGenes,
    ...Object.keys(geneAliases),
    ...Object.values(geneAliases).flat(),
  ],
);

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

Deno.test("no disease literal remains in lib/, routes/, islands/ or components/", async () => {
  const hits: string[] = [];
  for (const root of ROOTS) {
    // Collected and sorted so a hit prints at the same place every run --
    // walk() yields in directory order, which the filesystem decides.
    const entries = await Array.fromAsync(
      walk(root, { exts: [".ts", ".tsx"], includeDirs: false }),
    );
    entries.sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of entries) {
      const lines = (await Deno.readTextFile(entry.path)).split("\n");
      lines.forEach((line, i) => {
        if (!namesTerm(line)) return;
        const allowed = ALLOWED.some(([path, pat]) =>
          path.test(entry.path) && pat.test(line)
        );
        if (!allowed) hits.push(`${entry.path}:${i + 1}: ${line.trim()}`);
      });
    }
  }
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
  name: "no disease literal remains in the generic test trees",
  ignore: !HAS_CSVD_TREE,
  fn: async () => {
    const hits: string[] = [];
    for (const root of TEST_ROOTS) {
      const entries = await Array.fromAsync(
        walk(root, {
          exts: TEST_EXTS,
          includeDirs: false,
          skip: TEST_SKIPS,
        }),
      );
      entries.sort((a, b) => a.path.localeCompare(b.path));
      for (const entry of entries) {
        const lines = (await Deno.readTextFile(entry.path)).split("\n");
        lines.forEach((line, i) => {
          if (!namesTerm(line)) return;
          const allowed = ALLOWED.some(([path, pat]) =>
            path.test(entry.path) && pat.test(line)
          );
          if (!allowed) hits.push(`${entry.path}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    assertEquals(
      hits,
      [],
      "A test that has to name the disease belongs in a csvd/ tree (tests/csvd " +
        "or e2e/tests/csvd), which a fork deletes. Otherwise use a placeholder " +
        "(GENE1, Protein 1), derive the value from the manifest or the data, or " +
        "reword the comment so it names no term; when the text means something " +
        "else, add an entry to ALLOWED in tests/no_disease_literals_test.ts: " +
        "the path, a pattern for the line and the reason.",
    );
  },
});

Deno.test("every ALLOWED entry still names a line it excuses", async () => {
  for (const [path, pattern, reason] of ALLOWED) {
    let found = false;
    for (const root of [...ROOTS, ...TEST_ROOTS]) {
      for await (
        const entry of walk(root, {
          exts: ROOTS.includes(root) ? [".ts", ".tsx"] : TEST_EXTS,
          includeDirs: false,
          skip: ROOTS.includes(root) ? undefined : TEST_SKIPS,
        })
      ) {
        if (!path.test(entry.path)) continue;
        const text = await Deno.readTextFile(entry.path);
        if (text.split("\n").some((line) => pattern.test(line))) found = true;
      }
    }
    assert(found, `no line matches ${pattern} (${reason})`);
  }
});
