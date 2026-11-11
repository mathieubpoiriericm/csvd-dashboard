import { useHydratedRef } from "../components/useHydratedRef.ts";
/**
 * The About page's pipeline-run widget.
 *
 * Renders the last recorded run from `data/pipeline_run.json` as a verdict
 * over a ledger: when it ran and whether it completed, three figures a
 * visiting researcher reads first, then one row per step saying what came
 * out of it. A row carries a flag only when something needs a look, and
 * opens onto the note that says why. Everything else the run recorded is
 * in the drawer.
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

import type { ComponentChildren } from "preact";
import { memo } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";

import { ApiList } from "../components/ApiList.tsx";
import { Icon } from "../components/Icon.tsx";
import { Note } from "../components/pipeline/Note.tsx";
import { useEscapeKey } from "../components/useEscapeKey.ts";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import { formatOmicsEntry, parseOmicsEntry } from "../lib/omics.ts";
import {
  describeError,
  describePaper,
  describeRefusal,
  describeRejection,
  describeTruncation,
  field,
  formatConfidence,
  formatCount,
  formatDuration,
  isTruncated,
  paperSourceLabel,
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
import type {
  PipelineRun,
  RejectedGene,
  RunGene,
  RunPaper,
  RunStep,
} from "../lib/types.ts";

const DRAWER_ID = "pipeline-run-drawer";

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
 * One field of a drawer record: its name in the label column, its value in
 * the `<dd>` beside it.
 *
 * The names used to be chips the same shape as the values next to them, so
 * a line read as a row of pills with nothing to say which was the label.
 * `pills` lays the value out as a wrapping row, for a list of pills or a
 * verdict pill and its detail.
 */
function Field(
  { name, pills = false, children }: {
    name: string;
    pills?: boolean;
    children: ComponentChildren;
  },
) {
  return (
    <>
      <FieldName name={name} />
      <dd class={pills ? "pipeline-pills" : undefined}>{children}</dd>
    </>
  );
}

/** A field's name, glyph and word, as the term of a record's list. */
function FieldName({ name }: { name: string }) {
  const { label, icon } = field(name);
  return (
    <dt>
      <Icon name={icon} />
      {label}
    </dt>
  );
}

/** A neutral pill: a value from a fixed vocabulary, not a verdict. */
function ValuePill({ children }: { children: ComponentChildren }) {
  return <span class="pipeline-chip pipeline-tint-muted">{children}</span>;
}

/**
 * "PMID" and the number, linked to the paper -- the one way a PMID reads in
 * the drawer, in a gene's head and at the start of a paper's row alike.
 */
function Pmid({ pmid }: { pmid: string }) {
  return (
    <span class="pipeline-fact">
      {field("pmid").label}{" "}
      <a
        class="pipeline-pmid"
        href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {pmid}
      </a>
    </span>
  );
}

/**
 * The symbol in the label column, and what identifies the extraction
 * beside it: "Confidence 1.00 · PMID 20437615", in words. Both used to be
 * glyph chips whose names only a screen reader was told.
 */
function GeneHead(
  { gene }: { gene: Pick<RunGene, "symbol" | "pmid" | "confidence"> },
) {
  return (
    <div class="pipeline-record-head">
      <strong class="pipeline-record-name">{gene.symbol}</strong>
      <span class="pipeline-facts">
        {gene.confidence !== null && (
          <span class="pipeline-fact">
            {field("confidence").label}{" "}
            <span class="pipeline-fact-value">
              {formatConfidence(gene.confidence)}
            </span>
          </span>
        )}
        {gene.pmid && <Pmid pmid={gene.pmid} />}
      </span>
    </div>
  );
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
  const panelId = `${DRAWER_ID}-step-${index + 1}`;

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

function GeneCard({ gene }: { gene: RunGene }) {
  return (
    <>
      <GeneHead gene={gene} />
      <dl class="pipeline-fields">
        {gene.proteinName && <Field name="protein">{gene.proteinName}</Field>}
        {
          /* An existing gene whose best score sat below the insert floor
            took this paper as a reference and nothing else, so its record
            carries no trait or omics pill. Said in words: without it the
            gene reads as one the model found nothing about. */
        }
        {gene.citationOnly && (
          <Field name="writtenAs" pills>
            <ValuePill>Citation only</ValuePill>
          </Field>
        )}
        {gene.gwasTraits.length > 0 && (
          <Field name="gwasTrait" pills>
            {gene.gwasTraits.map((trait, index) => (
              <ValuePill key={index}>{trait}</ValuePill>
            ))}
          </Field>
        )}
        {gene.omicsEvidence.length > 0 && (
          <Field name="omicsEvidence" pills>
            {gene.omicsEvidence.map((method, index) => (
              <ValuePill key={index}>
                {formatOmicsEntry(parseOmicsEntry(method))}
              </ValuePill>
            ))}
          </Field>
        )}
        {
          /* Recorded on every gene and, until now, rendered on none: the
            drawer's promise is everything the run recorded. Shown only
            when it is the case -- "No" on every row would be noise, and
            absence reads as absence. */
        }
        {gene.mendelianRandomization === true && (
          <Field name="mendelian">Yes</Field>
        )}
        {gene.causalEvidenceSummary && (
          <Field name="causalEvidence">{gene.causalEvidenceSummary}</Field>
        )}
        {gene.sourceQuote && (
          <Field name="sourceQuote">
            <blockquote class="pipeline-quote">{gene.sourceQuote}</blockquote>
          </Field>
        )}
      </dl>
    </>
  );
}

/**
 * A rejected gene: the same head as an accepted one, then its verdicts.
 *
 * The verdict pill is the only colour in the record. The record itself used
 * to be painted danger -- rail, border and every chip -- which made a
 * low-confidence miss, the run's most routine outcome, read as an alarm;
 * the section heading already says these were rejected.
 */
function RejectedCard({ gene }: { gene: RejectedGene }) {
  return (
    <>
      <GeneHead gene={gene} />
      {gene.reasons.length > 0 && (
        <dl class="pipeline-fields">
          <FieldName name="reason" />
          {gene.reasons.map((reason, index) => {
            const { label, icon, tint, detail } = describeRejection(reason);
            return (
              <dd key={index} class="pipeline-pills">
                <span class={`pipeline-chip pipeline-tint-${tint}`}>
                  <Icon name={icon} />
                  {label}
                </span>
                {detail}
              </dd>
            );
          })}
        </dl>
      )}
    </>
  );
}

/**
 * A paper, in the columns of the service rows below it: the PMID, where its
 * text came from, and on the right what became of it (`describePaper`).
 *
 * A paper another model extracted -- the Opus 4.8 fallback, after Opus 5.5
 * declined -- names that model beside its source. The run's own model is
 * left unsaid: it is in the header, and on every row it would be noise. A
 * refusal names its classifier as a verdict pill, whether the paper then
 * failed or the fallback served it.
 */
function PaperRow(
  { paper, primaryModel, written }: {
    paper: RunPaper;
    primaryModel: string | null;
    written: boolean;
  },
) {
  const otherModel = paper.extractionModel !== null &&
      paper.extractionModel !== primaryModel
    ? paper.extractionModel
    : null;
  const refusal = paper.refusal === null
    ? null
    : describeRefusal(paper.refusal);
  return (
    <>
      <div class="pipeline-paper">
        <Pmid pmid={paper.pmid} />
        <ValuePill>{paperSourceLabel(paper.source)}</ValuePill>
        <span class="pipeline-paper-detail">
          {describePaper(paper, written)}
        </span>
      </div>
      {(otherModel || refusal || paper.error) && (
        <dl class="pipeline-fields">
          {otherModel && (
            <Field name="extractionModel" pills>
              <ValuePill>{otherModel}</ValuePill>
            </Field>
          )}
          {refusal && (
            <Field name="refusal" pills>
              <span class={`pipeline-chip pipeline-tint-${refusal.tint}`}>
                <Icon name={refusal.icon} />
                {refusal.label}
              </span>
            </Field>
          )}
          {paper.error && <Field name="reason">{paper.error}</Field>}
        </dl>
      )}
    </>
  );
}

/** A drawer section that says when it is showing less than it counted. */
function DrawerSection<T>(
  { title, list, render, keyOf }: {
    title: string;
    list: { shown: number; total: number; items: T[] };
    render: (item: T) => ComponentChildren;
    keyOf: (item: T, index: number) => string;
  },
) {
  if (list.total === 0) return null;
  return (
    <section class="pipeline-drawer-section">
      <h3>
        {title}
        <span class="pipeline-count">{formatCount(list.total)}</span>
      </h3>
      {isTruncated(list.shown, list.total) && (
        <p class="pipeline-truncation">
          {describeTruncation(list.shown, list.total)}
        </p>
      )}
      <ul class="pipeline-records">
        {list.items.map((item, index) => (
          <li key={keyOf(item, index)} class="pipeline-record">
            {render(item)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function PipelineRunView(
  { run = pipelineRun }: PipelineRunViewProps = {},
) {
  return run ? <PipelineRunContent key={run.runTimestamp} run={run} /> : null;
}

function PipelineRunContent({ run }: { run: PipelineRun }) {
  const hydratedRef = useHydratedRef<HTMLDivElement>();
  const [drawer, setDrawer] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Whether the drawer has ever been opened, so mount does not move focus. */
  const opened = useRef(false);

  // Focus moves into the drawer only once it is actually rendered, and
  // back to the trigger when it closes. The `opened` guard is what keeps
  // the closing branch from firing on mount: without it, loading the
  // About page would pull focus to a button halfway down it.
  useEffect(() => {
    if (drawer) {
      opened.current = true;
      closeRef.current?.focus();
    } else if (opened.current) {
      triggerRef.current?.focus();
    }
  }, [drawer]);

  useEscapeKey(drawer, () => setDrawer(false));

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
  // Whether there is anything for the drawer to show. A run that failed
  // before it processed a paper records no detail at all, and a trigger
  // over an empty panel is a promise the drawer cannot keep. The services
  // the run called count towards that: they are in the drawer, so a run
  // that reached an API and nothing else still has a record worth opening.
  const recorded = run.acceptedGenes.total + run.rejectedGenes.total +
          run.papersDetail.total > 0 || run.apis.length > 0;

  return (
    <div ref={hydratedRef} class="card pipeline-card">
      {
        /* Inert while the drawer is open. The drawer is absolutely
          positioned over this card, so without it Tab walks straight off
          the drawer's last link into the step buttons and the trigger --
          all painted over, focus ring invisible, Enter toggling panels
          nobody can see. */
      }
      <div class="card-body" inert={drawer}>
        <div class="pipeline-title-row">
          <h2 class="card-title">Last Pipeline Run</h2>
          {recorded && (
            <button
              ref={triggerRef}
              type="button"
              class="pipeline-drawer-trigger"
              aria-expanded={drawer ? "true" : "false"}
              aria-controls={DRAWER_ID}
              onClick={() => setDrawer(true)}
            >
              Run details
            </button>
          )}
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

      {recorded && (
        <aside
          id={DRAWER_ID}
          class="pipeline-drawer"
          role="region"
          aria-label="Everything this run recorded"
          hidden={!drawer}
          inert={!drawer}
        >
          <div class="pipeline-drawer-head">
            <h2>Everything this run recorded</h2>
            <button
              ref={closeRef}
              type="button"
              class="pipeline-drawer-close"
              aria-label="Close run details"
              onClick={() => setDrawer(false)}
            >
              ×
            </button>
          </div>

          {(drawer || opened.current) && <PipelineRunDetails run={run} />}
        </aside>
      )}
    </div>
  );
}

export const PipelineRunDetails = memo(
  function PipelineRunDetails({ run }: { run: PipelineRun }) {
    // Whether the run reached its merge; see the Accepted stat on the card.
    const written = run.database !== null;
    return (
      <>
        <DrawerSection
          title={written ? "Genes accepted" : "Genes validated, not written"}
          list={run.acceptedGenes}
          keyOf={(gene, index) => `${gene.symbol}-${gene.pmid}-${index}`}
          render={(gene) => <GeneCard gene={gene} />}
        />
        <DrawerSection
          title="Genes rejected"
          list={run.rejectedGenes}
          keyOf={(gene, index) => `${gene.symbol}-${gene.pmid}-${index}`}
          render={(gene) => <RejectedCard gene={gene} />}
        />
        <DrawerSection
          title="Papers"
          list={run.papersDetail}
          keyOf={(paper, index) => `${paper.pmid}-${index}`}
          render={(paper) => (
            <PaperRow
              paper={paper}
              primaryModel={run.config.model}
              written={written}
            />
          )}
        />

        {
          /* The request log lives here rather than on the card. Endpoint
              paths and HTTP verbs are a maintainer's register, and the card
              sits above a Data Sources panel that names the same class of
              thing -- external sources the run consulted -- in prose. The
              drawer is where the maintainer-facing record already is. */
        }
        {run.apis.length > 0 && (
          <section class="pipeline-apis pipeline-drawer-section">
            <h3>External services</h3>
            <ApiList apis={run.apis} />
          </section>
        )}
      </>
    );
  },
);
