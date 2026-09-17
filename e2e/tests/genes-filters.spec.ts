import { expect, test } from "@playwright/test";
import { TRAIT_COUNT } from "../fixtures/expected-data.ts";
import {
  choice,
  expectRowCount,
  expectSummary,
  filterCount,
  filterGroup,
} from "../helpers.ts";

const TOTAL = 79;

/**
 * The sidebar legend and the filter banner name each group with the same
 * string (F57) — the constants below are shared between the two.
 *
 * The banner prints each choice's label, not its wire value: the GWAS option
 * shown as "Extreme-cSVD" reports as "Extreme-cSVD", not "extreme-cSVD".
 */
const MR = "Mendelian randomization performed";
const GWAS = "GWAS Traits";
const OMICS = "Evidence From Other Omics Studies";

test.beforeEach(async ({ page }) => {
  await page.goto("/genes");
});

test("starts unconstrained with every group showing All", async ({ page }) => {
  await expectSummary(page, "None");
  await expectRowCount(page, TOTAL, TOTAL);
  for (const group of [MR, GWAS, OMICS]) {
    await expect(filterCount(page, group)).toHaveText("All");
  }
  // The binary group starts with both boxes ticked; the others with Show All.
  await expect(choice(page, MR, "Yes")).toBeChecked();
  await expect(choice(page, MR, "No")).toBeChecked();
  await expect(choice(page, GWAS, "Show All")).toBeChecked();
});

test("a binary group only constrains when exactly one box is ticked", async ({ page }) => {
  await choice(page, MR, "No").uncheck();
  await expectRowCount(page, 30, TOTAL);
  await expectSummary(page, "Mendelian randomization performed: Yes");
  await expect(filterCount(page, MR)).toHaveText("1");

  // Unticking the only remaining box re-checks both rather than emptying the
  // group, so getting to "No only" means going back through both.
  await choice(page, MR, "Yes").click();
  await expect(choice(page, MR, "No")).toBeChecked();
  await choice(page, MR, "Yes").uncheck();
  await expectRowCount(page, 49, TOTAL);
  await expectSummary(page, "Mendelian randomization performed: No");

  await choice(page, MR, "Yes").check();
  await expectRowCount(page, TOTAL, TOTAL);
  await expectSummary(page, "None");
});

test("a binary group can never be left matching nothing", async ({ page }) => {
  await choice(page, MR, "No").uncheck();
  // Clicking the last remaining box re-checks both rather than emptying the
  // group, so the table never collapses to zero rows. This is a click() and
  // not an uncheck(): the box ends up checked again, which uncheck() would
  // report as a failure to change state.
  await choice(page, MR, "Yes").click();

  await expect(choice(page, MR, "Yes")).toBeChecked();
  await expect(choice(page, MR, "No")).toBeChecked();
  await expect(filterCount(page, MR)).toHaveText("All");
  await expectRowCount(page, TOTAL, TOTAL);
});

test("picking a GWAS trait clears Show All and filters", async ({ page }) => {
  await choice(page, GWAS, "SVS").check();

  await expect(choice(page, GWAS, "Show All")).not.toBeChecked();
  await expect(filterCount(page, GWAS)).toHaveText("1");
  await expectRowCount(page, 13, TOTAL);
  await expectSummary(page, "GWAS Traits: SVS");
});

test("unticking the last GWAS trait snaps back to Show All", async ({ page }) => {
  await choice(page, GWAS, "SVS").check();
  await choice(page, GWAS, "SVS").uncheck();

  await expect(choice(page, GWAS, "Show All")).toBeChecked();
  await expect(filterCount(page, GWAS)).toHaveText("All");
  await expectRowCount(page, TOTAL, TOTAL);
  await expectSummary(page, "None");
});

test("ticking Show All clears the other choices", async ({ page }) => {
  await choice(page, GWAS, "SVS").check();
  await choice(page, GWAS, "WMH").check();
  await expect(filterCount(page, GWAS)).toHaveText("2");

  await choice(page, GWAS, "Show All").check();
  await expect(choice(page, GWAS, "SVS")).not.toBeChecked();
  await expect(choice(page, GWAS, "WMH")).not.toBeChecked();
  await expectRowCount(page, TOTAL, TOTAL);
});

test("choices within a group union", async ({ page }) => {
  await choice(page, GWAS, "WMH").check();
  await expectRowCount(page, 34, TOTAL);

  await choice(page, GWAS, "PSMD").check();
  await expectRowCount(page, 38, TOTAL);
  await expectSummary(page, "GWAS Traits: WMH, PSMD");
  await expect(filterCount(page, GWAS)).toHaveText("2");
});

/**
 * The R original compared trait strings raw and silently dropped rows stored
 * with a trailing space ("WMH ", "PSMD "). filterGenes normalizes both sides.
 *
 * The committed data no longer carries a padded WMH value -- all 19 are exact
 * -- because `data_contract_test.ts` now fails on edge whitespace and the
 * export trims on the way out, so the padding cannot come back. This is kept
 * as a regression guard on the normalizing itself rather than as a live
 * example of it: it fails if filterGenes ever stops trimming, which is what
 * the R version got wrong.
 */
test("trait matching ignores trailing whitespace in the data", async ({ page }) => {
  await choice(page, GWAS, "WMH").check();
  await expectRowCount(page, 34, TOTAL);
});

/** Likewise the data holds lowercase "proteomics" against a "Proteomics" choice. */
test("omics matching ignores case differences in the data", async ({ page }) => {
  await choice(page, OMICS, "Proteomics").check();
  await expectRowCount(page, 24, TOTAL);
  await expectSummary(page, "Evidence From Other Omics Studies: Proteomics");
});

test("the sentinel values are selectable filter choices", async ({ page }) => {
  await choice(page, GWAS, "None Found").check();
  await expectRowCount(page, 21, TOTAL);
  await expectSummary(page, "GWAS Traits: None Found");

  await choice(page, OMICS, "None Found").check();
  await expectRowCount(page, 3, TOTAL);
  await expectSummary(
    page,
    "GWAS Traits: None Found | Evidence From Other Omics Studies: None Found",
  );
});

test("groups intersect", async ({ page }) => {
  await choice(page, MR, "No").uncheck();
  await choice(page, OMICS, "Proteomics").check();

  await expectRowCount(page, 21, TOTAL);
  await expectSummary(
    page,
    "Mendelian randomization performed: Yes | Evidence From Other Omics Studies: Proteomics",
  );
});

test("an impossible combination shows the empty state", async ({ page }) => {
  // Data-derived: no Mendelian-randomisation gene carries PVWMH. It was
  // MR=Yes + SVS until the 365-day run put two genes in that intersection.
  await choice(page, MR, "No").uncheck();
  await choice(page, GWAS, "PVWMH").check();

  await expectRowCount(page, 0, TOTAL);
  await expectSummary(
    page,
    "Mendelian randomization performed: Yes | GWAS Traits: PVWMH",
  );
});

test("all committed GWAS traits are selectable", async ({ page }) => {
  await choice(page, GWAS, "CMB").check();
  // APOE and COL4A1/2 were the first two; the 365-day run added four more.
  await expectRowCount(page, 6, TOTAL);

  await choice(page, GWAS, "CMB").uncheck();
  await choice(page, GWAS, "WM-PVS").check();
  await expectRowCount(page, 15, TOTAL);
});

test("the banner prints choice labels, not wire values", async ({ page }) => {
  await choice(page, GWAS, "Extreme-cSVD").check();
  await expectSummary(page, "GWAS Traits: Extreme-cSVD");
});

test("filter state resets on reload", async ({ page }) => {
  await choice(page, GWAS, "SVS").check();
  await expectRowCount(page, 13, TOTAL);

  // All selection state is in-memory useState with no URL persistence.
  await page.reload();
  await expectSummary(page, "None");
  await expectRowCount(page, TOTAL, TOTAL);
});

test("every group renders its full choice list", async ({ page }) => {
  await expect(filterGroup(page, MR).getByRole("checkbox")).toHaveCount(2);
  // The vocabulary's traits plus the two sentinels, Show All and None Found.
  await expect(filterGroup(page, GWAS).getByRole("checkbox"))
    .toHaveCount(TRAIT_COUNT + 2);
  // 8 since WES/WGS joined OMICS_CHOICES: Show All, None Found, EWAS,
  // TWAS, PWAS, Proteomics, WES/WGS, MENTR.
  await expect(filterGroup(page, OMICS).getByRole("checkbox")).toHaveCount(8);
});
