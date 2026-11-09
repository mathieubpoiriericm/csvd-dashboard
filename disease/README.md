# Cerebral small vessel disease (cSVD)

The disease this repository's `disease/` describes. Everything on this page is a
measurement of the cSVD dataset the dashboard was built on; the code, the
pipeline and the tests outside the four `csvd/` trees hold for any disease.

- **Institute:** Paris Brain Institute (ICM),
  <https://institutducerveau-icm.org>
- **Maintainer:** Mathieu B. Poirier, <mathieu.poirier3@mail.mcgill.ca>
- **Hosted at:** <https://csvd-dashboard.fly.dev>

## What the dashboard holds

| File                    | Rows             | Source                              |
| ----------------------- | ---------------- | ----------------------------------- |
| `table1.json`           | 88 genes         | `genes` table (+ three join tables) |
| `table2.json`           | 102 trial rows   | `clinical_trials` table (curated)   |
| `gene_info.json`        | 88               | `ncbi_gene_info` cache              |
| `gene_info_table2.json` | 26               | `ncbi_gene_info` cache              |
| `protein_info.json`     | 88               | `uniprot_info` cache                |
| `refs.json`             | 168 citations    | `pubmed_citations` cache            |
| `omim_info.json`        | 49               | `disease/omim_info.csv`             |
| `gene_annotations.json` | 160              | `gene_annotations` table (pivoted)  |
| `pipeline_syncs.json`   | 3 (one per mode) | `sync_runs` table                   |
| `geocoded_trials.json`  | 378 sites        | ClinicalTrials.gov                  |
| `cytobands_hg38.json`   | 862 bands        | UCSC Genome Browser                 |

The 102 curated trial rows are 65 drugs across 82 registered trials, 77 of them
on ClinicalTrials.gov, which is where the 378 map sites in 23 countries come
from. `timeline.json` names 51 curated mechanisms of action grouped into 14
families; the rows themselves use 46 of the mechanisms. The karyogram draws the
21 chromosomes that carry a gene.

### Traits

The 16 canonical phenotypes in `vocabulary.json`, by family. Each carries its
STRIVE-2 definition, an ontology cross-reference (or an explicit `null` with the
reason), and synonyms; nine more prompt terms are listed as deliberately
untracked.

| Key              | Name                                                        | Family      |
| ---------------- | ----------------------------------------------------------- | ----------- |
| `WMH`            | White matter hyperintensities (of presumed vascular origin) | `wmh`       |
| `PVWMH`          | Periventricular white matter hyperintensities               | `wmh`       |
| `DWMH`           | Deep white matter hyperintensities                          | `wmh`       |
| `BG-PVS`         | Basal ganglia perivascular spaces                           | `pvs`       |
| `WM-PVS`         | White matter perivascular spaces                            | `pvs`       |
| `HIP-PVS`        | Hippocampal perivascular spaces                             | `pvs`       |
| `PSMD`           | Peak width of skeletonized mean diffusivity                 | `diffusion` |
| `FA`             | Fractional anisotropy                                       | `diffusion` |
| `MD`             | Mean diffusivity                                            | `diffusion` |
| `NODDI`          | Neurite orientation dispersion and density imaging          | `diffusion` |
| `extreme-cSVD`   | Extreme cerebral small vessel disease                       | `extreme`   |
| `SVS`            | Small vessel stroke                                         | `stroke`    |
| `stroke`         | Stroke                                                      | `stroke`    |
| `lacunar stroke` | Lacunar stroke                                              | `stroke`    |
| `CMB`            | Cerebral microbleeds                                        | `cmb`       |
| `lacunes`        | Lacunes (of presumed vascular origin)                       | `lacunes`   |

### Populations

The trials are filed under four populations (`manifest.json`, `populations`),
shown on the trials pages as the "SVD Population" column: **CAA**, **Cognitive
Impairment**, **Stroke** and **SVD** -- the last labelled "Any SVD (including
monogenic)" on the radar.

## The PubMed query

`SVD_QUERY` in `pipeline/pubmed_search.py` is built from the search terms in
`pipeline.json`, and its recall is measured rather than assumed.
`tests/pipeline/csvd/test_query_recall.py` intersects it with a `[uid]`
disjunction over a gold set of 204 PMIDs -- the 183 the pipeline-built table
cited up to the 2026-11-03 re-extraction, plus the 21 references the
hand-curated gold table adds -- so recall is exact rather than sampled and never
meets PubMed's 9,999-record `esearch` cap -- it bounds a result set that can
never exceed the gold set. `recall_gold.csv` holds the same 204 PMIDs for the
generic harness, so the denominator does not move when the published table does,
and `recall_baseline.json` the figure the last
`scripts.measure_recall --write-baseline` recorded.

It retrieves **184 of 204** (178 of the first 183). The third branch,
`MESH_TERMS AND GENETIC_TERMS`, reaches papers that never write the disease name
out in the title or abstract and recovers 64 of the 204 on its own; its genetics
gate is what keeps `"White Matter"[MeSH]` from quadrupling ingestion. The two
Title/Abstract branches both `AND` on
`"cerebral small vessel disease"[Title/Abstract]`, which is therefore the
ceiling on them: the ten `GENETIC_TERMS` and seven `MARKER_TERMS` are precision
filters and **contribute no recall at all**, and a test pins that so widening
either list in the belief that it helps fails loudly.

The five misses are the same five at gold sets of 29, 32, 111, 178 and 183
papers, which on its own proves nothing: every reference a run adds came from a
paper the query itself retrieved, so it could never be missed. The evidence is
the 28 hand-curated references of the 31 August baseline, which the query did
not choose: it retrieves 23 of them, and all five misses are among them. They
are pinned with a reason each in `_MISSED`. The gold table's references add
fifteen misses, most of them the single-cell atlases and methods papers it cites
for its cell-type columns rather than cSVD papers the query should find.

Retrieval precision is not measured. The argument for the MeSH branch is a
volume argument -- 43% more papers for six more gold ones -- not a relevance
one. Nothing says what fraction of those ~263 extra papers a year is signal, and
settling it needs relevance judgments over a sample.

## Extraction recall

`tests/pipeline/csvd/test_extraction_golden.py` replays locally recorded
cassettes (CI skips it) and asserts recall over the gold genes each paper's
_retrieved text actually names_:

| Subset                      | Recall          |
| --------------------------- | --------------- |
| genes named in the prompt   | 19/20 = **95%** |
| genes the prompt never says | 21/26 = **81%** |
| pooled                      | 40/46 = **87%** |

Measured on Claude Opus 5.5 with prompt v8 (re-recorded 2026-11-08); prompt v7
measured 18/20, 21/26 and 39/46 on the 2026-11-02 recording. Opus 5 scored 88%
clean and 93% pooled on the same text, but the genes it found and Opus 5.5 did
not were ones it reported below the confidence floor a run applies; after that
floor the two models recover 38/46 and 39/46 of the pooled genes.

**Quote the 81%** -- the clean subset is the one that measures extraction rather
than recall of the prompt. 13 of the 36 gold genes are named verbatim in the
rendered v8 prompt -- the `<example>` blocks that name them live in `prompt.md`,
not the template in `pipeline/prompts.py` -- six of them with their expected
trait and confidence, and `test_the_prompt_names_part_of_its_own_answer_key`
pins that count so a prompt edit naming another gold gene fails instead of
quietly inflating the figure.

The 2026-09-11 re-record, against fixtures refetched through the current Europe
PMC parser, measured the same as the one before it on Opus 5; the recording
before that measured two points lower (81% clean, 87% pooled): one paper gains
or loses two genes the prompt never names from one recording to the next, with
the model, prompt version and effort unchanged -- the nondeterminism the suite
is built around rather than a regression to chase.

Raw set-F1 measures about 0.40, for reasons that are mostly not extraction: 23%
of gold gene-paper pairs name a gene that is not in the retrieved text at all,
and the gold standard is a curated table whose rows are the genes the curators
judged causal, not every gene a paper implicates. Still unmeasured: the Docling
PDF path (no gold PMID takes it), negative cases (no gold row reports zero
genes), and anything downstream of `extract_from_paper`, which runs before the
confidence gate and NCBI validation.

## How to cite

The citation is not settled yet: `about.citation` in `manifest.json` is `null`,
and the About page says so. The scientific board, the contact text and the
acknowledgements are `null` for the same reason.
