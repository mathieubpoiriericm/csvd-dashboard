import { ParsedTextField, TextField } from "../Field.tsx";
import { Card } from "../Card.tsx";
import { StepSummary } from "../StepSummary.tsx";
import { ListEditor } from "../ListEditor.tsx";
import {
  applyGeneCheck,
  hasOmimRow,
  lookupSummary,
  lookupValues,
} from "../../../lib/adapt/edits.ts";
import { clinvarTraits, officialSymbol } from "../../../lib/adapt/lookups.ts";
import { joinList, splitList } from "./helpers.ts";
import type { StepProps } from "./types.ts";

const OMIM_FIELDS = [
  ["omimNum", "OMIM phenotype number"],
  ["location", "Cytogenetic location"],
  ["phenotype", "Phenotype"],
  ["phenotypeMimNumber", "Phenotype MIM number"],
  ["inheritance", "Inheritance (AD, AR, XL…)"],
  ["phenotypeMappingKey", "Phenotype mapping key (1–4)"],
  ["geneOrLocus", "Gene"],
  ["geneOrLocusMimNumber", "Gene MIM number"],
] as const;

export function MonogenicStep(
  { answers, update, fetch, setStatus, busy, lookup }: StepProps,
) {
  const { genes, aliases, omimRows } = answers.monogenic;
  const auth = answers.search.ncbi;

  // The write-back (applyGeneCheck) finds the row by the symbol asked
  // about as the answer lands, because a symbol can be removed or retyped
  // while its requests are out, and writes the official spelling NCBI Gene
  // returned -- to the OMIM rows and aliases naming the gene too -- so a
  // symbol typed in the wrong case is stored as HGNC writes it. A ClinVar
  // failure is reported rather than swallowed, and the symbol is still
  // recorded as verified: NCBI Gene answered, and that answer is worth
  // keeping. The finally leaves a failure on the status line, or else what
  // was checked. Only unchecked symbols are asked about, and a blank row is
  // skipped: "[sym] AND human[orgn]" finds every human gene.
  async function checkGenes() {
    let outcome = "";
    setStatus("Checking symbols against NCBI Gene and ClinVar…");
    const symbols = lookupValues(
      genes.filter((g) => g.verified === null).map((g) => g.symbol),
    );
    let refused = 0;
    let missed = 0;
    try {
      for (const typed of symbols) {
        const official = await officialSymbol(fetch, typed, auth);
        if (!official.ok) {
          outcome = `NCBI Gene lookup failed for ${typed}: ${official.error}`;
          return;
        }
        const symbol = official.value;
        if (symbol === null) refused += 1;
        const traits = symbol === null
          ? { ok: true as const, value: [] }
          : await clinvarTraits(fetch, symbol, auth);
        let found = false;
        update((d) =>
          found = applyGeneCheck(
            d,
            typed,
            symbol,
            traits.ok ? traits.value : [],
          )
        );
        if (!found) missed += 1;
        if (!traits.ok) {
          outcome = `ClinVar lookup failed for ${symbol}: ${traits.error}`;
          return;
        }
      }
      outcome = lookupSummary("genes", symbols.length, refused, missed);
    } finally {
      setStatus(outcome);
    }
  }

  const addOmimRow = (gene: string, name: string, omim: string | null) =>
    update((d) =>
      d.monogenic.omimRows.push({
        omimNum: omim ?? "",
        location: "",
        phenotype: name,
        phenotypeMimNumber: omim ?? "",
        inheritance: "",
        phenotypeMappingKey: "",
        geneOrLocus: gene,
        geneOrLocusMimNumber: "",
      })
    );

  return (
    <section class="adapt-step">
      <h2 class="adapt-step-title">5. Monogenic genes</h2>
      <StepSummary />
      <Card step="monogenic" id="genes">
        <p class="adapt-status">
          Genes in which rare variants cause a Mendelian form of the disease,
          zero to ten. Checking a symbol confirms it with NCBI Gene and lists
          the diseases ClinVar attests for this gene's own pathogenic variants,
          each with its OMIM number when ClinVar reports one.
        </p>
        <ListEditor
          items={genes}
          addLabel="Add gene"
          field="genes"
          rowLabel={(gene, i) =>
            `Gene ${i + 1}${
              gene.symbol.trim() === "" ? "" : `: ${gene.symbol}`
            }`}
          empty="No monogenic genes. That is a valid answer."
          add={() =>
            update((d) =>
              d.monogenic.genes.push({
                symbol: "",
                verified: null,
                clinvarTraits: [],
              })
            )}
          remove={(i) => update((d) => d.monogenic.genes.splice(i, 1))}
          render={(gene, i) => (
            <div class="adapt-lookup">
              <TextField
                label="HGNC symbol"
                value={gene.symbol}
                onInput={(v) =>
                  update((d) => {
                    // Kept as typed: HGNC symbols are not all upper case
                    // (an open-reading-frame symbol keeps its lower-case
                    // "orf"), and the check writes back the official spelling.
                    d.monogenic.genes[i].symbol = v;
                    d.monogenic.genes[i].verified = null;
                    d.monogenic.genes[i].clinvarTraits = [];
                  })}
                field={`genes[${i}]`}
              />
              {gene.verified &&
                gene.clinvarTraits.map((trait) => {
                  const added = hasOmimRow(answers, gene.symbol, trait);
                  return (
                    <div class="adapt-lookup-result" key={trait.name}>
                      {trait.name} {trait.omim === null
                        ? "(no OMIM number)"
                        : `(OMIM ${trait.omim})`} {
                        /* Named after its trait, its visible label first,
                           so one of several is told apart; once the row is
                           there it says so rather than adding it again. The
                           OMIM card may be folded, so the status line says
                           what was added. */
                      }
                      <button
                        type="button"
                        class="adapt-button"
                        aria-disabled={added ? "true" : undefined}
                        aria-label={added
                          ? `Already in the OMIM entries: ${trait.name}`
                          : `Add OMIM row for ${trait.name}`}
                        onClick={() => {
                          if (added) return;
                          addOmimRow(gene.symbol, trait.name, trait.omim);
                          setStatus(
                            `Added ${
                              trait.omim === null ? "" : `OMIM ${trait.omim} `
                            }(${trait.name}) to the OMIM entries.`,
                          );
                        }}
                      >
                        {added ? "Already in the OMIM entries" : "Add OMIM row"}
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
        />
        <div class="adapt-actions">
          <button
            type="button"
            class="adapt-button adapt-button-primary"
            aria-disabled={busy ? "true" : undefined}
            onClick={() => lookup(checkGenes)}
          >
            Check symbols
          </button>
        </div>
      </Card>
      <Card step="monogenic" id="aliases">
        <p class="adapt-status">
          The name the dashboard files a gene, or a group of genes, under
          instead of its HGNC symbol: a combined label such as XYZ1/2, or a
          symbol NCBI has retired that the literature still uses. Every
          extraction of the listed HGNC symbols is stored under this name, and
          shown under it on every page. A literature synonym of one gene needs
          no entry: NCBI validation already maps it to the gene.
        </p>
        <ListEditor
          items={aliases}
          addLabel="Add alias"
          field="aliases"
          add={() =>
            update((d) => d.monogenic.aliases.push({ alias: "", symbols: [] }))}
          remove={(i) => update((d) => d.monogenic.aliases.splice(i, 1))}
          render={(al, i) => (
            <>
              <TextField
                label="Dashboard name (curated key)"
                value={al.alias}
                onInput={(v) => update((d) => d.monogenic.aliases[i].alias = v)}
                field={`aliases[${i}]`}
              />
              <ParsedTextField
                label="HGNC symbols stored under it (comma separated)"
                canonical={joinList}
                value={al.symbols.join(", ")}
                onInput={(v) =>
                  update((d) => d.monogenic.aliases[i].symbols = splitList(v))}
                field={`aliases[${i}].symbols`}
              />
            </>
          )}
        />
      </Card>
      <Card step="monogenic" id="omim">
        <p class="adapt-status">
          One row per confirmed phenotype entry. Confirm each on omim.org and
          copy the location, inheritance, mapping key and gene MIM number from
          the entry page; the wizard has no OMIM API key to look them up. The
          table is plain ASCII.
        </p>
        <ListEditor
          items={omimRows}
          addLabel="Add OMIM row"
          field="omimRows"
          rowLabel={(row, i) =>
            `OMIM row ${i + 1}${
              row.omimNum.trim() === "" ? "" : `: ${row.omimNum}`
            }`}
          add={() => addOmimRow(genes[0]?.symbol ?? "", "", null)}
          remove={(i) => update((d) => d.monogenic.omimRows.splice(i, 1))}
          render={(row, i) => (
            <div class="adapt-row">
              {OMIM_FIELDS.map(([key, label]) => (
                <TextField
                  key={key}
                  label={label}
                  value={row[key]}
                  onInput={(v) =>
                    update((d) => d.monogenic.omimRows[i][key] = v)}
                  optional={key === "inheritance"}
                  field={`omimRows[${i}].${key}`}
                />
              ))}
            </div>
          )}
        />
      </Card>
    </section>
  );
}
