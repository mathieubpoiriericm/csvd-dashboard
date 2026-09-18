/** Abbreviation expansions for the curated cell-type column. */

import { manifest } from "./manifest.ts";

/** Column header, e.g. "Brain Cell Types". */
export const CELL_TYPES_LABEL: string = manifest.cellTypes.label;

/** Abbreviation → full name, shown in the column's tooltips. */
export const CELL_TYPE_NAMES: Record<string, string> =
  manifest.cellTypes.glossary;
