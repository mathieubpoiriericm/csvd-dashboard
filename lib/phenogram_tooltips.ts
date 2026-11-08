/** Tooltip content used only by the phenogram. */

import { NONE_FOUND } from "./constants.ts";
import { geneInfoByName } from "./data/gene_info.ts";
import { omimByNumber } from "./data/omim.ts";
import vocabulary from "../disease/vocabulary.json" with { type: "json" };
import { citationLink, definitionLabel } from "./disease/citation.ts";
import { COLOCALIZATION_LABEL } from "./acronyms.ts";
import { formatOmicsValue } from "./filters.ts";
import { colocalizedItems, parseOmicsEntry } from "./omics.ts";
import type { TraitEncoding } from "./phenogram.ts";
import {
  ncbiGeneLink,
  optionalText,
  present,
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

/**
 * The tissues that colocalized significantly, entry by entry -- the panel's
 * stand-in for the `*` the omics row no longer prints, and absent when no
 * entry has one.
 */
function colocalizationRows(values: readonly string[]): TooltipRow[] {
  const entries = values.map(parseOmicsEntry).flatMap((entry) => {
    const items = colocalizedItems(entry);
    if (items.length === 0) return [];
    const study = entry.biomarker
      ? `${entry.type} (${entry.biomarker})`
      : entry.type;
    return [`${study}: ${items.join(", ")}`];
  });
  return entries.length > 0
    ? [{ label: COLOCALIZATION_LABEL, value: entries.join("; ") }]
    : [];
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
    ...colocalizationRows(gene.evidenceFromOtherOmicsStudies),
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
  // `citationLink()` is undefined in a fork that names no standard; `present`
  // drops it without a branch only one of the two datasets could reach.
  return {
    rows,
    links: present([trait.standard ? citationLink() : undefined]),
  };
}
