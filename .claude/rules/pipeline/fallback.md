---
paths:
  - "pipeline/anthropic_client.py"
  - "pipeline/batch_extraction.py"
  - "pipeline/quality_metrics.py"
  - "pipeline/config.py"
  - "tests/pipeline/test_anthropic_client.py"
  - "tests/pipeline/test_batch_extraction.py"
  - "tests/pipeline/test_quality_metrics.py"
  - "tests/pipeline/test_config.py"
---

# Refusals and the fallback model

A safety refusal is a normal 200 with `stop_reason: "refusal"`, not an error.
`anthropic_client.py` checks for it _before_ reading any content: reading it
would fail JSON parsing and spend the validation-retry budget reporting a
malformed response. The server-side `fallbacks` parameter is unavailable on the
Message Batches API, so `results_by_custom_id` in `batch_extraction.py` runs the
same two checks -- refusal, then `max_tokens` -- on every batch entry before
reading its content. It did not, so a refused entry was logged as a prose-only
answer and a truncated one could never raise the token-ceiling warning; the
batch path also accumulates each entry's usage and records each as an Anthropic
call, which is what put a `--batch` run's tokens, cost and services row in the
report at all. It shares the reasoning accounting too — the thinking count the
API reports in `usage.output_tokens_details`, which `accumulate_usage` takes
(`_account_reasoning` estimates from the character ratio only for a response
that reports none), and `_record_thinking_trace` writing the trace to the event
log — because a `--batch` run otherwise published `thinkingTokens: 0` beside the
batch's real output count and left an auditor no trace to read for any paper the
batch extracted.

**A refusal names its classifier, and the streaming path falls back to Claude
Opus 4.8.** Opus 5.5 runs a biology classifier Opus 5 did not, and on this
corpus it is the one that fires: the 2026-11-03 re-extraction lost 37 of 1,570
papers to `bio`. Both paths read the category through `_refusal_category` --
from the first `fallback` block's `trigger.category` when the fallback ran and
declined too (the final `stop_details` are then the fallback model's), else from
`stop_details` -- and carry it as data, `ExtractionRefusedError.category`, which
the run report groups by. When both models declined, the message also names the
fallback's own reason (`_fallback_declined_too`: the last block's `to.model` and
the final `stop_details.category`), so a paper Opus 4.8 declined under another
classifier does not read as one classifier's verdict.

`_stream_and_parse` requests `fallbacks=[{"model": EXTRACTION_FALLBACK_MODEL}]`
under `FALLBACK_BETA` (`server-side-fallback-2026-06-01`, the array form's own
header; the scalar form's `-2026-07-01` rejects it), so a paper Opus 5.5
declines is re-run on `claude-opus-4-8` in the same round trip. The fallback
rides on the stream call, not in `_build_message_params`, because the Batches
API rejects the field and the golden cassettes' recorded bodies are compared
against those params; the beta stream posts to the same `/v1/messages`, so the
cassettes replay. **It is named, never `"default"`.** The default routes by
refusal category, server-side and unpublished, and Opus 5 is one of Opus 5.5's
two permitted targets (`allowed_fallback_models` on its `/v1/models` entry) -- a
model whose extractions this dataset no longer admits. Opus 4.8 is not
documented to run the biology classifier Opus 5.5 added, and it is not immune
either: on 2026-11-03 it served 34 of the 35 papers Opus 5.5 declined as `bio`
and declined the 35th itself. It accepts the request unchanged (adaptive
thinking, every effort level, citations, 128,000 output tokens), so the entry
needs no overrides.

This used to be refused outright, because a fallback would extract a paper with
a model the run report did not name, which is what pinning the model exists to
prevent. It is allowed now because every record names it, per paper: the
response's own top-level `model` (never assumed) becomes
`PaperResult.extraction_model`, then `pubmed_refs.extraction_model` (migration
015; NULL when no model ran, or for a row written before 015),
`papersDetail[*].extractionModel` and a `model_fallback` warning naming the
PMIDs, and the run's `config.fallbackModel` names what was requested. Joining
`pubmed_refs` to `gene_references` finds every gene an Opus 4.8 extraction
contributed to. The served-by signal is a `fallback_message` entry in
`usage.iterations`, not the block. **A sticky-served turn has no block**: once a
paper falls back, the API answers its next requests from Opus 4.8 directly for
about an hour, so a validation retry never runs Opus 5.5 and names no
classifier. `_PaperCalls` in `anthropic_client.py` carries the category the
paper's first fallback named into its retries; a paper that fell back before the
run reads "unspecified", and the `model_fallback` warning's detail says why.
Because top-level `usage` covers only the attempt that served the message,
`accumulate_usage` sums `iterations` instead -- the declined Opus 5.5 attempt is
billed too -- and keeps the fallback's share in `TokenUsage.fallback_*`, which
`estimate_cost` prices at Opus 4.8's rates ($5 / $25 per MTok, cache reads
0.1×). That share is counted by the entry's `model` as well as its type: only
the attempt that served is a `fallback_message`, so when both models decline,
Opus 4.8's attempt is a plain `message` entry naming it, and counting by type
alone priced it at Opus 5.5's rates. The checkpoint fingerprint names the
fallback model, since a refused paper's extraction depends on it.

`--batch` has no fallback: the Batches API rejects `fallbacks`. A refused batch
entry is handed back through `results_by_custom_id`'s `refusals` and fails with
the same sentence and category as a streaming refusal, and the next run whose
window still covers it retries it.

**Opus 4.8 was measured on the golden fixtures before it served a paper**
(2026-11-03, one call per scorable paper, the pipeline's own request with only
`model` changed and no `fallbacks`; scratch only, nothing recorded over the
committed cassettes; $3.53). Scored by the same code over the same seven papers
the Opus 5.5 cassettes cover:

| Model                         | pooled recall | clean recall | quotes verbatim |
| ----------------------------- | ------------- | ------------ | --------------- |
| `claude-opus-5-5` (cassettes) | 39/46 = 85%   | 21/26 = 81%  | 122/124 = 98%   |
| `claude-opus-4-8` (live)      | 41/46 = 89%   | 22/26 = 85%  | 137/139 = 99%   |

n=46 cannot separate the two -- the difference is two genes, one of them a
prompt-named one -- so read it as "no worse", which is all a fallback needs: a
paper it serves is otherwise not extracted at all. It is a record, not a gate.
**One of its seven answers double-encoded the tool input** -- the gene-densest
paper, PMID 37069360, came back as `{"genes": "<JSON of the whole object>"}` --
which validation refused into a paid retry until `_decoded_input` in
`anthropic_client.py` learned to decode that shape. Each decode logs "Decoded a
JSON-encoded genes value from <model> for PMID <pmid>", so how often either
model does it in production is a count of that line. Nothing else about the
request needed changing: Opus 4.8 wrote cited prose before the tool call on five
of the seven papers (one short text block and no citation on the other two), and
its high-effort output ran 3,100-34,600 tokens a paper.

**A failed entry is logged with the API's own reason.** A non-succeeded result
was logged as its bare type (`Batch entry 37063705: errored`), and the `error`
payload the API attaches — `result.error.error`, type and message — was dropped.
A request-level rejection applies to _every_ entry, so that read as an
unexplained "errored" over every paper in the batch with the cause nowhere, and
the operator's only move was to re-submit and pay for the same rejection.
`_error_detail` reads it through `getattr`, because an expired or canceled
result genuinely carries none. A refusal is the exception, carried in the
`refusals` map beside the result; for every other failure the per-paper string
the run report publishes is still the generic "no result returned by the batch":
`results_by_custom_id` signals a failed entry by _absence_ from its result map,
so carrying the cause that far would mean changing what it returns.

**The batch path runs the provenance check too.** `report_provenance` lives in
`pipeline/citations.py` and both callers hand it the same entries: the streaming
path from `_stream_and_parse`, the batch path from `results_by_custom_id`, which
`submit_and_collect` gives the text each document block carried so
`locate_quote`'s offsets mean what the API's do. Until it did, `--batch` parsed
the tool blocks and returned, so `require_verified_quotes` dropped nothing there
and the run report published 0/0 quotes checked over every gene the batch found.
