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
 * Every word, glyph and tint comes from `lib/pipeline_encoding.json`
 * through `lib/`; no vocabulary is restated here. The dialog is a native
 * `<dialog>` opened through `useModal`, the hook the adapt guide's session
 * windows use, so the browser supplies the focus trap and the return of
 * focus rather than this file.
 */

import { useRef, useState } from "preact/hooks";

import { Icon } from "../components/Icon.tsx";
import { Note, WarningNote } from "../components/pipeline/Note.tsx";
import { RunDetails } from "../components/pipeline/RunDetails.tsx";
import { useModal } from "../components/useModal.ts";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import {
  describeError,
  field,
  formatCount,
  formatDuration,
  runModeLabel,
  runStatusBadge,
  runWhen,
  stepStatusBadge,
} from "../lib/pipeline_display.ts";
import {
  type Figure,
  FIGURES_LABEL,
  isOpenable,
  OF,
  reviewCount,
  type Segment,
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
  /**
   * Whether the card is shown as a preview, as the run's own page under New
   * Feature Previews draws it: a pill after the heading says so, and
   * nothing else changes.
   */
  preview?: boolean;
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
        <OutcomeLine key={index} line={line} />
      ))}
    </span>
  );
}

/*
 * A line and a part are components because they are keyed: `jsx:
 * "precompile"` drops the key of an intrinsic element it turns into a
 * template (islands/CLAUDE.md, the adapt wizard's `ListRow`).
 */
function OutcomeLine({ line }: { line: Segment[] }) {
  return (
    <span class="pipeline-outcome-line">
      {line.map((part, index) => <OutcomePart key={index} part={part} />)}
    </span>
  );
}

function OutcomePart({ part }: { part: Segment }) {
  return (
    <span class="pipeline-outcome-part">
      {part.value !== null && <b>{part.value}</b>}
      {part.value !== null && " "}
      {part.text}
    </span>
  );
}

/** One figure of the verdict: a numeral, what it is, and its breakdown. */
function FigureItem({ figure }: { figure: Figure }) {
  return (
    <li class="pipeline-figure">
      <span class="pipeline-figure-value">
        {figure.value}
        {
          /* The space is text, not a margin: read aloud or copied, the
            figure is "37 of 38", not "37of 38". */
        }
        {figure.of !== null && " "}
        {figure.of !== null && <small>{OF} {figure.of}</small>}
      </span>
      <span class="pipeline-figure-label">{figure.label}</span>
      <span class="pipeline-figure-sub">{figure.sub}</span>
    </li>
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
            <WarningNote key={index} warning={warning} />
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
  { run = pipelineRun, preview = false }: PipelineRunViewProps = {},
) {
  return run
    ? <PipelineRunContent key={run.runTimestamp} run={run} preview={preview} />
    : null;
}

function PipelineRunContent(
  { run, preview }: { run: PipelineRun; preview: boolean },
) {
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
          {preview && (
            <span class="pipeline-badge pipeline-tint-muted pipeline-preview-mark">
              {runModeLabel("preview")}
            </span>
          )}
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

        <div class="pipeline-verdict">
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
              /* A list, named: three bare runs of text reached a screen
                reader as one sentence. */
              <ul class="pipeline-figures" aria-label={FIGURES_LABEL}>
                {verdictFigures(run).map((figure) => (
                  <FigureItem key={figure.key} figure={figure} />
                ))}
              </ul>
            )}
        </div>

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
