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

const OUTCOMES = encoding.outcomes;

/** The disclosure over a note's remaining subjects: "Show all 34". */
export const SHOW_ALL = OUTCOMES.showAll;

/** What a step with nothing to say reads, on the card and in the step log. */
export const NOTHING_TO_REPORT = OUTCOMES.nothing;

/** The noun in the number `count` takes: "gene" for one, "genes" otherwise. */
function nounFor(count: number, noun: Noun): string {
  const [one, many] = NOUNS[noun];
  return count === 1 ? one : many;
}

/** A count and the noun it counts, in that noun's number: "1 gene". */
export function counted(count: number, noun: Noun): string {
  return `${formatCount(count)} ${nounFor(count, noun)}`;
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

/**
 * One part of a step's row: a figure and the words after it.
 *
 * `value` is drawn as a numeral; a part with none is a muted clause that
 * breaks the figure before it down ("10 full text, 5 abstract only").
 */
export interface Segment {
  value: string | null;
  text: string;
}

/**
 * What came out of a step. `quiet` marks a sentence rather than a readout:
 * the step's own words, "Not reached", or nothing to report.
 */
export interface StepOutcome {
  lines: Segment[][];
  quiet: boolean;
}

const figure = (count: number, text: string): Segment => ({
  value: formatCount(count),
  text,
});

const clause = (parts: Array<[number, string]>): Segment => ({
  value: null,
  text: parts.map(([count, text]) => `${formatCount(count)} ${text}`)
    .join(", "),
});

const sentence = (text: string): StepOutcome => ({
  lines: [[{ value: null, text }]],
  quiet: true,
});

/** A count and a label, kept only when the count is above zero. */
const present = (parts: Array<[number, string]>) =>
  parts.filter(([count]) => count > 0);

/**
 * The readout for a step the card knows, from the run's own counts, or
 * `null` when a count it would print was never recorded.
 *
 * The counts are the run's, not the step's: the report holds one set, and
 * each belongs to the step that produced it. Per-finding validation happens
 * inside `processing_papers`; `batch_validation` is the cross-check after
 * it, so "passed" and "rejected" sit on the former.
 */
function readout(run: PipelineRun, key: string): Segment[][] | null {
  const { papers, genes, database } = run;
  switch (key) {
    case "searching_pubmed": {
      if (papers.found === null) return null;
      // Of what the count is a count: the window the run searched, when it
      // recorded one. Without it "1,571 papers matched" matched nothing in
      // particular.
      const days = run.config.daysBack;
      return [[
        figure(
          papers.found,
          `${nounFor(papers.found, "paper")} ${OUTCOMES.matched}`,
        ),
        ...(days === null ? [] : [{
          value: null,
          text: days === 1
            ? OUTCOMES.lastDay
            : OUTCOMES.lastDays.replace("{days}", formatCount(days)),
        }]),
      ]];
    }
    case "filtering_pmids":
      if (papers.newlySeen === null || papers.alreadySeen === null) {
        return null;
      }
      return [[
        figure(papers.newlySeen, OUTCOMES.new),
        figure(papers.alreadySeen, OUTCOMES.seenBefore),
      ]];
    case "processing_papers":
      return [
        [
          figure(papers.processed, OUTCOMES.read),
          clause([
            [papers.fulltext, OUTCOMES.fullText],
            [papers.abstractOnly, OUTCOMES.abstractOnly],
            ...present([
              [papers.noTextAvailable, OUTCOMES.noText],
              [papers.failed, OUTCOMES.failed],
            ]),
          ]),
        ],
        [
          figure(
            genes.extracted,
            `${nounFor(genes.extracted, "finding")} ${OUTCOMES.extracted}`,
          ),
          clause([
            [genes.validated, OUTCOMES.passedValidation],
            [genes.rejected, OUTCOMES.rejected],
          ]),
        ],
      ];
    case "batch_validation":
      return [[
        figure(
          genes.validated,
          `${nounFor(genes.validated, "finding")} ${OUTCOMES.crossChecked}`,
        ),
      ]];
    case "merging_database": {
      if (database === null) return null;
      const held = genes.rejectedAtInsertFloor;
      return [[
        figure(
          database.inserted,
          `${nounFor(database.inserted, "gene")} ${OUTCOMES.added}`,
        ),
        figure(database.updated, OUTCOMES.updated),
        ...(held > 0
          ? [figure(held, `${nounFor(held, "finding")} ${OUTCOMES.held}`)]
          : []),
      ]];
    }
    default:
      return null;
  }
}

/**
 * What the row for `run.steps[index]` says.
 *
 * A step that was not reached says so. A step the card knows reads out the
 * run's counts, once: a step can recur, and the second visit printing the
 * same totals would count them twice, so it falls back to its own sentences
 * -- as does a step the card does not know, and one whose counts the run
 * never recorded (an offline run searched nothing).
 */
export function stepOutcome(run: PipelineRun, index: number): StepOutcome {
  const step = run.steps[index];
  if (step.status === "skipped") {
    return sentence(stepStatusBadge("skipped").label);
  }
  const first = run.steps.findIndex((other) => other.key === step.key);
  const lines = first === index ? readout(run, step.key) : null;
  if (lines !== null) return { lines, quiet: false };
  return sentence(
    step.actions.length > 0 ? step.actions.join(". ") : NOTHING_TO_REPORT,
  );
}

/**
 * Whether a step's row opens. Only on something the row does not already
 * say: a note or an error. Its action sentences repeat the readout, and
 * opening a row to read it again is a dud click.
 */
export function isOpenable(step: RunStep): boolean {
  return step.warnings.length > 0 || step.error !== null;
}

/** Whether a warning's subject is a PubMed identifier, and so a link. */
export function isPmid(subject: string): boolean {
  return /^\d{1,9}$/.test(subject);
}

/**
 * A note's subjects, cut at what a note shows before its disclosure. The
 * rest stay in the page behind it rather than becoming "and 26 more".
 */
export function splitSubjects(
  subjects: string[],
  limit = 8,
): { shown: string[]; rest: string[] } {
  return { shown: subjects.slice(0, limit), rest: subjects.slice(limit) };
}

const VERDICT = encoding.verdict;

/** What the verdict's list of figures is, for a screen reader. */
export const FIGURES_LABEL = VERDICT.label;

/** The word between a figure and its denominator: "37 of 38". */
export const OF = VERDICT.of;

/** One figure of the verdict row: a numeral, what it is, and its breakdown. */
export interface Figure {
  key: "papers" | "genes" | "quotes";
  value: string;
  /** The denominator of "37 of 38", or `null` when the run recorded none. */
  of: string | null;
  label: string;
  sub: string;
}

/**
 * The verdict row: how much the run read, what it changed, and whether its
 * extractions were checked against their papers.
 *
 * A figure whose source the run never recorded is left out rather than
 * printed as a zero: a run that failed before its merge wrote nothing and
 * has no `database` block, and one that checked no quote has no rate.
 */
export function verdictFigures(run: PipelineRun): Figure[] {
  const { papers, genes, database } = run;
  const figures: Figure[] = [];
  // A paper with no retrievable text is counted as processed, so that no
  // later run fetches it again, and nobody read it: the figure is the
  // papers that had text, which is what its breakdown adds up to.
  const readCount = Math.max(0, papers.processed - papers.noTextAvailable);
  // The noun stands after the denominator when there is one: "1 of 38 new
  // papers read".
  const read = `${
    nounFor(papers.newlySeen ?? readCount, "paper")
  } ${VERDICT.read}`;
  figures.push({
    key: "papers",
    value: formatCount(readCount),
    of: papers.newlySeen === null ? null : formatCount(papers.newlySeen),
    label: papers.newlySeen === null ? read : `${VERDICT.new} ${read}`,
    sub: `${formatCount(papers.fulltext)} ${VERDICT.inFullText}, ${
      formatCount(papers.abstractOnly)
    } ${VERDICT.fromAbstract}`,
  });
  if (database !== null) {
    const written = database.inserted + database.updated;
    figures.push({
      key: "genes",
      value: formatCount(written),
      of: null,
      label: `${nounFor(written, "gene")} ${VERDICT.written}`,
      sub: `${formatCount(database.inserted)} ${VERDICT.added}, ${
        formatCount(database.updated)
      } ${VERDICT.updated}`,
    });
  }
  if (genes.quotesChecked > 0) {
    figures.push({
      key: "quotes",
      value: formatCount(genes.quotesVerbatim),
      of: formatCount(genes.quotesChecked),
      label: VERDICT.quotes,
      sub: VERDICT.quotesSub,
    });
  }
  return figures;
}

/**
 * What stands in for the verdict row on a failed run: where it stopped, and
 * what that means for the data the dashboard shows. `null` on any other run.
 *
 * The second sentence is the one a visiting researcher needs. A run that
 * stopped before its merge changed nothing they are looking at; one that
 * stopped after it did.
 */
export function stoppedNote(
  run: PipelineRun,
): { title: string; consequence: string } | null {
  if (run.status !== "failed") return null;
  const failed = run.steps.find((step) => step.status === "failed");
  const written = run.database === null
    ? 0
    : run.database.inserted + run.database.updated;
  return {
    title: failed
      ? VERDICT.stoppedAt.replace("{ordinal}", String(failed.ordinal))
        .replace("{label}", failed.label)
      : VERDICT.stopped,
    consequence: written === 0
      ? VERDICT.nothingWritten
      : VERDICT.alreadyWritten.replace("{genes}", counted(written, "gene")),
  };
}
