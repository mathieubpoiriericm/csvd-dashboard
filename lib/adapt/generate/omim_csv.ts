import type { Answers } from "../answers.ts";
import { clean, csvLine } from "./json.ts";

const HEADER = [
  "omim_num",
  "omim_link",
  "location",
  "phenotype",
  "phenotype_mim_number",
  "inheritance",
  "phenotype_mapping_key",
  "gene_or_locus",
  "gene_or_locus_mim_number",
];

export function omimLink(num: string): string {
  return `https://www.omim.org/entry/${num}?search=${num}&highlight=${num}`;
}

/**
 * A field as read_omim_csv reads it back: a non-breaking space or any other
 * run of whitespace is one plain space, so the file holds what the export
 * publishes, and stays the ASCII test_omim.py requires.
 */
const field = (value: string): string => clean(value).replace(/\s+/g, " ");

export function generateOmimCsv(answers: Answers): string {
  const rows = answers.monogenic.omimRows.map((r) =>
    csvLine([
      field(r.omimNum),
      omimLink(field(r.omimNum)),
      field(r.location),
      field(r.phenotype),
      field(r.phenotypeMimNumber),
      field(r.inheritance),
      field(r.phenotypeMappingKey),
      field(r.geneOrLocus),
      field(r.geneOrLocusMimNumber),
    ])
  );
  return [csvLine(HEADER), ...rows].join("\n") + "\n";
}
