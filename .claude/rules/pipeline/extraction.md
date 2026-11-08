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

## Effort stays at `high`, and the margin is one gene

`PIPELINE_LLM_EFFORT` defaults to `"high"`, and stays there. All three arms were
recorded over the same ten golden fixtures under a decision rule fixed before
the numbers were seen: _lower the default to the cheapest arm within 2 points of
`high` on pooled recall and on verbatim-quote rate_:

| effort   | pooled recall   | genes | verbatim | output tokens | cost  | wall   |
| -------- | --------------- | ----- | -------- | ------------- | ----- | ------ |
| low      | 36/46 = 78%     | 113   | 99%      | 31,167        | $1.71 | 6m22s  |
| medium   | 41/46 = 89%     | 135   | 100%     | 46,812        | $2.10 | 9m42s  |
| **high** | **42/46 = 91%** | 138   | 99%      | 90,450        | $3.19 | 17m35s |

`medium` fails by 2.2 points, which is one gene (`ICA1L` on PMID 36180795, the
GIGASTROKE paper the prompt is not aimed at) -- finer than n=46 can resolve, so
a re-run could land either side. **`medium` is the lever** if cost or latency
ever binds: 34% cheaper, 55% of the wall-clock, quote fidelity if anything
better. `low` is not: 13 points, and it stops producing prose.

**That sweep was measured on Claude Opus 5, and the pipeline now runs Opus
5.5.** Effort names do not carry across models: Anthropic reports 5.5 at
`medium` matching or exceeding 5 at `high` on its coding and knowledge-work
evaluations, and 5.5 thinking more per turn than 5 at the same level (prompting
guide, "Calibrate effort"). Neither is a measurement of this extraction task.
`high` was kept as the default through the model change so that one step changes
one variable; re-run the three arms on 5.5 before reading the table above as a
statement about it. The recall and quote figures in `provenance.md` and
`not-proven.md` are Opus 5.5's: the golden cassettes were re-recorded on it at
`high` on 2026-11-02, where the same eight calls cost $2.48 against Opus 5's
$3.72, on 77,177 output tokens against 101,007.

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

`pipeline/prompts.py` holds one prompt; its module docstring records why v4's
stricter exclusion guards were measured and ruled out rather than assumed, and
`tests/pipeline/test_prompts.py` pins it. The 43-vs-17 gap on PMID 37069360 is a
**curation** difference, not a prompt defect, which is why the confidence floor
is split by insert-versus-update instead (see `not-proven.md`).
