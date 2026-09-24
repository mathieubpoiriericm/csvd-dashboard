/**
 * The filters over the committed cSVD rows: each choice the dashboard offers
 * matches at least one published gene or trial.
 *
 * The matching rules are tested on synthetic rows in tests/filters_test.ts;
 * this is the record that the committed data reaches them, and a fork
 * deletes the whole tests/csvd/ tree.
 */
import { assertEquals } from "@std/assert";

import { SHOW_ALL } from "../../lib/constants.ts";
import { genes, trials } from "../../lib/data.ts";
import { filterGenes, filterTrials, omicsType } from "../../lib/filters.ts";

const NO_GENE_FILTERS = {
  mendelianRandomization: ["Yes", "No"],
  gwasTraits: [SHOW_ALL],
  omics: [SHOW_ALL],
};

const NO_TRIAL_FILTERS = {
  geneticEvidence: ["Yes", "No"],
  registries: [SHOW_ALL],
  phases: [SHOW_ALL],
  populations: [SHOW_ALL],
  sponsors: [SHOW_ALL],
  statuses: [SHOW_ALL],
};

Deno.test("GWAS filter matches the committed genes carrying SVS", () => {
  const svs = filterGenes(genes, { ...NO_GENE_FILTERS, gwasTraits: ["SVS"] });
  assertEquals(svs.length > 0, true);
  assertEquals(svs.every((g) => g.gwasTrait.includes("SVS")), true);
});

Deno.test("omics filter matches the committed proteomics rows case-insensitively", () => {
  // The choice is "Proteomics"; the data says "proteomics".
  const filtered = filterGenes(genes, {
    ...NO_GENE_FILTERS,
    omics: ["Proteomics"],
  });
  assertEquals(filtered.length > 0, true);
  assertEquals(
    filtered.every((g) =>
      g.evidenceFromOtherOmicsStudies.some((v) =>
        omicsType(v).toLowerCase() === "proteomics"
      )
    ),
    true,
  );
});

Deno.test("omics filter matches the committed MENTR long form", () => {
  const filtered = filterGenes(genes, {
    ...NO_GENE_FILTERS,
    omics: ["mutation effect prediction on ncRNA transcription"],
  });
  assertEquals(filtered.length > 0, true);
});

Deno.test("omics filter finds the committed genes with no evidence via the sentinel", () => {
  const filtered = filterGenes(genes, {
    ...NO_GENE_FILTERS,
    omics: ["(none found)"],
  });
  assertEquals(filtered.length > 0, true);
  assertEquals(
    filtered.every((g) =>
      g.evidenceFromOtherOmicsStudies.includes("(none found)")
    ),
    true,
  );
});

Deno.test("registry filter keeps the committed NCT trials", () => {
  const nct = filterTrials(trials, {
    ...NO_TRIAL_FILTERS,
    registries: ["NCT"],
  });
  assertEquals(nct.length > 0, true);
  assertEquals(nct.every((t) => t.registryId.startsWith("NCT")), true);
});
