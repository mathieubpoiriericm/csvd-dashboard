/**
 * hg38 cytobands: the karyogram's geometry, and the band → coordinate lookup
 * that places a gene from its `chromosomalLocation` string.
 *
 * `data/cytobands_hg38.json` is written by `scripts/fetch_cytobands.py` from
 * UCSC `cytoBandIdeo.txt.gz` (`deno task cytobands`) and committed like every
 * other data file; nothing fetches at build or run time.
 */

import cytobandsJson from "../data/cytobands_hg38.json" with { type: "json" };

/** The UCSC `gieStain` values, in the order the encoding's `stains` map lists them. */
export const STAINS = [
  "gneg",
  "gpos25",
  "gpos50",
  "gpos75",
  "gpos100",
  "acen",
  "gvar",
  "stalk",
] as const;

export interface Band {
  name: string;
  start: number;
  end: number;
  stain: string;
}

export interface Chromosome {
  name: string;
  length: number;
  bands: Band[];
}

export interface CytobandTable {
  assembly: string;
  source: string;
  chromosomes: Chromosome[];
}

export const cytobands: CytobandTable = cytobandsJson;

export interface BandHit {
  chromosome: string;
  band: string;
  start: number;
  end: number;
  midpoint: number;
}

/** `7q31.1` → chromosome `7`, band `q31.1`. Anchored: `23q11` and `7q31.1x` fail. */
const LOCATION = /^(\d{1,2}|X|Y)([pq]\d+(?:\.\d+)?)$/;

/**
 * The band a location names, or null. Exact match only: a location naming a
 * parent band (`7q31`) or a chromosome the table lacks is unplaced rather
 * than guessed, so a bad string can never land silently on the wrong band.
 */
export function placeGene(
  location: string,
  table: CytobandTable = cytobands,
): BandHit | null {
  const match = LOCATION.exec(location.trim());
  if (!match) return null;
  const [, chromosome, bandName] = match;
  const band = table.chromosomes.find((c) => c.name === chromosome)?.bands
    .find((b) => b.name === bandName);
  if (!band) return null;
  return {
    chromosome,
    band: bandName,
    start: band.start,
    end: band.end,
    midpoint: (band.start + band.end) / 2,
  };
}
