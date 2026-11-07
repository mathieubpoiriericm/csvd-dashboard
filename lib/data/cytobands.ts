/**
 * The hg38 cytoband table. Imported here rather than in lib/cytobands.ts so
 * it ships in a protected chunk of its own, like every other data file.
 */

import cytobandsJson from "../../data/cytobands_hg38.json" with {
  type: "json",
};

export const rawCytobands = cytobandsJson;
