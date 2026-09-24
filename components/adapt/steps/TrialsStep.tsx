import { ParsedTextField, SelectField, TextField } from "../Field.tsx";
import { Card } from "../Card.tsx";
import { StepSummary } from "../StepSummary.tsx";
import { ListEditor } from "../ListEditor.tsx";
import {
  applyTrialCount,
  lookupSummary,
  lookupValues,
  removeFamily,
  renameFamily,
  setTrialTerm,
} from "../../../lib/adapt/edits.ts";
import { ctgovCount, ctgovSample } from "../../../lib/adapt/lookups.ts";
import {
  MECHANISM_PALETTE,
  POPULATION_PALETTE,
} from "../../../lib/adapt/palette.ts";
import { familyOptions, joinList, splitList } from "./helpers.ts";
import type { StepProps } from "./types.ts";

export function TrialsStep(
  { answers, update, fetch, setStatus, busy, lookup }: StepProps,
) {
  const t = answers.trials;
  const options = familyOptions(t.mechanismFamilies);

  // The write-back (applyTrialCount) finds the rows by their term as the
  // answer lands, because a term can be removed or retyped while its two
  // requests are out; the finally leaves a failure on the status line, or
  // else what was counted. A blank term is skipped: as a condition query it
  // matches every registered study.
  async function countTerms() {
    let outcome = "";
    setStatus("Counting ClinicalTrials.gov studies…");
    const terms = lookupValues(t.searchTerms.map((s) => s.term));
    let missed = 0;
    try {
      for (const term of terms) {
        const count = await ctgovCount(fetch, term);
        const sample = await ctgovSample(fetch, term);
        if (!count.ok || !sample.ok) {
          outcome = `ClinicalTrials.gov lookup failed for "${term}": ${
            count.ok ? (sample as { error: string }).error : count.error
          }`;
          return;
        }
        let found = false;
        update((d) =>
          found = applyTrialCount(d, term, count.value, sample.value)
        );
        if (!found) missed += 1;
      }
      outcome = lookupSummary("trials", terms.length, 0, missed);
    } finally {
      setStatus(outcome);
    }
  }

  return (
    <section class="adapt-step">
      <h2 class="adapt-step-title">4. Clinical trials</h2>
      <StepSummary />
      <Card step="trials" id="populations">
        <p class="adapt-status">
          The populations the trials page files a trial under: at least one, at
          most{" "}
          {POPULATION_PALETTE.length}. Label lines are how the radar wraps the
          name.
        </p>
        <ListEditor
          items={t.populations}
          addLabel="Add population"
          field="populations"
          rowLabel={(p, i) =>
            `Population ${i + 1}${p.key.trim() === "" ? "" : `: ${p.key}`}`}
          add={() =>
            update((d) =>
              d.trials.populations.push({ key: "", label: "", lines: [] })
            )}
          remove={(i) => update((d) => d.trials.populations.splice(i, 1))}
          render={(p, i) => (
            <>
              <TextField
                label="Key"
                value={p.key}
                onInput={(v) => update((d) => d.trials.populations[i].key = v)}
                field={`populations[${i}].key`}
              />
              <TextField
                label="Label"
                value={p.label}
                onInput={(v) =>
                  update((d) => {
                    const population = d.trials.populations[i];
                    // The lines are redrafted from the label only while they
                    // are still the draft -- none, blank (a field emptied by
                    // hand holds one blank line), or the label on one line; a
                    // hand-wrapped label is the researcher's and survives an
                    // edit to the name.
                    const drafted = population.lines.every((line) =>
                      line.trim() === ""
                    ) ||
                      (population.lines.length === 1 &&
                        population.lines[0] === population.label);
                    population.label = v;
                    if (drafted) population.lines = v.trim() === "" ? [] : [v];
                  })}
                field={`populations[${i}].label`}
              />
              <TextField
                label="Radar label lines"
                value={p.lines.join("\n")}
                onInput={(v) =>
                  update((d) => d.trials.populations[i].lines = v.split("\n"))}
                multiline
                hint="One line per row on the radar."
                field={`populations[${i}].lines`}
              />
            </>
          )}
        />
        <div class="adapt-row">
          <TextField
            label="Population column label"
            value={t.populationField.label}
            onInput={(v) => update((d) => d.trials.populationField.label = v)}
            hint="e.g. XYZ Population"
            field="populationField.label"
          />
          <TextField
            label="Population details label"
            value={t.populationField.detailsLabel}
            onInput={(v) =>
              update((d) => d.trials.populationField.detailsLabel = v)}
            hint="e.g. XYZ Population Details"
            field="populationField.detailsLabel"
          />
        </div>
      </Card>
      <Card step="trials" id="search">
        <p class="adapt-status">
          Condition terms to search with. The count is what each retrieves; the
          sample conditions show what a term pulls in, so you can choose the
          substrings below that keep the right trials.
        </p>
        <ListEditor
          items={t.searchTerms}
          addLabel="Add search term"
          field="searchTerms"
          add={() =>
            update((d) =>
              d.trials.searchTerms.push({
                term: "",
                count: null,
                sampleConditions: [],
                sampleInterventions: [],
              })
            )}
          remove={(i) => update((d) => d.trials.searchTerms.splice(i, 1))}
          render={(s, i) => (
            <div class="adapt-lookup">
              <TextField
                label={`Term ${i + 1}`}
                value={s.term}
                onInput={(v) => update((d) => setTrialTerm(d, i, v))}
                field={`searchTerms[${i}]`}
              />
              {s.count !== null && (
                <div class="adapt-lookup-result">
                  {s.count} studies. Conditions seen:{" "}
                  {s.sampleConditions.join("; ") || "none"}. Interventions seen:
                  {" "}
                  {s.sampleInterventions.join("; ") || "none"}.
                </div>
              )}
            </div>
          )}
        />
        <div class="adapt-actions">
          <button
            type="button"
            class="adapt-button adapt-button-primary"
            aria-disabled={busy ? "true" : undefined}
            onClick={() => lookup(countTerms)}
          >
            Count studies
          </button>
        </div>
        <ParsedTextField
          label="Condition substrings (comma separated)"
          canonical={joinList}
          value={t.conditions.join(", ")}
          onInput={(v) => update((d) => d.trials.conditions = splitList(v))}
          hint="A discovered trial is kept when its stated condition contains one of these. The condition is compared in lower case with punctuation turned into spaces, so write letters, digits and spaces only."
          field="conditions"
        />
        <ListEditor
          items={t.conditionPairs}
          addLabel="Add word pair"
          field="conditionPairs"
          empty="No word pairs. A pair keeps a trial whose condition contains both words, e.g. juvenile + onset."
          add={() => update((d) => d.trials.conditionPairs.push(["", ""]))}
          remove={(i) => update((d) => d.trials.conditionPairs.splice(i, 1))}
          render={(pair, i) => (
            <>
              <TextField
                label="First word"
                value={pair[0]}
                onInput={(v) =>
                  update((d) => d.trials.conditionPairs[i][0] = v)}
                field={`conditionPairs[${i}]`}
              />
              <TextField
                label="Second word"
                value={pair[1]}
                onInput={(v) =>
                  update((d) => d.trials.conditionPairs[i][1] = v)}
                field={`conditionPairs[${i}].1`}
              />
            </>
          )}
        />
      </Card>
      <Card step="trials" id="mechanisms">
        <p class="adapt-status">
          At least one mechanism already being tested for the disease, in your
          own wording (never an intervention name copied as-is), each in a
          family. At most {MECHANISM_PALETTE.length}.
        </p>
        <ListEditor
          items={t.mechanismFamilies}
          addLabel="Add mechanism family"
          field="mechanismFamilies"
          add={() =>
            update((d) =>
              d.trials.mechanismFamilies.push({ key: "", label: "" })
            )}
          remove={(i) =>
            update((d) =>
              removeFamily(d.trials.mechanismFamilies, d.trials.mechanisms, i)
            )}
          render={(f, i) => (
            <>
              <TextField
                label="Family key"
                value={f.key}
                onInput={(v) =>
                  update((d) =>
                    renameFamily(
                      d.trials.mechanismFamilies,
                      d.trials.mechanisms,
                      i,
                      v,
                    )
                  )}
                hint='Key the family of mechanisms not yet characterised "uncharacterised": the radar flags its trials.'
                field={`mechanismFamilies[${i}]`}
              />
              <TextField
                label="Family label"
                value={f.label}
                onInput={(v) =>
                  update((d) => d.trials.mechanismFamilies[i].label = v)}
                field={`mechanismFamilies[${i}].label`}
              />
            </>
          )}
        />
        <ListEditor
          items={t.mechanisms}
          addLabel="Add mechanism"
          field="mechanisms"
          rowLabel={(m, i) =>
            `Mechanism ${i + 1}${m.name.trim() === "" ? "" : `: ${m.name}`}`}
          add={() =>
            update((d) => d.trials.mechanisms.push({ name: "", family: "" }))}
          remove={(i) => update((d) => d.trials.mechanisms.splice(i, 1))}
          render={(m, i) => (
            <>
              <TextField
                label="Mechanism"
                value={m.name}
                onInput={(v) => update((d) => d.trials.mechanisms[i].name = v)}
                field={`mechanisms[${i}].name`}
              />
              <SelectField
                label="Family"
                value={m.family}
                options={options}
                onChange={(v) =>
                  update((d) => d.trials.mechanisms[i].family = v)}
                field={`mechanisms[${i}].family`}
              />
            </>
          )}
        />
      </Card>
    </section>
  );
}
