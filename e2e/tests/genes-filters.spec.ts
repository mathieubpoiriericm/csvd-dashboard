import { expect, test } from "@playwright/test";
import { EXPECTED, GENE_TOTAL, TRAIT_COUNT } from "../fixtures/expected-data.ts";
import {
  choice,
  expectRowCount,
  expectSummary,
  filterCount,
  filterGroup,
} from "../helpers.ts";

/**
 * The sidebar legend and the filter banner name each group with the same
 * string (F57) — the constants below are shared between the two.
 *
 * Every count comes from `EXPECTED`, derived from the committed data through
 * the app's own filter rules, and every trait or omics choice is picked from
 * the vocabulary rather than named: the tests that name the first disease's
 * traits are in `csvd/genes-filters.spec.ts`.
 */
const MR = "Mendelian randomization performed";
const GWAS = "GWAS Traits";
const OMICS = "Evidence From Other Omics Studies";

const G = EXPECTED.genes;
const [TOP, SECOND] = G.topTraits;

test.beforeEach(async ({ page }) => {
  await page.goto("/genes");
});

test("starts unconstrained with every group showing All", async ({ page }) => {
  await expectSummary(page, "None");
  await expectRowCount(page, GENE_TOTAL, GENE_TOTAL);
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
  await expectRowCount(page, G.mrYes, GENE_TOTAL);
  await expectSummary(page, "Mendelian randomization performed: Yes");
  await expect(filterCount(page, MR)).toHaveText("1");

  // Unticking the only remaining box re-checks both rather than emptying the
  // group, so getting to "No only" means going back through both.
  await choice(page, MR, "Yes").click();
  await expect(choice(page, MR, "No")).toBeChecked();
  await choice(page, MR, "Yes").uncheck();
  await expectRowCount(page, G.mrNo, GENE_TOTAL);
  await expectSummary(page, "Mendelian randomization performed: No");

  await choice(page, MR, "Yes").check();
  await expectRowCount(page, GENE_TOTAL, GENE_TOTAL);
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
  await expectRowCount(page, GENE_TOTAL, GENE_TOTAL);
});

test("picking a GWAS trait clears Show All and filters", async ({ page }) => {
  test.skip(!TOP, "no committed gene carries a trait");
  await choice(page, GWAS, TOP.label).check();

  await expect(choice(page, GWAS, "Show All")).not.toBeChecked();
  await expect(filterCount(page, GWAS)).toHaveText("1");
  await expectRowCount(page, TOP.count, GENE_TOTAL);
  await expectSummary(page, `GWAS Traits: ${TOP.label}`);
});

test("unticking the last GWAS trait snaps back to Show All", async ({ page }) => {
  test.skip(!TOP, "no committed gene carries a trait");
  await choice(page, GWAS, TOP.label).check();
  await choice(page, GWAS, TOP.label).uncheck();

  await expect(choice(page, GWAS, "Show All")).toBeChecked();
  await expect(filterCount(page, GWAS)).toHaveText("All");
  await expectRowCount(page, GENE_TOTAL, GENE_TOTAL);
  await expectSummary(page, "None");
});

test("ticking Show All clears the other choices", async ({ page }) => {
  test.skip(!SECOND, "fewer than two traits carry a gene");
  await choice(page, GWAS, TOP.label).check();
  await choice(page, GWAS, SECOND.label).check();
  await expect(filterCount(page, GWAS)).toHaveText("2");

  await choice(page, GWAS, "Show All").check();
  await expect(choice(page, GWAS, TOP.label)).not.toBeChecked();
  await expect(choice(page, GWAS, SECOND.label)).not.toBeChecked();
  await expectRowCount(page, GENE_TOTAL, GENE_TOTAL);
});

test("choices within a group union", async ({ page }) => {
  test.skip(!SECOND, "fewer than two traits carry a gene");
  await choice(page, GWAS, TOP.label).check();
  await expectRowCount(page, TOP.count, GENE_TOTAL);

  await choice(page, GWAS, SECOND.label).check();
  await expectRowCount(page, G.topTraitsUnion, GENE_TOTAL);
  await expectSummary(page, `GWAS Traits: ${TOP.label}, ${SECOND.label}`);
  await expect(filterCount(page, GWAS)).toHaveText("2");
});

/**
 * The R original compared omics strings raw and silently dropped rows whose
 * case differed from the choice ("proteomics" against "Proteomics").
 * filterGenes normalizes both sides; the count is what the normalized rule
 * yields over the committed rows, whatever their case.
 */
test("omics matching follows the normalized rule", async ({ page }) => {
  test.skip(!G.topOmics, "no committed gene carries an omics study");
  await choice(page, OMICS, G.topOmics!.label).check();
  await expectRowCount(page, G.topOmics!.count, GENE_TOTAL);
  await expectSummary(
    page,
    `Evidence From Other Omics Studies: ${G.topOmics!.label}`,
  );
});

test("the sentinel values are selectable filter choices", async ({ page }) => {
  await choice(page, GWAS, "None Found").check();
  await expectRowCount(page, G.noneFound, GENE_TOTAL);
  await expectSummary(page, "GWAS Traits: None Found");

  await choice(page, OMICS, "None Found").check();
  await expectRowCount(page, G.noneFoundBoth, GENE_TOTAL);
  await expectSummary(
    page,
    "GWAS Traits: None Found | Evidence From Other Omics Studies: None Found",
  );
});

test("groups intersect", async ({ page }) => {
  test.skip(!G.topOmics, "no committed gene carries an omics study");
  await choice(page, MR, "No").uncheck();
  await choice(page, OMICS, G.topOmics!.label).check();

  await expectRowCount(page, G.mrYesTopOmics, GENE_TOTAL);
  await expectSummary(
    page,
    `Mendelian randomization performed: Yes | Evidence From Other Omics Studies: ${G.topOmics!.label}`,
  );
});

test("an impossible combination shows the empty state", async ({ page }) => {
  // Data-derived: a trait no Mendelian-randomisation gene carries.
  test.skip(!G.impossible, "every trait has a Mendelian-randomisation gene");
  await choice(page, MR, "No").uncheck();
  await choice(page, GWAS, G.impossible!.label).check();

  await expectRowCount(page, 0, GENE_TOTAL);
  await expectSummary(
    page,
    `Mendelian randomization performed: Yes | GWAS Traits: ${G.impossible!.label}`,
  );
});

test("every trait with a committed gene is selectable", async ({ page }) => {
  for (const trait of G.traits.filter((t) => t.count > 0)) {
    await choice(page, GWAS, trait.label).check();
    await expectRowCount(page, trait.count, GENE_TOTAL);
    await choice(page, GWAS, trait.label).uncheck();
  }
});

test("the banner prints choice labels, not wire values", async ({ page }) => {
  test.skip(!G.relabelledTrait, "every trait label is its wire value");
  await choice(page, GWAS, G.relabelledTrait!.label).check();
  await expectSummary(page, `GWAS Traits: ${G.relabelledTrait!.label}`);
});

test("filter state resets on reload", async ({ page }) => {
  test.skip(!TOP, "no committed gene carries a trait");
  await choice(page, GWAS, TOP.label).check();
  await expectRowCount(page, TOP.count, GENE_TOTAL);

  // All selection state is in-memory useState with no URL persistence.
  await page.reload();
  await expectSummary(page, "None");
  await expectRowCount(page, GENE_TOTAL, GENE_TOTAL);
});

test("every group renders its full choice list", async ({ page }) => {
  await expect(filterGroup(page, MR).getByRole("checkbox")).toHaveCount(2);
  // The vocabulary's traits plus the two sentinels, Show All and None Found.
  await expect(filterGroup(page, GWAS).getByRole("checkbox"))
    .toHaveCount(TRAIT_COUNT + 2);
  // Show All plus every omics choice, None Found among them.
  await expect(filterGroup(page, OMICS).getByRole("checkbox")).toHaveCount(
    G.omics.length + 1,
  );
});
