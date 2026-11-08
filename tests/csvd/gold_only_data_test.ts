/**
 * While gold-only is on, the published tables are the hand-curated gold
 * tables and nothing else: every gene in Table 1 and every registry id in
 * Table 2 comes from `disease/gold/out/`, and none of them is missing.
 *
 * `scripts/load_gold.py` writes the database from these CSVs; this pins
 * that `deno task data` published exactly what it wrote, so a pipeline run
 * that slipped a gene or trial in shows up here.
 */
import { assertEquals } from "@std/assert";

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
