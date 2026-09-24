---
name: sync-clinical-trials
description: "Use when running or debugging `--clinical-trials`: column-spelling rules, the upsert key, the status denylist, running `deno task geocode` after `deno task data`, and re-deriving the pinned downstream counts."
---

# Syncing ClinicalTrials.gov

```bash
uv run python -m pipeline.main --clinical-trials
deno task data      # then, and only then:
deno task geocode
```

The discovery gate (`is_disease_study`, `ct_max_retries`, and why `trial_name` and
`primary_outcome` are curator-owned once `target_population` is filled in --
renamed from `svd_population` by migration 014 so the wire key does not spell
the disease) is under "The discovery is gated on a stated cSVD condition" in
`pipeline/CLAUDE.md`.

Table 2 is curated, and `--clinical-trials` writes beside it under the same
filter vocabulary, so every API-sourced column has to arrive in the spelling the
dashboard reads. `Industry` already did, and `II/III` reads under the table's
filter (`lib/filters.ts` matches whole Roman-numeral tokens) though not on the
figure -- see "A phase the radar cannot place" below; three more things were
wrong in the same way:

- **Completion dates are `M/YYYY`.** CT.gov answers ISO (`2027-06-30`, or
  `2026-12` when the day is not set); every curated row reads `12/2026` and
  `lib/sorting.ts`'s `completionDateKey` parses only that shape, so an ISO date
  sorted as no date at all and an exact `(registry_id, drug)` conflict replaced
  the curated `12/2026` with `2026-12-31`. `_completion_label` relabels an ISO
  date and passes anything else through.
- **Only an interventional study is a trial, and a comparator arm is not a
  drug.** CT.gov lists observational studies with a `DRUG` intervention as well,
  and types a placebo as `DRUG`; the mapper skipped neither, so a cohort on
  aspirin users became a trial row and `"Placebo"` became a drug (the drug sync
  then resolved it in ChEMBL to nicotine). `_map_study_to_records` drops a study
  whose `designModule.studyType` is present and not `INTERVENTIONAL` -- a record
  naming no type is kept -- and `_drug_interventions` drops an intervention
  whose **name or any `otherNames` synonym** carries `placebo`, `sham` or
  `vehicle` as a whole word anywhere in it. The word can sit anywhere: live
  CT.gov writes `Matching placebo` (NCT07026994),
  `Isosorbide Mononitrate
  Placebo` and `Butylphthalide Placebo`, none of which
  a prefix test caught. **Saline gets a stricter rule than those three words**,
  and deliberately: the name has to be _nothing but_ a saline synonym once its
  concentration is stripped, so `0.9 % NaCl` (NCT05755997, with
  `Sodium Chloride` only in `otherNames`) is a comparator and
  `Hypertonic saline 3%` -- an agent under study -- is not. Hiding a real agent
  from the curator is the worse of the two errors, because an unrecognised
  comparator sits in the table unpublished (the curation gate below) while a
  dropped agent reaches nobody.
- **`sponsor_type` is curator-owned on conflict, and `UNKNOWN`/`AMBIG` are not
  "Academic".** CT.gov knows only the sponsor's class, folded to
  `Industry`/`Academic`, while the curated rows carry the sponsor's name beside
  it (`Industry (Ever Neuro Pharma GmbH)`). The upsert keeps the existing value
  whenever there is one (`COALESCE`), so a sync cannot strip the name; the other
  API columns keep updating, which is what the sync is for. The fold itself is
  intended for the classes that name a sponsor -- `NIH`, `FED`, `OTHER_GOV`,
  `NETWORK`, `INDIV`, `OTHER` all read `Academic`, and
  `tests/pipeline/test_clinical_trials_fetch.py` pins that -- but `UNKNOWN` and
  `AMBIG` name none, so `_sponsor_label` returns `None` for them and the export
  publishes `(unknown)`. `Academic` is a claim about who ran a trial; the
  registry did not make it, and the `COALESCE` would have kept it forever.

**The registry id is the upsert key, not `(registry_id, drug)`.** A curated row
names the agent under study (`Mivelsiran (ALN-APP)`, `Exenatide`,
`Palm
tocotrienols complex (HOV-12020)`); CT.gov names the intervention its
sponsor registered (`ALN-APP`, `GLP-1 receptor agonist`,
`HOV-12020 (Palm tocotrienols
complex)`), and for five of the eight curated NCT
trials the two spellings differ. `ON CONFLICT (registry_id, drug)` therefore
never fired for those five: each sync inserted a _second_ row for the same trial
with every curator column NULL -- published beside the curated one as
`(unknown)` mechanism, population and evidence, which
`tests/data_contract_test.ts` fails on -- while the curated row's completion
date and enrolment were never refreshed, which is the whole point of the sync.
`upsert_clinical_trials_batch` reads the registry ids first and then does one of
two things:

- a registry id the table already holds **refreshes** the API columns of every
  row carrying it (one statement per trial: those columns are the study's, not
  the arm's), and adds nothing;
- an intervention name no row of that trial carries is **logged, not inserted**
  -- whether a newly registered arm belongs in Table 2 is a curation judgement,
  and the drug column is what the row is about. It is a warning and not a sync
  `error`, because it happens on most trials on every run and a standing red
  badge says nothing;
- a registry id new to the table is inserted as an uncurated discovery.

Two things a refresh will not do. It **never erases a column the registry
stopped stating** (`COALESCE($n, clinical_trials.<column>)`), and it **never
overwrites a completion value that is not a month and year**:
`Completed
(unpublished)` on NCT04658823 is a curated fact CT.gov has no field
for, and the registry's own `2024-10-31` is an ACTUAL date that would have
published as a forecast under the `Estimated Completion Date` header. CT.gov's
`completionDateStruct.type` is read only to log that mismatch per trial -- the
table has one column and no place to say which kind of date it holds.

**An uncurated discovery is written but never published.** The ten default
search terms match hundreds of interventional drug studies
(`cerebral small
vessel disease` alone returns ~200), and each arrives with
`mechanism_of_action`, `target_population`, `target_population_details` and
`genetic_evidence` NULL. Those publish as `(unknown)`, a value no
`POPULATION_CHOICES` entry offers and `lib/timeline_encoding.json` does not
carry, so the radar -- which groups by `targetPopulation` and iterates only the
four encoded populations -- draws them nowhere while Table 2 lists them.
`_read_curated_trials` in `pipeline/export/main.py` is the gate: a row with no
`target_population` is not exported, and the count of skipped rows is logged.
`target_population` is the test because it is the one curator column the
dashboard makes structural use of. The sync reports the same number as
`discovered` on
`ClinicalTrialSyncResult`, so the write is visible in the run's metrics rather
than only in the table.

**A terminated or withdrawn trial is written and never published; every other
status is published as `overallStatus`.** CT.gov states an `overallStatus` on
every study and nothing read it: `_map_study_to_records` took `statusModule` for
the completion date alone, and the schema had nowhere to put one anyway. So the
dashboard published trials that stopped early (TERMINATED) or never enrolled a
participant (WITHDRAWN) beside the running ones -- 8 of the 111 committed rows,
6 trials -- in Table 2, as markers on the radar and as pins on the map, with
nothing anywhere saying which were which. The only status in the repo was
`data/geocoded_trials.json`, written per _facility_ by `deno task geocode`
**after** the export and read only by the map popup, so no gate could ever have
been written against it. Migration 013 is the column, and four things about the
arrangement are load-bearing:

- **The status is captured in two places because the search cannot reach the
  curated set.** Reading it in `_map_study_to_records` is free -- the search
  sends no `fields` list, so `overallStatus` is already in every payload -- but
  `is_disease_study` and the interventional and drug-type gates all drop trials a
  curator nonetheless published, and the terminated rows in the committed data
  are exactly the old, off-vocabulary trials the ten `query.cond` terms are
  least likely to reach. `fetch_trial_statuses` sweeps every NCT id the _table_
  holds, uncurated discoveries included: gating that on `target_population`
  would save a request and cost the status of every trial a curator publishes
  tomorrow, which would then ship NULL until the next sync.
- **The sweep fails open, which is the exact inverse of `export/geocode.py`.**
  `fetch_trial_locations` **raises** when a requested id comes back with no
  record, because a silent miss shrinks the map. Here a miss must not silently
  _delete a trial from Table 2_, so an unanswered id is absent from the mapping
  and the row keeps the status it had; a failed batch is one `errors` entry and
  100 unswept ids; a sweep that cannot reach the database at all is an error on
  an otherwise complete sync. The batch is **100 ids, and the binding limit is
  URL length rather than `pageSize`**: ~600 ids is ~7.2 KB of `filter.ids`, at
  or past the request line most servers accept, and CT.gov answers an over-long
  one with a 400 that `_fetch_page_with_retry` classifies as non-retryable.
- **`update_trial_statuses` carries no `COALESCE`, alone among the API
  columns.** "Never erase what the registry stopped stating" is the right rule
  for a fact a curator may also hold; a status is the registry's own current
  answer and has to be able to move when a trial is terminated. The erase case
  cannot arise anyway, because an unanswered id is never written. It reads the
  stored values first so `status_refreshed` is real rather than a count of
  statements, and so each transition is logged by registry id: this is the one
  write in the pipeline that can remove a row from Table 2, and it must not do
  so silently. **Read `status_refreshed` before exporting.**
- **The export gate is a denylist, and the column is published.**
  `_UNPUBLISHED_TRIAL_STATUSES` in `pipeline/export/main.py` is `TERMINATED` and
  `WITHDRAWN` only: `SUSPENDED` intends to resume and `UNKNOWN` is CT.gov
  reporting that a still-recruiting sponsor stopped updating -- an information
  gap, not a stopped trial -- so publishing stays the default. NULL publishes
  too, as `"(unknown)"` through `_UNKNOWN_COLUMNS`, which is what keeps the
  ISRCTN, ChiCTR and ANZCTR rows in Table 2 forever. Every surviving row carries
  its status as the fourteenth key, `overallStatus`, because the dashboard's
  "Study status" filter (`STATUS_CHOICES` in `lib/constants.ts`, `matchesStatus`
  in `lib/filters.ts`) reads it: the default selection hides COMPLETED on the
  trials table, the radar and the map while the rows stay in the file, the print
  figure and the About totals. The map matches the same choices against
  `geocoded_trials.json`'s per-facility status, which the geocoder writes at a
  separate time; the two can disagree for a trial whose status moved between the
  two commands, and the map's own file wins there.

Removing a trial moves every count downstream of `data/table2.json`: the two
About totals, the radar's sector spans and marker count, the mechanism legend,
the `nctIds` set `deno task geocode` re-derives, and the pinned numbers in
`tests/timeline_layout_test.ts`, `tests/scripts/test_timeline_figure.py` and
five e2e specs. Re-derive them from the regenerated files; and run
`deno task geocode` **after** `deno task data`, never before, or it requests the
removed ids, succeeds, and writes an `nctIds` superset that
`tests/data_contract_test.ts` fails on.

**A phase the radar cannot place is an error.** `lib/timeline.ts` and
`scripts/timeline_figure.py` both place a trial by comparing
`clinicalTrialPhase` to the ring's phase for **equality**, and the rings are
`III`, `II`, `I`. A synced `IV`, `N/A`, `Early Phase I` or multi-phase `II/III`
still matches the table's token filter, so the table and the figure would
disagree about the trial set with nothing said. `RADAR_PHASES` is read from
`lib/timeline_encoding.json` rather than restated, and `_unplaceable_phases`
reports any refreshed row outside it into the sync's `errors`. Only refreshed
rows: a discovery is not published until a curator fills its population in, and
a `None` phase never overwrites a curated one.

**A term whose pagination stopped short is an error, not a log line.**
`_search_condition_term` keeps the pages it reached and returns the truncation
beside them; `fetch_disease_studies` appends it to the sync's `errors`, so a 503 on
page 2 reaches the run record instead of badging a partial result set as the
whole registry. **It is not a `failed` count, though.** `failed` used to be
`len(errors)`, so a truncated term -- a hundred studies never fetched -- was
published on the About page as `failed: 1` beside a `fetched` count of studies,
which reads as one trial having failed. It counts the studies whose mapping or
write actually failed; the truncation says what it is in `errors`, where
`derive_sync_status` still turns it red. `cached` is rows written, refreshed and
discovered together.

**`pipeline/xrefs.py` is the one place a spelling is decided, and it normalises
the local id as well as the prefix.** ClinVar prefixes MONDO but not Orphanet,
Orphadata prefixes neither, and Open Targets prefixes both with an underscore,
so nothing cross-links until one spelling wins. Every identifier goes through
`canonical_xref` — Ensembl, HGNC, GO and HPO included, rather than being
f-string-built or trusted from the payload — and a prefix this pipeline cannot
interpret returns `None` rather than passing through, so the table never looks
richer than it is.

Two rules about the local id are load-bearing, and both were found in shipped
data rather than reasoned about:

- **MONDO, HP, GO and EFO are zero-padded to seven digits.** Orphadata returns
  MONDO both ways, so `MONDO:18831` and `MONDO:0018831` were two strings for one
  disease: Orphadata's MONDO could never join ClinVar's, and the short form was
  published on HTRA1, where it resolves to nothing. ORPHAcodes and HGNC ids are
  genuinely unpadded and must stay out of `_ZERO_PADDED_WIDTH`.
- **A local id whose shape the authority does not use is rejected and logged.**
  `_LOCAL_ID_SHAPES` was measured against every distinct identifier in the live
  table, so it accepts MeSH's nine-digit entries and MedGen's `CN` series.
  `canonical_xref("OMIM", "not a number")` used to pass.

An **OMIM phenotypic series** (`PS143890`) is kept — it is a real identifier —
but `is_omim_series` marks it, and the export publishes it apart from the
disease's own MIM number, because a series names a group of phenotypes and
nothing keyed on entry numbers can resolve one.
