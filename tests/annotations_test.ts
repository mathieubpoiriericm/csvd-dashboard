import { assert, assertEquals } from "@std/assert";

import {
  geneAnnotations,
  normalizeAnnotation,
  normalizeAnnotations,
} from "../lib/data/annotations.ts";
import type { GeneAnnotation } from "../lib/types.ts";
import rawAnnotationJson from "../data/gene_annotations.json" with {
  type: "json",
};

const WIRE_KEYS = [
  "geneSymbol",
  "groupKey",
  "diseaseName",
  "omimId",
  "mondoId",
  "orphacode",
  "medgenId",
  "omimSeries",
  "classification",
  "recordCount",
  "relatedXrefs",
  "sourceVersions",
];

// -----------------------------------------------------------------------------
// THE RAW COMMITTED FILE
// -----------------------------------------------------------------------------

Deno.test("every committed annotation row carries the full wire shape", () => {
  // Vacuous on the empty export a fork starts from; that the committed file
  // has rows at all is pinned in tests/csvd/annotations_test.ts.
  const rows = rawAnnotationJson as Record<string, unknown>[];
  for (const row of rows) {
    assertEquals(Object.keys(row), WIRE_KEYS);
  }
});

Deno.test("the two list fields are always arrays", () => {
  // The same invariant tests/data_contract_test.ts pins for Gene's four list
  // columns: Python lists serialise as JSON arrays unconditionally, so a
  // consumer never has to guard for a bare string.
  for (const row of rawAnnotationJson as Record<string, unknown>[]) {
    assert(Array.isArray(row.omimSeries), `${row.geneSymbol}: omimSeries`);
    assert(Array.isArray(row.relatedXrefs), `${row.geneSymbol}: relatedXrefs`);
  }
});

Deno.test("an omimId is always a bare six-digit MIM number", () => {
  // A phenotypic series names a group of phenotypes, so it is not the
  // disease's own number and omimByNumber could never resolve one. Six rows
  // shipped one here before the export learned to separate them.
  for (const row of geneAnnotations) {
    if (row.omimId === null) continue;
    assert(
      /^\d{6}$/.test(row.omimId),
      `${row.geneSymbol}: omimId ${row.omimId} is not a six-digit entry`,
    );
  }
});

Deno.test("every MONDO identifier is zero-padded to the authority width", () => {
  // Orphadata returns MONDO ids both padded and bare. HTRA1 shipped
  // "MONDO:18831", which resolves to nothing and can never join ClinVar's
  // "MONDO:0018831".
  for (const row of geneAnnotations) {
    const ids = [
      row.mondoId,
      row.groupKey,
      ...row.relatedXrefs.map((xref) => xref.id),
    ];
    for (const id of ids) {
      if (id === null || !id.startsWith("MONDO:")) continue;
      assert(
        /^MONDO:\d{7}$/.test(id),
        `${row.geneSymbol}: ${id} is not a 7-digit MONDO identifier`,
      );
    }
  }
});

Deno.test("a published identifier is never repeated as a related concept", () => {
  // Orphanet:1885 maps BTNT to the very OMIM number ClinVar attests for
  // ADAMTSL4; listing it under relatedXrefs too would read as a second,
  // different disease.
  for (const row of geneAnnotations) {
    const named = new Set(
      [
        row.omimId === null ? null : `OMIM:${row.omimId}`,
        row.mondoId,
        row.orphacode === null ? null : `Orphanet:${row.orphacode}`,
        row.medgenId === null ? null : `MedGen:${row.medgenId}`,
      ].filter((entry): entry is string => entry !== null),
    );
    for (const xref of row.relatedXrefs) {
      assert(
        !named.has(xref.id),
        `${row.geneSymbol} ${row.groupKey}: ${xref.id} is both an identifier ` +
          "of this disease and a related concept",
      );
    }
  }
});

Deno.test("a related cross-reference carries a canonical prefixed id", () => {
  for (const row of geneAnnotations) {
    for (const xref of row.relatedXrefs) {
      assert(
        xref.id.includes(":"),
        `${row.geneSymbol}: ${xref.id} is not a canonical PREFIX:LOCALID`,
      );
    }
  }
});

// -----------------------------------------------------------------------------
// THE NORMALIZATION BOUNDARY
// -----------------------------------------------------------------------------

Deno.test("normalization keeps every committed row", () => {
  assertEquals(geneAnnotations.length, (rawAnnotationJson as unknown[]).length);
});

Deno.test("committed annotations are unique by gene and disease together", () => {
  const keys = geneAnnotations.map((row) =>
    JSON.stringify([row.geneSymbol, row.groupKey])
  );
  assertEquals(new Set(keys).size, geneAnnotations.length);
});

Deno.test("normalizeAnnotation defends the boundary against a malformed row", () => {
  // A partially generated or older file must not crash or silently poison the
  // UI -- the same contract lib/data.ts holds for every other dataset.
  assertEquals(
    normalizeAnnotation(
      {
        geneSymbol: "  HTRA1  ",
        groupKey: " ",
        diseaseName: 42,
        omimId: "",
        mondoId: null,
        orphacode: undefined,
        medgenId: "  C6022615  ",
        omimSeries: "PS143890",
        classification: " Pathogenic ",
        recordCount: -1,
        relatedXrefs: [
          { id: " OMIM:225200 ", relation: " BTNT " },
          { id: "", relation: "E" },
          null,
          "OMIM:129600",
          { id: "MeSH:D004479" },
        ],
        sourceVersions: { clinvar: 7, "  ": "x", orphadata: " 2026-06-23 " },
      } as unknown as Partial<GeneAnnotation>,
    ),
    {
      geneSymbol: "HTRA1",
      groupKey: "(unknown)",
      diseaseName: "(unknown)",
      omimId: null,
      mondoId: null,
      orphacode: null,
      medgenId: "C6022615",
      omimSeries: [],
      classification: "Pathogenic",
      recordCount: null,
      relatedXrefs: [
        { id: "OMIM:225200", relation: "BTNT" },
        { id: "MeSH:D004479", relation: null },
      ],
      sourceVersions: { clinvar: null, orphadata: "2026-06-23" },
    },
  );
});

Deno.test("normalizeAnnotation keeps a well-formed list", () => {
  const row = normalizeAnnotation({
    geneSymbol: "APOE",
    groupKey: "OMIM:143890",
    omimSeries: ["PS143890"],
  });
  assertEquals(row.omimSeries, ["PS143890"]);
});

Deno.test("annotation normalization accepts malformed rows and top-level values", () => {
  assertEquals(normalizeAnnotation(null), normalizeAnnotation({}));
  assertEquals(normalizeAnnotations({ geneSymbol: "APOE" }), []);
  assertEquals(normalizeAnnotations([null]), [normalizeAnnotation({})]);
});
