import { assertEquals } from "@std/assert";

import { indexGeneInfoByName } from "../lib/data/gene_info.ts";
import { indexOmimByNumber } from "../lib/data/omim.ts";
import { indexProteinInfoByGene } from "../lib/data/protein_info.ts";
import { indexReferencesByPmid } from "../lib/data/references.ts";
import { indexTrialGeneInfoByName } from "../lib/data/trial_lookups.ts";
import type { GeneInfo } from "../lib/types.ts";

Deno.test("gene lookup indexes discard malformed rows and normalize safe rows", () => {
  const rows = [
    null,
    [],
    { name: 7 },
    { name: " " },
    {
      name: " NOTCH3 ",
      uid: " 4854 ",
      description: 7,
      otheraliases: " ",
    },
  ];
  const expected: [string, GeneInfo][] = [[
    "NOTCH3",
    {
      name: "NOTCH3",
      uid: "4854",
      description: null,
      otheraliases: null,
    },
  ]];

  assertEquals([...indexGeneInfoByName(rows)], expected);
  assertEquals([...indexTrialGeneInfoByName(rows)], expected);
  assertEquals([...indexGeneInfoByName({ name: "NOTCH3" })], []);
});

Deno.test("protein lookup rejects unusable keys without touching optional fields", () => {
  assertEquals(
    [...indexProteinInfoByGene([
      null,
      {},
      { gene: 42 },
      { gene: " COL4A1 ", accession: " P02462 ", url: [] },
    ])],
    [[
      "COL4A1",
      {
        gene: "COL4A1",
        accession: "P02462",
        url: null,
      },
    ]],
  );
  assertEquals([...indexProteinInfoByGene(null)], []);
});

Deno.test("OMIM lookup requires a positive integer identity", () => {
  assertEquals(
    [...indexOmimByNumber([
      null,
      [],
      { omimNum: "617168" },
      { omimNum: 0 },
      {
        omimNum: 617168,
        omimLink: " https://www.omim.org/entry/617168 ",
        phenotype: 7,
        inheritance: " AD ",
        geneOrLocus: null,
        geneOrLocusMimNumber: " 153455 ",
      },
    ])],
    [[
      "617168",
      {
        omimNum: 617168,
        omimLink: "https://www.omim.org/entry/617168",
        phenotype: "",
        inheritance: "AD",
        geneOrLocus: "",
        geneOrLocusMimNumber: "153455",
      },
    ]],
  );
  assertEquals([...indexOmimByNumber({ omimNum: 617168 })], []);
});

Deno.test("reference lookup requires a string PMID and makes display fields safe", () => {
  assertEquals(
    [...indexReferencesByPmid([
      null,
      [],
      { pmid: 37063705 },
      { pmid: "not-a-pmid" },
      {
        pmid: " 37063705 ",
        authors: " Example et al. ",
        title: {},
        journal: " ",
        publicationDate: null,
        doi: [],
        formattedRef: 7,
      },
    ])],
    [[
      "37063705",
      {
        pmid: "37063705",
        authors: "Example et al.",
        title: null,
        journal: null,
        publicationDate: null,
        doi: null,
        formattedRef: "PMID: 37063705 (citation not available)",
      },
    ]],
  );
  assertEquals([...indexReferencesByPmid(undefined)], []);
});
