import { assert, assertEquals } from "@std/assert";

import {
  buildFilterSummary,
  defaultTrialFilters,
  filterGenes,
  filterLocationsByStatus,
  filterTrials,
  formatOmicsValue,
  omicsType,
  visibleTrials,
} from "../lib/filters.ts";
import { formatTrialPlace, registryOf } from "../lib/trials.ts";
import { genes, trials } from "../lib/data.ts";
import type { Trial } from "../lib/types.ts";
import { sampleGene, sampleTrial } from "./fixtures/rows.ts";
import {
  DEFAULT_TRIAL_STATUSES,
  SHOW_ALL,
  STATUS_CHOICES,
} from "../lib/constants.ts";
import { UNKNOWN } from "../lib/sentinels.ts";

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

// -----------------------------------------------------------------------------
// omicsType
// -----------------------------------------------------------------------------

Deno.test("omicsType takes the study type before the semicolon", () => {
  assertEquals(omicsType("TWAS;whole blood"), "TWAS");
  assertEquals(omicsType("TWAS;"), "TWAS");
  assertEquals(omicsType("proteomics"), "proteomics");
  assertEquals(omicsType("(none found)"), "(none found)");
});

Deno.test("formatOmicsValue keeps the type readable and the detail in parentheses", () => {
  assertEquals(formatOmicsValue("TWAS;cross tissue"), "TWAS (cross tissue)");
  assertEquals(
    formatOmicsValue("Proteomics;plasma, CSF"),
    "Proteomics (plasma, CSF)",
  );
  assertEquals(formatOmicsValue("TWAS"), "TWAS");
  assertEquals(formatOmicsValue("(none found)"), "(none found)");
  // A trailing semicolon with no detail -- omicsType's own fixture -- drops
  // the parentheses rather than printing an empty pair.
  assertEquals(formatOmicsValue("TWAS;"), "TWAS");
});

// -----------------------------------------------------------------------------
// Gene filters
// -----------------------------------------------------------------------------

Deno.test("no active gene filters returns every row", () => {
  assertEquals(filterGenes(genes, NO_GENE_FILTERS).length, genes.length);
});

Deno.test("selecting both MR options is treated as no filter", () => {
  const both = filterGenes(genes, {
    ...NO_GENE_FILTERS,
    mendelianRandomization: ["Yes", "No"],
  });
  assertEquals(both.length, genes.length);
});

Deno.test("a single MR selection partitions the rows", () => {
  const yes = filterGenes(genes, {
    ...NO_GENE_FILTERS,
    mendelianRandomization: ["Yes"],
  });
  const no = filterGenes(genes, {
    ...NO_GENE_FILTERS,
    mendelianRandomization: ["No"],
  });

  assertEquals(yes.length + no.length, genes.length);
  assertEquals(yes.every((g) => g.mendelianRandomization === "Yes"), true);
});

Deno.test("GWAS filter matches genes carrying the trait", () => {
  const rows = [
    sampleGene({ gene: "A", gwasTrait: ["T1", "T2"] }),
    sampleGene({ gene: "B", gwasTrait: ["T2"] }),
    sampleGene({ gene: "C" }),
  ];
  const t1 = filterGenes(rows, { ...NO_GENE_FILTERS, gwasTraits: ["T1"] });
  assertEquals(t1.map((g) => g.gene), ["A"]);
  const t2 = filterGenes(rows, { ...NO_GENE_FILTERS, gwasTraits: ["T2"] });
  assertEquals(t2.map((g) => g.gene), ["A", "B"]);
});

Deno.test("GWAS filter matches values stored with a trailing space", () => {
  const padded = { ...sampleGene(), gene: "PADDED", gwasTrait: ["PSMD "] };

  const filtered = filterGenes([padded], {
    ...NO_GENE_FILTERS,
    gwasTraits: ["PSMD"],
  });
  assertEquals(filtered.map((gene) => gene.gene), ["PADDED"]);
});

Deno.test("omics filter matches case-insensitively", () => {
  // The choice is "Proteomics"; the data says "proteomics".
  const rows = [
    sampleGene({ gene: "A", evidenceFromOtherOmicsStudies: ["proteomics"] }),
    sampleGene({ gene: "B", evidenceFromOtherOmicsStudies: ["TWAS;blood"] }),
  ];
  const filtered = filterGenes(rows, {
    ...NO_GENE_FILTERS,
    omics: ["Proteomics"],
  });
  assertEquals(filtered.map((g) => g.gene), ["A"]);
});

Deno.test("omics filter matches the type before the detail", () => {
  const rows = [
    sampleGene({
      gene: "A",
      evidenceFromOtherOmicsStudies: [
        "mutation effect prediction on ncRNA transcription",
      ],
    }),
    sampleGene({ gene: "B", evidenceFromOtherOmicsStudies: ["TWAS;blood"] }),
  ];
  const mentr = filterGenes(rows, {
    ...NO_GENE_FILTERS,
    omics: ["mutation effect prediction on ncRNA transcription"],
  });
  assertEquals(mentr.map((g) => g.gene), ["A"]);
  const twas = filterGenes(rows, { ...NO_GENE_FILTERS, omics: ["TWAS"] });
  assertEquals(twas.map((g) => g.gene), ["B"]);
});

Deno.test("omics filter finds genes with no evidence via the sentinel", () => {
  const rows = [
    sampleGene({ gene: "A", evidenceFromOtherOmicsStudies: ["TWAS"] }),
    sampleGene({ gene: "B" }),
  ];
  const filtered = filterGenes(rows, {
    ...NO_GENE_FILTERS,
    omics: ["(none found)"],
  });
  assertEquals(filtered.map((g) => g.gene), ["B"]);
});

Deno.test("every committed omics value is reachable through its type", () => {
  // Vacuous on the empty export; on the committed rows it is what keeps every
  // published study selectable (the export gates the vocabulary).
  for (const gene of genes) {
    for (const value of gene.evidenceFromOtherOmicsStudies) {
      const hit = filterGenes(genes, {
        ...NO_GENE_FILTERS,
        omics: [omicsType(value)],
      });
      assert(hit.includes(gene), `${gene.gene}: ${value}`);
    }
  }
});

Deno.test("gene filters compose as an intersection", () => {
  const combined = filterGenes(genes, {
    mendelianRandomization: ["Yes"],
    gwasTraits: ["SVS"],
    omics: [SHOW_ALL],
  });
  const gwasOnly = filterGenes(genes, {
    ...NO_GENE_FILTERS,
    gwasTraits: ["SVS"],
  });

  assertEquals(combined.length <= gwasOnly.length, true);
  assertEquals(combined.every((g) => g.mendelianRandomization === "Yes"), true);
});

// -----------------------------------------------------------------------------
// Trial filters
// -----------------------------------------------------------------------------

Deno.test("registryOf reads the registry from the ID prefix", () => {
  assertEquals(registryOf("NCT05755997"), "NCT");
  assertEquals(registryOf("ISRCTN14632228"), "ISRCTN");
  assertEquals(registryOf("ChiCTR2500109773"), "ChiCTR");
  assertEquals(registryOf("ACTRN12624001477516"), "ACTRN");
  assertEquals(registryOf("  nct05755997  "), "NCT");
  assertEquals(registryOf("chictr2500109773"), "ChiCTR");
  assertEquals(registryOf(""), null);
});

Deno.test("trial places omit blank parts and surrounding whitespace", () => {
  assertEquals(
    formatTrialPlace({ city: " Paris ", state: " ", country: " France " }),
    "Paris, France",
  );
});

Deno.test("no active trial filters returns every row", () => {
  assertEquals(filterTrials(trials, NO_TRIAL_FILTERS).length, trials.length);
});

Deno.test("registry filter keeps only the selected registries", () => {
  const rows = [
    sampleTrial({ registryId: "NCT00000001" }),
    sampleTrial({ registryId: "ISRCTN00000001" }),
    sampleTrial({ registryId: "chictr2500000001" }),
  ];
  const nct = filterTrials(rows, { ...NO_TRIAL_FILTERS, registries: ["NCT"] });
  assertEquals(nct.map((t) => t.registryId), ["NCT00000001"]);
  const two = filterTrials(rows, {
    ...NO_TRIAL_FILTERS,
    registries: ["ISRCTN", "ChiCTR"],
  });
  assertEquals(two.map((t) => t.registryId), [
    "ISRCTN00000001",
    "chictr2500000001",
  ]);
  // Every committed registry id resolves to a registry choice.
  for (const trial of trials) {
    assert(registryOf(trial.registryId) !== null, trial.registryId);
  }
});

Deno.test("phase matching ignores Roman-numeral letters inside words", () => {
  const fixture = [{
    ...sampleTrial(),
    clinicalTrialPhase: "Clinical Trial Phase II",
  }];

  assertEquals(
    filterTrials(fixture, { ...NO_TRIAL_FILTERS, phases: ["I"] }).length,
    0,
  );
  assertEquals(
    filterTrials(fixture, { ...NO_TRIAL_FILTERS, phases: ["II"] }).length,
    1,
  );

  assertEquals(
    filterTrials(
      [{ ...fixture[0], clinicalTrialPhase: "Not applicable" }],
      { ...NO_TRIAL_FILTERS, phases: ["II"] },
    ).length,
    0,
  );
});

Deno.test("only Industry uses sponsor prefix matching", () => {
  const fixture = [
    { ...sampleTrial(), sponsorType: "Academic Medical Center" },
    {
      ...sampleTrial(),
      registryId: "NCT00000001",
      sponsorType: "Industrywide",
    },
    {
      ...sampleTrial(),
      registryId: "NCT00000002",
      sponsorType: "Industry (Example Pharma)",
    },
  ];

  assertEquals(
    filterTrials(fixture, { ...NO_TRIAL_FILTERS, sponsors: ["Academic"] })
      .length,
    0,
  );
  assertEquals(
    filterTrials(fixture, { ...NO_TRIAL_FILTERS, sponsors: ["Industry"] })
      .map((trial) => trial.registryId),
    ["NCT00000002"],
  );
});

// -----------------------------------------------------------------------------
// Filter summary
// -----------------------------------------------------------------------------

Deno.test("buildFilterSummary omits inactive groups", () => {
  const summary = buildFilterSummary([
    {
      label: "Mendelian randomization performed",
      value: ["Yes", "No"],
      mode: "binary",
    },
    { label: "GWAS Traits", value: [SHOW_ALL] },
    { label: "Evidence From Other Omics Studies", value: ["TWAS"] },
  ]);

  assertEquals(summary, ["Evidence From Other Omics Studies: TWAS"]);
});

Deno.test("buildFilterSummary reports a single-valued group", () => {
  const summary = buildFilterSummary([
    {
      label: "Mendelian randomization performed",
      value: ["Yes"],
      mode: "binary",
    },
  ]);

  assertEquals(summary, ["Mendelian randomization performed: Yes"]);
});

Deno.test("buildFilterSummary prints choice labels, not wire values", () => {
  const summary = buildFilterSummary([
    {
      label: "Clinical Trial Phase",
      value: ["(unknown)", "I"],
      choices: [
        { label: "Show All", value: "all" },
        { label: "Phase I", value: "I" },
        { label: "Phase not stated", value: "(unknown)" },
      ],
    },
  ]);
  assertEquals(summary, [
    "Clinical Trial Phase: Phase not stated, Phase I",
  ]);
});

Deno.test("status choices derive from the vocabulary and the default hides Completed", () => {
  const values = STATUS_CHOICES.map((c) => c.value);
  assertEquals(values[0], SHOW_ALL);
  assert(values.includes("COMPLETED") && values.includes("UNKNOWN"));
  assert(!values.includes("TERMINATED") && !values.includes("WITHDRAWN"));
  assertEquals(
    DEFAULT_TRIAL_STATUSES,
    values.filter((v) => v !== SHOW_ALL && v !== "COMPLETED"),
  );
});

Deno.test("status filtering folds the export sentinel onto the UNKNOWN choice", () => {
  const rows = [
    { ...sampleTrial(), overallStatus: "COMPLETED" },
    { ...sampleTrial(), overallStatus: " recruiting " },
    { ...sampleTrial(), overallStatus: "UNKNOWN" },
    { ...sampleTrial(), overallStatus: UNKNOWN },
  ];
  const only = (statuses: string[]) =>
    filterTrials(rows, { ...NO_TRIAL_FILTERS, statuses }).map((r) =>
      r.overallStatus
    );
  assertEquals(only(["COMPLETED"]), ["COMPLETED"]);
  assertEquals(only(["RECRUITING"]), [" recruiting "]);
  assertEquals(only(["UNKNOWN"]), ["UNKNOWN", UNKNOWN]);
  assertEquals(only([SHOW_ALL]).length, 4);
  assertEquals(visibleTrials(rows).length, 3);
  assertEquals(defaultTrialFilters().statuses, DEFAULT_TRIAL_STATUSES);
});

Deno.test("location status filtering treats a null status as not stated", () => {
  const site = {
    nctId: "NCT00000001",
    facilityName: "A",
    city: "B",
    state: null,
    country: "C",
    trialTitle: "T",
    status: null,
    lat: 0,
    lon: 0,
  };
  assertEquals(
    filterLocationsByStatus([site, { ...site, status: "COMPLETED" }], [
      "UNKNOWN",
    ]).length,
    1,
  );
  assertEquals(filterLocationsByStatus([site], [SHOW_ALL]).length, 1);
  assertEquals(
    filterLocationsByStatus([site], DEFAULT_TRIAL_STATUSES).length,
    1,
  );
});

// -----------------------------------------------------------------------------
// The same rules over synthetic rows, so they run on the empty export too
// -----------------------------------------------------------------------------

Deno.test("a single MR selection keeps only the matching synthetic genes", () => {
  const rows = [
    sampleGene({ gene: "A", mendelianRandomization: "Yes" }),
    sampleGene({ gene: "B", mendelianRandomization: "No" }),
    sampleGene({ gene: "C", mendelianRandomization: " yes " }),
  ];
  const yes = filterGenes(rows, {
    ...NO_GENE_FILTERS,
    mendelianRandomization: ["Yes"],
  });
  assertEquals(yes.map((g) => g.gene), ["A", "C"]);
  const no = filterGenes(rows, {
    ...NO_GENE_FILTERS,
    mendelianRandomization: ["No"],
  });
  assertEquals(no.map((g) => g.gene), ["B"]);
});

Deno.test("a single genetic-evidence selection keeps only the matching synthetic trials", () => {
  const rows = [
    sampleTrial({ registryId: "NCT00000001", geneticEvidence: "Yes" }),
    sampleTrial({ registryId: "NCT00000002", geneticEvidence: "No" }),
  ];
  const ids = (selected: Trial[]) => selected.map((t) => t.registryId);
  assertEquals(
    ids(filterTrials(rows, { ...NO_TRIAL_FILTERS, geneticEvidence: ["Yes"] })),
    ["NCT00000001"],
  );
  assertEquals(
    ids(filterTrials(rows, { ...NO_TRIAL_FILTERS, geneticEvidence: ["No"] })),
    ["NCT00000002"],
  );
  assertEquals(ids(filterTrials(rows, NO_TRIAL_FILTERS)).length, 2);
});

Deno.test("phase and population selections keep only the matching synthetic trials", () => {
  const rows = [
    sampleTrial({
      registryId: "NCT00000001",
      clinicalTrialPhase: "II/III",
      targetPopulation: "Population A",
    }),
    sampleTrial({
      registryId: "NCT00000002",
      clinicalTrialPhase: "I",
      targetPopulation: "Population B",
    }),
    sampleTrial({
      registryId: "NCT00000003",
      clinicalTrialPhase: "(unknown)",
      targetPopulation: "Population A",
    }),
  ];
  const ids = (selected: Trial[]) => selected.map((t) => t.registryId);
  assertEquals(
    ids(filterTrials(rows, { ...NO_TRIAL_FILTERS, phases: ["III"] })),
    ["NCT00000001"],
  );
  assertEquals(
    ids(filterTrials(rows, { ...NO_TRIAL_FILTERS, phases: [UNKNOWN] })),
    ["NCT00000003"],
  );
  assertEquals(
    ids(
      filterTrials(rows, {
        ...NO_TRIAL_FILTERS,
        populations: ["Population A"],
      }),
    ),
    ["NCT00000001", "NCT00000003"],
  );
  assertEquals(
    ids(
      filterTrials(rows, {
        ...NO_TRIAL_FILTERS,
        phases: ["I"],
        populations: ["Population A"],
      }),
    ),
    [],
  );
});
