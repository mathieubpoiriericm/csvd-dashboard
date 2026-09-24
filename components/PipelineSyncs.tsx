/**
 * The reference-data refreshes, beside the run widget on the About page.
 *
 * `--clinical-trials`, `--sync-external-data` and `--sync-annotations`
 * each talk to upstreams the PubMed run never touches, and none of it
 * reached this page: `build_run_report` is reachable only from inside
 * `run_pipeline`, so the ClinVar, Orphadata, Open Targets, UniProt and
 * ClinicalTrials.gov rows those refreshes recorded were dropped when the
 * process ended.
 *
 * **A sibling block, not a section of the run widget.** A refresh is a
 * different event from a run -- its own timestamp, its own outcome, its
 * own upstreams -- and folding it into the widget would mean one card
 * claiming two things happened at once. It sits above the two-column grid
 * whose right column is Data Sources, the panel whose names it echoes, so
 * the two read together: the panel says what each source is, this says
 * when it was last consulted and how that went.
 *
 * **Not an island.** It holds no state, so it needs no hydration, and it
 * therefore avoids the props-serialisation trap the run widget documents.
 * Promote it if a per-refresh drawer is ever wanted.
 */

import { ApiList } from "./ApiList.tsx";
import { Icon } from "./Icon.tsx";
import {
  describeTruncation,
  formatCount,
  formatDuration,
  formatRunTimestamp,
  isTruncated,
  runStatusBadge,
  syncModeLabel,
} from "../lib/pipeline_display.ts";
import type { SyncRun } from "../lib/types.ts";

function SourceCount({ source }: { source: SyncRun["sources"][number] }) {
  // Fetched and cached are separate facts -- what came back from the
  // upstream, and what reached the database -- so a refresh that answered
  // entirely from cache is visibly different from one that fetched.
  const parts: string[] = [];
  if (source.fetched > 0) parts.push(`${formatCount(source.fetched)} fetched`);
  if (source.cached > 0) parts.push(`${formatCount(source.cached)} written`);
  if (source.failed > 0) parts.push(`${formatCount(source.failed)} failed`);
  return (
    <li class="pipeline-source">
      <span class="pipeline-source-name">{source.label}</span>
      <span class="pipeline-source-detail">
        {parts.length > 0 ? parts.join(" · ") : "nothing to do"}
      </span>
    </li>
  );
}

function Refresh({ run }: { run: SyncRun }) {
  const badge = runStatusBadge(run.status);
  const when = formatRunTimestamp(run.runTimestamp);
  return (
    <li class="pipeline-sync">
      <div class="pipeline-head">
        <h3 class="pipeline-sync-name">{syncModeLabel(run.mode)}</h3>
        <span class={`pipeline-badge pipeline-tint-${badge.tint}`}>
          <Icon name={badge.icon} />
          {badge.label}
        </span>
        <span class="pipeline-head-when">
          <Icon name="calendar" />
          {when ?? "Date unavailable"}
        </span>
        <span class="pipeline-head-meta">
          <Icon name="clock" />
          {formatDuration(run.durationSeconds)}
        </span>
      </div>

      {run.sources.length > 0 && (
        <ul class="pipeline-sources">
          {run.sources.map((source) => (
            <SourceCount key={source.key} source={source} />
          ))}
        </ul>
      )}

      {
        /* `ApiList` is the same `.pipeline-apis > ul > .pipeline-api` shape
          the run widget's drawer uses, so the two lists are one component
          with one set of styles rather than a copy that drifts.

          Endpoint paths and HTTP verbs are a maintainer's register (see
          `islands/CLAUDE.md`), and the Data Sources panel a few hundred
          pixels below already names the same upstreams in prose -- so the
          list sits behind a disclosure rather than on the card. A native
          `<details>` needs no state and, closed, still keeps every
          `.pipeline-api-name` in the DOM for `about.spec.ts` to read. */
      }
      {run.apis.length > 0 && (
        <details class="pipeline-apis">
          <summary>
            External services consulted
            <span class="pipeline-count">{formatCount(run.apis.length)}</span>
            {
              /* `chevronDown`, rotated 180deg open -- `.pipeline-step-caret`
                in the run widget is the incumbent disclosure idiom on this
                page, and matching it is worth more than either being wrong:
                two chevron behaviours for the same "this expands" concept a
                few hundred pixels apart would read as two components that
                forgot about each other. */
            }
            <span class="pipeline-apis-caret" aria-hidden="true">
              <Icon name="chevronDown" />
            </span>
          </summary>
          <ApiList apis={run.apis} />
        </details>
      )}

      {isTruncated(run.errors.shown, run.errors.total) && (
        <p class="pipeline-truncation">
          {describeTruncation(run.errors.shown, run.errors.total, "errors")}
        </p>
      )}

      {run.errors.items.length > 0 && (
        <ul class="pipeline-sync-errors">
          {run.errors.items.map((error, index) => (
            // Keyed by position, as the widget's lists are: two refreshes
            // that failed the same way produce the same sentence, and a
            // text-keyed list collapses them.
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function PipelineSyncs({ runs }: { runs: SyncRun[] }) {
  // Nothing at all rather than an empty heading: a database that has
  // recorded no refresh has nothing to say about one, and the run widget
  // and the Data Sources panel below it both still stand on their own.
  if (runs.length === 0) return null;
  return (
    <div class="card">
      <div class="card-body">
        <h2 class="card-title">Reference Data Refreshes</h2>
        <p class="pipeline-syncs-lead">
          The curated tables are refreshed from their sources separately from
          the paper pipeline. Each entry is the most recent refresh of its kind.
        </p>
        <ul class="pipeline-sync-list">
          {runs.map((run) => <Refresh key={run.mode} run={run} />)}
        </ul>
      </div>
    </div>
  );
}
