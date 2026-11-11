/**
 * The run details' Findings tab: what the run's papers proposed, and what
 * became of each proposal.
 */

import { Icon } from "../Icon.tsx";
import { formatOmicsEntry, parseOmicsEntry } from "../../lib/omics.ts";
import {
  describeRejection,
  field,
  formatConfidence,
} from "../../lib/pipeline_display.ts";
import type { PipelineRun, RejectedGene, RunGene } from "../../lib/types.ts";
import {
  DrawerSection,
  Field,
  FieldName,
  Pmid,
  ValuePill,
} from "./records.tsx";

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

export function FindingsPanel({ run }: { run: PipelineRun }) {
  // Whether the run reached its merge: accepted means what reached the
  // database, so before it the findings are validated and no more.
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
    </>
  );
}
