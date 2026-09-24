import { SelectField, TextField } from "../Field.tsx";
import { Card } from "../Card.tsx";
import { FieldNote, NotedCheckbox } from "../FieldNote.tsx";
import { StepSummary } from "../StepSummary.tsx";
import { ListEditor } from "../ListEditor.tsx";
import {
  removeFamily,
  renameFamily,
  replacesChoice,
  setXref,
  xrefAnswer,
} from "../../../lib/adapt/edits.ts";
import { olsSearch } from "../../../lib/adapt/lookups.ts";
import { FAMILY_PALETTE } from "../../../lib/adapt/palette.ts";
import { familyOptions } from "./helpers.ts";
import type { StepProps } from "./types.ts";

export function VocabularyStep(
  { answers, update, fetch, setStatus, busy, lookup }: StepProps,
) {
  const { traits, families, citationStandard } = answers.vocabulary;
  const options = familyOptions(families);

  // The write-back re-checks the row: the trait can be removed, or its long
  // name edited, while the search is out, and the answer would then belong
  // to a question nobody asked. A term or a note the researcher chose is
  // replaced only on a yes. The finally leaves a failure on the status line,
  // or else what was found.
  async function lookupXref(i: number) {
    let outcome = "";
    const asked = traits[i];
    const name = asked.name;
    if (name.trim() === "") {
      setStatus(
        "Give the trait its long name first; that is what is searched.",
      );
      return;
    }
    setStatus(`Searching ontologies for "${name}"…`);
    try {
      const hits = await olsSearch(fetch, name);
      if (!hits.ok) {
        outcome = `Ontology search failed: ${hits.error}`;
        return;
      }
      const answer = xrefAnswer(name, hits.value);
      if (
        replacesChoice(asked, answer) &&
        !globalThis.confirm(
          "Replace the term and note you chose with the search's top hit?",
        )
      ) {
        outcome = "Kept the term and note you chose.";
        return;
      }
      update((d) => {
        const trait = d.vocabulary.traits[i];
        if (trait === undefined || trait.name !== name) return;
        trait.xref = answer.xref;
        trait.xrefNote = answer.xrefNote;
      });
      outcome = answer.xref === null
        ? `No term in EFO, HP or MONDO for "${name}".`
        : `Found ${answer.xref} for "${name}".`;
    } finally {
      setStatus(outcome);
    }
  }

  return (
    <section class="adapt-step">
      <h2 class="adapt-step-title">3. Trait vocabulary</h2>
      <StepSummary />
      <Card step="vocabulary" id="families">
        <p class="adapt-status">
          Groups of two to five traits that share a colour; at most{" "}
          {FAMILY_PALETTE.length}.
        </p>
        <ListEditor
          items={families}
          addLabel="Add family"
          field="families"
          rowLabel={(family, i) =>
            `Family ${i + 1}${
              family.key.trim() === "" ? "" : `: ${family.key}`
            }`}
          add={() =>
            update((d) => d.vocabulary.families.push({ key: "", label: "" }))}
          remove={(i) =>
            update((d) =>
              removeFamily(d.vocabulary.families, d.vocabulary.traits, i)
            )}
          render={(family, i) => (
            <>
              <TextField
                label="Family key"
                value={family.key}
                onInput={(v) =>
                  update((d) =>
                    renameFamily(
                      d.vocabulary.families,
                      d.vocabulary.traits,
                      i,
                      v,
                    )
                  )}
                hint="Short, lower case."
                field={`families[${i}]`}
              />
              <TextField
                label="Family label"
                value={family.label}
                onInput={(v) =>
                  update((d) => d.vocabulary.families[i].label = v)}
                field={`families[${i}].label`}
              />
            </>
          )}
        />
      </Card>
      <Card step="vocabulary" id="traits">
        <p class="adapt-status">
          Four to sixteen. The key is what the model writes, and what the genes
          table and the run widget show; the label is the short text on the
          karyogram's pill and the filter choice. The definition is one
          sentence, quoted from the field's standard when there is one.
        </p>
        <ListEditor
          items={traits}
          addLabel="Add trait"
          field="traits"
          rowLabel={(trait, i) =>
            `Trait ${i + 1}${trait.key.trim() === "" ? "" : `: ${trait.key}`}`}
          add={() =>
            update((d) =>
              d.vocabulary.traits.push({
                key: "",
                label: "",
                name: "",
                family: "",
                definition: "",
                standard: false,
                xref: null,
                xrefNote: "",
              })
            )}
          remove={(i) => update((d) => d.vocabulary.traits.splice(i, 1))}
          render={(trait, i) => (
            <div class="adapt-lookup">
              <div class="adapt-row">
                <TextField
                  label="Key"
                  value={trait.key}
                  onInput={(v) => update((d) => d.vocabulary.traits[i].key = v)}
                  field={`traits[${i}].key`}
                />
                <TextField
                  label="Label"
                  value={trait.label}
                  onInput={(v) =>
                    update((d) => d.vocabulary.traits[i].label = v)}
                  hint="Short: it is drawn in a narrow column (about 20 characters)."
                  field={`traits[${i}].label`}
                />
                <SelectField
                  label="Family"
                  value={trait.family}
                  options={options}
                  onChange={(v) =>
                    update((d) => d.vocabulary.traits[i].family = v)}
                  field={`traits[${i}].family`}
                />
              </div>
              <TextField
                label="Long name"
                value={trait.name}
                onInput={(v) => update((d) => d.vocabulary.traits[i].name = v)}
                field={`traits[${i}].name`}
              />
              <TextField
                label="Definition"
                value={trait.definition}
                onInput={(v) =>
                  update((d) => d.vocabulary.traits[i].definition = v)}
                multiline
                field={`traits[${i}].definition`}
              />
              <label class="adapt-field">
                <span class="adapt-field-label">
                  <NotedCheckbox
                    field={`traits[${i}].standard`}
                    checked={trait.standard}
                    onToggle={(checked) =>
                      update((d) => d.vocabulary.traits[i].standard = checked)}
                  />{" "}
                  The definition is quoted from the named standard
                </span>
              </label>
              <FieldNote field={`traits[${i}].standard`} />
              <div class="adapt-actions">
                <button
                  type="button"
                  class="adapt-button"
                  aria-disabled={busy ? "true" : undefined}
                  onClick={() => lookup(() => lookupXref(i))}
                >
                  Find ontology term
                </button>
              </div>
              {
                /* The search offers its top hit; the researcher accepts it,
                   takes another from the alternatives the note lists, or
                   clears it when none fits, as the interview asks. */
              }
              <TextField
                label="Ontology term"
                value={trait.xref ?? ""}
                onInput={(v) =>
                  update((d) => setXref(d.vocabulary.traits[i], v))}
                optional
                field={`traits[${i}].xref`}
                hint="The search's top hit, another id from the note, or blank when none fits."
              />
              <TextField
                label="Cross-reference note"
                value={trait.xrefNote}
                onInput={(v) =>
                  update((d) => d.vocabulary.traits[i].xrefNote = v)}
                optional={trait.xref !== null}
                field={`traits[${i}].xrefNote`}
              />
            </div>
          )}
        />
      </Card>
      <Card step="vocabulary" id="standard">
        <div class="adapt-actions">
          <button
            type="button"
            class="adapt-button"
            aria-pressed={citationStandard === null ? "false" : "true"}
            onClick={() => {
              // Turning the standard off drops its four fields, so what has
              // been typed into them goes only on a yes.
              if (
                citationStandard !== null &&
                Object.values(citationStandard).some((v) => v.trim() !== "") &&
                !globalThis.confirm("Discard the standard's citation?")
              ) return;
              update((d) =>
                d.vocabulary.citationStandard = citationStandard === null
                  ? { name: "", label: "", doi: "", linkLabel: "" }
                  : null
              );
            }}
          >
            The field has a phenotype standard
          </button>
        </div>
        {citationStandard !== null && (
          <>
            <TextField
              label="Standard name"
              value={citationStandard.name}
              onInput={(v) =>
                update((d) => d.vocabulary.citationStandard!.name = v)}
              field="citationStandard.name"
            />
            <TextField
              label="Citation"
              value={citationStandard.label}
              onInput={(v) =>
                update((d) => d.vocabulary.citationStandard!.label = v)}
              field="citationStandard.label"
            />
            <TextField
              label="DOI"
              value={citationStandard.doi}
              onInput={(v) =>
                update((d) => d.vocabulary.citationStandard!.doi = v)}
              spellCheck={false}
              hint="The DOI alone, e.g. 10.1000/xyz123, without https://doi.org/."
              field="citationStandard.doi"
            />
            <TextField
              label="Link label"
              value={citationStandard.linkLabel}
              onInput={(v) =>
                update((d) => d.vocabulary.citationStandard!.linkLabel = v)}
              field="citationStandard.linkLabel"
            />
          </>
        )}
      </Card>
    </section>
  );
}
