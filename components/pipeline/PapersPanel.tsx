/**
 * The run details' Papers tab: every paper the run took up, and what became
 * of it.
 */

import { Icon } from "../Icon.tsx";
import {
  describePaper,
  describeRefusal,
  paperSourceLabel,
} from "../../lib/pipeline_display.ts";
import type { PipelineRun, RunPaper } from "../../lib/types.ts";
import { DrawerSection, Field, Pmid, ValuePill } from "./records.tsx";

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

export function PapersPanel({ run }: { run: PipelineRun }) {
  const written = run.database !== null;
  return (
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
  );
}
