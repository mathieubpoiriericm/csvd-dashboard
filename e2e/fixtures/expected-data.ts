/**
 * Counts derived from the committed data/*.json. Regenerating the data can
 * legitimately change every number here — verify the data is correct, then
 * update this file. It is the only place the map and About-page totals used
 * by map.spec.ts and about.spec.ts appear — other specs (genes-filters.spec.ts,
 * genes-table.spec.ts) still declare their own `TOTAL` and are out of scope
 * here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The GWAS trait vocabulary, read rather than restated. `lib/vocabulary.json`
 * is the single source of truth that `GWAS_TRAIT_CHOICES` and both phenogram
 * renderers derive from; a literal here would be one more copy of the list to
 * drift. The assertions still prove something: they check the rendered DOM,
 * so they fail if a vocabulary change does not reach the browser.
 */
const vocabulary = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "lib", "vocabulary.json"), "utf8"),
) as { traits: { key: string }[] };

export const TRAIT_COUNT = vocabulary.traits.length;

export const EXPECTED = {
  genes: 79,
  drugs: 65,
  trials: 82,
  publications: 111,
  mapSites: 378,
  mapSitesShown: 173,
  mapCountries: 23,
  mapTrials: 69,
} as const;
