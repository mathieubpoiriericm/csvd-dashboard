/** The trial populations: the radar's sectors and the population filter. */

import type { Population } from "../types.ts";
import { manifest } from "./manifest.ts";

export const POPULATIONS: readonly Population[] = manifest.populations;

/** Column header and filter label for the population column. */
export const POPULATION_FIELD: { label: string; detailsLabel: string } =
  manifest.populationField;
