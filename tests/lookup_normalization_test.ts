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
      name: " GENE1 ",
      uid: " 4854 ",
      description: 7,
      otheraliases: " ",
    },
  ];
  const expected: [string, GeneInfo[]][] = [[
    "GENE1",
    [{
      name: "GENE1",
      symbol: "GENE1",
      uid: "4854",
      description: null,
      otheraliases: null,
    }],
  ]];

  assertEquals([...indexGeneInfoByName(rows)], expected);
  assertEquals([...indexTrialGeneInfoByName(rows)], expected);
  assertEquals([...indexGeneInfoByName({ name: "GENE1" })], []);
});

/**
 * An alias key is published as one lookup row per member gene, so a key
 * maps to every row it has, in file order. A file written before `symbol`
 * existed, or one carrying a blank symbol, still indexes: the symbol falls
 * back to the key, which is what it was then.
 */
Deno.test("gene lookup rows group under their key and default the symbol to it", () => {
  const index = indexGeneInfoByName([
    { name: "PAIR", symbol: " GENEA ", uid: "1" },
    { name: "PAIR", symbol: "GENEB", uid: "2" },
    { name: "OLD", uid: "3" },
    { name: "BLANK", symbol: "  ", uid: "4" },
  ]);
  assertEquals(index.get("PAIR")!.map((row) => row.symbol), [
    "GENEA",
    "GENEB",
  ]);
  assertEquals(index.get("OLD")!.map((row) => row.symbol), ["OLD"]);
  assertEquals(index.get("BLANK")!.map((row) => row.symbol), ["BLANK"]);
  assertEquals(
    indexTrialGeneInfoByName([
      { name: "PAIR", symbol: "GENEA" },
      { name: "PAIR", symbol: "GENEB" },
    ]).get("PAIR")!.length,
    2,
  );
});

Deno.test("protein lookup rows group under their gene and default the symbol to it", () => {
  const index = indexProteinInfoByGene([
    { gene: "PAIR", symbol: "GENEA", accession: "P1" },
    { gene: "PAIR", symbol: "GENEB", accession: "P2" },
    { gene: "OLD", accession: "P3" },
    { gene: "BLANK", symbol: " ", accession: "P4" },
  ]);
  assertEquals(index.get("PAIR")!.map((row) => row.symbol), [
    "GENEA",
    "GENEB",
  ]);
  assertEquals(index.get("OLD")!.map((row) => row.symbol), ["OLD"]);
  assertEquals(index.get("BLANK")!.map((row) => row.symbol), ["BLANK"]);
});

Deno.test("protein lookup rejects unusable keys without touching optional fields", () => {
  assertEquals(
    [...indexProteinInfoByGene([
      null,
      {},
      { gene: 42 },
      { gene: " GENE1 ", accession: " P02462 ", url: [] },
    ])],
    [[
      "GENE1",
      [{
        gene: "GENE1",
        symbol: "GENE1",
        accession: "P02462",
        url: null,
      }],
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

Deno.test("reference lookup keeps a preprint keyed by its DOI", () => {
  const doi = "10.1000/preprint.1";
  assertEquals(
    [...indexReferencesByPmid([{ pmid: doi }])],
    [[doi, {
      pmid: doi,
      authors: null,
      title: null,
      journal: null,
      publicationDate: null,
      doi: null,
      formattedRef: `DOI: ${doi} (citation not available)`,
    }]],
  );
});
