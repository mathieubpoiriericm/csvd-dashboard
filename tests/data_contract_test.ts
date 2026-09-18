import { assert, assertEquals } from "@std/assert";

import {
  GWAS_TRAIT_CHOICES,
  OMICS_CHOICES,
  PHASE_CHOICES,
  POPULATION_CHOICES,
  REGISTRY_CHOICES,
  SHOW_ALL,
  SPONSOR_CHOICES,
  STATUS_CHOICES,
  YES_NO_CHOICES,
} from "../lib/constants.ts";
import {
  genes,
  trialLocations,
  trialLocationsGeneratedAt,
  trials,
} from "../lib/data.ts";
import { filterGenes, filterTrials } from "../lib/filters.ts";
import type { Gene, Trial } from "../lib/types.ts";
import rawGeocodedJson from "../data/geocoded_trials.json" with {
  type: "json",
};
import rawGeneInfoJson from "../data/gene_info.json" with { type: "json" };
import rawTrialGeneInfoJson from "../data/gene_info_table2.json" with {
  type: "json",
};
import rawOmimJson from "../data/omim_info.json" with { type: "json" };
import rawPipelineSyncsJson from "../data/pipeline_syncs.json" with {
  type: "json",
};
import rawPipelineStatusJson from "../data/pipeline_status.json" with {
  type: "json",
};
import rawProteinInfoJson from "../data/protein_info.json" with {
  type: "json",
};
import rawReferencesJson from "../data/refs.json" with { type: "json" };
import rawGenesJson from "../data/table1.json" with { type: "json" };
import rawTrialsJson from "../data/table2.json" with { type: "json" };

const TRIAL_STRING_FIELDS = [
  "drug",
  "mechanismOfAction",
  "geneticTarget",
  "geneticEvidence",
  "trialName",
  "registryId",
  "clinicalTrialPhase",
  "targetPopulation",
  "targetPopulationDetails",
  "targetSampleSize",
  "estimatedCompletionDate",
  "primaryOutcome",
  "sponsorType",
  "overallStatus",
] as const satisfies readonly (keyof Trial)[];

const GENE_ARRAY_FIELDS = [
  "gwasTrait",
  "evidenceFromOtherOmicsStudies",
  "linkToMonogenicDisease",
  "references",
] as const satisfies readonly (keyof Gene)[];

const GENE_STRING_FIELDS = [
  "gene",
  "protein",
  "chromosomalLocation",
  "mendelianRandomization",
  "brainCellTypes",
  "affectedPathway",
  "sourceQuote",
] as const satisfies readonly (keyof Gene)[];

const LOCATION_NULLABLE_STRING_FIELDS = [
  "facilityName",
  "city",
  "state",
  "country",
  "trialTitle",
  "status",
] as const;

function assertUniqueKeys(
  rows: Array<Record<string, unknown>>,
  field: string,
  dataset: string,
): void {
  const keys = rows.map((row) => String(row[field]));
  assertEquals(
    new Set(keys).size,
    keys.length,
    `${dataset}.${field} values must be unique`,
  );
}

Deno.test("generated trial rows satisfy the string-only UI contract", () => {
  const rawTrials = rawTrialsJson as Array<Record<string, unknown>>;
  for (const [index, trial] of rawTrials.entries()) {
    for (const field of TRIAL_STRING_FIELDS) {
      const value = trial[field];
      assert(
        typeof value === "string" && value.trim() !== "",
        `table2 row ${index} field ${field} must be a nonblank string`,
      );
      assertEquals(
        value,
        value.trim(),
        `table2 row ${index} field ${field} must have no edge whitespace`,
      );
    }
    assert(
      !/^(?:NA|N\/A|-)$/i.test(String(trial.geneticTarget)),
      `table2 row ${index} has a sentinel genetic target`,
    );
    assert(
      !/^Completed\s*[,;]?\s*unpublish(?:ed)?$/i.test(
        String(trial.estimatedCompletionDate),
      ),
      `table2 row ${index} has an unnormalised completion status`,
    );
  }
});

// A trial registered once is one trial however many drugs it tests, so its
// rows agree on every per-trial column. The population columns did not:
// upstream, the two were sorted on their own and laid back over rows ordered
// by drug, so three registry IDs disagreed with themselves and the CADASIL
// cerebrolysin trial published as CAA. Nothing in the export can see that;
// this can.
const PER_TRIAL_FIELDS = [
  "trialName",
  "clinicalTrialPhase",
  "targetSampleSize",
  "estimatedCompletionDate",
  "primaryOutcome",
  "sponsorType",
  "targetPopulation",
  "targetPopulationDetails",
] as const;

Deno.test("rows of one registered trial agree on every per-trial column", () => {
  const byRegistryId = new Map<string, Trial[]>();
  for (const trial of trials) {
    byRegistryId.set(trial.registryId, [
      ...(byRegistryId.get(trial.registryId) ?? []),
      trial,
    ]);
  }
  for (const [registryId, rows] of byRegistryId) {
    for (const field of PER_TRIAL_FIELDS) {
      const values = new Set(rows.map((row) => row[field]));
      assertEquals(
        values.size,
        1,
        `${registryId}: ${field} differs across its rows (${
          [...values].join(" | ")
        })`,
      );
    }
  }
});

Deno.test("generated gene list-columns always remain arrays of strings", () => {
  const rawGenes = rawGenesJson as Array<Record<string, unknown>>;
  for (const [index, gene] of rawGenes.entries()) {
    for (const field of GENE_STRING_FIELDS) {
      const value = gene[field];
      assert(
        typeof value === "string" && value.trim() !== "",
        `table1 row ${index} field ${field} must be a nonblank string`,
      );
      assertEquals(
        value,
        value.trim(),
        `table1 row ${index} field ${field} must have no edge whitespace`,
      );
    }
    for (const field of GENE_ARRAY_FIELDS) {
      const value = gene[field];
      assert(
        Array.isArray(value),
        `table1 row ${index} field ${field} must be an array`,
      );
      assert(
        value.every((entry) =>
          typeof entry === "string" && entry.trim() !== ""
        ),
        `table1 row ${index} field ${field} must contain nonblank strings`,
      );
      for (const entry of value) {
        assertEquals(
          entry,
          entry.trim(),
          `table1 row ${index} field ${field} has edge whitespace`,
        );
      }
    }
    assert(
      !/^(?:NA|N\/A)$/i.test(String(gene.brainCellTypes)),
      `table1 row ${index} has a sentinel brain-cell value`,
    );
    assert(
      !/^(?:NA|N\/A)$/i.test(String(gene.affectedPathway)),
      `table1 row ${index} has a sentinel pathway value`,
    );
    // confidence is a nullable number, not a sentineled string: a gene with
    // no machine extraction publishes JSON null rather than a placeholder.
    assert(
      gene.confidence === null ||
        (typeof gene.confidence === "number" &&
          gene.confidence >= 0 && gene.confidence <= 1),
      `table1 row ${index} field confidence must be null or in [0, 1]`,
    );
  }
});

/**
 * `clean_table1.R` deletes whole tissue names ("YFS.BLOOD.RNAARR", "GTEx.")
 * from the omics column *after* the pass that strips orphaned separators, so a
 * deletion that empties the tissue half leaves the separator pointing at
 * nothing. The result is displayed verbatim in the table cell — "TWAS;" rather
 * than "TWAS" — and `omicsType` still resolves, so nothing else notices.
 */
Deno.test("generated omics values carry no dangling separator", () => {
  const rawGenes = rawGenesJson as Array<Record<string, unknown>>;
  const dangling = rawGenes.flatMap((gene) =>
    (gene.evidenceFromOtherOmicsStudies as string[])
      .filter((value) => /[;,]\s*$|^\s*[;,]/.test(value))
      .map((value) => `${gene.gene}: ${JSON.stringify(value)}`)
  );

  assertEquals(dangling, []);
});

Deno.test("generated tooltip lookups satisfy their runtime contracts", () => {
  const geneDatasets = [
    ["gene_info", rawGeneInfoJson],
    ["gene_info_table2", rawTrialGeneInfoJson],
  ] as const;
  for (const [dataset, value] of geneDatasets) {
    const rows = value as Array<Record<string, unknown>>;
    assertUniqueKeys(rows, "name", dataset);
    for (const [index, row] of rows.entries()) {
      assert(
        typeof row.name === "string" && row.name.trim() !== "",
        `${dataset} row ${index} needs a nonblank gene name`,
      );
      for (const field of ["uid", "description", "otheraliases"] as const) {
        assert(
          row[field] === null || typeof row[field] === "string",
          `${dataset} row ${index} field ${field} must be a string or null`,
        );
      }
    }
  }

  const proteins = rawProteinInfoJson as Array<Record<string, unknown>>;
  assertUniqueKeys(proteins, "gene", "protein_info");
  for (const [index, row] of proteins.entries()) {
    assert(
      typeof row.gene === "string" && row.gene.trim() !== "",
      `protein_info row ${index} needs a nonblank gene`,
    );
    assert(row.accession === null || typeof row.accession === "string");
    assert(
      row.url === null ||
        (typeof row.url === "string" && /^https:\/\//.test(row.url)),
      `protein_info row ${index} has an invalid URL`,
    );
  }

  const omim = rawOmimJson as Array<Record<string, unknown>>;
  assertUniqueKeys(omim, "omimNum", "omim_info");
  for (const [index, row] of omim.entries()) {
    assert(
      typeof row.omimNum === "number" && Number.isFinite(row.omimNum),
      `omim_info row ${index} needs a finite phenotype number`,
    );
    for (
      const field of [
        "omimLink",
        "phenotype",
        "inheritance",
        "geneOrLocus",
        "geneOrLocusMimNumber",
      ] as const
    ) {
      assert(
        typeof row[field] === "string",
        `omim_info row ${index} field ${field} must be a string`,
      );
    }
    assert(/^https:\/\//.test(row.omimLink as string));
  }

  const references = rawReferencesJson as Array<Record<string, unknown>>;
  assertUniqueKeys(references, "pmid", "refs");
  for (const [index, row] of references.entries()) {
    assert(
      typeof row.pmid === "string" && /^[1-9]\d*$/.test(row.pmid),
      `refs row ${index} needs a numeric PMID`,
    );
    assert(
      typeof row.formattedRef === "string" && row.formattedRef.trim() !== "",
      `refs row ${index} needs a formatted citation`,
    );
    // The citation as data, beside the fragment. Each is nullable on its own
    // -- a PMID the export cannot resolve is completed with nulls -- but the
    // key has to be there, because the dashboard reads it rather than
    // splitting the fragment.
    for (
      const key of ["authors", "title", "journal", "publicationDate", "doi"]
    ) {
      assert(
        key in row && (row[key] === null || typeof row[key] === "string"),
        `refs row ${index} needs a string-or-null "${key}"`,
      );
    }
  }
});

Deno.test("pipeline status is null or a complete run summary", () => {
  if (rawPipelineStatusJson === null) return;

  const status = rawPipelineStatusJson as Record<string, unknown>;
  assert(
    typeof status.runTimestamp === "string" &&
      !Number.isNaN(Date.parse(status.runTimestamp)),
  );
  for (
    const field of [
      "papersProcessed",
      "fulltextRetrieved",
      "genesExtracted",
      "genesValidated",
    ] as const
  ) {
    assert(
      typeof status[field] === "number" &&
        Number.isInteger(status[field]) &&
        status[field] >= 0,
      `pipeline status ${field} must be a nonnegative integer`,
    );
  }
});

Deno.test("every recorded refresh names a known mode, status and provider", () => {
  // Against the raw committed JSON, not the normalized boundary: the
  // normalizer drops a row it cannot read, so asserting through it would
  // pass over exactly the regression this is here to catch.
  assert(Array.isArray(rawPipelineSyncsJson));
  const modes = ["clinical_trials", "external_sync", "annotation_sync"];
  const statuses = ["completed", "completed_with_warnings", "failed"];

  for (const [index, entry] of rawPipelineSyncsJson.entries()) {
    const run = entry as Record<string, unknown>;
    assert(
      typeof run.runTimestamp === "string" &&
        !Number.isNaN(Date.parse(run.runTimestamp)),
      `refresh ${index} needs a parseable runTimestamp`,
    );
    assert(
      typeof run.mode === "string" && modes.includes(run.mode),
      `refresh ${index} has an unknown mode`,
    );
    assert(
      typeof run.status === "string" && statuses.includes(run.status),
      `refresh ${index} has an unknown status`,
    );
    // Always arrays, never a sentinel and never absent: the TypeScript
    // side maps over both without a guard.
    assert(
      Array.isArray(run.sources),
      `refresh ${index} sources must be a list`,
    );
    assert(Array.isArray(run.apis), `refresh ${index} apis must be a list`);
    for (const api of run.apis as Record<string, unknown>[]) {
      assert(
        typeof api.label === "string" && api.label.length > 0,
        `refresh ${index} has an API row with no label`,
      );
    }
  }
});

Deno.test("the public data boundary normalizes legacy text sentinels", () => {
  for (const gene of genes) {
    assertEquals(gene.gene, gene.gene.trim());
    assert(!/^(?:NA|N\/A)$/i.test(gene.brainCellTypes));
    assert(!/^(?:NA|N\/A)$/i.test(gene.affectedPathway));
  }

  for (const trial of trials) {
    for (const field of TRIAL_STRING_FIELDS) {
      assertEquals(trial[field], trial[field].trim());
    }
    assert(!/^(?:NA|N\/A|-)$/i.test(trial.geneticTarget));
  }
});

Deno.test("every committed GWAS trait is available as a filter choice", () => {
  const choices = new Set(
    GWAS_TRAIT_CHOICES.map((choice) => choice.value.trim().toLowerCase()),
  );
  const missing = [
    ...new Set(genes.flatMap((gene) => gene.gwasTrait)),
  ].filter((trait) => !choices.has(trait.trim().toLowerCase()));

  assertEquals(missing, []);
});

Deno.test("every generated category is reachable through its filter", () => {
  const geneDefaults = {
    mendelianRandomization: YES_NO_CHOICES.map((choice) => choice.value),
    gwasTraits: [SHOW_ALL],
    omics: [SHOW_ALL],
  };
  for (const gene of genes) {
    assert(
      YES_NO_CHOICES.some((choice) =>
        filterGenes([gene], {
          ...geneDefaults,
          mendelianRandomization: [choice.value],
        }).length === 1
      ),
      `${gene.gene} has an unfilterable Mendelian-randomization value`,
    );
    assert(
      GWAS_TRAIT_CHOICES.filter((choice) => choice.value !== SHOW_ALL).some(
        (choice) =>
          filterGenes([gene], {
            ...geneDefaults,
            gwasTraits: [choice.value],
          }).length === 1,
      ),
      `${gene.gene} has no selectable GWAS trait`,
    );
    for (const evidence of gene.evidenceFromOtherOmicsStudies) {
      const fixture = [{
        ...gene,
        evidenceFromOtherOmicsStudies: [evidence],
      }];
      assert(
        OMICS_CHOICES.filter((choice) => choice.value !== SHOW_ALL).some(
          (choice) =>
            filterGenes(fixture, {
              ...geneDefaults,
              omics: [choice.value],
            }).length === 1,
        ),
        `${gene.gene} has an unfilterable omics value: ${evidence}`,
      );
    }
  }

  const trialDefaults = {
    geneticEvidence: YES_NO_CHOICES.map((choice) => choice.value),
    registries: [SHOW_ALL],
    phases: [SHOW_ALL],
    populations: [SHOW_ALL],
    sponsors: [SHOW_ALL],
    statuses: [SHOW_ALL],
  };
  const dimensions = [
    ["geneticEvidence", YES_NO_CHOICES],
    ["registries", REGISTRY_CHOICES],
    ["phases", PHASE_CHOICES],
    ["populations", POPULATION_CHOICES],
    ["sponsors", SPONSOR_CHOICES],
    ["statuses", STATUS_CHOICES],
  ] as const;

  for (const trial of trials) {
    for (const [dimension, choices] of dimensions) {
      assert(
        choices.filter((choice) => choice.value !== SHOW_ALL).some((choice) =>
          filterTrials([trial], {
            ...trialDefaults,
            [dimension]: [choice.value],
          }).length === 1
        ),
        `${trial.registryId} has an unfilterable ${dimension} value`,
      );
    }
  }
});

Deno.test("generated map metadata and coordinates are internally consistent", () => {
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(
      trialLocationsGeneratedAt,
    ),
  );
  assert(!Number.isNaN(Date.parse(trialLocationsGeneratedAt)));

  const expectedNctIds = trials
    .map((trial) => trial.registryId)
    .filter((id) => /^NCT\d{8}$/i.test(id))
    .map((id) => id.toUpperCase());
  assertEquals(
    [...new Set(rawGeocodedJson.nctIds)].sort(),
    [...new Set(expectedNctIds)].sort(),
  );

  const knownNctIds = new Set(rawGeocodedJson.nctIds);
  for (const [index, location] of trialLocations.entries()) {
    assert(typeof location.nctId === "string");
    for (const field of LOCATION_NULLABLE_STRING_FIELDS) {
      assert(
        location[field] === null || typeof location[field] === "string",
        `geocoded row ${index} field ${field} must be a string or null`,
      );
      if (location[field] !== null) {
        assertEquals(location[field], location[field].trim());
      }
    }
    assert(knownNctIds.has(location.nctId));
    assert(Number.isFinite(location.lat));
    assert(Number.isFinite(location.lon));
    assert(location.lat >= -90 && location.lat <= 90);
    assert(location.lon >= -180 && location.lon <= 180);
  }
});
