/**
 * What the perf scenarios derive from the committed data, and when a
 * scenario is skipped. Playwright-free on purpose: `deno task test:perf`
 * runs in CI's check job, which installs no e2e/node_modules, so the tests
 * import this module and never scenarios.mjs.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * What the suite expects of the committed data, from
 * e2e/fixtures/expected.deno.ts: derived by the app's own lib/ under Deno,
 * because Node cannot import its JSON-attributed modules. Read once, when
 * the module loads, so no measured interaction pays for it.
 */
export const EXPECTED = JSON.parse(
  execFileSync(
    "deno",
    [
      "run",
      "-A",
      fileURLToPath(new URL("../fixtures/expected.deno.ts", import.meta.url)),
    ],
    { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" },
  ),
);

/**
 * The inputs the data-derived scenarios type and tick, each null when the
 * data cannot supply one: the gene search query (a symbol's first five
 * characters, one row's), the trial search query (a drug name, one shown
 * row's) and the GWAS trait the genes filter-toggle ticks (the one most genes
 * carry, else the first the page offers).
 */
export function deriveInputs(expected) {
  return {
    geneSearch: expected.search.genes,
    trialSearch: expected.search.trials,
    toggledTrait:
      (expected.genes.topTraits[0] ?? expected.genes.traits[0])?.label ?? null,
  };
}

/**
 * The derived inputs, recorded in the run's metadata: a scenario's numbers
 * compare across runs only where these are the same.
 */
export const DERIVED_INPUTS = deriveInputs(EXPECTED);

/** Which derived input each data-derived scenario needs, and why it is skipped without it. */
export const SCENARIO_INPUTS = {
  "genes/search": "geneSearch",
  "genes/search-100": "geneSearch",
  "trials/search": "trialSearch",
  "trials/search-100": "trialSearch",
  "genes/filter-toggle": "toggledTrait",
};
const MISSING = {
  geneSearch: "no gene row holds a query of its own",
  trialSearch: "no shown trial row holds a query of its own",
  toggledTrait: "the GWAS group offers no trait",
};

/**
 * What a scenario with this `id` adds to itself: `{ unavailable }` when the
 * input it needs is missing from `inputs`, else nothing.
 */
export function availability(id, inputs = DERIVED_INPUTS) {
  const input = SCENARIO_INPUTS[id];
  return input !== undefined && inputs[input] === null
    ? { unavailable: MISSING[input] }
    : {};
}

/**
 * Why `scenario` cannot run on any page, or null: a scenario whose data the
 * committed rows cannot supply says why in `unavailable`, and is skipped
 * without loading a page.
 */
export function unavailableReason(scenario) {
  return scenario.unavailable ?? null;
}

/**
 * Why `scenario` cannot run on the page as loaded, or null: its
 * `unavailable` reason, or, for a scenario that names an element it `needs`,
 * this reason rather than a timeout when the page renders none.
 */
export async function skipReason(page, scenario) {
  const unavailable = unavailableReason(scenario);
  if (unavailable) return unavailable;
  if (!scenario.needs) return null;
  return await page.locator(scenario.needs).count() === 0
    ? `no ${scenario.needs}: ${scenario.missingBecause}`
    : null;
}
