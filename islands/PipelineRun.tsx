import { useHydratedRef } from "../components/useHydratedRef.ts";
/**
 * The About page's pipeline-run widget.
 *
 * Renders the last recorded run from `data/pipeline_run.json`: its six
 * steps with pass/warn/fail badges and expandable action lists, papers
 * and genes fetched against accepted, the external services it called,
 * what it cost, and a drawer holding everything it wrote.
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
import { useEscapeKey } from "../components/useEscapeKey.ts";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import {
  describeError,
  describeRejection,
  describeTruncation,
  field,
  formatConfidence,
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  formatRunTimestamp,
  isTruncated,
  paperSourceLabel,
  runModeLabel,
  runStatusBadge,
  stepIcon,
  stepStatusBadge,
  warningCount,
  warningIcon,
} from "../lib/pipeline_display.ts";
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

/** A glyph plus its field label, the widget's one labelled-value shape. */
function FieldIcon({ name }: { name: string }) {
  const { label, icon } = field(name);
  return (
    <span class="pipeline-field-icon">
      <Icon name={icon} />
      <span class="visually-hidden">{label}</span>
    </span>
  );
}

/**
 * A field's name, said out loud.
 *
 * The record lines used to pair a glyph with a `.visually-hidden` label, which
 * left a sighted reader to infer the field from the mark -- and one line, the
 * Mendelian randomization "Yes", had no other words at all. The chip carries
 * the glyph and the word together, so the hidden copy goes with it: kept, a
 * screen reader would read the field name twice.
 */
function FieldLabel({ name }: { name: string }) {
  const { label, icon } = field(name);
  return (
    <span class="pipeline-chip pipeline-label-chip pipeline-tint-muted">
      <Icon name={icon} />
      {label}
    </span>
  );
}

/** A PMID chip linking to the paper, shared by the accepted and rejected cards. */
function PmidChip({ pmid }: { pmid: string }) {
  return (
    <a
      class="pipeline-chip"
      href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <FieldIcon name="pmid" />
      {pmid}
    </a>
  );
}

/** The symbol, confidence and PMID line the accepted and rejected cards share. */
function GeneHead(
  { gene }: { gene: Pick<RunGene, "symbol" | "pmid" | "confidence"> },
) {
  return (
    <div class="pipeline-record-head">
      <strong>{gene.symbol}</strong>
      {gene.confidence !== null && (
        <span class="pipeline-chip">
          <FieldIcon name="confidence" />
          {formatConfidence(gene.confidence)}
        </span>
      )}
      {gene.pmid && <PmidChip pmid={gene.pmid} />}
    </div>
  );
}

/** One number under its name, with the glyph that stands for it. */
function Stat({ name, value }: { name: string; value: number }) {
  const { label, icon } = field(name);
  return (
    <div class="pipeline-stat">
      <span class="pipeline-stat-label">
        <Icon name={icon} />
        {label}
      </span>
      <span class="pipeline-stat-value">{formatCount(value)}</span>
    </div>
  );
}

/**
 * One step row.
 *
 * The whole header is the control, not a separate chevron: a 3px target
 * beside a full-width row is the kind of hit area that reads as
 * decoration.
 */
function Step(
  { step, index, expanded, onToggle }: {
    step: RunStep;
    index: number;
    expanded: boolean;
    onToggle: () => void;
  },
) {
  const badge = stepStatusBadge(step.status);
  const warnings = warningCount(step);
  const panelId = `${DRAWER_ID}-step-${index + 1}`;
  const empty = step.actions.length === 0 && step.warnings.length === 0 &&
    step.error === null;

  return (
    <li class="pipeline-step">
      <button
        type="button"
        class="pipeline-step-head"
        aria-expanded={expanded ? "true" : "false"}
        aria-controls={panelId}
        disabled={empty}
        onClick={onToggle}
      >
        <span class="pipeline-step-ordinal">{step.ordinal}</span>
        <span class="pipeline-step-glyph" aria-hidden="true">
          <Icon name={stepIcon(step.key)} />
        </span>
        <span class="pipeline-step-label">{step.label}</span>
        <span class={`pipeline-badge pipeline-tint-${badge.tint}`}>
          <Icon name={badge.icon} />
          {badge.label}
          {warnings > 0 && <span class="pipeline-badge-count">{warnings}</span>}
        </span>
        <span class="pipeline-step-time">
          {formatDuration(step.durationSeconds)}
        </span>
        {
          /* Always rendered, hidden by CSS when the step has nothing to
            expand. Each step header is its own grid, so dropping the
            element dropped the column with it and let the last row's badge
            and duration hang 16px past the five above. */
        }
        <span
          class={`pipeline-step-caret${expanded ? " is-open" : ""}`}
          aria-hidden="true"
        >
          <Icon name="chevronDown" />
        </span>
      </button>

      <div id={panelId} class="pipeline-step-body" hidden={!expanded}>
        {step.actions.length > 0 && (
          <ul class="pipeline-actions">
            {step.actions.map((action, index) => <li key={index}>{action}</li>)}
          </ul>
        )}

        {step.warnings.map((warning, index) => (
          <p key={index} class="pipeline-note pipeline-tint-ember">
            <Icon name={warningIcon(warning.kind)} />
            <span>
              {warning.title}
              {warning.detail && (
                <span class="pipeline-note-subjects">{warning.detail}</span>
              )}
              {warning.subjects.length > 0 && (
                <span class="pipeline-note-subjects">
                  {warning.subjects.slice(0, 8).join(", ")}
                  {warning.subjects.length > 8 &&
                    ` and ${warning.subjects.length - 8} more`}
                </span>
              )}
            </span>
          </p>
        ))}

        {step.error && <StepError error={step.error} />}
      </div>
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
    <div class="pipeline-note pipeline-error pipeline-tint-danger">
      <Icon name={described.icon} />
      <div>
        <strong>{described.title}</strong>
        <p class="pipeline-error-hint">{described.hint}</p>
        {described.detail && (
          <pre class="pipeline-error-detail">{described.detail}</pre>
        )}
      </div>
    </div>
  );
}

function GeneCard({ gene }: { gene: RunGene }) {
  return (
    <>
      <GeneHead gene={gene} />
      {gene.proteinName && (
        <p class="pipeline-record-line">
          <FieldLabel name="protein" />
          {gene.proteinName}
        </p>
      )}
      {gene.gwasTraits.length > 0 && (
        <p class="pipeline-record-line">
          <FieldLabel name="gwasTrait" />
          {gene.gwasTraits.map((trait, index) => (
            <span key={index} class="pipeline-chip">{trait}</span>
          ))}
        </p>
      )}
      {gene.omicsEvidence.length > 0 && (
        <p class="pipeline-record-line">
          <FieldLabel name="omicsEvidence" />
          {gene.omicsEvidence.join(", ")}
        </p>
      )}
      {
        /* Recorded on every gene and, until now, rendered on none: the
          drawer's promise is everything the run recorded. Shown only
          when it is the case -- "No" on every row would be noise, and
          absence reads as absence. */
      }
      {gene.mendelianRandomization === true && (
        <p class="pipeline-record-line">
          <FieldLabel name="mendelian" />
          Yes
        </p>
      )}
      {gene.causalEvidenceSummary && (
        <p class="pipeline-record-line">
          <FieldLabel name="causalEvidence" />
          {gene.causalEvidenceSummary}
        </p>
      )}
      {gene.sourceQuote && (
        <blockquote class="pipeline-quote">
          <FieldLabel name="sourceQuote" />
          {gene.sourceQuote}
        </blockquote>
      )}
    </>
  );
}

function RejectedCard({ gene }: { gene: RejectedGene }) {
  return (
    <>
      <GeneHead gene={gene} />
      {gene.reasons.map((reason, index) => {
        const { label, icon, tint, detail } = describeRejection(reason);
        return (
          <p key={index} class="pipeline-record-line">
            <span class={`pipeline-chip pipeline-tint-${tint}`}>
              <Icon name={icon} />
              {label}
            </span>
            {detail}
          </p>
        );
      })}
    </>
  );
}

function PaperRow({ paper }: { paper: RunPaper }) {
  return (
    <>
      <div class="pipeline-record-head">
        {
          /* The same chip the gene cards use. A bare link here made one
            identifier read two ways in one drawer -- ember and 16px in the
            paper list, indigo and 13px in a pill three sections above. */
        }
        <PmidChip pmid={paper.pmid} />
        <span class="pipeline-chip">
          <FieldIcon name="source" />
          {paperSourceLabel(paper.source)}
        </span>
        {paper.processingSeconds !== null && (
          <span class="pipeline-chip">
            <FieldIcon name="duration" />
            {formatDuration(paper.processingSeconds)}
          </span>
        )}
        <span class="pipeline-chip">
          <FieldIcon name="genesAccepted" />
          {formatCount(paper.geneCount)}
        </span>
        {paper.rejectedCount > 0 && (
          <span class="pipeline-chip">
            <FieldIcon name="genesRejected" />
            {formatCount(paper.rejectedCount)}
          </span>
        )}
      </div>
      {paper.error && (
        <p class="pipeline-record-line">
          <FieldLabel name="reason" />
          {paper.error}
        </p>
      )}
    </>
  );
}

/** A drawer section that says when it is showing less than it counted. */
function DrawerSection<T>(
  { title, list, render, keyOf, itemClass = "pipeline-record" }: {
    title: string;
    list: { shown: number; total: number; items: T[] };
    render: (item: T) => ComponentChildren;
    keyOf: (item: T, index: number) => string;
    itemClass?: string;
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
          <li key={keyOf(item, index)} class={itemClass}>
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
  const [open, setOpen] = useState<number | null>(null);
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

  const badge = runStatusBadge(run.status);
  const when = formatRunTimestamp(run.runTimestamp);
  const wrote = run.database;
  const effort = field("effort");
  const prompt = field("promptVersion");
  // Whether there is anything for the drawer to show. A run that failed
  // before it processed a paper records no detail at all, and a trigger
  // reading "View everything this run recorded" over an empty panel is
  // a promise the drawer cannot keep. The services the run called count
  // towards that now: they are in the drawer, so a run that reached an API
  // and nothing else still has a record worth opening.
  const recorded = run.acceptedGenes.total + run.rejectedGenes.total +
          run.papersDetail.total > 0 || run.apis.length > 0;

  return (
    <div ref={hydratedRef} class="card pipeline-card">
      {
        /* Inert while the drawer is open. The drawer is absolutely
          positioned over this card, so without it Tab walks straight off
          the drawer's last link into six step buttons and the trigger --
          all painted over, focus ring invisible, Enter toggling panels
          nobody can see. TrialsTimeline's drawer sits *beside* its plate
          and so never needed this. */
      }
      <div class="card-body" inert={drawer}>
        {
          /* The trigger sits beside the heading rather than at the foot of
            the card, so open (here) and close (top of the drawer overlay,
            same box) land at the same point instead of ~600px apart. It is
            conditional on `recorded`, but the row's own alignment is not --
            `justify-content: space-between` with one child still reads as a
            plain heading row when the trigger is absent, which is the real
            case a run that failed before it recorded anything leaves. */
        }
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
              View everything this run recorded
              <Icon name="chevronRight" />
            </button>
          )}
        </div>

        <div class="pipeline-head">
          <span class="pipeline-head-when">
            <Icon name="calendar" />
            {when ?? "Date unavailable"}
          </span>
          <span class={`pipeline-badge pipeline-tint-${badge.tint}`}>
            <Icon name={badge.icon} />
            {badge.label}
          </span>
          <span class="pipeline-head-meta">
            <Icon name="clock" />
            {formatDuration(run.durationSeconds)}
          </span>
          <span class="pipeline-head-meta">
            <Icon name="beaker" />
            {runModeLabel(run.runMode)}
          </span>
          {run.config.model && (
            <span class="pipeline-head-meta">
              <Icon name="cube" />
              {run.config.model}
            </span>
          )}
          {
            /* The method is the model *and* how it was asked: effort and
              prompt version are both pinned and measured (see
              pipeline/CLAUDE.md), so a header naming only the model
              stated half of it. */
          }
          {run.config.effort && (
            <span class="pipeline-head-meta">
              <Icon name={effort.icon} />
              {run.config.effort} {effort.label.toLowerCase()}
            </span>
          )}
          {run.config.promptVersion && (
            <span class="pipeline-head-meta">
              <Icon name={prompt.icon} />
              {prompt.label} {run.config.promptVersion}
            </span>
          )}
        </div>

        {run.steps.length > 0 && (
          <ol class="pipeline-steps">
            {run.steps.map((step, index) => (
              <Step
                key={index}
                step={step}
                index={index}
                expanded={open === index}
                onToggle={() => setOpen(open === index ? null : index)}
              />
            ))}
          </ol>
        )}

        <div class="pipeline-stats">
          {
            /* Fetched before accepted, in that order: the widget's job is
              to show the funnel, and "40 found" is the denominator every
              number after it is a fraction of. Absent on an offline run,
              which was handed its identifiers and never searched. */
          }
          {run.papers.found !== null && (
            <Stat name="papersFound" value={run.papers.found} />
          )}
          <Stat
            name="papersProcessed"
            value={run.papers.processed}
          />
          <Stat
            name="papersFulltext"
            value={run.papers.fulltext}
          />
          <Stat
            name="papersAbstract"
            value={run.papers.abstractOnly}
          />
          {run.papers.noTextAvailable > 0 && (
            <Stat
              name="papersNoText"
              value={run.papers.noTextAvailable}
            />
          )}
          {
            /* Papers that failed outright are the other leak in the
              funnel, and were counted in the document but shown nowhere:
              "Processed 9" over 12 papers had no line saying where the
              other three went. */
          }
          {run.papers.failed > 0 && (
            <Stat name="papersFailed" value={run.papers.failed} />
          )}
          <Stat
            name="genesExtracted"
            value={run.genes.extracted}
          />
          {
            /* What reached the database, counted from the accepted list's
              own total -- exact even when the list itself is capped.
              `validated - rejectedAtInsertFloor` was not the same number:
              `validated` counts one per paper and a hold counts one per
              merged gene, so COL4A1 and COL4A2 validated from two papers
              and held once as COL4A1/2 read as one gene accepted when
              none was. */
          }
          <Stat
            name="genesAccepted"
            value={run.acceptedGenes.total}
          />
          <Stat name="genesRejected" value={run.genes.rejected} />
          {
            /* The second gate, shown separately because it is a different
              decision: these genes cleared validation and were still
              refused as *new* rows at the merge. Published but rendered
              nowhere until now, so nothing on the page reconciled
              "Accepted" against the drawer's rejected list. */
          }
          {run.genes.rejectedAtInsertFloor > 0 && (
            <Stat
              name="genesHeld"
              value={run.genes.rejectedAtInsertFloor}
            />
          )}
          {wrote && (
            <>
              <Stat name="inserted" value={wrote.inserted} />
              <Stat name="updated" value={wrote.updated} />
            </>
          )}
        </div>

        {
          /* Two numbers, not one rate. `verbatim` asks whether the
            sentence is in the paper, of every gene; `cited` asks whether
            the API attested to that span, which is the stronger claim but
            is bounded by how much prose the model wrote. Averaging them
            would report a quality figure the second number cannot carry. */
        }
        {run.genes.quotesChecked > 0 && (
          <p class="pipeline-provenance">
            <Icon name="chatQuote" />
            {formatCount(run.genes.quotesVerbatim)} of{" "}
            {formatCount(run.genes.quotesChecked)} quotes found in the paper
            <span class="pipeline-dot" aria-hidden="true">·</span>
            {formatCount(run.genes.quotesCited)}{" "}
            attested by the model's own citations
          </p>
        )}

        {run.tokens.totalTokens > 0 && (
          <p class="pipeline-tokens">
            <Icon name="cube" />
            {formatCount(run.tokens.totalTokens)} tokens
            <span class="pipeline-dot" aria-hidden="true">·</span>
            {formatPercent(run.tokens.cacheHitRate)} served from cache
            <span class="pipeline-dot" aria-hidden="true">·</span>
            <Icon name="currencyDollar" />
            {formatCost(run.tokens.estimatedCostUsd)}
          </p>
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
    return (
      <>
        <DrawerSection
          title="Genes accepted"
          list={run.acceptedGenes}
          keyOf={(gene, index) => `${gene.symbol}-${gene.pmid}-${index}`}
          render={(gene) => <GeneCard gene={gene} />}
        />
        <DrawerSection
          title="Genes rejected"
          list={run.rejectedGenes}
          itemClass="pipeline-record pipeline-record-rejected"
          keyOf={(gene, index) => `${gene.symbol}-${gene.pmid}-${index}`}
          render={(gene) => <RejectedCard gene={gene} />}
        />
        <DrawerSection
          title="Papers"
          list={run.papersDetail}
          keyOf={(paper, index) => `${paper.pmid}-${index}`}
          render={(paper) => <PaperRow paper={paper} />}
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
