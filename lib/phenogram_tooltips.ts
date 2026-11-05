/** Tooltip content used only by the phenogram. */

import { NONE_FOUND } from "./constants.ts";
import { geneInfoByName } from "./data/gene_info.ts";
import { omimByNumber } from "./data/omim.ts";
import vocabulary from "../disease/vocabulary.json" with { type: "json" };
import { citationLink, definitionLabel } from "./disease/citation.ts";
import { formatOmicsValue } from "./filters.ts";
import type { TraitEncoding } from "./phenogram.ts";
import {
  ncbiGeneLink,
  optionalText,
  type TooltipContent,
  type TooltipRow,
} from "./tooltip_content.ts";
import type { Gene, GeneInfo, OmimEntry } from "./types.ts";

// Import the vocabulary JSON directly: value-importing `phenogram.ts` for its
// composed `encoding` would pull the 113 KB cytoband table into every tooltip
// consumer. Labels come from the vocabulary, the citation from the manifest.
const TRAIT_LABELS = new Map(vocabulary.traits.map((trait) => [
  trait.key,
  trait.label,
]));

function joined(
  values: readonly string[],
  render: (value: string) => string,
): string {
  const present = values.filter((value) => value !== NONE_FOUND);
  return present.length ? present.map(render).join("; ") : "None found";
}

/** The two caches the panel resolves against; tests hand in their own. */
export interface PhenogramLookups {
  omim: ReadonlyMap<string, OmimEntry>;
  geneInfo: ReadonlyMap<string, readonly GeneInfo[]>;
}

/** Complete verbal counterpart to one gene's visual encoding. */
export function phenogramTooltip(
  gene: Gene,
  { omim = omimByNumber, geneInfo = geneInfoByName }: Partial<
    PhenogramLookups
  > = {},
): TooltipContent {
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
      value: joined(gene.evidenceFromOtherOmicsStudies, formatOmicsValue),
    },
    {
      label: "Monogenic disease",
      value: joined(
        gene.linkToMonogenicDisease,
        (value) => optionalText(omim.get(value.trim())?.phenotype) ?? value,
      ),
    },
    { label: "Mendelian randomization", value: gene.mendelianRandomization },
  ];
  // One NCBI link per lookup row with a uid: an alias key is published as
  // one row per member gene, and each link then names its member.
  const infos = geneInfo.get(gene.gene) ?? [];
  const several = infos.length > 1;
  return {
    rows,
    links: infos.flatMap((info) => {
      const link = ncbiGeneLink(
        optionalText(info.uid),
        several ? info.symbol : undefined,
      );
      return link ? [link] : [];
    }),
  };
}

export function phenotypeTooltip(trait: TraitEncoding): TooltipContent {
  const rows: TooltipRow[] = [{ label: trait.label, value: trait.name }];
  if (trait.definition) {
    rows.push({ label: definitionLabel(), value: trait.definition });
  }
  const citation = trait.standard ? citationLink() : undefined;
  return { rows, links: citation ? [citation] : [] };
}
