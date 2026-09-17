/** Latest pipeline-run summary and its runtime normalization boundary. */

import pipelineStatusJson from "../../data/pipeline_status.json" with {
  type: "json",
};

import type { PipelineStatus } from "../types.ts";
import { nonnegativeInteger, nullableText } from "./normalize.ts";

/** Null until the pipeline has recorded a complete, valid run. */
export function normalizePipelineStatus(
  value: unknown,
): PipelineStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<PipelineStatus>;
  const runTimestamp = nullableText(row.runTimestamp);
  const papersProcessed = nonnegativeInteger(row.papersProcessed);
  const fulltextRetrieved = nonnegativeInteger(row.fulltextRetrieved);
  const genesExtracted = nonnegativeInteger(row.genesExtracted);
  const genesValidated = nonnegativeInteger(row.genesValidated);

  if (
    runTimestamp === null || papersProcessed === null ||
    fulltextRetrieved === null || genesExtracted === null ||
    genesValidated === null
  ) return null;

  return {
    runTimestamp,
    papersProcessed,
    fulltextRetrieved,
    genesExtracted,
    genesValidated,
  };
}

export const pipelineStatus = normalizePipelineStatus(pipelineStatusJson);
