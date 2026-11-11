import { useHydratedRef } from "../components/useHydratedRef.ts";
/**
 * The About page's pipeline-run widget.
 *
 * Renders the last recorded run from `data/pipeline_run.json` as a verdict
 * over a ledger: when it ran and whether it completed, three figures a
 * visiting researcher reads first, then one row per step saying what came
 * out of it. A row carries a flag only when something needs a look, and
 * opens onto the note that says why. Everything else the run recorded is
 * behind "Run details", a dialog (`components/pipeline/RunDetails.tsx`).
 *
 * What a row says, which warnings need a look and what the verdict holds
 * are decided in `lib/pipeline_ledger.ts`, which is tested; this file
 * renders what it returns.
 *
 * Every label, glyph and tint comes from `lib/pipeline_encoding.json`
 * through `lib/pipeline_display.ts`; nothing is restated here. The
 * drawer follows `islands/TrialsTimeline.tsx`'s pattern exactly --
 * `aria-expanded`/`aria-controls`, the close button takes focus, Escape
 * closes and returns it -- so this adds an instance of that behaviour
 * rather than a second implementation of it.
 */

import { useRef, useState } from "preact/hooks";

import { Icon } from "../components/Icon.tsx";
import { Note } from "../components/pipeline/Note.tsx";
import { RunDetails } from "../components/pipeline/RunDetails.tsx";
import { useModal } from "../components/useModal.ts";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import {
  describeError,
  field,
  formatCount,
  formatDuration,
  runStatusBadge,
  runWhen,
  stepStatusBadge,
} from "../lib/pipeline_display.ts";
import {
  isOpenable,
  isPmid,
  isReview,
  OF,
  reviewCount,
  SHOW_ALL,
  splitSubjects,
  stepFlag,
  type StepOutcome,
  stepOutcome,
  stoppedNote,
  verdictFigures,
} from "../lib/pipeline_ledger.ts";
import type { PipelineRun, RunStep } from "../lib/types.ts";

const DETAILS_ID = "pipeline-run-details";

interface PipelineRunViewProps {
  /**
   * Injectable for tests only. The route renders this island with no
   * props at all, because every island here reads its own data: Fresh
   * serialises island props for hydration, and a run report does not
   * survive that round trip -- the island renders server-side and then
   * never becomes interactive, with nothing in the console to say so.
   * Reading the module binding keeps the client bundle self-sufficient.
   */
  run?: PipelineRun | null;
}

/**
 * What came out of a step: one line per thing it did, each a row of parts.
 *
 * A part is a numeral and its words, or a muted clause breaking the part
 * before it down. The parts are separated by a rule the stylesheet draws on
 * every part but a line's first, never by a glyph: a "·" between flex items
 * ends the line it wraps on.
 */
function Outcome({ outcome }: { outcome: StepOutcome }) {
  return (
    <span
      class={`pipeline-step-outcome${outcome.quiet ? " is-quiet" : ""}`}
    >
      {outcome.lines.map((line, index) => (
        <span key={index} class="pipeline-outcome-line">
          {line.map((part, index) => (
            <span key={index} class="pipeline-outcome-part">
              {part.value !== null && <b>{part.value}</b>}
              {part.value !== null && " "}
              {part.text}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * A warning's subject, after the comma that separates it from the one
 * before: a paper is a link to it, anything else its name.
 */
function Subject({ subject, first }: { subject: string; first: boolean }) {
  return (
    <>
      {!first && ", "}
      {isPmid(subject)
        ? (
          <a
            class="pipeline-pmid"
            href={`https://pubmed.ncbi.nlm.nih.gov/${subject}/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {subject}
          </a>
        )
        : subject}
    </>
  );
}

function SubjectList({ subjects }: { subjects: string[] }) {
  return (
    <>
      {subjects.map((subject, index) => (
        <Subject key={index} subject={subject} first={index === 0} />
      ))}
    </>
  );
}

/**
 * What a warning names. The first few are in the note; the rest wait
 * behind a native disclosure, in the page, rather than becoming "and 26
 * more" -- a count of things the reader was then given no way to see.
 */
function Subjects({ subjects }: { subjects: string[] }) {
  if (subjects.length === 0) return null;
  const { shown, rest } = splitSubjects(subjects);
  return (
    <div class="pipeline-note-subjects">
      <SubjectList subjects={shown} />
      {rest.length > 0 && (
        <details class="pipeline-note-more">
          <summary>{SHOW_ALL} {formatCount(subjects.length)}</summary>
          <SubjectList subjects={rest} />
        </details>
      )}
    </div>
  );
}

/**
 * One step: a row of the ledger.
 *
 * The whole row is the control when it opens, and it opens only on what it
 * does not already say -- a note or an error. A row with neither is a
 * disabled button at full contrast: a real step with nothing more to tell,
 * which dimmed would read as "did not run".
 */
function Step(
  { run, index, expanded, onToggle }: {
    run: PipelineRun;
    index: number;
    expanded: boolean;
    onToggle: () => void;
  },
) {
  const step = run.steps[index];
  const flag = stepFlag(step);
  const openable = isOpenable(step);
  const panelId = `pipeline-run-step-${index + 1}`;

  return (
    <li class="pipeline-step" data-status={step.status}>
      <button
        type="button"
        class="pipeline-step-head"
        aria-expanded={openable ? (expanded ? "true" : "false") : undefined}
        aria-controls={openable ? panelId : undefined}
        disabled={!openable}
        onClick={onToggle}
      >
        <span class="pipeline-step-ordinal">{step.ordinal}</span>
        <span class="pipeline-step-label">{step.label}</span>
        <Outcome outcome={stepOutcome(run, index)} />
        <span class="pipeline-step-flag">
          {flag && (
            <span class={`pipeline-badge pipeline-tint-${flag.tint}`}>
              <Icon name={flag.icon} />
              {flag.label}
            </span>
          )}
        </span>
        <span class="pipeline-step-time">
          {step.durationSeconds !== null &&
            formatDuration(step.durationSeconds)}
        </span>
        {
          /* Always rendered, hidden by CSS when the row does not open. Each
            row is its own grid, so dropping the element dropped the column
            with it and let that row's flag and duration hang past the
            others. */
        }
        <span
          class={`pipeline-step-caret${expanded ? " is-open" : ""}`}
          aria-hidden="true"
        >
          <Icon name="chevronDown" />
        </span>
      </button>

      {openable && (
        <div id={panelId} class="pipeline-step-body" hidden={!expanded}>
          {step.warnings.map((warning, index) => (
            <Note
              key={index}
              tint={isReview(warning.kind) ? "ember" : "muted"}
              mark={isReview(warning.kind) ? field("toReview") : undefined}
              title={warning.title}
            >
              {warning.detail && (
                <p class="pipeline-note-detail">{warning.detail}</p>
              )}
              <Subjects subjects={warning.subjects} />
            </Note>
          ))}

          {step.error && <StepError error={step.error} />}
        </div>
      )}
    </li>
  );
}

/**
 * A failure, as prose rather than as console output.
 *
 * Three parts, in order of what a reader needs: the pipeline's own
 * sentence, what that category of failure means, and only then the raw
 * detail -- which is the exception text, kept because a maintainer wants
 * it and demoted because nobody else does.
 */
function StepError({ error }: { error: NonNullable<RunStep["error"]> }) {
  const described = describeError(error);
  return (
    <Note
      tint="danger"
      mark={stepStatusBadge("failed")}
      title={described.title}
    >
      <p class="pipeline-note-detail">{described.hint}</p>
      {described.detail && (
        <pre class="pipeline-error-detail">{described.detail}</pre>
      )}
    </Note>
  );
}

export default function PipelineRunView(
  { run = pipelineRun }: PipelineRunViewProps = {},
) {
  return run ? <PipelineRunContent key={run.runTimestamp} run={run} /> : null;
}

function PipelineRunContent({ run }: { run: PipelineRun }) {
  const hydratedRef = useHydratedRef<HTMLDivElement>();
  const [details, setDetails] = useState(false);
  /**
   * Whether the dialog has ever been opened. Its content mounts then and
   * stays: a closed dialog costs the page a heading and a button, not a
   * thousand records, and reopening it does not build them again.
   */
  const opened = useRef(false);
  const openDetails = () => {
    opened.current = true;
    setDetails(true);
  };
  const closeDetails = () => setDetails(false);
  // A native modal dialog: the browser supplies the top layer, the focus
  // trap, the inert page behind it, and returns focus to the trigger when
  // it closes. The drawer this replaces sat inside the card and did each
  // of those by hand.
  const dialogRef = useModal(details, closeDetails);

  // A step that failed starts open: its error is the first thing anyone
  // looking at a failed run wants, and one click away it was a row that
  // said "Failed" and no more.
  const [open, setOpen] = useState<ReadonlySet<number>>(() =>
    new Set(
      run.steps.flatMap((step, index) =>
        step.status === "failed" && isOpenable(step) ? [index] : []
      ),
    )
  );
  const toggle = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  // "Completed with warnings" is not said: what there is to look at is
  // counted beside the status, and a run whose notes are all routine has
  // nothing to add to "Completed".
  const badge = runStatusBadge(
    run.status === "completed_with_warnings" ? "completed" : run.status,
  );
  const review = reviewCount(run);
  const toReview = field("toReview");
  const when = runWhen(run.runTimestamp);
  const stopped = stoppedNote(run);
  return (
    <div ref={hydratedRef} class="card pipeline-card">
      <div class="card-body">
        <div class="pipeline-title-row">
          <h2 class="card-title">Last Pipeline Run</h2>
          {
            /* Always there: every run has a method, so the dialog's Setup
              tab is never empty. It names the dialog it opens; the browser
              gives focus back to it on close. */
          }
          <button
            type="button"
            class="pipeline-drawer-trigger"
            aria-haspopup="dialog"
            onClick={openDetails}
          >
            Run details
          </button>
        </div>

        {
          /* No separators between the items: the row wraps, and a glyph
            between flex items ends whichever line it wraps on. */
        }
        <p class="pipeline-when">
          <span class="pipeline-when-date">
            {when
              ? (
                <>
                  {when.date}{" "}
                  <span class="pipeline-when-time">{when.time}</span>
                </>
              )
              : "Date unavailable"}
          </span>
          <span class={`pipeline-badge pipeline-tint-${badge.tint}`}>
            <Icon name={badge.icon} />
            {badge.label}
          </span>
          {review > 0 && (
            <span class="pipeline-badge pipeline-tint-ember">
              <Icon name={toReview.icon} />
              {formatCount(review)} {toReview.label}
            </span>
          )}
          <span class="pipeline-when-duration">
            {formatDuration(run.durationSeconds)}
          </span>
        </p>

        {stopped
          ? (
            <Note
              tint="danger"
              mark={runStatusBadge("failed")}
              title={stopped.title}
            >
              <p class="pipeline-note-detail">{stopped.consequence}</p>
            </Note>
          )
          : (
            <div class="pipeline-figures">
              {verdictFigures(run).map((figure) => (
                <div key={figure.key} class="pipeline-figure">
                  <span class="pipeline-figure-value">
                    {figure.value}
                    {figure.of !== null && <small>{OF} {figure.of}</small>}
                  </span>
                  <span class="pipeline-figure-label">{figure.label}</span>
                  <span class="pipeline-figure-sub">{figure.sub}</span>
                </div>
              ))}
            </div>
          )}

        {run.steps.length > 0 && (
          <ol class="pipeline-steps">
            {run.steps.map((_, index) => (
              <Step
                key={index}
                run={run}
                index={index}
                expanded={open.has(index)}
                onToggle={() => toggle(index)}
              />
            ))}
          </ol>
        )}
      </div>

      <dialog
        ref={dialogRef}
        id={DETAILS_ID}
        class="pipeline-details"
        aria-labelledby={`${DETAILS_ID}-title`}
        onCancel={(event) => {
          // Escape is reported, not obeyed: the state closes the dialog,
          // so the prop and the element cannot drift apart.
          event.preventDefault();
          closeDetails();
        }}
      >
        <div class="pipeline-details-head">
          <div>
            <h2 id={`${DETAILS_ID}-title`}>Run details</h2>
            <p class="pipeline-details-sub">
              <span>
                {when ? `${when.date} ${when.time}` : "Date unavailable"}
              </span>
              <span>{badge.label}</span>
              <span>{formatDuration(run.durationSeconds)}</span>
            </p>
          </div>
          <button
            type="button"
            class="pipeline-drawer-close"
            aria-label="Close run details"
            onClick={closeDetails}
          >
            ×
          </button>
        </div>

        {(details || opened.current) && <RunDetails run={run} />}
      </dialog>
    </div>
  );
}
