// Imports inputs.mjs only, never scenarios.mjs: that imports @playwright/test,
// which CI's check job, where this runs, does not install.
import test from "node:test";
import assert from "node:assert/strict";
import {
  availability,
  DERIVED_INPUTS,
  deriveInputs,
  SCENARIO_INPUTS,
  skipReason,
  unavailableReason,
} from "./inputs.mjs";

/** A page whose every locator counts `count` and that records each lookup. */
function fakePage(count) {
  const looked = [];
  return {
    looked,
    locator(selector) {
      looked.push(selector);
      return { count: async () => count };
    },
  };
}

test("an unavailable scenario is skipped without asking the page", async () => {
  const scenario = { unavailable: "no gene row holds a query of its own" };
  assert.equal(unavailableReason(scenario), scenario.unavailable);
  const page = fakePage(1);
  assert.equal(await skipReason(page, scenario), scenario.unavailable);
  assert.deepEqual(page.looked, []);
});

test("unavailable outranks needs, which is asked only without it", async () => {
  const both = {
    unavailable: "no trait",
    needs: ".pipeline-card",
    missingBecause: "gold only",
  };
  assert.equal(await skipReason(fakePage(0), both), "no trait");
  const needsOnly = { needs: ".pipeline-card", missingBecause: "gold only" };
  assert.equal(unavailableReason(needsOnly), null);
  assert.equal(
    await skipReason(fakePage(0), needsOnly),
    "no .pipeline-card: gold only",
  );
  assert.equal(await skipReason(fakePage(1), needsOnly), null);
  assert.equal(await skipReason(fakePage(0), {}), null);
});

test("a data-derived scenario is unavailable exactly when its input is null", () => {
  const present = { geneSearch: "Q", trialSearch: "Q", toggledTrait: "T" };
  for (const [id, input] of Object.entries(SCENARIO_INPUTS)) {
    assert.ok(input in present, `${id}: ${input}`);
    assert.deepEqual(availability(id, present), {}, id);
    const missing = availability(id, { ...present, [input]: null });
    assert.equal(typeof missing.unavailable, "string", id);
    // Only its own input counts.
    for (const other of Object.keys(present)) {
      if (other === input) continue;
      assert.deepEqual(availability(id, { ...present, [other]: null }), {}, id);
    }
  }
  const allNull = { geneSearch: null, trialSearch: null, toggledTrait: null };
  assert.deepEqual(availability("genes/sort", allNull), {});
  // The loaded inputs: a string where the data supplies one, else null.
  for (const value of Object.values(DERIVED_INPUTS)) {
    assert.ok(value === null || typeof value === "string");
  }
});

test("the inputs are null where the data supplies none (the empty export)", () => {
  assert.deepEqual(
    deriveInputs({
      search: { genes: null, trials: null },
      genes: { topTraits: [], traits: [] },
    }),
    { geneSearch: null, trialSearch: null, toggledTrait: null },
  );
  assert.deepEqual(
    deriveInputs({
      search: { genes: "ABCDE", trials: "Examplumab" },
      genes: { topTraits: [], traits: [{ label: "TRAIT-A" }] },
    }),
    { geneSearch: "ABCDE", trialSearch: "Examplumab", toggledTrait: "TRAIT-A" },
  );
});
