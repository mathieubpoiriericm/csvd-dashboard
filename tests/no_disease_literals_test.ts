/**
 * No disease term survives in the web code outside disease/.
 *
 * The terms are the manifest's own, so a fork's test scans for *its*
 * disease. Every hit not on the allow-list fails, comments included: a
 * comment naming "the SVD rim" is reworded rather than listed.
 *
 * The monogenic gene symbols live in disease/pipeline.json, not the web
 * manifest -- `lib/disease/manifest.ts`'s `DiseaseManifest` carries no
 * `monogenicGenes` field, because that file is bundled into every island's
 * client chunk and gene symbols belong to the pipeline document instead. This
 * test reads them directly so the scan still covers every disease-specific
 * term.
 */
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";

import { manifest } from "../lib/disease.ts";

const ROOTS = ["lib", "routes", "islands", "components"];

// (path, regex source) → why it is allowed. The --svd- custom properties,
// the theme storage key and event, the session cookie and the filter
// panel's storage key are internal namespaces nobody reads. The
// csvd-protected-data(-dev)-boundary chunk names live in server/, which
// this test does not scan, and need no entry here.
const ALLOWED: ReadonlyArray<[RegExp, RegExp, string]> = [
  [/.*/, /--svd-[a-z0-9-]+/, "CSS custom-property namespace"],
  [
    /^lib\/theme\.ts$/,
    /"svd-theme"|"svd:themechange"/,
    "storage key and event name",
  ],
  [/^lib\/auth\.ts$/, /"svd_session"/, "session cookie name"],
  [/^components\/FilterPanel\.tsx$/, /"svd-filters-collapsed"/, "storage key"],
  [
    /^routes\/_app\.tsx$/,
    /--svd-nav/,
    "comment tying THEME_COLORS to the token",
  ],
];

const pipelineJson = JSON.parse(
  await Deno.readTextFile("disease/pipeline.json"),
);
const monogenicGenes: string[] = pipelineJson.monogenicGenes;

const terms = [
  manifest.disease.name,
  manifest.disease.abbreviation,
  manifest.disease.short,
  manifest.institute.name,
  manifest.institute.short,
  ...monogenicGenes,
];
const TERM = new RegExp(
  `\\b(${
    terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  })\\b`,
  "i",
);

Deno.test("no disease literal remains in lib/, routes/, islands/ or components/", async () => {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for await (
      const entry of walk(root, { exts: [".ts", ".tsx"], includeDirs: false })
    ) {
      const lines = (await Deno.readTextFile(entry.path)).split("\n");
      lines.forEach((line, i) => {
        if (!TERM.test(line)) return;
        const allowed = ALLOWED.some(([path, pat]) =>
          path.test(entry.path) && pat.test(line)
        );
        if (!allowed) hits.push(`${entry.path}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assertEquals(hits, []);
});
