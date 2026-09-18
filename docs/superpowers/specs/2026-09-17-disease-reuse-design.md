# Reusing the dashboard for another disease

Design, 2026-09-17. The inventory this design rests on is the "Dashboard Static
Text" artifact (https://claude.ai/artifact/HgDLT1q5zeSCkJRkZQhJcm), which lists
every cSVD-specific string in the repository with the file and line it lives at
and the destination this document assigns it.

## 1. Problem

The dashboard's second goal was reuse for diseases similar to cSVD. Nothing
supports that today: no scaffolder, no configuration layer, no documented list
of what to change. The disease-specific surface is small in kind but scattered
in place. An audit found:

- **Scientific content** that a new disease must rewrite: the extraction prompt
  (`pipeline/prompts.py`, essentially all 355 lines), the trait vocabulary
  (`lib/vocabulary.json`), the PubMed term lists
  (`pipeline/pubmed_search.py:63-87`), the ClinicalTrials.gov search terms and
  relevance gate (`pipeline/config.py:200-211`,
  `pipeline/clinical_trials_fetch.py:67-97`), the curated OMIM CSV, the
  monogenic gene list inside the prompt, the radar's four populations and 51
  mechanisms (`lib/timeline_encoding.json`), the seven phenogram families and
  the STRIVE-2 citation (`lib/phenogram_encoding.json`).
- **Branding and prose**: fourteen literals across eight files
  (`lib/constants.ts:22`, `routes/_app.tsx:48,76,209`,
  `routes/index.tsx:21,28,199`, `routes/login.tsx:69`, four route descriptions,
  `islands/TrialsTimeline.tsx:1221`, `components/IcmLogo.tsx`), plus the README
  and six CLAUDE.md files.
- **Identifiers** that embed the abbreviation: the `svd_population` column
  (which reaches the wire key, the column header and the filter label), 191
  `--svd-` CSS custom properties, and a cookie, two storage keys, an event name
  and the PMID scanner's marker token.
- **Measurements** pinned in about 25 test files: row counts, gene names, the
  106/111 query recall and its cassettes, the golden extraction fixtures, the
  confidence floors, the "over 20 genes per paper" heuristic.

Retrieval, PDF parsing, the annotation fetchers, the export writer, the map, the
run widget, auth and every migration but 001 are already disease-neutral.

## 2. Decisions

These were made with the maintainer before the design was drawn.

1. **The user is a researcher running a Claude Code skill after forking.** Not a
   pure CLI questionnaire, and not an internal tool run on their behalf. The
   skill can draft the prompt and vocabulary from an interview; a scaffolder
   cannot.
2. **Manifest first.** One `disease/` directory becomes the seam. The code reads
   it; the skill writes it; cSVD is its first instance.
3. **Rename only the population column.** `svd_population` becomes
   `target_population` through a migration because its name reaches the JSON
   contract. The CSS prefix, cookie, storage and event names are internal
   namespaces and stay.
4. **A generated repo ships empty data.** Tests derive their expectations from
   the committed JSON; the cSVD regression tests move into `csvd/` trees the
   skill deletes.
5. **Upstream sync is a plain git fork.** With the disease content confined to
   `disease/` and `data/`, `git merge upstream/main` conflicts only there.
   Copier was evaluated: it is the one scaffolder with an update path, but it
   requires Jinja placeholders in the tree, Python plus Copier on the
   researcher's machine, and its update conflicts are reported as frequent. The
   fork gives the same update path for free.
6. **Any disease with a genetics literature.** Cell types, populations, families
   and the citation standard are all configurable, so a cardiac or renal disease
   is in scope.
7. **Approach A for the prompt.** The methodology stays upstream as a v7
   template; the disease prose lives in `disease/prompt.md`; assembly is
   deterministic; a test pins the cSVD assembly byte-identical to today's v6
   literals. Rejected: keeping the whole prompt in the disease file (methodology
   fixes would never reach a fork) and generating the prompt from manifest
   fields (the worked examples are where the rubric lives, and generating them
   from fields either drops them or turns the manifest into a prompt in JSON
   clothing).

### Amendments (2026-09-17)

Rulings made during implementation that this design did not anticipate; they
bind later sub-projects same as the decisions above.

- **The manifest is two files, not one.** `disease/manifest.json` carries the
  web-facing keys; `disease/pipeline.json` carries `search`, `monogenicGenes`,
  `geneAliases` and `pipeline`, and is read only by `pipeline/disease.py`.
  Reason: `server/protected_data_build.ts` lists `COL4A1/2` as a leak canary,
  and every island bundle embeds the web-facing manifest, so no gene symbol may
  live in the file TypeScript reads. See §3 and §3.1.
- **`disease/prompt.md` is excluded from `deno fmt`** (`deno.json`'s
  `fmt.exclude`), because `deno fmt` rewraps Markdown prose and every inserted
  newline would reach the model; `tests/pipeline/test_prompt_assembly.py` still
  pins the cSVD rendering byte-identical to the v6 literals.
- **Migration 014 is written by the seam work; applying it to the production
  database is the maintainer's job at merge time**, not something this branch
  does. The committed `data/table2.json` already carries the renamed
  `targetPopulation` key because it was regenerated against a database migration
  014 had already been run against during development — that run is separate
  from, and does not stand in for, applying the migration in production.
- **`data/pipeline_run.json` keeps its pre-seam shape until the next real run.**
  It is the last recorded run's report rather than derived data, so it still
  reads `config.promptVersion: "v6"` with no `disease` or `promptSha256` key;
  both are nullable additions to `RunConfigRecord` and will appear, non-null,
  once a run using this branch's code produces a new report.
- **The About lede lost its two `<b>` spans, by design.** It read
  "<b>up-to-date</b> and <b>standardized</b>" as JSX; the sentence is
  `site.aboutLede` in `disease/manifest.json` now, and the manifest holds text
  rather than markup. Emphasis inside a manifest string would mean either a
  markup dialect to parse or `dangerouslySetInnerHTML` over an authored file —
  both larger than the two bold words are worth. A disease that wants emphasis
  back adds a rendered field, not a tag in the string.

## 3. The `disease/` directory

```
disease/
  manifest.json         web-facing: names, prose, institute, contact, about,
                        hosting, populations, cell types, citation standard
  manifest.schema.json  JSON Schema for the above
  pipeline.json         pipeline-only: search terms, monogenic genes, gene
                        aliases, pipeline knobs — read only by
                        pipeline/disease.py
  pipeline.schema.json  JSON Schema for the above
  vocabulary.json       moved from lib/; `strive` renamed `standard`
  prompt.md             the disease sections of the extraction prompt
  phenogram.json        families (key, label, hue, tint)
  timeline.json         populations, mechanisms, unknownMechanism, families
  omim_info.csv         moved from pipeline/export/data/
  recall_gold.csv       pmid,note: papers the query must find (cSVD: the 111)
  recall_baseline.json  written by scripts/measure_recall.py --write-baseline
  README.md             the disease-specific half of the README
```

The manifest is two files rather than one, for a reason a directory listing
can't carry on its own: `server/protected_data_build.ts` lists `COL4A1/2` as a
leak canary, and every island bundle embeds the web-facing manifest, so no gene
symbol — nor anything else the pipeline alone needs — may live in it.
`manifest.json` is the file TypeScript reads; `pipeline.json` is the file only
`pipeline/disease.py` reads.

Appearance stays in `lib/`. `lib/phenogram_encoding.json` keeps `evidence`,
`glyphs`, `stains` and `layout`; `lib/timeline_encoding.json` keeps `rings`,
`rimBand`, `boundary`, `emptyCell`, `evidenceStates` and `recordFlag`. The rings
stay because `pipeline/clinical_trials_fetch.py` reads `RADAR_PHASES` off them
and the seven phases are registry facts. Families and mechanisms move with their
hues: a fork has a different family count, so its palette is re-chosen anyway,
and splitting label from hue across two files would put one array's order in two
places.

`lib/phenogram.ts` and `lib/timeline.ts` compose the two halves at import:
`{ ...appearance, families }` and
`{ ...appearance, populations, mechanisms,
unknownMechanism, families }`. The
`TimelineEncoding` type is unchanged, so every test that hands
`computeTimelineLayout` a hand-built encoding keeps working.

### 3.1 manifest.json and pipeline.json

`schemaVersion` is `1` in both files. Every string is trimmed at the boundary;
`null` on an optional key means absent, never `""`. Values shown are cSVD's.

```jsonc
{
  "schemaVersion": 1,
  "disease": {
    "key": "csvd", // slug; run report, fingerprint, DB names
    "name": "cerebral small vessel disease",
    "short": "SVD",
    "abbreviation": "cSVD", // the prompt's spelling
    "adjective": "Cerebral SVD" // "<adjective> clinical trials by population and phase"
  },
  "site": {
    "title": "ICM Cerebral SVD Dashboard",
    "heading": "Putative Causal Genes and Clinical Trial Drugs for Cerebral Small Vessel Disease",
    "metaDescription": "Interactive dashboard of putative causal genes and clinical trial drugs for cerebral small vessel disease, from the Paris Brain Institute (ICM).",
    "aboutTitle": "Welcome to the Paris Brain Institute's Cerebral SVD Dashboard",
    "aboutLede": "This dashboard provides up-to-date and standardized information on putative cerebral small vessel disease (SVD) causal genes and drugs tested in planned or ongoing cerebral SVD clinical trials.",
    "loginLede": "Putative causal genes and clinical trial drugs for cerebral small vessel disease (SVD).",
    "pages": { "genes": "…", "trials": "…", "timeline": "…", "map": "…" }
  },
  "institute": {
    "name": "Paris Brain Institute",
    "short": "ICM",
    "url": "https://institutducerveau-icm.org",
    "copyright": "Paris Brain Institute (ICM)",
    "logo": {
      "src": "/institute/logo-light.svg",
      "srcOnDark": "/institute/logo-dark.svg",
      "alt": "Paris Brain Institute"
    }
  },
  "contact": {
    "maintainer": {
      "name": "Mathieu B. Poirier",
      "email": "mathieu.poirier@icm-institute.org"
    }
  },
  "about": {
    "citation": null, // null renders the pending placeholder row; else {authors,title,journal,year,doi}
    "board": null,
    "contactUs": null,
    "acknowledgements": null,
    "additionalSources": [] // [{name, href, licence:{label, href?}, provides}], rendered after the three fixed sources
  },
  "hosting": { "url": "https://csvd-dashboard.mathieubpoiriericm.deno.net" },
  "populations": [
    { "key": "CAA", "label": "CAA" },
    { "key": "Cognitive Impairment", "label": "Cognitive Impairment" },
    { "key": "Stroke", "label": "Stroke" },
    { "key": "SVD", "label": "SVD" }
  ],
  "populationField": {
    "label": "SVD Population",
    "detailsLabel": "SVD Population Details"
  },
  "cellTypes": {
    "label": "Brain Cell Types",
    "glossary": {
      "EC": "Endothelial Cells",
      "SMC": "Smooth Muscle Cells",
      "VSMC": "Vascular Smooth Muscle Cells",
      "AC": "Astrocytes",
      "MG": "Microglia",
      "OL": "Oligodendrocytes",
      "PC": "Pericytes",
      "FB": "Fibroblasts"
    }
  },
  "citationStandard": {
    "name": "STRIVE-2",
    "label": "Duering, M. et al. Neuroimaging standards for research into small vessel disease—advances since 2013. The Lancet Neurology 22, 602–618 (2023).",
    "doi": "10.1016/S1474-4422(23)00131-X",
    "linkLabel": "View STRIVE-2 (Lancet Neurol 2023)"
  } // nullable
}
```

`pipeline.json`:

```jsonc
{
  "schemaVersion": 1,
  "$comment": "Read only by pipeline/disease.py. Gene symbols and search terms belong here, never in disease/manifest.json, because every island bundle embeds that file.",
  "search": {
    "pubmed": {
      "diseaseTerms": ["cerebral small vessel disease"],
      "markerTerms": [
        "stroke",
        "dementia",
        "lacunes",
        "lacunar stroke",
        "white matter hyperintensities",
        "perivascular spaces",
        "cerebral microbleeds"
      ],
      "meshTerms": ["Cerebral Small Vessel Diseases", "White Matter"]
    },
    "clinicalTrials": {
      "searchTerms": [
        "cerebral small vessel disease",
        "lacunar stroke",
        "lacunar infarction",
        "CADASIL",
        "CARASIL",
        "cerebral microbleeds",
        "white matter hyperintensities",
        "vascular cognitive impairment",
        "vascular dementia",
        "cerebral amyloid angiopathy"
      ],
      "conditions": [
        "small vessel disease",
        "small vascular disease",
        "lacunar",
        "lacune",
        "cadasil",
        "carasil",
        "microbleed",
        "white matter hyperintensit",
        "white matter lesion",
        "white matter disease",
        "leukoaraiosis",
        "amyloid angiopathy",
        "binswanger",
        "perivascular space",
        "subcortical infarct",
        "subcortical ischemi",
        "covert brain infarct",
        "silent brain infarct",
        "silent cerebral infarct"
      ],
      "conditionPairs": [["vascular", "dementia"], ["vascular", "cognitive"]]
    }
  },
  "monogenicGenes": ["NOTCH3", "COL4A1", "COL4A2", "HTRA1", "TREX1", "GLA"],
  "geneAliases": {
    "COL4A1/2": ["COL4A1", "COL4A2"],
    "C6orf195": ["LINC01600"]
  },
  "pipeline": { "runLabel": "SVD Pipeline", "maxGenesPerPaper": 20 }
}
```

Three keys deserve a word. `GENETIC_TERMS` is not in the manifest: the ten words
are disease-neutral and stay in `pubmed_search.py`. `geneAliases` replaces both
`_CANONICAL_GENE_SYMBOLS` in `data_merger.py` (inverted) and `_LOOKUP_ALIASES`
in `annotations.py`; the test that reconciled the two becomes a same-source
check and stays. Cell types are in the manifest, not the vocabulary:
`vocabulary.json` is read by three Python consumers as the extraction enum, and
cell types are never extracted, enumerated or folded.

### 3.2 Readers

**TypeScript.** `lib/disease/manifest.ts` imports the JSON, normalizes it the
way `lib/data/normalize.ts` does, and throws on a `schemaVersion` it does not
know: a wrong manifest is a build error, not a data gap. Narrow modules keep
islands from pulling the whole manifest into a client bundle:
`lib/disease/site.ts` (title, heading, meta description, About, login, route
descriptions, radar title, institute, contact), `populations.ts` (`POPULATIONS`,
`POPULATION_FIELD`), `cell_types.ts`, `citation.ts`. A barrel `lib/disease.ts`
exists for the tests, as `lib/data.ts` does. `lib/constants.ts` derives
`POPULATION_CHOICES` from `populations[]` exactly as `GWAS_TRAIT_CHOICES`
derives from the vocabulary, and re-exports `SITE_TITLE` so `_app.tsx` and
`login.tsx` do not move their imports. `components/IcmLogo.tsx` becomes
`components/InstituteLogo.tsx`, an `<img>` over `institute.logo`; the inline SVG
is exported once to `static/institute/logo-light.svg` and `logo-dark.svg`, so a
fork edits nothing under `components/`.

**Python.** `pipeline/disease.py` is stdlib-only and imports nothing from
`pipeline`, so `extraction_models.py` and `config.py` can both import it without
the cycle `extraction_models.py:15-17` warns about. `DISEASE_DIR` is resolved
from `__file__`. `load_disease()` is `@cache`d and returns a frozen dataclass.
Module constants become derived rather than removed, so the recall test's
imports and `SVD_QUERY`'s name survive: `DISEASE_TERMS`, `MARKER_TERMS`,
`MESH_TERMS`, `DEFAULT_CT_SEARCH_TERMS` (the `PIPELINE_CT_SEARCH_TERMS` override
stays), the CT gate (`is_csvd_study` → `is_disease_study`, `fetch_csvd_studies`
→ `fetch_disease_studies`), `_CANONICAL_GENE_SYMBOLS`, `_LOOKUP_ALIASES`,
`_MAX_GENES_PER_PAPER`, `DEFAULT_OMIM_CSV`, the vocabulary path, the run label
in `notifications.py` and `digest.md.j2`, and the tool description. `main.py`'s
parser description goes neutral rather than reading the manifest, because the
parser is built before any heavy import.

### 3.3 The prompt: template v7 plus `disease/prompt.md`

**The rule stays in the template; the nouns move to the disease file; where a
sentence is nothing but nouns and a connective, the whole sentence moves.**

`prompt.md` is Markdown with one `## <section.id>` heading per section; the body
is the text between headings with leading and trailing blank lines stripped.
Sections and their v6 origin:

| section                            | kind                                      | v6 line  |
| ---------------------------------- | ----------------------------------------- | -------- |
| `persona.specificity`              | whole sentence                            | :61-62   |
| `criteria.phenotypes`              | block (both headings and lists)           | :83-100  |
| `strategy.phenotype_shortlist`     | phrase                                    | :108     |
| `strategy.neighbouring_conditions` | phrase                                    | :108     |
| `strategy.monogenic_genes`         | phrase                                    | :110     |
| `strategy.background_example`      | phrase                                    | :110     |
| `strategy.causal_gene_example`     | sentence                                  | :112     |
| `strategy.mr_example`              | phrase                                    | :114     |
| `strategy.ortholog_example`        | phrase                                    | :115     |
| `strategy.disease_steps`           | numbered splice (cSVD: one item, step 10) | :116     |
| `strategy.convergence_example`     | phrase                                    | :118     |
| `traits.canonical`                 | the comma list, v6 order                  | :125     |
| `guidance.specificity_note`        | sentence                                  | :129     |
| `rubric.subgroup_example`          | phrase                                    | :139     |
| `rubric.monogenic_examples`        | phrase                                    | :143     |
| `rubric.cell_types`                | phrase                                    | :143     |
| `rubric.neighbour_gwas_gene`       | phrase                                    | :147     |
| `rubric.modifiers`                 | block (both bullets)                      | :153-154 |
| `examples`                         | block (the 15 `<example>` elements)       | :157-243 |

`disease.name` and `disease.abbreviation` come from the manifest, not from
`prompt.md`, so nothing is spelled twice. The `task_instruction` and the tool
description are f-strings over the same two values.

The renderer is a 20-line `re.sub` over `{{ section.id }}` slots in
`prompts.py`. It raises on a slot the disease file lacks, on a section the
template never references, and on any `{{` surviving in the output. Not Jinja:
its defaults (`keep_trailing_newline`, `trim_blocks`, autoescape) each silently
alter bytes, and a data file must not receive control flow. Not `str.format`: a
future disease author writing a JSON-ish example would have to escape braces in
prose. The v6 literals contain no braces, which is why byte identity is
reachable at all.

The one non-substitution is the numbered splice. `_STRATEGY_STEPS` is a tuple of
strings with a `DiseaseSteps` sentinel at position 10; the renderer numbers at
render time, so cSVD's one item keeps steps 11-13 at their numbers and a disease
with none gets 1-12. Step 12 (multi-phenotype convergence) is methodology,
because the rubric at :139 and :146 restates it, and stays in the template with
its example slotted.

The canonical trait sentence stays prose in `prompt.md`: the vocabulary orders
`BG-PVS` first and separates tracked from untracked terms, so deriving the
sentence would either change bytes or need an ordering key that is a second copy
of it. `tests/pipeline/test_prompt_vocabulary.py` keeps its regex unchanged over
the rendered text, both directions, with its named allow-list. The monogenic
list is prose too, reconciled against `manifest.monogenicGenes` by a new test.

v6 is removed, not aliased. The byte-identity test is the record that v7 plus
cSVD _is_ v6: `tests/pipeline/test_prompt_assembly.py` compares the rendered
system prompt and instructions to
`tests/pipeline/fixtures/prompt_v6_{system,instructions}.txt`, whose sha256 are
pinned in the test (`f571dedb…`, 1062 characters; `70908abc…`, 18,469
characters; the task instruction `b3b2344a…`). The recall baseline, the golden
cassettes and Anthropic's prompt cache therefore carry over unchanged.

**Provenance.** `report_metadata` in `anthropic_client.py` adds `disease` (the
key) and `promptSha256` (of the rendered system plus instructions).
`RunConfigRecord` gains both as nullable fields, so a stored row from before
re-validates with `null`. The checkpoint fingerprint includes the hash: an edit
to `prompt.md` changes what the model is asked and must invalidate a checkpoint.
`lib/types.ts`, `lib/pipeline_encoding.json` and `islands/PipelineRun.tsx`
render it beside `promptVersion` as `Prompt v7 · csvd 70908abc0302`.

### 3.4 The population rename

Migration `014_rename_trial_population.py` renames `svd_population` and
`svd_population_details` to `target_population` and `target_population_details`,
both directions. `SVD` leaves `_ACRONYMS` in `pipeline/export/text.py:11` (it
existed for this column alone), so `clean_column_name` yields
`Target Population` and `to_camel` yields `targetPopulation`. `_UNKNOWN_COLUMNS`
in `tables.py:244` follows. The header text the table shows is
`populationField.label` from the manifest, so the wire key and the label are
decoupled, which is the point of the rename. `data/table2.json` is rewritten by
`deno task data` after the migration and byte-gated by `test_writer.py`.

Files touched: `lib/types.ts:44-45`, `lib/data/trials.ts`, `lib/filters.ts:242`,
`lib/timeline.ts:400`, `islands/TrialsView.tsx`,
`islands/TrialsTimeline.tsx:143`, `pipeline/database.py` (eight sites),
`pipeline/export/main.py:135-146`, `pipeline/export/tables.py`,
`pipeline/clinical_trials_fetch.py`, `scripts/timeline_figure.py:197`,
`scripts/normalize_drug_names.py`, about fifteen test files, and the
`sync-clinical-trials` skill.

## 4. Tests

### 4.1 Contract and greplist

`tests/disease_manifest_test.ts` and `tests/pipeline/test_disease_manifest.py`
both load `disease/manifest.json` and validate it against the schema. The
TypeScript one also checks `populations[].key` equals `timeline.json`'s
population keys in order (replacing the literal at
`tests/timeline_encoding_test.ts:60`), that `phenogram.json`'s family keys equal
the set of `vocabulary.traits[].family` (replacing `FAMILY_ORDER` at
`tests/phenogram_encoding_test.ts:21-29`), and that the cell-type glossary
covers every abbreviation in the committed genes.

Both run a greplist: whole-word, case-insensitive scans of `routes/`,
`islands/`, `lib/`, `components/` and of `pipeline/`, `scripts/` for the
manifest's own terms (name, abbreviation, short form, monogenic genes, every
search term). A hit fails unless it is on an allow-list keyed by (path, term)
with a reason: the `--svd-` custom properties, `svd-theme`, `svd:themechange`,
`svd_session`, `svd-filters-collapsed`, `SVDPMIDTOKEN`, the `csvd-dashboard`
tool name NCBI knows the pipeline by, and comments that quote measured counts.
Docstrings count as hits, so a comment naming "the SVD rim" is reworded rather
than listed.

### 4.2 Empty data

`pipeline/export/empty.py`, exposed as `deno task data:empty`, writes the
export's empty shape for every file in `_COMMITTED_FILES` with no database: `[]`
for the row tables, `null` for `pipeline_status` and `pipeline_run`, `[]` for
`pipeline_syncs`, `{ "nctIds": [], "generatedAt": "<now>", "locations": [] }`
for `geocoded_trials`, `omim_info.json` from the CSV, `cytobands_hg38.json`
untouched. `gene_annotations.json` is emptied here deliberately: the database
export's skip rule protects a synced file from an unsynced read, but a fork must
not ship cSVD annotations. `tests/pipeline/export/test_empty.py` asserts the
written set equals `_COMMITTED_FILES` and each file round-trips byte-exact
through the writer.

### 4.3 The taxonomy

Every test that names cSVD content is one of three kinds.

- **Invariants** loop over rows or test pure functions and pass vacuously on
  `[]`. They stay: `data_contract_test.ts`, `data_normalization_test.ts`,
  `lookup_normalization_test.ts`, `pipeline_run_data_test.ts`,
  `pipeline_widget_test.tsx`, the logic in `filters_test.ts`, `test_writer.py`,
  the geometry golden in `tests/fixtures/timeline-geometry.json` (an input to
  `separateLabels`, not derived from `data/`).
- **Committed-data pins** are numbers any dataset has an analogue of. They are
  rewritten to derive from the JSON at test time.
  `e2e/fixtures/expected-data.ts` computes its counts mirroring
  `lib/data/summary.ts` and the default status filter, and exports `FIRST_GENE`,
  `POPULATION_LABEL`, `SITE_TITLE` and `ABOUT_HEADING` from the manifest.
  Per-trait and per-population counts in the filter specs are filtered from the
  fixture. Title strings in `routes_test.tsx` import `SITE_TITLE`. A
  `tests/fixtures/rows.ts` factory (`sampleGene`, `sampleTrial`,
  `sampleLocation`) replaces every `{ ...genes[0] }` spread, which throws on an
  empty array.
- **cSVD regressions** name HTRA1, CADASIL, Cilostazol, NCT02467413, CENPF's
  y-coordinate, the 106/111 recall. They move to `tests/csvd/`,
  `e2e/tests/csvd/` and `tests/pipeline/csvd/` (including
  `test_extraction_golden.py`, the recall baseline half of
  `test_query_recall.py` and its cassettes, the figure suites' sector counts,
  the gold-standard CSV). Directory trees rather than a tag or an env guard:
  `deno test` has no tag filter, a guarded test is noise on every run in a fork,
  and git handles a deleted tree natively, reporting upstream's new files there
  as "deleted by us" with `git rm -r` as the one resolution.

### 4.4 Recall harness

`pipeline/query_eval.gold_pmids()` reads `disease/recall_gold.csv` plus the
published table's references, and the gold-standard CSV only when it exists.
`scripts/measure_recall.py` runs the same `(query) AND (uid disjunction)`
request the cSVD test does and prints matched and missed PMIDs with titles;
`--write-baseline` writes `disease/recall_baseline.json`. A generic
`tests/pipeline/test_query_recall_gold.py` replays a cassette against the
baseline and skips when the gold file has no rows; the recorded-terms check from
the cSVD test is reused so a changed query cannot replay a stale answer.

### 4.5 Figures, coverage, CI

Both print scripts get an explicit empty branch (`timeline_figure.py` hands `{}`
to `Circos` today, which pyCirclize rejects). Coverage is measured in a worktree
after `data:empty`; known gaps are `lib/data/summary.ts`'s module-level
callbacks (fix: a pure `summarize(genes, trials)`), and row-driven branches in
`lib/tooltips.ts`, `lib/phenogram_tooltips.ts`, `lib/citations.ts`,
`lib/cytobands.ts` and `lib/timeline.ts` that get synthetic-row tests.
`GenesView`, `Phenogram` and `TrialsTimeline` take an optional rows prop
defaulting to the committed data, as the trials table tests already exploit. A
CI job `empty-data` runs `data:empty`, removes the three `csvd/` trees and runs
all five gates, so the promise that a fresh disease starts green is checked on
every push.

## 5. The skills

### 5.1 `new-disease`

`.claude/skills/new-disease/` holds `SKILL.md`, `interview.md` (the questions
with exact API URLs and a sample response per lookup) and `checklist.md`. The
worked example is the live `disease/` directory.

The interview is nine questions, in dependency order:

| # | asks                                                               | feeds                                                     | pre-fill                                                                      |
| - | ------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 | name, key, abbreviation, institute, maintainer                     | `disease.*`, `site.*`, `institute.*`, `contact.*`         | none                                                                          |
| 2 | disease phrases and MeSH headings                                  | `search.pubmed.diseaseTerms`, `meshTerms`                 | E-utilities `esearch db=mesh`, then `rettype=count` per heading               |
| 3 | marker terms                                                       | `search.pubmed.markerTerms`                               | per-term count                                                                |
| 4 | confirm the genetic terms                                          | (stay in code)                                            | shown, accepted by default                                                    |
| 5 | trait vocabulary, 4-16 phenotypes                                  | `vocabulary.json`                                         | OLS4 search for EFO/HP/MONDO xrefs; a miss becomes `"xref": null` with a note |
| 6 | trial populations and CT.gov conditions                            | `populations`, `timeline.json`, `search.clinicalTrials.*` | CT.gov v2 `countTotal=true` per term                                          |
| 7 | monogenic genes                                                    | `monogenicGenes`, `omim_info.csv`, prompt examples        | ClinVar and Orphadata, the endpoints the pipeline already uses                |
| 8 | two to four papers by PMID with the gene and sentence each reports | `prompt.md` examples                                      | `efetch` to confirm each PMID exists                                          |
| 9 | ten to thirty gold PMIDs                                           | `recall_gold.csv`                                         | validation only                                                               |

Drafting follows the dependency order (manifest, vocabulary, encodings, OMIM
CSV, prompt, gold list, README), then `data:empty` and removal of the `csvd/`
trees. **The hard rule:** every example in `prompt.md` cites a PMID from
question 8 and quotes a sentence the researcher supplied or the skill copied
from the fetched abstract. The skill never composes a paper, a gene-paper pair
or a source quote. With fewer than two papers it ships the prompt with an
`<!-- examples: none yet -->` marker and says so.

Verification runs the five gates, then
`uv run python -m pipeline.main --test-mode --days-back 365` (no database
needed) and prints a cost estimate from the per-paper figure in the
`run-long-window` skill, sending the researcher back to question 3 above roughly
2,000 papers a year. Then `scripts/measure_recall.py`, and the cassette is
recorded on the first live measurement.

Fork setup: `git remote add upstream …`, `.env` from `.env.example` with
`DB_NAME=<key>_dashboard`, `deno install`, `uv sync`, `npm ci` in `e2e/`, create
the database and migrate, first commit, hand-off to the `deploy` skill with the
project name and the two runtime secrets; `hosting.url` is written back once
known.

### 5.2 `update-from-upstream`

A separate skill, because it runs repeatedly.
`git fetch upstream && git
merge upstream/main`, then one resolution per
location: `data/` is ours and regenerated; `disease/` is ours, then
`manifest.schema.json` is diffed against the old upstream for keys to add; the
`csvd/` trees are `git rm -r` again; the README's first line is ours. Everything
else merges clean by construction, and the gates re-run afterwards.

## 6. Documentation

`README.md` goes generic: an H1 that does not name a disease, one line pointing
at `disease/README.md`, the row-count table replaced by column descriptions, the
test-count badges dropped. `disease/README.md` carries what the manifest fills:
name, institute, maintainer, hosted URL, the trait table, the populations, the
query rationale, how to cite. `CLAUDE.md` keeps every cSVD number, because they
are the recorded method, and gains one paragraph naming the seam and the `csvd/`
trees. `pipeline/CLAUDE.md`'s "The prompt is v6" section is rewritten for v7.
The `paths:` lists in `.claude/rules/phenogram.md` and `timeline.md` follow the
moved files.

## 7. Execution

Four sub-projects, each with its own implementation plan, in this order:

1. **The artifact** (done 2026-09-17).
2. **The seam**: `disease/`, `lib/disease/*`, `pipeline/disease.py`, the three
   file moves, prompt v7 with byte identity, term and gate derivation, migration
   014 and the rename, provenance fields, contract and greplist tests, rules and
   docs path updates.
3. **The empty-data suite**: `data:empty`, the rows factory, pin derivation, the
   `csvd/` trees, the recall harness, figure empty branches, coverage fixes, the
   CI job, the README split.
4. **The skills**: `new-disease`, `update-from-upstream`, and a dry run on a
   scratch worktree with a clearly invented disease, every gate green on the
   result.

After 2: all five gates green; the byte-identity test green; the recall test
green on untouched cassettes; `deno task data` produces a diff limited to the
`svdPopulation` key rename. After 3: in a worktree, `deno task data:empty`,
remove the `csvd/` trees, all five gates green. After 4: the dry run passes and
the worktree is deleted.

## 8. Out of scope

Renaming `brain_cell_types` or `link_to_monogenetic_disease`; the `--svd-` CSS
namespace; a Copier or Cookiecutter template; supporting a disease with no
genetics literature; re-measuring the confidence floors for cSVD.
