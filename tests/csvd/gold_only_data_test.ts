/**
 * While gold-only is on, the published tables are the hand-curated gold
 * tables and nothing else: every gene in Table 1 and every registry id in
 * Table 2 comes from `disease/gold/out/`, and none of them is missing. The
 * lookup files beside them are keyed by gold ids alone: the NCBI, UniProt and
 * PubMed records, the OMIM entries gold links to, and the disease annotations.
 *
 * `scripts/load_gold.py` writes the database from these CSVs; this pins
 * that `deno task data` published exactly what it wrote, so a pipeline run
 * that slipped a gene, trial, reference or lookup in shows up here.
 */
import { assertEquals } from "@std/assert";

import annotations from "../../data/gene_annotations.json" with {
  type: "json",
};
import geneInfo from "../../data/gene_info.json" with { type: "json" };
import trialGeneInfo from "../../data/gene_info_table2.json" with {
  type: "json",
};
import omimInfo from "../../data/omim_info.json" with { type: "json" };
import proteinInfo from "../../data/protein_info.json" with { type: "json" };
import refs from "../../data/refs.json" with { type: "json" };
import table1 from "../../data/table1.json" with { type: "json" };
import table2 from "../../data/table2.json" with { type: "json" };

const GOLD_DIR = new URL("../../disease/gold/out/", import.meta.url);

/** RFC 4180 rows: quoted fields may hold commas, quotes and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function goldColumn(file: string, column: string): string[] {
  const text = Deno.readTextFileSync(new URL(file, GOLD_DIR)).replace(
    /^﻿/,
    "",
  );
  const [header, ...rows] = parseCsv(text);
  const index = header.indexOf(column);
  if (index < 0) throw new Error(`${file} has no ${column} column`);
  return rows.map((row) => row[index]);
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

Deno.test("Table 1 publishes exactly the gold genes, one row each", () => {
  const goldGenes = goldColumn("st1_genes.csv", "gene");
  assertEquals(table1.length, goldGenes.length);
  assertEquals(sorted(table1.map((row) => row.gene)), sorted(goldGenes));
});

Deno.test("Table 2 publishes exactly the gold trials", () => {
  const goldIds = goldColumn("st3_trials.csv", "registry_id");
  assertEquals(table2.length, goldIds.length);
  assertEquals(sorted(table2.map((row) => row.registryId)), sorted(goldIds));
});

const goldGenes = sorted(goldColumn("st1_genes.csv", "gene"));

Deno.test("the NCBI and UniProt lookups are keyed by exactly the gold genes", () => {
  // An alias key such as COL4A1/2 carries a row per member symbol, each
  // under the gold key.
  assertEquals(sorted(geneInfo.map((row) => row.name)), goldGenes);
  assertEquals(sorted(proteinInfo.map((row) => row.gene)), goldGenes);
});

Deno.test("the PubMed lookup holds exactly the PMIDs gold cites", () => {
  // References are separated by ";" or ","; a DOI reference has no PubMed
  // record and so no row.
  const pmids = goldColumn("st1_genes.csv", "references")
    .flatMap((cell) => cell.split(/[;,]/))
    .map((reference) => reference.trim())
    .filter((reference) => /^\d+$/.test(reference));
  assertEquals(sorted(refs.map((row) => row.pmid)), sorted(pmids));
});

Deno.test("the OMIM lookup holds exactly the entries gold links to", () => {
  const numbers = goldColumn("st1_genes.csv", "monogenic")
    .flatMap((cell) => cell.match(/\b\d{6}\b/g) ?? []);
  assertEquals(
    sorted(omimInfo.map((row) => String(row.omimNum))),
    sorted(numbers),
  );
});

Deno.test("the trials' NCBI lookup is keyed by exactly the gold targets", () => {
  // A target is looked up by its symbol: "GWAS for ischemic stroke: PDE3A"
  // by PDE3A.
  const targets = goldColumn("st3_trials.csv", "genetic_target")
    .flatMap((cell) => cell.split(/[,;/]/))
    .map((target) => target.trim().replace(/^[^:]*:\s+/, ""))
    .filter((target) => target !== "");
  assertEquals(sorted(trialGeneInfo.map((row) => row.name)), sorted(targets));
});

Deno.test("every disease annotation belongs to a gold gene", () => {
  const gold = new Set(goldGenes);
  assertEquals(
    sorted(annotations.map((row) => row.geneSymbol))
      .filter((symbol) => !gold.has(symbol)),
    [],
  );
});
