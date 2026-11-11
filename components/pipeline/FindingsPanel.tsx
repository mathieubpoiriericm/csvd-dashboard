/**
 * The run details' Findings tab: what the run's papers proposed, and what
 * became of each proposal.
 *
 * A finding is one paper's proposal of a gene, so a gene found in two
 * papers is listed twice here and written once; the tab opens by saying so,
 * since its count is otherwise read against the card's "genes written".
 *
 * The accepted findings come first, as full records. The rest are grouped
 * by why they were not accepted (`rejectionGroups`), under a heading that
 * says it once, so a row has only its own numbers to give. Each used to
 * carry its verdict as a pill: fourteen findings under a floor were
 * fourteen identical pills.
 */

import encoding from "../../lib/pipeline_encoding.json" with { type: "json" };
import { Icon } from "../Icon.tsx";
import { formatOmicsEntry, parseOmicsEntry } from "../../lib/omics.ts";
import {
  confidenceMarks,
  floorLegend,
  type RejectionGroup,
  rejectionGroups,
} from "../../lib/pipeline_details.ts";
import {
  describeRejection,
  describeTruncation,
  field,
  formatConfidence,
  formatCount,
  isTruncated,
} from "../../lib/pipeline_display.ts";
import type { PipelineRun, RejectedGene, RunGene } from "../../lib/types.ts";
import { DrawerSection, Field, Pmid, ValuePill } from "./records.tsx";

const FINDINGS = encoding.findings;

/** A share of the track's width, to a tenth of a percent. */
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;

function Mark({ at }: { at: number }) {
  return <i class="pipeline-conf-mark" style={`left: ${percent(at)}`} />;
}

/**
 * A finding's confidence: the number, named in words, and a track that
 * draws it against the floors it had to clear.
 *
 * The track is why a held finding can be read at a glance as "just short"
 * or "nowhere near". It is a drawing of the number beside it and is hidden
 * from assistive technology; the number is the value. A finding the run
 * kept fills its track in the primary, one it did not in a neutral.
 */
export function Confidence(
  { value, marks, kept }: {
    value: number | null;
    marks: number[];
    kept: boolean;
  },
) {
  if (value === null) return null;
  return (
    <span class="pipeline-conf">
      <span class="pipeline-fact">
        {field("confidence").label}{" "}
        <span class="pipeline-fact-value">{formatConfidence(value)}</span>
      </span>
      <span
        class={`pipeline-conf-track${kept ? " is-kept" : ""}`}
        style={`--pipeline-conf: ${percent(value)}`}
        aria-hidden="true"
      >
        {marks.map((at, index) => <Mark key={index} at={at} />)}
      </span>
    </span>
  );
}

function AcceptedRecord({ gene, marks }: { gene: RunGene; marks: number[] }) {
  return (
    <>
      <div class="pipeline-record-head">
        <strong class="pipeline-record-name">{gene.symbol}</strong>
        <span class="pipeline-facts">
          <Confidence value={gene.confidence} marks={marks} kept />
          {gene.pmid && <Pmid pmid={gene.pmid} />}
        </span>
      </div>
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
          /* Shown only when it is the case -- "No" on every row would be
            noise, and absence reads as absence. */
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
 * A further reason on a finding already grouped by its first: of another
 * kind, which nothing above the row says, so it carries its own verdict.
 */
function OtherReason({ reason }: { reason: string }) {
  const { label, icon, tint, detail } = describeRejection(reason);
  return (
    <span class="pipeline-pills">
      <span class={`pipeline-chip pipeline-tint-${tint}`}>
        <Icon name={icon} />
        {label}
      </span>
      {detail}
    </span>
  );
}

/**
 * A finding that was not accepted, as one line: its symbol, its score
 * against the floors, what the pipeline recorded about why, and its paper.
 */
function RejectedRow({ gene, marks }: { gene: RejectedGene; marks: number[] }) {
  const [first, ...others] = gene.reasons;
  return (
    <li class="pipeline-record pipeline-record-row">
      <strong class="pipeline-record-name">{gene.symbol}</strong>
      <Confidence value={gene.confidence} marks={marks} kept={false} />
      <span class="pipeline-record-why">
        {first !== undefined && <span>{describeRejection(first).detail}</span>}
        {others.map((reason, index) => (
          <OtherReason
            key={index}
            reason={reason}
          />
        ))}
      </span>
      {gene.pmid && <Pmid pmid={gene.pmid} />}
    </li>
  );
}

function Group(
  { group, marks }: { group: RejectionGroup; marks: number[] },
) {
  return (
    <section class="pipeline-drawer-section">
      <h3>
        {group.heading}
        {group.count !== null && (
          <span class="pipeline-count">{formatCount(group.count)}</span>
        )}
      </h3>
      <ul class="pipeline-records">
        {group.items.map((gene, index) => (
          <RejectedRow key={index} gene={gene} marks={marks} />
        ))}
      </ul>
    </section>
  );
}

export function FindingsPanel({ run }: { run: PipelineRun }) {
  const marks = confidenceMarks(run.config);
  const legend = floorLegend(run.config);
  const rejected = run.rejectedGenes;
  return (
    <>
      <p class="pipeline-panel-lead">{FINDINGS.bridge}</p>
      {legend !== null && (
        <p class="pipeline-conf-legend">
          <span class="pipeline-conf-track" aria-hidden="true">
            {marks.map((at, index) => <Mark key={index} at={at} />)}
          </span>
          {legend}
        </p>
      )}
      <DrawerSection
        // Accepted means what reached the database, so a run that failed
        // before its merge lists findings that were validated and no more.
        title={run.database !== null ? FINDINGS.accepted : FINDINGS.validated}
        list={run.acceptedGenes}
        keyOf={(gene, index) => `${gene.symbol}-${gene.pmid}-${index}`}
        render={(gene) => <AcceptedRecord gene={gene} marks={marks} />}
      />
      {
        /* One line for the whole set: the groups below are cut from the
          findings the report holds, so past its cap none of them can say
          how many it is short. It names what it counts: bare, directly over
          the first group's uncounted heading, it read as that group's
          total. */
      }
      {isTruncated(rejected.shown, rejected.total) && (
        <p class="pipeline-truncation">
          {describeTruncation(
            rejected.shown,
            rejected.total,
            FINDINGS.notAccepted,
          )}
        </p>
      )}
      {rejectionGroups(run).map((group) => (
        <Group key={group.kind} group={group} marks={marks} />
      ))}
    </>
  );
}
