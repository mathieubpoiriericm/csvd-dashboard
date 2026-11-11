/**
 * What the run details dialog says, derived from the report.
 *
 * The dialog (`components/pipeline/RunDetails.tsx` and its panels) renders
 * what these functions return: which tabs it has and what each counts, how
 * the findings group, what a paper's row says, which columns the services
 * table needs, and what Setup holds. They are here for the reason
 * `lib/pipeline_ledger.ts` is: a component's branches are out of a test's
 * reach, and `lib/` is held to full coverage.
 */

import encoding from "./pipeline_encoding.json" with { type: "json" };

import {
  describeRefusal,
  describeRejection,
  field,
  formatConfidence,
  formatCount,
  formatDuration,
  formatPercent,
  runModeLabel,
} from "./pipeline_display.ts";
import type {
  ApiService,
  PipelineRun,
  RejectedGene,
  RunConfig,
  RunPaper,
  RunWarning,
} from "./types.ts";

const TABS = encoding.tabs;
const SETUP = encoding.setup;

/** The dialog's sections, in the order its tabs stand. */
export type TabId = keyof typeof TABS;

const TAB_ORDER: TabId[] = ["findings", "papers", "services", "setup"];

/**
 * The tabs a run has, each with what it counts.
 *
 * A tab with nothing in it is not offered: a run that failed before it read
 * a paper has no findings, no papers and perhaps no services, and three
 * empty panels behind three tabs are three dud clicks. Setup is always
 * there, since every run has a method. A count is the list's total, which
 * is exact even when the list the report holds is capped.
 */
export function detailTabs(
  run: PipelineRun,
): { id: TabId; label: string; count: number | null }[] {
  const counts: Record<TabId, number | null> = {
    findings: run.acceptedGenes.total + run.rejectedGenes.total,
    papers: run.papersDetail.total,
    services: run.apis.length,
    setup: null,
  };
  return TAB_ORDER
    .filter((id) => counts[id] !== 0)
    .map((id) => ({ id, label: TABS[id], count: counts[id] }));
}

/**
 * The tab a key moves to from `current`, as a tablist moves: the arrows
 * step and wrap, Home and End jump, and any other key stays put.
 */
export function nextTab(tabs: TabId[], current: TabId, key: string): TabId {
  const at = tabs.indexOf(current);
  switch (key) {
    case "ArrowRight":
      return tabs[(at + 1) % tabs.length];
    case "ArrowLeft":
      return tabs[(at - 1 + tabs.length) % tabs.length];
    case "Home":
      return tabs[0];
    case "End":
      return tabs[tabs.length - 1];
    default:
      return current;
  }
}

/** The findings that were not accepted, under one kind of reason. */
export interface RejectionGroup {
  kind: string;
  heading: string;
  /** How many, or `null` when the report's list is capped and cannot say. */
  count: number | null;
  items: RejectedGene[];
}

/**
 * The rejected findings, grouped by why, in the order the encoding lists
 * the kinds. A finding with several reasons sits with its first; one with
 * none is the fallback kind.
 *
 * The kinds are cut here from the items the report holds, and the report
 * caps its list. Past the cap a group's size is not its total, so its count
 * is `null` rather than a number that would read as one.
 */
export function rejectionGroups(run: PipelineRun): RejectionGroup[] {
  const { items, shown, total } = run.rejectedGenes;
  const groups = new Map<string, RejectionGroup>();
  const order: string[] = [
    ...encoding.rejectionReasons.kinds.map((entry) => entry.kind),
    encoding.rejectionReasons.fallback.kind,
  ];
  for (const gene of items) {
    const { kind, heading } = describeRejection(gene.reasons[0] ?? "");
    const group = groups.get(kind) ??
      { kind, heading, count: null, items: [] };
    group.items.push(gene);
    groups.set(kind, group);
  }
  return order.flatMap((kind) => {
    const group = groups.get(kind);
    if (group === undefined) return [];
    return [{ ...group, count: shown < total ? null : group.items.length }];
  });
}

/** One paper of the run, as its row of the Papers table reads. */
export interface PaperRow {
  paper: RunPaper;
  /** Who extracted it: the run's model, its fallback, or nobody. */
  readBy: "primary" | "fallback" | "unread";
  /** The classifier that declined it, in words, or `null`. */
  declinedBy: string | null;
  time: string | null;
}

/**
 * The Papers table's rows, with the two facts its head needs.
 *
 * A paper that errored leads, since it is the one that needs a look; the
 * rest keep the report's order. `declinedColumn` is whether any paper was
 * declined, so a run nothing was declined in has no empty column for it.
 * `written` is whether the run reached its merge: accepted means what
 * reached the database, so before it a paper's findings are validated and
 * no more.
 */
export function paperRows(
  run: PipelineRun,
): { rows: PaperRow[]; declinedColumn: boolean; written: boolean } {
  const rows = run.papersDetail.items.map((paper): PaperRow => ({
    paper,
    readBy: paper.error !== null ? "unread" : paper.extractionModel === null ||
        paper.extractionModel === run.config.model
      ? "primary"
      : "fallback",
    declinedBy: paper.refusal === null
      ? null
      : describeRefusal(paper.refusal).label,
    time: paper.processingSeconds === null
      ? null
      : formatDuration(paper.processingSeconds),
  }));
  const errored = (row: PaperRow) => row.paper.error !== null;
  return {
    rows: [...rows.filter(errored), ...rows.filter((row) => !errored(row))],
    declinedColumn: rows.some((row) => row.declinedBy !== null),
    written: run.database !== null,
  };
}

const PAPER_NOTE_KINDS = ["model_fallback", "paper_refused"];

/**
 * The run's own account of its fallback model and of the papers nobody
 * read, for the head of the Papers tab. Stated once there, in the run's
 * words and with its exact counts, where it used to be a pill on every row
 * it applied to -- thirty-four of thirty-eight, on the run this was drawn
 * for.
 */
export function paperNotes(run: PipelineRun): RunWarning[] {
  return run.steps.flatMap((step) =>
    step.warnings.filter((warning) => PAPER_NOTE_KINDS.includes(warning.kind))
  );
}

/**
 * Which trouble columns the services table needs: one appears only when
 * some service had that trouble, so a clean inventory stays narrow and a
 * troubled one is visibly different.
 */
export function apiColumns(
  apis: ApiService[],
): { retried: boolean; notFound: boolean; failed: boolean } {
  return {
    retried: apis.some((api) => api.retries > 0),
    notFound: apis.some((api) => api.notFound > 0),
    failed: apis.some((api) => api.errors > 0),
  };
}

/**
 * Where the confidence track is marked: the floors the run recorded, in
 * order. A report that recorded neither has an unmarked track.
 */
export function confidenceMarks(config: RunConfig): number[] {
  return [config.confidenceThresholdUpdate, config.confidenceThresholdInsert]
    .filter((floor): floor is number => floor !== null)
    .sort((a, b) => a - b);
}

/** One row of Setup: what it is, its value, and a line under it. */
export interface SetupRow {
  label: string;
  value: string;
  sub: string | null;
  /** Whether the line under it is an identifier, and is set as code. */
  code: boolean;
}

const row = (
  label: string,
  value: string,
  sub: string | null = null,
  code = false,
): SetupRow => ({ label, value, sub, code });

/**
 * How the run was asked to work: its mode, its model and how hard it was
 * asked to think, its prompt down to the bytes, and the floors a finding
 * had to clear. What the run did not record is left out, not printed blank.
 *
 * This is the header strip the card used to carry. It is a maintainer's
 * register, and beside the date and the status it outweighed both.
 */
export function setupMethod(run: PipelineRun): SetupRow[] {
  const { config } = run;
  const rows = [row(field("runMode").label, runModeLabel(run.runMode))];
  if (config.model !== null) {
    const how = [
      config.effort === null
        ? null
        : `${config.effort} ${field("effort").label.toLowerCase()}`,
      config.batch === true ? field("batch").label : null,
    ].filter((part) => part !== null);
    rows.push(
      row(
        field("model").label,
        config.model,
        how.length > 0 ? how.join(", ") : null,
      ),
    );
  }
  if (config.fallbackModel !== null) {
    rows.push(
      row(
        `${field("fallbackModel").label} ${field("model").label.toLowerCase()}`,
        config.fallbackModel,
      ),
    );
  }
  if (config.promptVersion !== null) {
    const bytes = config.disease !== null && config.promptSha256 !== null
      ? `${config.disease} ${config.promptSha256}`
      : null;
    rows.push(
      row(
        field("promptVersion").label,
        config.promptVersion,
        bytes,
        bytes !== null,
      ),
    );
  }
  const floors = [
    config.confidenceThresholdUpdate === null
      ? null
      : `${
        formatConfidence(config.confidenceThresholdUpdate)
      } ${SETUP.toUpdate}`,
    config.confidenceThresholdInsert === null
      ? null
      : `${formatConfidence(config.confidenceThresholdInsert)} ${SETUP.toAdd}`,
  ].filter((part) => part !== null);
  if (floors.length > 0) rows.push(row(SETUP.floors, floors.join(", ")));
  if (config.skipValidation) {
    rows.push(row(SETUP.validation, SETUP.validationSkipped));
  }
  if (config.dryRun) rows.push(row(SETUP.dryRun, SETUP.dryRunValue));
  return rows;
}

/**
 * What the run cost in time and tokens, and how its extractions checked
 * out. The two quote numbers stay two: one asks whether the sentence is in
 * the paper, the other whether the model's own citation attested to it.
 * The estimated cost is published and not shown.
 */
export function setupUsage(run: PipelineRun): SetupRow[] {
  const { tokens, genes } = run;
  const rows = [
    row(
      field("duration").label,
      formatDuration(run.durationSeconds),
      `${formatDuration(run.computeSeconds)} ${SETUP.work}`,
    ),
  ];
  if (tokens.totalTokens > 0) {
    const written = tokens.cacheCreationInputTokens ?? 0;
    const parts = [
      `${formatCount(tokens.inputTokens)} ${SETUP.tokensIn}`,
      `${formatCount(tokens.outputTokens)} ${SETUP.tokensOut}`,
      `${formatPercent(tokens.cacheHitRate)} ${SETUP.cached}`,
      ...(written > 0 ? [`${formatCount(written)} ${SETUP.cacheWritten}`] : []),
    ];
    rows.push(
      row(
        field("tokens").label,
        formatCount(tokens.totalTokens),
        parts.join(", "),
      ),
    );
  }
  if (genes.quotesChecked > 0) {
    rows.push(
      row(
        SETUP.quotes,
        `${formatCount(genes.quotesVerbatim)} ${SETUP.of} ${
          formatCount(genes.quotesChecked)
        } ${SETUP.quotesFound}`,
        `${formatCount(genes.quotesCited)} ${SETUP.quotesCited}`,
      ),
    );
  }
  return rows;
}
