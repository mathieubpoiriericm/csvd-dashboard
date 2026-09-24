import { TextField } from "../Field.tsx";
import { Card } from "../Card.tsx";
import { StepSummary } from "../StepSummary.tsx";
import { ListEditor } from "../ListEditor.tsx";
import {
  addExamplePapers,
  applyTitles,
  lookupSummary,
} from "../../../lib/adapt/edits.ts";
import { pubmedSummaries } from "../../../lib/adapt/lookups.ts";
import { PMID } from "../../../lib/adapt/validate.ts";
import type { StepProps } from "./types.ts";

export function GoldStep(
  { answers, update, fetch, setStatus, busy, lookup }: StepProps,
) {
  const { rows } = answers.gold;

  // The write-back (applyTitles) matches rows by PMID rather than by
  // index, so a row removed or retyped while the request was out simply
  // goes unanswered. The finally leaves a failure on the status line, or
  // else what was checked.
  async function checkAll() {
    let outcome = "";
    setStatus("Checking PMIDs…");
    try {
      const pmids = [
        ...new Set(rows.map((r) => r.pmid.trim()).filter((p) => PMID.test(p))),
      ];
      const titles = await pubmedSummaries(fetch, pmids, answers.search.ncbi);
      if (!titles.ok) {
        outcome = `PubMed lookup failed: ${titles.error}`;
        return;
      }
      let missed = 0;
      update((d) => missed = applyTitles(d, titles.value));
      const absent = Object.values(titles.value).filter((t) => t === null);
      outcome = lookupSummary("gold", pmids.length, absent.length, missed);
    } finally {
      setStatus(outcome);
    }
  }

  return (
    <section class="adapt-step">
      <h2 class="adapt-step-title">7. Gold papers for recall</h2>
      <StepSummary />
      <Card step="gold" id="rows">
        <p class="adapt-status">
          Ten to thirty PMIDs the PubMed query must retrieve: the genetics
          papers on this disease you would be alarmed to see a run miss. The
          note says why each is gold.
        </p>
        <div class="adapt-actions">
          <button
            type="button"
            class="adapt-button"
            onClick={() => update(addExamplePapers)}
          >
            Add the example papers
          </button>
          <button
            type="button"
            class="adapt-button adapt-button-primary"
            aria-disabled={busy ? "true" : undefined}
            onClick={() => lookup(checkAll)}
          >
            Check PMIDs
          </button>
        </div>
        <ListEditor
          items={rows}
          addLabel="Add PMID"
          field="rows"
          rowLabel={(row, i) =>
            `Gold paper ${i + 1}${
              row.pmid.trim() === "" ? "" : `: PMID ${row.pmid}`
            }`}
          add={() =>
            update((d) =>
              d.gold.rows.push({
                pmid: "",
                note: "",
                title: null,
                exists: null,
              })
            )}
          remove={(i) => update((d) => d.gold.rows.splice(i, 1))}
          render={(row, i) => (
            <>
              <TextField
                label="PMID"
                value={row.pmid}
                onInput={(v) =>
                  update((d) => {
                    d.gold.rows[i].pmid = v;
                    d.gold.rows[i].exists = null;
                    d.gold.rows[i].title = null;
                  })}
                field={`rows[${i}].pmid`}
              />
              <TextField
                label="Why it is gold"
                value={row.note}
                onInput={(v) => update((d) => d.gold.rows[i].note = v)}
                field={`rows[${i}].note`}
              />
              <span class="adapt-status">
                {row.title ??
                  (row.exists === false ? "not found" : "unchecked")}
              </span>
            </>
          )}
        />
      </Card>
    </section>
  );
}
