import { TextField } from "../Field.tsx";
import { Card } from "../Card.tsx";
import { FieldNote } from "../FieldNote.tsx";
import { StepSummary } from "../StepSummary.tsx";
import { ListEditor } from "../ListEditor.tsx";
import {
  addDiseaseTerm,
  applyMarkerCount,
  dropMeshHeading,
  lookupSummary,
  lookupValues,
  markerCountQuery,
  phrasesToCheck,
  removeDiseaseTerm,
  setDiseaseTerm,
  writeMeshRow,
} from "../../../lib/adapt/edits.ts";
import { GENETIC_TERMS } from "../../../lib/adapt/genetic_terms.ts";
import { meshRow, pubmedCount } from "../../../lib/adapt/lookups.ts";
import type { StepProps } from "./types.ts";

export function SearchStep(
  { answers, update, fetch, setStatus, busy, lookup }: StepProps,
) {
  const { diseaseTerms, meshTerms, markerTerms, ncbi } = answers.search;

  // Every lookup below writes its answer back through lib/adapt/edits.ts,
  // which finds the row by the value asked about as the answer lands: the
  // researcher can remove or retype a row while the request is out, and the
  // answer then belongs to no row rather than the wrong one. The finally
  // leaves the failure on the status line, or else what the lookup did. The
  // island's fetch spaces the NCBI requests, so the loops need no pacing of
  // their own; a blank row is skipped, because the empty term is a query
  // for everything. Only a phrase no row answers yet is looked up: one
  // whose heading was dropped is answered, and asking again would bring the
  // heading back.
  async function resolveHeadings() {
    let outcome = "";
    setStatus("Resolving MeSH headings…");
    const phrases = phrasesToCheck(answers.search);
    let none = 0;
    let missed = 0;
    try {
      for (const phrase of phrases) {
        const row = await meshRow(fetch, phrase, ncbi);
        if (!row.ok) {
          outcome = `Could not resolve "${phrase}": ${row.error}`;
          return;
        }
        if (row.value.heading === null) none += 1;
        let found = false;
        update((d) => found = writeMeshRow(d, phrase, row.value));
        if (!found) missed += 1;
      }
      outcome = lookupSummary("mesh", phrases.length, none, missed);
    } finally {
      setStatus(outcome);
    }
  }

  async function countMarkers() {
    const phrases = lookupValues(diseaseTerms);
    if (phrases.length === 0) {
      setStatus(
        "Add a disease phrase first; marker counts are anchored on the phrases.",
      );
      return;
    }
    let outcome = "";
    setStatus("Counting papers per marker term…");
    const terms = lookupValues(markerTerms.map((m) => m.term));
    let missed = 0;
    try {
      for (const term of terms) {
        const counted = await pubmedCount(
          fetch,
          markerCountQuery(phrases, term),
          ncbi,
        );
        if (!counted.ok) {
          outcome = `Could not count "${term}": ${counted.error}`;
          return;
        }
        let found = false;
        update((d) =>
          found = applyMarkerCount(d, phrases, term, counted.value)
        );
        if (!found) missed += 1;
      }
      outcome = lookupSummary("markers", terms.length, 0, missed);
    } finally {
      setStatus(outcome);
    }
  }

  const total = markerTerms.reduce((sum, m) => sum + (m.count ?? 0), 0);

  return (
    <section class="adapt-step">
      <h2 class="adapt-step-title">2. Search terms</h2>
      <StepSummary />
      <Card step="search" id="ncbi">
        <div class="adapt-row">
          <TextField
            label="NCBI email (optional)"
            value={ncbi.email}
            onInput={(v) => update((d) => d.search.ncbi.email = v)}
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            optional
            field="ncbi.email"
            hint="Sent with every NCBI request as E-utilities asks."
          />
          {
            /* A secret: no spelling service, no autofill, no capital. Not
               type="password", which would invite a password manager. */
          }
          <TextField
            label="NCBI API key (optional)"
            value={ncbi.apiKey}
            onInput={(v) => update((d) => d.search.ncbi.apiKey = v)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            optional
            field="ncbi.apiKey"
            hint="Lifts the limit from three to ten requests a second. Stays in this browser: it is never written to the archive or to the exported answers. A wrong or regenerated key makes every NCBI lookup fail; clear it to use the keyless rate."
          />
        </div>
      </Card>
      <Card step="search" id="phrases">
        <p class="adapt-status">
          The phrases a paper about this disease writes in its title or
          abstract; at least one, and two or three is usual. Every phrase is
          searched, and each is checked against MeSH for the heading that
          catches papers indexed under it.
        </p>
        <ListEditor
          items={diseaseTerms}
          addLabel="Add phrase"
          field="diseaseTerms"
          add={() => update(addDiseaseTerm)}
          remove={(i) => update((d) => removeDiseaseTerm(d, i))}
          render={(term, i) => (
            <TextField
              label={`Phrase ${i + 1}`}
              value={term}
              onInput={(v) => update((d) => setDiseaseTerm(d, i, v))}
              field={`diseaseTerms[${i}]`}
            />
          )}
        />
        <div class="adapt-actions">
          {
            /* aria-disabled rather than disabled: a disabled button drops
               the focus of the keyboard user who pressed it. lookup() is
               the guard. */
          }
          <button
            type="button"
            class="adapt-button adapt-button-primary"
            aria-disabled={busy ? "true" : undefined}
            data-action="check-mesh"
            onClick={() => lookup(resolveHeadings)}
          >
            Check MeSH headings
          </button>
        </div>
        <FieldNote field="meshTerms" />
        <div class="adapt-lookup">
          {diseaseTerms.map((phrase, i) => {
            // A row answers its phrase only while it still names it; one
            // resolved for words since retyped is not shown, and its note
            // says the phrase is unchecked.
            const m = meshTerms[i];
            const checked = phrase.trim() !== "" && m !== undefined &&
              m.phrase.trim() === phrase.trim();
            if (!checked) {
              return <FieldNote key={i} field={`meshTerms[${i}]`} />;
            }
            return (
              <div class="adapt-lookup-result" key={i}>
                {m.heading === null
                  ? (
                    <span>
                      "{m.phrase}" has no MeSH heading; it is still searched in
                      titles and abstracts.
                    </span>
                  )
                  : (
                    <>
                      <span>
                        "{m.phrase}" → <strong>{m.heading}</strong>{" "}
                        ({m.count === null
                          ? "count unavailable"
                          : `${m.count} papers all-time`}). {m.scopeNote}
                        {m.count !== null && m.count > 100000 &&
                          " This heading is a parent, not a disease; consider a narrower phrase, or drop the heading."}
                      </span>{" "}
                      <button
                        type="button"
                        class="adapt-button"
                        onClick={(e) => {
                          // The button goes with the heading; the check
                          // button takes focus rather than the page.
                          const card = (e.currentTarget as HTMLElement)
                            .closest(".adapt-card-body");
                          update((d) => dropMeshHeading(d, i));
                          setTimeout(() =>
                            card?.querySelector<HTMLElement>(
                              '[data-action="check-mesh"]',
                            )?.focus()
                          );
                        }}
                      >
                        Drop heading
                      </button>
                    </>
                  )}
                <FieldNote field={`meshTerms[${i}]`} />
              </div>
            );
          })}
        </div>
      </Card>
      <Card step="search" id="markers">
        <p class="adapt-status">
          Phenotypes, biomarkers or clinical terms that mark a paper as about
          this disease's biology; one to fifteen, and five to ten is usual. A
          marker keeps a paper that writes a disease phrase and the marker but
          no genetics term: it adds recall, and cost. It never reaches a paper
          that writes no disease phrase; the MeSH headings do that. Each count
          is the papers of all time holding any disease phrase and the term, so
          a large one is the term to look at first. The counts overlap and span
          every year, so their total is not the cost: that is the papers a year
          the whole query retrieves, which the checklist measures, at about 0.09
          USD a paper; above 2,000 a year is the point to trim.
        </p>
        <ListEditor
          items={markerTerms}
          addLabel="Add marker term"
          field="markerTerms"
          add={() =>
            update((d) => d.search.markerTerms.push({ term: "", count: null }))}
          remove={(i) => update((d) => d.search.markerTerms.splice(i, 1))}
          render={(marker, i) => (
            <>
              <TextField
                label={`Term ${i + 1}`}
                value={marker.term}
                onInput={(v) =>
                  update((d) => {
                    d.search.markerTerms[i].term = v;
                    d.search.markerTerms[i].count = null;
                  })}
                field={`markerTerms[${i}]`}
              />
              <span class="adapt-status">
                {marker.count === null
                  ? "not counted"
                  : `${marker.count} papers`}
              </span>
            </>
          )}
        />
        <div class="adapt-actions">
          <button
            type="button"
            class="adapt-button adapt-button-primary"
            aria-disabled={busy ? "true" : undefined}
            onClick={() => lookup(countMarkers)}
          >
            Count papers
          </button>
          <span class="adapt-status">Total across terms: {total}</span>
        </div>
      </Card>
      <Card step="search" id="genetic">
        <p class="adapt-status">
          The genetics vocabulary gating the query stays in code because it is
          about genetics, not the disease:{" "}
          {GENETIC_TERMS.join(", ")}. To add one, open an issue upstream.
        </p>
      </Card>
    </section>
  );
}
