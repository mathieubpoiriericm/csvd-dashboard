---
name: sync-annotations
description: "Use when running or debugging `--sync-annotations` (ClinVar → Orphadata dependency order, delete-before-insert trap, the 30-day TTL purge, _LOOKUP_ALIASES) or when data/gene_annotations.json looks wrong."
---

# Syncing the annotations

```bash
uv run python -m pipeline.main --sync-annotations
```

It is free, takes about 30 minutes, and records its own `sync_runs` row (see
"The refreshes record their own runs" in `pipeline/CLAUDE.md`). Everything below
was found in shipped data or a recorded run rather than reasoned about.

`--sync-annotations` fetches disease, ontology and identity annotations for the
63 curated genes from ClinVar, Orphadata and Open Targets, and verifies Table
2's curator-entered mechanisms against Open Targets' ChEMBL records. Four
clients — `clinvar_fetch.py`, `orphadata_fetch.py`, `opentargets_fetch.py`,
`opentargets_drugs.py` — write three tables and nothing else.

**The curated `genes` table is never written by any of it.** There is no foreign
key to `genes` either, deliberately, so an annotation run cannot lock or cascade
into it. The acceptance criterion is that `max(updated_at)` on `genes` is the
same before and after a full run; every other check here can pass while a client
quietly writes into a curated column, and that one cannot.

**One edge table, not six.** The three sources produce the same _kind_ of fact —
a gene, a relation, an object with an identifier, and provenance — in three
envelopes, and a table per source would need six that every consumer would union
anyway. `gene_annotations` holds all of them keyed on
`(gene_symbol, source, relation, group_key, object_id)`.

- **`group_key` is what makes an enrichment joinable.** Every row describing one
  disease repeats that disease's canonical identifier there, preferring MONDO,
  then OMIM, then Orphanet, then MedGen. For HTRA1's CARASIL that is
  `MONDO:0010829`, and it is carried by ClinVar's four cross-reference rows,
  Orphadata's four cross-references and 32 HPO phenotypes, and Open Targets'
  scored association alike — so one `GROUP BY` collects all of them.
- **It defaults to `''`, never `NULL`.** PostgreSQL treats `NULL` as distinct
  from itself in a `UNIQUE` constraint, so two identical GO rows would both
  insert. Rows that are not about a disease — GO terms, Ensembl and HGNC
  identity — carry the empty string.
- **`gene_annotation_status` is the negative cache and the TTL anchor.** A gene
  with no annotations has no rows in `gene_annotations`, which is otherwise
  indistinguishable from a gene never fetched. A _transport_ failure writes no
  row at all, so a 500 is never remembered as "this gene has no diseases" for 30
  days.

- **Two curated keys are not gene symbols, and are looked up by what they stand
  for.** `COL4A1/2` is the curators' label for the pair — the two collagen IV
  alpha chains form one heterotrimer and the cSVD literature reports them
  together — and `C6orf195` is a symbol NCBI has retired in favour of
  `LINC01600`. Queried literally, both returned nothing from all three sources
  and were written as zero-count rows, recorded here for a long time as
  "findings about the curated table, not failures". That reading was too
  generous: the dashboard does not render a zero-count row as "this key is not a
  symbol", it renders it as no disease at all — for the pair that causes Gould
  syndrome, PADMAL, HANAC and brain small-vessel disease 1 and 2, which is the
  dashboard's own subject. `_LOOKUP_ALIASES` in `pipeline/annotations.py` fans
  the lookup out to `COL4A1`/`COL4A2` and `LINC01600`, and the rows come back
  filed under the curated key, which is what `genes.gene` holds and therefore
  what the export asks for. COL4A1/2 now carries 51 ClinVar rows, 109 Orphadata
  and 92 Open Targets, and publishes 15 diseases; C6orf195 gains 9 Open Targets
  identity rows and still has no ClinVar disease, which for a lncRNA is the
  genuine zero.

  Two properties of the fan-out are load-bearing. The **status row is per
  curated key, not per query symbol**, and is withheld entirely if any of that
  key's aliases failed — otherwise one alias succeeding would write the status
  that suppresses the retry for 30 days while the other alias's rows were
  missing, which is the delete-before-insert trap the three clients each fell
  into differently above. And the map is **reconciled, not derived**:
  `pipeline/annotations.py` imports nothing from the pipeline, so it declares
  `_LOOKUP_ALIASES` itself and `tests/pipeline/test_annotations.py` asserts it
  is exactly the inverse of `data_merger._CANONICAL_GENE_SYMBOLS`, the map that
  folds an extracted `COL4A1` onto the curated key on the way in. Neither
  direction can gain an entry the other lacks.

  What it costs: `gene_annotations` has no column naming which member gene
  supplied a row, so a COL4A2 disease and a COL4A1 disease sit side by side
  under `COL4A1/2` with nothing saying which chain carries which. Every row
  still carries its own OMIM, MONDO and Orphanet identifiers, so no identifier
  is moved between diseases — the loss is attribution _within_ a pair the
  curated key already asserts is one entity. Recording the member gene is a
  migration, and is the upgrade if the distinction is ever wanted.

**That last invariant is easy to break and each client broke it differently.**
`replace_gene_annotations` deletes before it inserts, so a status row written
after a failure does not merely fail to record — it drops the rows the gene
already had and then suppresses the retry for the whole TTL, while the run
reports success. All three now refuse to write one:

- ClinVar's `_fetch_summaries` returns `None` rather than skipping a failed
  esummary batch. NOTCH3's 248 uids are two batches, and skipping one published
  a truncated disease set as though it were complete.
- Open Targets' `resolve_target` returns a `_Resolution`, not a bare
  `str | None`. A timeout, a 5xx, a JSON error and the GraphQL `errors` array
  all produced `None`, which was indistinguishable from "no such gene" — so one
  outage during a run wiped every Open Targets row for 61 genes.
- Orphadata skips a gene if _any_ of its ORPHAcodes failed. Skipping only when
  every code failed wrote the surviving codes' rows plus a status row, which --
  delete-before-insert -- dropped the failed code's previous enrichment and then
  suppressed the retry. A gene with no ORPHAcode at all is the different case,
  and does get its zero-count row: there is no gene entry point, so that is a
  final answer rather than a failure.

**ClinVar is the entry point and Orphadata is the enrichment, so their order in
`sync_all_annotations` is a dependency rather than a preference.** Orphadata has
no gene endpoint — `rd-associated-genes/genes/HTRA1` is a 404, and every
endpoint is keyed by ORPHAcode — so `orphacodes_by_gene()` reads the `Orphanet:`
rows ClinVar wrote. A consequence worth knowing: if a ClinVar run degrades,
Orphadata caches a zero-count status against the incomplete result and the
30-day TTL keeps it there. Delete the `orphadata` rows from both annotation
tables and re-run; nothing else needs touching.

**Orphadata waits for a ClinVar answer.** A gene whose ClinVar fetch failed
outright has no rows and no status -- the transport-failure invariant above,
kept correctly on ClinVar's side -- which in `orphacodes_by_gene()` is the same
shape as a gene ClinVar answered with no Orphanet identifier. Writing the
zero-count row for the first negative-cached ClinVar's outage one hop
downstream: on the first sync after an NCBI 500, or after the manual purge just
described, HTRA1 would carry an Orphadata status of zero for 30 days while both
syncs reported success. `sync_orphadata_annotations` therefore reads ClinVar's
status for every gene it is about to fetch, at any age, and skips a gene with
none as a failure (`Orphadata skipped HTRA1: no ClinVar answer yet`); the
zero-count row is written only when ClinVar's own status says the gene has no
ORPHAcode.

**Orphadata's TTL is not its own either.** Its rows carry the ORPHAcodes and
`group_key`s ClinVar chose, so a ClinVar refresh inside Orphadata's 30 days --
the manual purge above, or any run in which ClinVar's status expired first --
can add a code or move a group and leave enrichment behind that no longer joins.
The export drops such a group with a warning; an added code gets no warning at
all, just no enrichment. `sync_orphadata_annotations` therefore reads ClinVar's
status for _every_ gene, not only the ones it is about to fetch, and re-fetches
a gene whose ClinVar `updated_at` is newer than its own. Missing timestamps
answer "not stale": a cache is invalidated on evidence.

**Two ORPHAcodes under one group used to overwrite each other's mapping.**
ClinVar can attach several codes to one disease -- LAMC2 carries four under
`MONDO:0009180` -- and each reports its own `DisorderMappingRelation` for a
target they share. Those rows land on one
`(gene, source, relation, group_key,
object_id)` key, so `ON CONFLICT DO UPDATE`
kept whichever `executemany` wrote last and the other relation left no trace in
the table, the export or the log. `_resolve_code_collisions` decides before the
write instead: an exact (`E`) mapping wins, otherwise the first code in
ClinVar's order does, and every conflict is logged with both codes and both
relations. The relation is the scientific payload -- it is what says an OMIM
number is not a synonym for the Orphanet disease -- so it must never be chosen
by sort order.

**A 200 without `data.results` is a failure, not an empty disease.** An in-band
error document or a renamed field used to build a disease with no
cross-references, which wrote a zero-count status row and -- delete before
insert -- dropped the enrichment the gene already had, for 30 days, while the
run reported success. `_get_results` requires the key to be present; a
present-but-empty `results` is still an answer.

**UniProt's second call can fail too, and it used to be stored as a success.**
`fetch_uniprot_go_info` returned the same empty mapping for a 200 with no GO
columns and for a timeout, a 5xx or an unreadable body, so a gene whose
accession lookup succeeded and whose GO lookup did not was written with three
empty GO columns, filed under `successful`, and held out of the next sync for
`DB_CACHE_TTL_DAYS`. It now returns `None` for anything that is not an answer,
`_fetch_uniprot_uncached` turns that into a transient miss (`accession=None`,
`cacheable_miss=False`), and the sync counts the gene as failed and writes
nothing. The placeholder `fetch_uniprot_batch` builds when a lookup returns
nothing at all carries `cacheable_miss=False` for the same reason, as
`ncbi_gene_fetch`'s always has.

**A UniProt row that does not name the symbol is not the gene's protein.**
`_parse_search_rows` fell back to the _first returned row_ when no row's primary
gene matched, and UniProt token-matches the gene-names field even under
`gene_exact:` -- so an entry that merely contains the symbol as a word in
another gene's name was published as that gene's accession, protein name and
URL, filed as a success (`sync_uniprot_info` only consults `cacheable_miss` for
misses) and held for 30 days. The symbol must now appear either as the row's
primary gene or in its `Gene Names (synonym)` column, which is why the query
asks for that field and for `reviewed`; a reviewed (Swiss-Prot) synonym match
beats an unreviewed one, and neither query naming the symbol is a _cacheable_
miss -- the answer arrived and does not carry this gene. The synonym route is
load-bearing rather than lenient: `C6orf195` is published from `LINC01600`'s
entry, which lists the obsolete symbol, exactly as `select_gene_uid` renames it
at NCBI. A rows-but-no-match answer to `gene_exact:` no longer ends the lookup
either; the broader `gene:` query still gets its turn.

## The upstream services, documented where they are decided

**ClinVar's record filters and NCBI's `[Sym]` search are both documented where
they are decided.** `_MAX_RECORD_GENES` and `_MAX_OVERLAP_SPAN` in
`pipeline/clinvar_fetch.py` carry the measurements that separate a multi-gene
overlap (TREX1's readthrough, which the old `len(genes) == 1` rule dropped with
all 61 of TREX1's records) from a span event (FDFT1's 120-kb deletion, which
published squalene synthase deficiency as CTSB's disease);
`ncbi_http.select_gene_uid` carries why `idlist[0]` is never trusted (`ARSB`
resolved to SLURP1) and why the fallback to an unchecked first hit stays
(`C6orf195` is answered as `LINC01600`). Two operational facts live nowhere in
code. Fixing either filter changes what a re-sync returns, and the 30-day status
rows stand in the way: delete the `clinvar` **and** `orphadata` rows from
`gene_annotations` and `gene_annotation_status` for the affected genes and
re-run `--sync-annotations`. And a poisoned `ncbi_gene_info` row survives until
its 30-day `DB_CACHE_TTL_DAYS` expires, so correcting one means deleting it from
that table -- there is no refresh flag. That miss-only behaviour is also what
lets a PubMed run fill the lookup caches for its own keys
(`sync_external_data_for`, called from `_refresh_lookup_caches` before
`--export`; see the root `CLAUDE.md`).

**Open Targets is pinned and self-checking.** The API self-describes as Beta and
its schema has already moved once (`knownDrugs` → `drugAndClinicalCandidates`),
so every row records the data version it came from and the sync warns when the
live one differs from `opentargets_data_version`. Two traps are pinned by test:
`GeneOntologyTerm` exposes `label`, not `name`, and a schema drift arrives as a
**200 with an `errors` array** rather than a 4xx — without the errors check a
renamed field looks like an empty result and writes zero rows.

**The drug sync is a verification, not a correction.** 6 of the 11 curated trial
drugs resolve in ChEMBL and 5 carry a mechanism; every one of the 5 agrees with
the curator's parenthetical, and the returned `targets[].approvedSymbol` match
the curated `geneticTarget` column.

**Open Targets' drug search is fuzzy, so the hit is checked by name.** It
returns something for almost anything — measured live, `"Placebo"` comes back as
CHEMBL3 NICOTINE with a nicotinic-agonist mechanism and `"Minocyclin"` as
MINOCYCLINE HYDROCHLORIDE. `get_trial_drugs()` reads whatever the
`clinical_trials` table holds, so before the comparator rule above every arm
CT.gov typed as `DRUG` was searchable, and recording a mechanism for a drug
nobody asked about, beside a curated column, is worse than recording nothing.
`_matching_hit` requires the returned `name` to be the one searched for, exactly
as `resolve_target` does for genes. Two details go with it: `strip_trade_suffix`
is anchored at the end, so `"(ALN-APP)"` no longer becomes a search for the
empty string; and every mechanism row is recorded rather than `rows[0]`, because
the API does not rank them and Nimodipine's first row is a mineralocorticoid
antagonist rather than the calcium blocker the trial is testing. The 5 that do
not resolve are unregistered agents and trade-named preparations ChEMBL does not
index — a coverage limit of the reference database, not an error in the curated
column — so they are recorded as `resolved=False` rather than counted in
`SyncResult.failed`, which would otherwise mark every healthy run as failed
forever.

**Orphadata is CC-BY-4.0**, asserted as `data.__licence.identifier` in every
payload. The client logs an error if that value changes, because any published
attribution is tied to it.
