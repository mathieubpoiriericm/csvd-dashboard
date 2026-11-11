/**
 * What the run card says, derived from the report.
 *
 * The card (`islands/PipelineRun.tsx`) renders what these functions return
 * and decides nothing itself: what a step's row reads, which warnings need a
 * look, what the verdict row holds. They are here rather than in the island
 * because `jsx: "precompile"` leaves a component's branches out of a test's
 * reach, and `lib/` is held to full coverage.
 *
 * Every word still comes from `lib/pipeline_encoding.json`.
 */

import encoding from "./pipeline_encoding.json" with { type: "json" };

import type { IconName } from "../components/Icon.tsx";
import { formatCount } from "./format.ts";
import { field, stepStatusBadge } from "./pipeline_display.ts";
import type { PipelineRun, RunStep } from "./types.ts";

/**
 * The two things the report counts, and the papers they come from.
 *
 * A finding is one paper's proposal of a gene; a gene is a row of the
 * database. The widget used "gene" for both, so "10 accepted" beside "5
 * written" read as a contradiction where it is two facts.
 */
export type Noun = keyof typeof encoding.nouns;

const NOUNS = encoding.nouns as Record<Noun, string[]>;

const WARNING_KINDS = encoding.warningKinds as Record<
  string,
  { review: boolean; flag?: string[] }
>;

/** A count and the noun it counts, in that noun's number: "1 gene". */
export function counted(count: number, noun: Noun): string {
  const [one, many] = NOUNS[noun];
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/**
 * Whether a warning of this kind needs a look.
 *
 * A routine one -- the fallback model serving a paper, a finding under a
 * floor -- is the run working as designed. A kind the encoding has never
 * seen needs a look: the pipeline raised something nobody has judged yet,
 * and reading that as routine is the wrong way to be wrong.
 */
export function isReview(kind: string): boolean {
  return WARNING_KINDS[kind]?.review ?? true;
}

function reviewWarnings(step: RunStep) {
  return step.warnings.filter((warning) => isReview(warning.kind));
}

/**
 * How many notes across the run need a look.
 *
 * Notes, not the things they name: 34 papers served by the fallback model
 * are one fact about the run, and "49" beside a healthy run was the sum of
 * three notes' subjects.
 */
export function reviewCount(run: PipelineRun): number {
  return run.steps.reduce(
    (total, step) => total + reviewWarnings(step).length,
    0,
  );
}

/** What a step's row is flagged with: a tint, a glyph and words. */
export interface Flag {
  tint: "ember" | "danger";
  icon: IconName;
  label: string;
}

/**
 * A step's flag, or `null` when the row needs none.
 *
 * A failed step says so whatever else it warned of. One review warning is
 * named, with its own count, since the row has room to say what it is;
 * several are counted, since it has not. A passing step carries nothing --
 * "Passed" on every row said the default six times.
 */
export function stepFlag(step: RunStep): Flag | null {
  if (step.status === "failed") {
    const failed = stepStatusBadge("failed");
    return { tint: "danger", icon: failed.icon, label: failed.label };
  }
  const review = reviewWarnings(step);
  if (review.length === 0) return null;
  const toReview = field("toReview");
  const [only] = review;
  const named = review.length === 1
    ? WARNING_KINDS[only.kind]?.flag
    : undefined;
  const label = named
    ? `${formatCount(only.count)} ${only.count === 1 ? named[0] : named[1]}`
    : `${formatCount(review.length)} ${toReview.label}`;
  return { tint: "ember", icon: toReview.icon, label };
}
