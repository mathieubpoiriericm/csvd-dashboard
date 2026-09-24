import { ParsedTextField, TextField } from "../Field.tsx";
import { Card } from "../Card.tsx";
import { StepSummary } from "../StepSummary.tsx";
import { ListEditor } from "../ListEditor.tsx";
import { CodeBlock } from "../CodeBlock.tsx";
import { cardOf } from "../../../lib/adapt/cards.ts";
import { applyAbstract, parseConfidence } from "../../../lib/adapt/edits.ts";
import { pubmedAbstract } from "../../../lib/adapt/lookups.ts";
import { PMID } from "../../../lib/adapt/validate.ts";
import {
  prefillSections,
  SECTION_HELP,
  TYPED_SECTION_IDS,
} from "../../../lib/adapt/prompt_sections.ts";
import { joinList, splitList } from "./helpers.ts";
import type { StepProps } from "./types.ts";

const confidenceText = (value: number): string =>
  Number.isNaN(value) ? "" : String(value);

/**
 * Every example shows a gene to extract (validate() refuses any other
 * type), as interview question 8 asks: a paper reporting a causal-gene
 * finding.
 */
const EXAMPLE_TYPES =
  "An inclusion, e.g. include_validated, include_high_confidence or include_gwas_with_twas.";

export function PromptStep(
  { answers, update, fetch, setStatus, busy, lookup }: StepProps,
) {
  const { sections, examples } = answers.prompt;
  const traitKeys = answers.vocabulary.traits.map((t) => t.key);

  // The derived sections filled where they are blank; the status line says
  // which, since a filled section can sit in a folded card.
  const applyPrefills = () => {
    const filled: string[] = [];
    update((d) => {
      filled.length = 0;
      const prefills = prefillSections(d);
      for (const [id, body] of Object.entries(prefills)) {
        if ((d.prompt.sections[id] ?? "").trim() === "" && body !== "") {
          d.prompt.sections[id] = body;
          filled.push(id);
        }
      }
    });
    setStatus(
      filled.length === 0
        ? "Nothing to draft: each derived section is written, or its answers are not in yet."
        : `Drafted ${filled.join(", ")}.`,
    );
  };

  // The write-back (applyAbstract) finds the example by its PMID as the
  // answer lands, because the example can be removed or its PMID retyped
  // while the fetch is out. The finally leaves a failure -- or the "does
  // not exist" note, which is an answer, not a failure -- on the status
  // line, or else what was fetched.
  async function fetchAbstract(i: number) {
    let outcome = "";
    const pmid = examples[i].pmid.trim();
    if (!PMID.test(pmid)) {
      setStatus(
        "Enter the paper's PMID, digits with no leading zero, before fetching it.",
      );
      return;
    }
    setStatus(`Fetching PMID ${pmid}…`);
    try {
      const text = await pubmedAbstract(fetch, pmid, answers.search.ncbi);
      if (!text.ok) {
        outcome = `PubMed fetch failed: ${text.error}`;
        return;
      }
      let found = false;
      update((d) => found = applyAbstract(d, pmid, text.value));
      outcome = text.value === null
        ? `PMID ${pmid} does not exist.`
        : found
        ? `Fetched the abstract of PMID ${pmid}.`
        : `The example citing PMID ${pmid} changed while it was fetched; fetch it again.`;
    } finally {
      setStatus(outcome);
    }
  }

  return (
    <section class="adapt-step">
      <h2 class="adapt-step-title">6. Extraction prompt</h2>
      <StepSummary />
      <p class="adapt-status">
        These sentences are spliced into the model's instructions. Write them in
        your field's terms; the upstream file disease/prompt.md shows a worked
        example of each. Four are drafted from earlier steps and can be edited.
      </p>
      <div class="adapt-actions">
        <button type="button" class="adapt-button" onClick={applyPrefills}>
          Draft the four derived sections
        </button>
      </div>
      {(["criteria", "strategy", "rubric"] as const).map((card) => (
        <Card step="prompt" id={card} key={card}>
          {TYPED_SECTION_IDS.filter((id) =>
            cardOf("prompt", `sections.${id}`) === card
          ).map((id) => (
            <TextField
              key={id}
              label={id}
              value={sections[id] ?? ""}
              onInput={(v) =>
                update((d) => d.prompt.sections[id] = v)}
              multiline
              optional={id === "strategy.disease_steps"}
              hint={SECTION_HELP[id]}
              field={`sections.${id}`}
            />
          ))}
        </Card>
      ))}
      <Card step="prompt" id="examples">
        <p class="adapt-status">
          Two to four papers by PMID, or none. Each example quotes a sentence
          the paper wrote, names the gene the paper found, the trait keys from
          step 3 and your confidence that the gene is causal (0 to 1). Fetch the
          abstract to copy the sentence from it verbatim; never invent one.
        </p>
        <ListEditor
          items={examples}
          addLabel="Add example paper"
          field="examples"
          rowLabel={(e, i) =>
            `Example ${i + 1}${e.pmid.trim() === "" ? "" : `: PMID ${e.pmid}`}`}
          // The type and the confidence start unanswered: a default would
          // ship as the researcher's judgement without their having made it.
          add={() =>
            update((d) =>
              d.prompt.examples.push({
                pmid: "",
                type: "",
                abstract: null,
                gene: "",
                traits: [],
                sentence: "",
                confidence: NaN,
                reasoning: "",
              })
            )}
          remove={(i) => update((d) => d.prompt.examples.splice(i, 1))}
          render={(e, i) => (
            <div class="adapt-lookup">
              <div class="adapt-row">
                <TextField
                  label="PMID"
                  value={e.pmid}
                  onInput={(v) =>
                    update((d) => {
                      d.prompt.examples[i].pmid = v;
                      d.prompt.examples[i].abstract = null;
                    })}
                  field={`examples[${i}].pmid`}
                />
                <TextField
                  label="Example type"
                  value={e.type}
                  onInput={(v) => update((d) => d.prompt.examples[i].type = v)}
                  hint={EXAMPLE_TYPES}
                  field={`examples[${i}].type`}
                />
                <TextField
                  label="Gene symbol"
                  value={e.gene}
                  onInput={(v) => update((d) => d.prompt.examples[i].gene = v)}
                  field={`examples[${i}].gene`}
                />
              </div>
              <div class="adapt-actions">
                <button
                  type="button"
                  class="adapt-button"
                  aria-disabled={busy ? "true" : undefined}
                  onClick={() => lookup(() => fetchAbstract(i))}
                >
                  Fetch abstract
                </button>
              </div>
              {e.abstract !== null && <CodeBlock>{e.abstract}</CodeBlock>}
              <TextField
                label="Paper states (verbatim sentence)"
                value={e.sentence}
                onInput={(v) =>
                  update((d) => d.prompt.examples[i].sentence = v)}
                multiline
                field={`examples[${i}].sentence`}
              />
              <div class="adapt-row">
                <ParsedTextField
                  label="Trait keys (comma separated)"
                  canonical={joinList}
                  value={e.traits.join(", ")}
                  onInput={(v) =>
                    update((d) => d.prompt.examples[i].traits = splitList(v))}
                  hint={`From step 3: ${traitKeys.join(", ")}`}
                  field={`examples[${i}].traits`}
                />
                {
                  /* A text field rather than type="number": a number input
                     reports a half-typed "0." as "", which would clear the
                     field under the cursor. NaN renders as the empty field. */
                }
                <ParsedTextField
                  label="Confidence (0–1)"
                  canonical={(text) => confidenceText(parseConfidence(text))}
                  value={confidenceText(e.confidence)}
                  onInput={(v) =>
                    update((d) =>
                      d.prompt.examples[i].confidence = parseConfidence(v)
                    )}
                  inputMode="decimal"
                  field={`examples[${i}].confidence`}
                />
              </div>
              <TextField
                label="Reasoning"
                value={e.reasoning}
                onInput={(v) =>
                  update((d) => d.prompt.examples[i].reasoning = v)}
                field={`examples[${i}].reasoning`}
              />
            </div>
          )}
        />
      </Card>
    </section>
  );
}
