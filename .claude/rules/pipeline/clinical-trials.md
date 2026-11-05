---
paths:
  - "pipeline/clinical_trials_fetch.py"
  - "pipeline/config.py"
  - "pipeline/database.py"
  - "disease/pipeline.json"
  - "tests/pipeline/test_clinical_trials_fetch.py"
  - "tests/pipeline/test_config.py"
  - "tests/pipeline/test_database.py"
  - "tests/pipeline/test_clinical_trials_pipeline.py"
  - "tests/pipeline/csvd/test_csvd_clinical_trials_fetch.py"
  - "tests/pipeline/test_database_integration.py"
---

# ClinicalTrials.gov

A trial's population is decided from its registry, not from the curated row:
`https://clinicaltrials.gov/api/v2/studies/<NCT>` and
`https://www.isrctn.com/api/query/format/default?q=<ISRCTN>` answer fetches;
ANZCTR (403) and ChiCTR (empty page) do not, and their two trials were placed
from their titles.

**`clinical_trials.svd_population` and `svd_population_details` were misaligned
for every row, and are re-curated.** Upstream, the two columns had been sorted
on their own and laid back over rows ordered by drug: the published column was
byte-for-byte its own alphabetical sort, three registry IDs disagreed with
themselves across their own drug rows, and the CADASIL cerebrolysin trial was
published as CAA while the ALN-APP CAA trial read as lacunar stroke. The 16
(population, details) pairs were the right pairs in the wrong rows -- each
reassigns to exactly one trial from the registry's own condition and eligibility
text, with none left over -- so the correction on 2026-09-01 moved values rather
than inventing any, and the per-population totals did not change.
`tests/data_contract_test.ts` now fails if the rows of one registry ID disagree
on any per-trial column, which is the shape this damage takes and the export
cannot see.

## ClinicalTrials.gov rows must read like the curated ones

`--clinical-trials` writes beside the curated Table 2 rows under the same filter
vocabulary. The column-spelling rules (`M/YYYY` dates, comparator arms,
`sponsor_type`), the registry-id upsert key, the `overallStatus` denylist, the
order of `deno task data` and `deno task geocode`, and the pinned downstream
counts a removed trial moves are in the `sync-clinical-trials` skill
(`.claude/skills/sync-clinical-trials/SKILL.md`).

## The discovery is gated on a stated cSVD condition

`query.cond` expands into CT.gov's concept graph and nothing narrowed it again:
the only filter was `DRUG_INTERVENTION_TYPES`. Ten terms return 1,423 studies
whose most common stated condition is **Fabry disease** (215), beside cancer,
ANCA vasculitis, Parkinson's and MS -- 594 rows in a curator's queue, Ebola
vaccine trials among them. `is_disease_study` keeps a study only if a condition
it _states_ names a cSVD entity. `_CONDITIONS` is that vocabulary and
deliberately excludes the systemic diseases that _cause_ cSVD, because the
curated table has never held a Fabry or mitochondrial trial. MeSH inverts the
phrase, so "Dementia, Vascular" is matched as a co-occurrence inside **one**
condition string -- across two, "Cardiovascular Diseases" beside "Cognitive
Decline" would qualify. It drops 1,045 of 1,423 and none of the eight curated
NCT trials; validate any change to the vocabulary that way before shipping it.

**`ct_max_retries` is 6, and the difference is most of the registry.** CTG
throttles a paging burst hard enough that four attempts over ~7s give up
mid-term: two live syncs each truncated three of the ten terms at their first
page and fetched 382 studies. Six truncates no term and fetches 1,423. CTG
states no `Retry-After` -- the header path in `_fetch_page_with_retry` has never
fired -- so the curve is what paces this client.

**`trial_name` and `primary_outcome` are curator-owned once `target_population`
is filled in.** Refreshing them API-first replaced curator prose with registry
verbatim on five of the eight curated NCT trials the first time the sync ran. A
discovery inserts on the run that finds it and _refreshes_ on every run after,
so "refreshed" stops meaning "curated" the second time -- the same proxy made
`_unplaceable_phases` report 35 uncurated rows as publishing in Table 2. Gate on
`target_population` -- `TrialUpsertResult.curated_ids` is the set that carries
it -- never on refresh status.
