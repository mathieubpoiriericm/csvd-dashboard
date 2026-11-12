---
paths:
  - "pipeline/config.py"
  - "pipeline/anthropic_client.py"
  - "pipeline/prompts.py"
  - "pipeline/extraction_models.py"
  - "disease/prompt.md"
  - "disease/vocabulary.json"
  - "tests/pipeline/test_config.py"
  - "tests/pipeline/test_anthropic_client.py"
  - "tests/pipeline/test_prompts.py"
  - "tests/pipeline/test_prompt_vocabulary.py"
  - "tests/pipeline/test_prompt_assembly.py"
  - "tests/pipeline/test_extraction_models.py"
  - "tests/pipeline/csvd/test_csvd_prompt_assembly.py"
  - "tests/pipeline/csvd/test_csvd_prompts.py"
  - "tests/pipeline/csvd/test_csvd_extraction_models.py"
---

# Extraction

**The extraction model is pinned in code, not configured.** `EXTRACTION_MODEL`
in `pipeline/config.py` is `claude-opus-5-5`, and `PipelineConfig.llm_model` is
a read-only property returning it — there is no `PIPELINE_LLM_MODEL`. Extraction
output is compared across runs, against the recorded cassettes in
`tests/pipeline/cassettes/`, and against a gold standard, so the model is part
of the method rather than a deployment knob; a per-machine override would make
two runs of the same code incomparable with nothing saying so. Changing it is a
code change with a re-recorded harness. The one model a declined paper falls
back to, `EXTRACTION_FALLBACK_MODEL` (`claude-opus-4-8`), is pinned the same way
and behind the read-only `PipelineConfig.fallback_model`; see "A refusal names
its classifier" in `fallback.md`.

**The prompt version is pinned the same way, by refusal rather than by
fallback.** `PIPELINE_PROMPT_VERSION` still selects one, but `__post_init__`
refuses a name `prompts.py` does not carry, and `build_extraction_prompt` raises
instead of falling back to the default. The fallback was safe for the prompt and
false for every record of the run: `report_metadata`, `pipeline_runs.report`,
`data/pipeline_run.json` and the checkpoint fingerprint all publish
`config.prompt_version` verbatim, so a typo'd `PIPELINE_PROMPT_VERSION` named a
version that never existed as the method behind the rows it was extracting — on
the public About page — and correcting the typo afterwards changed the
fingerprint, discarding a checkpoint whose papers had been extracted with the
very same prompt. A run reports the prompt it ran.

`thinking_config` is always `{"type": "adaptive", "display": "summarized"}` —
`budget_tokens` is a 400 on 4.7 and later, and Opus 5.5 rejects `disabled` at
every effort — and `estimate_cost` returns a number, never `None`.

**`output_config` always carries the effort, `high` included.** It used to be
omitted at `high` as wire noise, because `high` was Claude Opus 5's API default.
Claude Opus 5.5's default is `medium`, so the same omission would run every
default-config paper a level below the `effort` the run report publishes and the
checkpoint fingerprints, with nothing failing.

**An overload is retried, not reported.** A 529 arrives as `OverloadedError`
after the SDK's own retries; an SSE `error` event mid-stream --
`overloaded_error` eight minutes into a paper is the common one -- is raised by
the SDK through `_make_status_error` with the _stream's_ response, the 200 that
opened it, so it is a bare `APIStatusError` whose `status_code` is 200.
`_is_retryable_status_error` routes both into the connection-retry path; they
used to be fatal, and the second was recorded as a clean 200 call. Every failing
branch of `extract` also releases the TPM reservation now, not only the two that
retry: a burst of five failed papers used to leave 100,000 tokens reserved for
the rest of the minute with no log line. A connection attempt that fails is
recorded through `record_service_failure`, as a call _and_ an error --
`status=None` reads as success to the recorder, so four failed attempts used to
publish as four clean calls beside three retries.

**The schema admits the prompt's own spellings.** The tool's `gwas_trait` enum
is `CANONICAL_TRAITS`: the tracked keys, the `untracked` terms, and the
prompt-sourced `synonyms` from `disease/vocabulary.json`. The prompt's frozen
canonical sentence asks for `cerebral-microbleeds` while the tracked key is
`CMB`, and with the spelling refused a model that obeyed the prompt failed the
paper after two paid calls -- which instruction it followed decided whether the
paper was lost. `_build_combined_gene_data` folds `TRAIT_SYNONYMS` by exact key
before the tracked filter, so the spelling is stored as `CMB` rather than
dropped as untracked. `tests/pipeline/test_prompt_vocabulary.py` reconciles the
prompt against the enum as well as against the vocabulary.

**The schema's shape is pinned against the SDK that renders it.**
`transform_schema` is the SDK's, and somewhere after anthropic 2.4 it began
dropping `"type"` from any node that carries an `enum`, so the lockfile bump of
2026-11-09 changed the tool definition every extraction is sent under with no
test failing: the only tests comparing it to what was recorded need the
gitignored cassettes and never run in CI. `_with_enum_types` in
`pipeline/config.py` states the type again, the shape every recall and
provenance figure here was measured under, and
`test_every_enum_in_the_tool_schema_states_its_type` runs in CI.

**The enum is part of the method, and it is the half that constrains the
model.** The frozen canonical sentence in `prompts.py` is what the model is
_asked_ for; the tool schema's `gwas_trait` enum is what it is _allowed_ to say,
and it is generated from `disease/vocabulary.json` at import time. So an edit to
a `traits[*].key` changes what a run may report with no prompt edit and no
re-recorded cassette — the drift the frozen sentence is documented to prevent,
arriving through the other door. It is not hypothetical: the enum admits `CMB`,
`NODDI` and `lacunar stroke`, none of which the sentence names, and the recorded
cassette for PMID 33773637 has the model emitting `lacunar stroke` 14 times
where the sentence asks for `lacunes`. Both spellings are tracked traits, so
both reach `data/table1.json` as separate values. The reconciliation therefore
runs **both** ways: prompt ⊆ enum, and enum ⊆ prompt terms plus a named
allow-list in the test, one entry per term with the reason it is admitted
unasked. Add the entry with its reason; do not widen the test.

**The SDK streams over `httpx2`, not `httpx`.** The pipeline pins `httpx` 0.28
for its own clients, and `anthropic` 2.x is built on the separate `httpx2`
package; the two exception hierarchies are unrelated. `client.send()` wraps a
failure to _open_ a request in `APIConnectionError`, but with `stream=True` it
returns once the headers arrive and the body is read by `get_final_message()`,
where a disconnect or read timeout surfaces as a raw `httpx2` exception. The
connection-retry branch in `AnthropicClient.extract` therefore catches
`httpx2.TransportError`; naming `httpx.ReadError` there matched nothing the SDK
can raise, and the one failure a ten-minute stream is exposed to fell through
with zero retries.

**The streaming fan-out writes the prompt cache once before it starts.** A cache
entry is readable only after the first response begins, so the papers launched
together at the start of a run each paid the write rate for the same large
prefix (tools and both system blocks). `process_papers_concurrently` therefore
awaits `prewarm_cache` once when it has two or more papers, and adds the usage
it returns to the run's `token_usage`. The request is
`_build_message_params("warmup", "warmup", config)` with `max_tokens` 0, sent
non-streaming (the API rejects `max_tokens: 0` with `stream: true`) with the
same `betas` and `fallbacks` the stream call carries, because the citations
toggle on the document block and the beta-header set both shape the cached
prefix: a warm-up that differed in either would warm an entry no extraction
reads. It is sent through `with_options(timeout=60, max_retries=0)`: the
client's 600 s timeout and two SDK retries could otherwise hold a run for half
an hour before any paper started. It never raises (cancellation aside): any
`Exception` -- an `anthropic.APIError`, a missing key from `build_async_client`,
anything else -- logs one warning and returns an empty `TokenUsage`, so a failed
warm-up costs the saving and not the run. A request that was sent and failed is
recorded for the API inventory as the streaming path records one (its status for
an `APIStatusError`, `record_service_failure` otherwise), so the run report
shows it as an errored Anthropic call. A request the API answered is recorded as
the 200 it was before its usage is read, so an answer whose usage cannot be read
logs its own warning and counts no tokens, and is not an errored call. The batch
path never calls it; the
Batches API rejects `max_tokens: 0`.

**The warm-up was checked against the live API on 2026-11-11, and a real
request reads what it writes.** The warm-up request -- `max_tokens: 0`, adaptive
thinking, the `fallbacks` entry and its beta header -- was accepted and reported
`cache_creation_input_tokens` 11,100, `cache_read_input_tokens` 0 and 0 output
tokens; the extraction sent straight after it reported
`cache_creation_input_tokens` 0 and `cache_read_input_tokens` 11,100. The shared
prefix is 11,100 tokens. If a future API change breaks this, the run logs
"Cache warm-up failed" and the API inventory shows the errored call; the
replacement is to delete `prewarm_cache` and have `process_papers_concurrently`
run the first paper to completion before starting the rest.

## How often an extraction is retried, counted 2026-11-11

**Never, in the one production run on record.** That run is the report
committed as `data/pipeline_run.json` (2026-11-03): 38 Anthropic calls for 38
papers, 0 retries, so 0 validation retries and 0 prose-only turns (a response
with no `report_genes` call, which `_retry_validation` retries like a schema
failure) in 38 extractions. `logs/` on this machine holds only test runs. Two
pieces of work are gated on these rates and were therefore not done: re-testing
`strict: true` on Opus 5.5 (see `provenance.md`), worth it from 2% validation
retries, and continuing a prose-only turn instead of restarting it, worth it
from 1%. Thirty-eight extractions cannot exclude a rate of a few percent, so
recount on a longer production log:

```bash
grep -rhoE "Validation retry [0-9]+/[0-9]+|No report_genes tool call|Decoded a JSON-encoded genes value from [a-z0-9-]+|Extracted [0-9]+ gene\(s\) from PMID" logs/log \
  | sed -E 's/Extracted [0-9]+ gene\(s\) from PMID/extracted/; s/ from claude.*//' | sort | uniq -c
```

A prose-only turn is logged inside its own `Validation retry` line (or the
`Validation retries exhausted` line that ends a paper), so its count is a share
of the retries, not an addition to them.

## Effort stays at `high`: on Opus 5.5 `medium` costs three genes of 46

`PIPELINE_LLM_EFFORT` defaults to `"high"`, and stays there. All three arms were
recorded on `claude-opus-5-5` with prompt v8 on 2026-11-11 over the same
golden fixtures, each arm into its own cassette directory with
`--golden-effort=<level>`, under a decision rule fixed before the numbers were
seen: _lower the default to the cheapest arm within 2 points of `high` on pooled
recall and on verbatim-quote rate_. The `high` row is the replay of the v8
baseline cassettes recorded the same day. Output tokens and cost cover the eight
recorded calls of the golden file (the seven scored papers plus the one repeat
the source-quote test makes); genes and verbatim cover the seven scored papers.
No paper in any arm was answered by the fallback model, which the harness
refuses to print figures for otherwise.

| effort   | pooled recall   | clean recall    | genes | verbatim | output tokens | cost  | wall      |
| -------- | --------------- | --------------- | ----- | -------- | ------------- | ----- | --------- |
| low      | 36/46 = 78%     | 19/26 = 73%     | 96    | 96/96    | 40,371        | $1.67 | 4m50s     |
| medium   | 37/46 = 80%     | 19/26 = 73%     | 111   | 111/111  | 62,755        | $2.12 | 7m42s     |
| **high** | **40/46 = 87%** | **22/26 = 85%** | 133   | 133/133  | 81,389        | $2.58 | not timed |

Verbatim is 100% in all three. The wall-clock is of the whole golden file while
recording; `low` and `medium` were recorded concurrently, so the two are
comparable with each other and not with a run alone, and `high` was not timed in
this sweep.

`medium` fails the rule by 6.5 points on pooled recall (three genes of 46) and
`low` by 8.7 (four genes), so neither qualifies. The gap is larger than the one
or two genes the prompt never names that come and go between identical
recordings (`not-proven.md`), though n=46 is still small. **`medium` is the
lever** if cost or latency ever binds: 18% cheaper ($2.12 against $2.58) and 23%
fewer output tokens, at the measured price of three genes of 46 pooled and three
of 26 clean. `low` is 35% cheaper and costs four genes of 46.

The earlier sweep, on Opus 5, came out differently: `medium` missed the same
rule by a single gene (89% against 91% pooled), which is why that section was
once titled for a one-gene margin. It does not carry over. Anthropic reports
Opus 5.5 at `medium` matching Opus 5 at `high` on its own coding and
knowledge-work evaluations (prompting guide, "Calibrate effort"), and on this
extraction task that did not hold: lower effort reported fewer genes (96 and 111
against 133), and recall fell with them. The recall and quote figures in
`provenance.md` and `not-proven.md` are Opus 5.5's: the golden cassettes were
re-recorded on it at `high` on 2026-11-02, where the same eight calls cost $2.48
against Opus 5's $3.72, on 77,177 output tokens against 101,007.

## The prompt is v8: a template plus `disease/prompt.md`, and v4's guards were measured rather than assumed

`pipeline/prompts.py` holds the methodology as a template with
`{{ section.id }}` slots and `disease/prompt.md` holds the disease prose, one
`## id` per slot. `render_prompt` refuses an unknown slot, an unreferenced
section and a residual `{{`, and
`tests/pipeline/csvd/test_csvd_prompt_assembly.py` pins the cSVD rendering to
the v6 literals (sha256 `70908abc…`) byte for byte, but for the pairs its
`_V8_CHANGES` lists.

**v8 asks for structured omics evidence**, and that is the only thing it
changed. `omics_evidence` is a list of studies -- `study_type` from
`OMICS_STUDY_TYPES` in `pipeline/omics.py` (the export's own vocabulary, so the
enum and the filter cannot drift), a `biomarker`, and `items` each with a
`colocalized` flag -- written to the curated table's wire form
(`TWAS;WMH: artery aorta*`) and stored as the JSON array the export publishes
verbatim. The study types reach the prompt through the computed
`{{ omics.study_types }}` slot rather than prose. v7 asked for bare labels and
every one was stored with a `*`, which under the column's footnote claimed a
colocalization nobody checked; v7 left the table, and its hash is in the
`prompts.py` docstring. The golden cassettes were re-recorded for v8 (see
`not-proven.md`).
`prompt_sha256()` hashes the rendered system prompt and instructions together,
because the version name stopped being enough the moment half the prompt moved
into a data file.

## A v9 was recorded twice on 2026-11-11 and ruled out: v8 stands

Three changes drawn from Anthropic's prompting and tool-use guides were built as
a v9 and recorded with `--golden-label` on `claude-opus-5-5` at `high`, over the
same fixtures as the v8 baseline of the same day. Neither recording met its bar,
and the tool definition recorded alone afterwards did no better, so none of it
shipped: the prompt, the tool definition and the task instruction are v8's, byte
for byte. The cassettes are kept (gitignored) under the labels below. Recall is
of the reachable gold genes; "cited" is the share of quotes that match an API
citation span.

| arm                                   | pooled | clean | genes | verbatim                        | cited        | output tokens |
| ------------------------------------- | ------ | ----- | ----- | ------------------------------- | ------------ | ------------- |
| **v8 baseline**                       | 40/46  | 22/26 | 133   | 133/133                         | 96/133 = 72% | 81,389        |
| `-v9-threshold` (all three changes)   | 33/45  | 17/26 | 89    | 89/89                           | 84/89 = 94%  | 70,888        |
| `-v9-cited-line` (the last two below) | 37/46  | 19/26 | 104   | 104/104 (103 before one repair) | 86/104 = 83% | 78,290        |
| `-tool-definition` (the last, alone)  | 36/45  | 19/26 | 108   | 106/108                         | 96/108 = 89% | 82,158        |

The first and the last arm scored six papers: in both the seventh, PMID
39216230, was refused by the safety classifier with its text written and its
tool call part-way onto the stream (see "A refusal while the tool call is on the
stream" in `fallback.md`).
On the same six papers v8 is 39/45, 22/26, 131 genes and 95/131 = 73% cited, and
the two arms' tokens include the refused calls' 1,725 and 2,744. The baseline is
the top of v8's own range, which over four recordings is 39-40 pooled and 21-22
clean. The cassettes replay only on the code that recorded them (commits
`fcd9e25` and `6682816` under the tag `prompt-v9-archive`, and `e23c0d6` under
`tool-definition-arm-archive`, both on the private repository and neither
merged); on v8's code their request-comparison tests fail by design.

**The arm with the reporting threshold lost five gold genes of ten on one
paper; three are the threshold's.** v8 contradicts itself: a positional
candidate is capped at 0.20, yet a genome-wide significant GWAS gene scores at
least 0.60 and the `include_gwas_alone` example scores a _nearest_ gene 0.65.
The first arm stated one rule instead -- "Report a gene only if you would score
it 0.30 or higher" -- with the cap, the "confidence 0" step for negative results
and that example (rewritten to a _sole_ gene) brought into line; it carried the
cited line and the tool definition below as well. PMID 33293549 fell from 10/10
(38 genes reported) to 5/10 (17), losing DEGS2, EFEMP1, KCNK2, NID2 and PLEKHG1,
every one a gene v8 reported at 0.45 or higher. The second arm, without the
threshold, kept EFEMP1, KCNK2 and NID2 and lost DEGS2 and PLEKHG1 again, and in
the first arm's own reasoning DEGS2 went for want of a quotable sentence, so
three of the five are the threshold's. The reasoning names the positional rule
for two of them: "Table 1 lists many loci by nearest gene, and the
positional-only ones seem to score low unless they're the sole gene", "EFEMP1
likewise looks positional-only", "NID2 remains borderline since it's
positional". Under v8's scoring text the model weighs the same contradiction and
reports them -- in the second arm, which kept that text: "I'm weighing whether a
gene that is only the nearest one to a lead SNP should get the 0.20 positional
cap or the higher score the example gives" -- and the curated table holds them.
**On this one recording the contradiction is load-bearing; do not tidy it
without a recording.** On the v8 recording 14 of 133 genes score below 0.30 and
one of them is a gold gene (PLEKHG1 at 0.15 on PMID 35511193, which this arm
lost too: the sixth gene between 39/45 and 33/45), so the rule had well under a
tenth of the output to save.

**One cited line per gene: three fewer than the same-day baseline, two of them
by the model's own account.** The second arm kept v8's scoring text (plus one
added field line, below) and changed the task instruction: one line
`SYMBOL: traits` per gene, citing the sentence the model would give as its
`source_quote`, where v8 asks for the supporting evidence in a sentence. A
parser read each line's cited sentence, and it replaced a `source_quote` that
was not verbatim in the paper: one repair in each arm's eight calls, here CENPF
on PMID 37069360, the reassembled table row `provenance.md` describes, so the
model's own quotes were 103/104 verbatim and 85/104 cited. PMID 33293549 came
out at 8/10 of 28 genes, without DEGS2 and PLEKHG1, and PMID 35511193 at 3/4 of
12, without PLEKHG1 (v8: 4/4 of 24). On the first paper the model scored both
genes (0.65 and 0.6) and then said why it dropped them: "I'm weighing which of
the table-only genes to keep, since their only source is the big locus table and
I can't quote that cleanly. I'm leaning toward dropping them". v8's Provenance
section already says "If no single sentence supports the entry, do not report
the gene", and on the v8 recording the model quotes the table row for both. The
third gene is not evidence about the line: on PMID 35511193 the model left
PLEKHG1 out for position ("The other nearest-gene-only loci, like PPTC7 and
NMT1, rest on position alone, so I'm leaving them out of the list"), and it is
one of the two genes that come and go between identical recordings. The `medium`
effort arm, with no text changed, is missing the same three, and gives the same
reason for the two on PMID 33293549; that paper measured 8/10 once before,
without the same two genes and with nothing about extraction changed
(2026-09-02, on Opus 5). The tool definition recorded alone (below) then lost
the same two for the same stated reason, under v8's task instruction, so
dropping a table-only gene is not shown to be the line's doing.
37/46 is two below the low end of v8's four recordings and three below the best,
on one recording. **A line earned a citation only by carrying the sentence**, so
it could not save output as well: on most papers the model wrote each sentence
on its line anyway (25,943 characters of prose before the tool call against
v8's 25,329), and on PMID 35511193 it wrote the twelve lines as asked, symbol
and trait only, and the API attached no citation to any of them.

**The tool definition alone came out where the cited line did.** Both v9 arms
also sent a description for every field of the tool's gene, study and item
objects, a three-sentence tool description, two `input_examples`, no `pmid`
property, and one added `- protein_name:` line in the prompt's field guidance.
It was recorded afterwards on v8's prompt and task instruction with nothing else
changed, under a rule fixed beforehand: adopted only at the baseline's recall
(40/46, 22/26, no paper under its floor) with at least 98% of quotes verbatim
and fewer output tokens. It came out at 36/45 and 19/26 over the six papers that
recorded, 108 genes against v8's 131, with no output saved (79,414 tokens on the
seven completed calls against v8's 78,726), so it was not adopted. It is missing
the same three gold genes as the cited-line arm, and on PMID 33293549 the model
gave the same reason: "I'm
dropping the table-only genes, since the paper's support for them is just a
table entry and I can't quote a single sentence backing it". That behaviour
needs no cited line, and no rewritten tool definition either: `medium`, on v8's
text and v8's tool definition, lost the same three and gave the same reason on
the same paper ("Their only source is one very long table row, so I had no
single sentence to quote as provenance"), and the baseline itself weighed
dropping them before quoting the row. What these recordings share is v8's
Provenance sentence, which the new `source_quote` description only repeats.
Nothing here shows the tool definition tipping the model toward that rule; the
likelier reading is that the baseline was the favourable draw, and one day's
recordings of one paper cannot settle it. PMID 39216230 was refused in two of
the three recordings that carried this tool definition and in none of the three
recorded with v8's that day (`high`, `medium`, `low`), which is two refusals of
one paper, not a rate; the rescue in `fallback.md` now covers that refusal.

**In all five arms recorded on 2026-11-11, fewer genes reported came with lower
recall.** `medium`, `low` and the three prompt arms reported 111, 96, 104, 89
and 108 genes (the last two over six papers, where v8 reported 131) against 133,
and recovered 37, 36 and 37 of 46 and 33 and 36 of 45. The v4 arms differed by
six genes at the same 42/46, so this is one day's pattern on one model, not a
rule; a change that makes the model more selective should still be expected to
cost recall on this gold standard until a recording says otherwise.

`pipeline/prompts.py` holds one prompt; its module docstring records why v4's
stricter exclusion guards were measured and ruled out rather than assumed, and
`tests/pipeline/test_prompts.py` pins it. The 43-vs-17 gap on PMID 37069360 is a
**curation** difference, not a prompt defect, which is why the confidence floor
is split by insert-versus-update instead (see `not-proven.md`).
