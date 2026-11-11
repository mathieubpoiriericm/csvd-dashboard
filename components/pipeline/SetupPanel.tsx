/**
 * The run details' Setup tab: how the run was asked to work, what it used,
 * and what each step did.
 *
 * This is where the card's header strip went. Mode, model, effort, prompt
 * and hash are a maintainer's register; beside the date and the status they
 * were nine items of equal weight, five of them forensics. Here they are a
 * list that can be read when it is wanted.
 *
 * The step log holds the sentences each step recorded. The card's rows say
 * what came out of a step in figures, so the sentences repeated them there
 * and are kept here, where "Recorded 37 processed PMIDs" still has a home.
 */

import encoding from "../../lib/pipeline_encoding.json" with { type: "json" };
import {
  setupMethod,
  type SetupRow,
  setupUsage,
} from "../../lib/pipeline_details.ts";
import { NOTHING_TO_REPORT } from "../../lib/pipeline_ledger.ts";
import type { PipelineRun, RunStep } from "../../lib/types.ts";

const SETUP = encoding.setup;

function SetupItem({ row }: { row: SetupRow }) {
  return (
    <>
      <dt>{row.label}</dt>
      <dd>
        {row.value}
        {row.sub !== null && (
          <span class="pipeline-setup-sub">
            {row.code ? <code>{row.sub}</code> : row.sub}
          </span>
        )}
      </dd>
    </>
  );
}

function SetupList({ title, rows }: { title: string; rows: SetupRow[] }) {
  return (
    <section class="pipeline-drawer-section">
      <h3>{title}</h3>
      <dl class="pipeline-setup-list">
        {rows.map((row, index) => <SetupItem key={index} row={row} />)}
      </dl>
    </section>
  );
}

/**
 * One step's line of the log. Its sentences are keyed by position: a
 * re-entered step merges its visits' actions, and two visits that did the
 * same thing produce the same sentence.
 */
function LogRow({ step }: { step: RunStep }) {
  return (
    <li class="pipeline-log-row">
      <span class="pipeline-log-step">{step.ordinal}. {step.label}</span>
      <span class="pipeline-log-actions">
        {step.actions.length > 0
          ? step.actions.map((action, index) => (
            <span key={index}>{action}</span>
          ))
          : NOTHING_TO_REPORT}
      </span>
    </li>
  );
}

export function SetupPanel({ run }: { run: PipelineRun }) {
  return (
    <>
      <div class="pipeline-setup">
        <SetupList title={SETUP.method} rows={setupMethod(run)} />
        <SetupList title={SETUP.usage} rows={setupUsage(run)} />
      </div>
      {run.steps.length > 0 && (
        <section class="pipeline-drawer-section">
          <h3>{SETUP.log}</h3>
          <ol class="pipeline-log">
            {run.steps.map((step, index) => <LogRow key={index} step={step} />)}
          </ol>
        </section>
      )}
    </>
  );
}
