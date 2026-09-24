import { expect, test } from "@playwright/test";
import {
  choice,
  expectRowCount,
  expectSummary,
  filterCount,
  filterGroup,
} from "../helpers.ts";
import {
  EXPECTED,
  POPULATION_LABEL,
  STATUS_SUMMARY,
  TRIAL_SHOWN,
  TRIAL_TOTAL,
} from "../fixtures/expected-data.ts";

/**
 * The sidebar legend and the filter banner name each group with the same
 * string (F57) — the constants below are shared between the two.
 *
 * As on the genes page the banner prints choice labels, so the registry
 * option labelled "ClinicalTrials.gov (NCT)" reports as that label, not the
 * wire value "NCT". Every count and every population comes from `EXPECTED`,
 * derived from the committed data and the manifest.
 */
const EVIDENCE = "Genetic evidence";
const REGISTRY = "Clinical Trial Registry";
const PHASE = "Clinical Trial Phase";
const POPULATION = POPULATION_LABEL;
const SPONSOR = "Sponsor Type";
const STATUS = "Study status";

const T = EXPECTED.trials;

/**
 * The status group starts constrained (every status but Completed), so its
 * summary fragment rides along in the banner whenever any other group is
 * also active -- it is always last, since `statuses` is the last key in
 * `FILTERS`.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/trials");
});

test("starts with completed trials hidden", async ({ page }) => {
  await expectSummary(page, STATUS_SUMMARY);
  await expectRowCount(page, TRIAL_SHOWN, TRIAL_TOTAL);
  for (const group of [EVIDENCE, REGISTRY, PHASE, POPULATION, SPONSOR]) {
    await expect(filterCount(page, group)).toHaveText("All");
  }
  await expect(filterCount(page, STATUS)).toHaveText(
    String(EXPECTED.defaultStatusLabels.length),
  );
});

test("the genetic-evidence binary group constrains at one selection", async ({ page }) => {
  await choice(page, EVIDENCE, "No").uncheck();
  await expectRowCount(page, T.evidenceYes, TRIAL_TOTAL);
  await expectSummary(page, `Genetic evidence: Yes | ${STATUS_SUMMARY}`);

  await choice(page, EVIDENCE, "No").check();
  await choice(page, EVIDENCE, "Yes").uncheck();
  await expectRowCount(page, T.evidenceNo, TRIAL_TOTAL);
  await expectSummary(page, `Genetic evidence: No | ${STATUS_SUMMARY}`);
});

/** The registry is derived from the ID prefix, not stored as its own column. */
test("registry filtering keys off the ID prefix", async ({ page }) => {
  for (const registry of T.registries) {
    await choice(page, REGISTRY, registry.label).check();
    await expectRowCount(page, registry.shown, TRIAL_TOTAL);
    await expectSummary(
      page,
      `Clinical Trial Registry: ${registry.label} | ${STATUS_SUMMARY}`,
    );
    await choice(page, REGISTRY, registry.label).uncheck();
  }

  test.skip(T.registryUnion === null, "fewer than two registries have rows");
  const [first, second] = T.registries;
  await choice(page, REGISTRY, first.label).check();
  await choice(page, REGISTRY, second.label).check();
  await expectRowCount(page, T.registryUnion!, TRIAL_TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Registry: ${first.label}, ${second.label} | ${STATUS_SUMMARY}`,
  );
});

/**
 * Phases are tokenized rather than substring-matched, so "I" must not also
 * select the Phase II and Phase III trials -- and a seamless "I/II" design
 * genuinely covers phase I, so it counts there too. The counts are the
 * tokenized rule's own over the committed rows.
 */
test("phase I does not match phase II or III", async ({ page }) => {
  const [one, two, three] = T.phases;
  await choice(page, PHASE, one.label).check();
  await expectRowCount(page, one.shown, TRIAL_TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Phase: ${one.label} | ${STATUS_SUMMARY}`,
  );

  await choice(page, PHASE, one.label).uncheck();
  await choice(page, PHASE, two.label).check();
  await expectRowCount(page, two.shown, TRIAL_TOTAL);

  test.skip(T.phaseUnion === null, "phase II or III has no rows");
  await choice(page, PHASE, three.label).check();
  await expectRowCount(page, T.phaseUnion!, TRIAL_TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Phase: ${two.label}, ${three.label} | ${STATUS_SUMMARY}`,
  );
});

test("population filtering", async ({ page }) => {
  for (const population of T.populations) {
    await choice(page, POPULATION, population.label).check();
    await expectRowCount(page, population.shown, TRIAL_TOTAL);
    await expectSummary(
      page,
      `${POPULATION}: ${population.label} | ${STATUS_SUMMARY}`,
    );
    await choice(page, POPULATION, population.label).uncheck();
  }
});

/**
 * Industry matches its named subtypes by prefix. Academic is exact after the
 * data-boundary whitespace normalization.
 */
test("sponsor filtering handles industry subtypes", async ({ page }) => {
  const [academic, industry] = T.sponsors;
  await choice(page, SPONSOR, academic.label).check();
  await expectRowCount(page, academic.shown, TRIAL_TOTAL);
  await expectSummary(
    page,
    `Sponsor Type: ${academic.label} | ${STATUS_SUMMARY}`,
  );

  await choice(page, SPONSOR, academic.label).uncheck();
  await choice(page, SPONSOR, industry.label).check();
  await expectRowCount(page, industry.shown, TRIAL_TOTAL);
});

test("groups intersect", async ({ page }) => {
  test.skip(!T.registryPhase, "no registry and phase both have rows");
  const { registry, phase, shown } = T.registryPhase!;
  await choice(page, REGISTRY, registry.label).check();
  await choice(page, PHASE, phase.label).check();
  await expectRowCount(page, shown, TRIAL_TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Registry: ${registry.label} | Clinical Trial Phase: ${phase.label} | ${STATUS_SUMMARY}`,
  );
});

test("impossible combinations show the empty state", async ({ page }) => {
  // Data-derived: a phase and a population that each have rows but none in
  // common.
  test.skip(!T.impossible, "every phase meets every population");
  const { phase, population } = T.impossible!;
  await choice(page, PHASE, phase.label).check();
  await choice(page, POPULATION, population.label).check();
  await expectRowCount(page, 0, TRIAL_TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Phase: ${phase.label} | ${POPULATION}: ${population.label} | ${STATUS_SUMMARY}`,
  );
});

test("ticking Show All in the status group lifts the default Completed filter", async ({ page }) => {
  await choice(page, STATUS, "Show All").check();
  await expectRowCount(page, TRIAL_TOTAL, TRIAL_TOTAL);
});

test("unticking every status but Completed shows only completed trials", async ({ page }) => {
  await choice(page, STATUS, "Completed").check();
  for (const label of EXPECTED.defaultStatusLabels) {
    await choice(page, STATUS, label).uncheck();
  }
  await expectRowCount(page, TRIAL_TOTAL - TRIAL_SHOWN, TRIAL_TOTAL);
});

test("clearing all filters restores every group and the search together", async ({ page }) => {
  const registry = T.registries[0];
  const phase = T.phases[1];
  const population = T.populations[0];
  const sponsor = T.sponsors[0];
  await choice(page, EVIDENCE, "No").uncheck();
  await choice(page, REGISTRY, registry.label).check();
  await choice(page, PHASE, phase.label).check();
  await choice(page, POPULATION, population.label).check();
  await choice(page, SPONSOR, sponsor.label).check();
  const search = page.getByRole("searchbox", { name: "Search trials" });
  await search.fill("zzznomatch");
  await expect(page.locator(".filter-message")).toContainText(
    "Search: “zzznomatch”",
  );

  await page.getByRole("button", { name: "Clear all filters" }).click();

  // `reset` returns every group to its seeded default, and the status
  // group's default is "every status but Completed" -- the summary reads
  // that line, not "None".
  await expectSummary(page, STATUS_SUMMARY);
  await expectRowCount(page, TRIAL_SHOWN, TRIAL_TOTAL);
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  for (const label of ["Yes", "No"]) {
    await expect(choice(page, EVIDENCE, label)).toBeChecked();
  }
  for (const group of [REGISTRY, PHASE, POPULATION, SPONSOR]) {
    await expect(choice(page, group, "Show All")).toBeChecked();
    await expect(
      filterGroup(page, group).getByRole("checkbox", {
        checked: true,
      }),
    ).toHaveCount(1);
  }
  await expect(choice(page, STATUS, "Show All")).not.toBeChecked();
  await expect(
    filterGroup(page, STATUS).getByRole("checkbox", { checked: true }),
  ).toHaveCount(EXPECTED.defaultStatusLabels.length);

  const first = T.phases[0];
  await choice(page, PHASE, first.label).check();
  await expectRowCount(page, first.shown, TRIAL_TOTAL);
});

test("every group renders its full choice list", async ({ page }) => {
  await expect(filterGroup(page, EVIDENCE).getByRole("checkbox")).toHaveCount(
    2,
  );
  await expect(filterGroup(page, REGISTRY).getByRole("checkbox")).toHaveCount(
    T.registries.length + 1,
  );
  await expect(filterGroup(page, PHASE).getByRole("checkbox")).toHaveCount(
    T.phases.length + 1,
  );
  await expect(filterGroup(page, POPULATION).getByRole("checkbox")).toHaveCount(
    T.populations.length + 1,
  );
  await expect(filterGroup(page, SPONSOR).getByRole("checkbox")).toHaveCount(
    T.sponsors.length + 1,
  );
  await expect(filterGroup(page, STATUS).getByRole("checkbox")).toHaveCount(
    EXPECTED.statusChoiceCount,
  );
});
