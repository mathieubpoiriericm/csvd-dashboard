import { expect, test } from "@playwright/test";
import {
  choice,
  expectRowCount,
  expectSummary,
  filterCount,
  filterGroup,
} from "../helpers.ts";

const TOTAL = 102;
/** Default-visible rows: every status but Completed (35 of 102 hidden). */
const SHOWN = 67;

/**
 * The sidebar legend and the filter banner name each group with the same
 * string (F57) — the constants below are shared between the two.
 *
 * As on the genes page the banner prints choice labels, so the registry
 * option labelled "ClinicalTrials.gov (NCT)" reports as that label, not the
 * wire value "NCT".
 */
const EVIDENCE = "Genetic evidence";
const REGISTRY = "Clinical Trial Registry";
const PHASE = "Clinical Trial Phase";
const POPULATION = "SVD Population";
const SPONSOR = "Sponsor Type";
const STATUS = "Study status";

/**
 * The status group starts constrained (every status but Completed), so its
 * summary fragment rides along in the banner whenever any other group is
 * also active -- it is always last, since `statuses` is the last key in
 * `FILTERS`.
 */
const STATUS_SUMMARY =
  "Study status: Recruiting, Enrolling by Invitation, Active (not recruiting), Not Yet Recruiting, Suspended, Unknown";

const NCT = "ClinicalTrials.gov (NCT)";
const ISRCTN =
  "International Standard Randomised Controlled Trial Number (ISRCTN)";
const CHICTR = "Chinese Clinical Trial Register (ChiCTR)";
const ACTRN = "Australian New Zealand Clinical Trials Registry (ANZCTR)";

test.beforeEach(async ({ page }) => {
  await page.goto("/trials");
});

test("starts with completed trials hidden", async ({ page }) => {
  await expectSummary(page, STATUS_SUMMARY);
  await expectRowCount(page, SHOWN, TOTAL);
  for (const group of [EVIDENCE, REGISTRY, PHASE, POPULATION, SPONSOR]) {
    await expect(filterCount(page, group)).toHaveText("All");
  }
  await expect(filterCount(page, STATUS)).toHaveText("6");
});

test("the genetic-evidence binary group constrains at one selection", async ({ page }) => {
  await choice(page, EVIDENCE, "No").uncheck();
  await expectRowCount(page, 8, TOTAL);
  await expectSummary(page, `Genetic evidence: Yes | ${STATUS_SUMMARY}`);

  await choice(page, EVIDENCE, "No").check();
  await choice(page, EVIDENCE, "Yes").uncheck();
  await expectRowCount(page, 59, TOTAL);
  await expectSummary(page, `Genetic evidence: No | ${STATUS_SUMMARY}`);
});

/** The registry is derived from the ID prefix, not stored as its own column. */
test("registry filtering keys off the ID prefix", async ({ page }) => {
  const cases: Array<[string, string, number]> = [
    [NCT, "NCT", 59],
    [ISRCTN, "ISRCTN", 4],
    [CHICTR, "ChiCTR", 3],
    [ACTRN, "ACTRN", 1],
  ];

  for (const [label, , count] of cases) {
    await choice(page, REGISTRY, label).check();
    await expectRowCount(page, count, TOTAL);
    await expectSummary(
      page,
      `Clinical Trial Registry: ${label} | ${STATUS_SUMMARY}`,
    );
    await choice(page, REGISTRY, label).uncheck();
  }

  await choice(page, REGISTRY, NCT).check();
  await choice(page, REGISTRY, ISRCTN).check();
  await expectRowCount(page, 63, TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Registry: ${NCT}, ${ISRCTN} | ${STATUS_SUMMARY}`,
  );
});

/**
 * Phases are tokenized rather than substring-matched, so "I" must not also
 * select the 25 Phase II and 19 Phase III trials. Tokenizing is also why "I"
 * returns four rather than two: two trials are registered "I", and two more
 * are seamless "I/II", which genuinely cover phase I.
 */
test("phase I does not match phase II or III", async ({ page }) => {
  await choice(page, PHASE, "Phase I").check();
  await expectRowCount(page, 4, TOTAL);
  await expectSummary(page, `Clinical Trial Phase: Phase I | ${STATUS_SUMMARY}`);

  await choice(page, PHASE, "Phase I").uncheck();
  await choice(page, PHASE, "Phase II").check();
  await expectRowCount(page, 25, TOTAL);

  await choice(page, PHASE, "Phase III").check();
  await expectRowCount(page, 40, TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Phase: Phase II, Phase III | ${STATUS_SUMMARY}`,
  );
});

test("population filtering", async ({ page }) => {
  for (
    const [label, count] of [["Stroke", 21], ["CAA", 7], ["SVD", 23], [
      "Cognitive Impairment",
      16,
    ]] as const
  ) {
    await choice(page, POPULATION, label).check();
    await expectRowCount(page, count, TOTAL);
    await expectSummary(page, `SVD Population: ${label} | ${STATUS_SUMMARY}`);
    await choice(page, POPULATION, label).uncheck();
  }
});

/**
 * Industry matches its named subtypes by prefix. Academic is exact after the
 * data-boundary whitespace normalization.
 */
test("sponsor filtering handles industry subtypes", async ({ page }) => {
  await choice(page, SPONSOR, "Academic").check();
  await expectRowCount(page, 61, TOTAL);
  await expectSummary(page, `Sponsor Type: Academic | ${STATUS_SUMMARY}`);

  await choice(page, SPONSOR, "Academic").uncheck();
  await choice(page, SPONSOR, "Industry").check();
  await expectRowCount(page, 6, TOTAL);
});

test("groups intersect", async ({ page }) => {
  await choice(page, REGISTRY, NCT).check();
  await choice(page, PHASE, "Phase II").check();
  await expectRowCount(page, 22, TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Registry: ${NCT} | Clinical Trial Phase: Phase II | ${STATUS_SUMMARY}`,
  );
});

test("impossible combinations show the empty state", async ({ page }) => {
  // No CAA trial has reached phase IV. Phase I against CAA is no longer the
  // empty pair it was: one CAA trial is registered as a seamless I/II, and
  // tokenizing means it answers "Phase I".
  await choice(page, PHASE, "Phase IV").check();
  await choice(page, POPULATION, "CAA").check();
  await expectRowCount(page, 0, TOTAL);
  await expectSummary(
    page,
    `Clinical Trial Phase: Phase IV | SVD Population: CAA | ${STATUS_SUMMARY}`,
  );
});

test("ticking Show All in the status group lifts the default Completed filter", async ({ page }) => {
  await choice(page, STATUS, "Show All").check();
  await expectRowCount(page, TOTAL, TOTAL);
});

test("unticking every status but Completed shows only completed trials", async ({ page }) => {
  await choice(page, STATUS, "Completed").check();
  for (
    const label of [
      "Recruiting",
      "Enrolling by Invitation",
      "Active (not recruiting)",
      "Not Yet Recruiting",
      "Suspended",
      "Unknown",
    ]
  ) {
    await choice(page, STATUS, label).uncheck();
  }
  await expectRowCount(page, TOTAL - SHOWN, TOTAL);
});

test("clearing all filters restores every group and the search together", async ({ page }) => {
  await choice(page, EVIDENCE, "No").uncheck();
  await choice(page, REGISTRY, NCT).check();
  await choice(page, PHASE, "Phase II").check();
  await choice(page, POPULATION, "CAA").check();
  await choice(page, SPONSOR, "Academic").check();
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
  await expectRowCount(page, SHOWN, TOTAL);
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
  ).toHaveCount(6);

  await choice(page, PHASE, "Phase I").check();
  await expectRowCount(page, 4, TOTAL);
});

test("every group renders its full choice list", async ({ page }) => {
  await expect(filterGroup(page, EVIDENCE).getByRole("checkbox")).toHaveCount(
    2,
  );
  await expect(filterGroup(page, REGISTRY).getByRole("checkbox")).toHaveCount(
    5,
  );
  await expect(filterGroup(page, PHASE).getByRole("checkbox")).toHaveCount(6);
  await expect(filterGroup(page, POPULATION).getByRole("checkbox")).toHaveCount(
    5,
  );
  await expect(filterGroup(page, SPONSOR).getByRole("checkbox")).toHaveCount(3);
  await expect(filterGroup(page, STATUS).getByRole("checkbox")).toHaveCount(8);
});
