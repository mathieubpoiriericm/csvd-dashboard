/** Tooltip content used only by the phenogram. */

import { NONE_FOUND } from "./constants.ts";
import { geneInfoByName } from "./data/gene_info.ts";
import { omimByNumber } from "./data/omim.ts";
import encodingJson from "./phenogram_encoding.json" with { type: "json" };
import vocabulary from "./vocabulary.json" with { type: "json" };
import type { TraitEncoding } from "./phenogram.ts";
import {
  ncbiGeneLink,
  optionalText,
  type TooltipContent,
  type TooltipRow,
} from "./tooltip_content.ts";
import type { Gene } from "./types.ts";

// Import both JSON files directly: value-importing `phenogram.ts` for its
// composed `encoding` would pull the 113 KB cytoband table into every tooltip
// consumer. Labels come from the vocabulary, the citation from the encoding.
const TRAIT_LABELS = new Map(vocabulary.traits.map((trait) => [
  trait.key,
  trait.label,
]));
const STRIVE_LINK = {
  href: `https://doi.org/${encodingJson.citation.doi}`,
  label: "View STRIVE-2 (Lancet Neurol 2023)",
};

function joined(
  values: readonly string[],
  render: (value: string) => string = (value) => value,
): string {
  const present = values.filter((value) => value !== NONE_FOUND);
  return present.length ? present.map(render).join("; ") : "None found";
}

/** Complete verbal counterpart to one gene's visual encoding. */
export function phenogramTooltip(gene: Gene): TooltipContent {
  const rows: TooltipRow[] = [
    { label: "Location", value: gene.chromosomalLocation },
    {
      label: "GWAS phenotypes",
      value: joined(
        gene.gwasTrait,
        (value) => TRAIT_LABELS.get(value) ?? value,
      ),
    },
    {
      label: "Other omics",
      value: joined(gene.evidenceFromOtherOmicsStudies),
    },
    {
      label: "Monogenic disease",
      value: joined(
        gene.linkToMonogenicDisease,
        (value) =>
          optionalText(omimByNumber.get(value.trim())?.phenotype) ?? value,
      ),
    },
    { label: "Mendelian randomization", value: gene.mendelianRandomization },
  ];
  const uid = optionalText(geneInfoByName.get(gene.gene)?.uid);
  return {
    rows,
    link: ncbiGeneLink(uid),
  };
}

export function phenotypeTooltip(trait: TraitEncoding): TooltipContent {
  const rows: TooltipRow[] = [{ label: trait.label, value: trait.name }];
  if (trait.definition) {
    rows.push({ label: "STRIVE-2 definition", value: trait.definition });
  }
  return { rows, link: trait.strive ? STRIVE_LINK : undefined };
}
