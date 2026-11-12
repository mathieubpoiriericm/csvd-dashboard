---
paths:
  - "pipeline/anthropic_client.py"
  - "pipeline/batch_extraction.py"
  - "pipeline/quality_metrics.py"
  - "tests/pipeline/test_anthropic_client.py"
  - "tests/pipeline/test_batch_extraction.py"
  - "tests/pipeline/test_quality_metrics.py"
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
under `FALLBACK_BETA` (`server-side-fallback-2026-07-01`, which takes both the
array form and the scalar `"default"`; the earlier `-2026-06-01` takes the array
form only), so a paper Opus 5.5 declines is re-run on `claude-opus-4-8` in the same round trip. The fallback
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
reported there too -- and keeps the fallback's share in `TokenUsage.fallback_*`,
which `estimate_cost` prices at Opus 4.8's rates ($5 / $25 per MTok, cache reads
0.1×). That share is counted by the entry's `model` as well as its type:
Anthropic's guide gives the last hop a `fallback_message` entry even when it
declined too, the code was written against that attempt arriving as a plain
`message` entry naming Opus 4.8, and counting by type alone priced that shape at
Opus 5.5's rates. The checkpoint fingerprint names the fallback model, since a
refused paper's extraction depends on it.

**A declined attempt is billed by category, not always.** A refusal that arrives
before any output is billed only as `bio`, `frontier_llm` or
`reasoning_extraction` (`BILLED_REFUSAL_CATEGORIES` in `quality_metrics.py`,
from "How refusals are billed" in Anthropic's refusals-and-fallback guide, as of
September 2026 and subject to change); as `cyber`, `general_harms` or with no
category it is reported in `usage` and not charged, and a mid-stream refusal is
billed whatever its category. `accumulate_usage` keeps an unbilled attempt in
the totals, which say what the API counted and what the rate limit was charged,
and in `TokenUsage.unbilled_*`, which `estimate_cost` takes off; it never joins
`fallback_*`, so the subtraction is right whichever model declined. On this
corpus the refusals are `bio`, so the declined attempt is paid for; the batch
path, where a refused entry is one top-level `usage`, follows the same rule.

**A refusal while the tool call is on the stream is not retried by the server,
so `extract` sends the paper to the fallback itself.** Anthropic's refusals
guide names the one case the server-side fallback does not cover: "a streaming
decline that fires while a tool-use block of any type ... is still open on the
stream: that refusal is returned directly". Every answer here is a tool-use
block, and it is more than half of the output. Seen once, 2026-11-11, on PMID
39216230 while recording a prompt arm: Opus 5.5 wrote its text and the whole
`report_genes` input (two genes; the block had closed), and the message then
ended `stop_reason: "refusal"`, category `bio`, with no `fallback` block and no
`fallback_message` iteration (`stop_details` carried
`fallback_has_prefill_claim: true` and a credit token this pipeline does not
redeem). Reading that as the guide's case is an inference: the guide says
"still open", and here the block had closed. `_stream_and_parse` raised
`ExtractionRefusedError` and, at the time, the paper counted as refused for the
run. The same paper sent 16 minutes later under the next arm's prompt (same
document, tool definition and task instruction, a different system prompt) was
answered by Opus 5.5. It was refused the same way once more that day, in a third
arm's recording, again with its text and the tool call on the stream and no
fallback attempt.

`ExtractionRefusedError.fallback_declined` now says whether the fallback model
itself declined: true when `_fallback_declined_too` names its hop, when the
request was a direct one, or when the refusal is the fallback's own sticky
answer (`_fallback_served`: the response's `model` is the fallback's, or a
`fallback_message` iteration is there with no block). When it is false -- this
shape, or one whose fallback could not be attempted (`recommended_model` set) --
`AnthropicClient.extract` logs one warning ("PMID … was refused (category: bio)
with no fallback attempt; sending it straight to claude-opus-4-8"), rebuilds the
request with `_build_message_params(..., model=config.fallback_model)` and
carries on in the same retry loop as a direct request: `_PaperCalls.direct` set,
`declined` seeded with the refusal's category, `sent` carried over. So every
later validation, rate-limit and connection retry stays on Opus 4.8 with no
`fallbacks` and no beta header, and the answer is `ServedBy(model=<the
response's>, declined=<that category>)`, which raises the `model_fallback`
warning like any other. It happens once per paper, and never to a request the
caller already sent to the fallback (the `--batch` rescue). The refused call
settled its own TPM reservation in `_stream_and_parse` before the error left it;
the direct call takes one of its own. Both attempts stay in the paper's
`TokenUsage`: the refused one at Opus 5.5's rates (or in `unbilled_*` when the
category and an empty output say it was not charged), the direct one in
`fallback_*` through `_is_direct_fallback`. When the fallback was skipped
because its model was rate-limited or overloaded, the direct request goes to
that same model and takes the ordinary 429/529 backoff. The first refusal is
logged at WARNING, since the paper is about to be sent on and may succeed. A
refusal that is final is logged at ERROR: the fallback model itself declined,
or the request was already the fallback model's (a direct or sticky-served
request). If Opus 4.8
declines too, the error
keeps the first refusal's category, which the run report groups by, and names
both as the batch rescue does: "Refused by safety classifier for PMID …
(category: bio; claude-opus-4-8 also declined: cyber)"; the next run whose
window covers it retries it.

**A paper can be sent straight to the fallback model.**
`AnthropicClient.extract` (and `extract_from_paper`) take `model=` and
`declined=`; with `model` set, `_build_message_params` changes the `model` field
and nothing else, and the stream call sends no `fallbacks` and no beta header --
the request already names the last model there is. `_PaperCalls.direct` keeps
every validation, rate-limit and connection retry on that model. Its answer
carries neither served-by signal (no `fallback` block, no `fallback_message`
iteration), so `_served_by` reports `ServedBy(model=response.model,
declined=declined or "unspecified")` from what the caller said. Its usage has no
`iterations` either, so `accumulate_usage` counts a top-level usage whose
response `model` is the fallback model's into `fallback_*` (`_is_direct_fallback`)
and prices it at Opus 4.8's rates; an ordinary answer naming Opus 5.5, or any
batch entry (whose caller passes no `fallback_model`), is untouched. If the
fallback declines a direct request it is an ordinary refusal: the category is
its own, from `stop_details`. With `model=None`, every existing caller, nothing
about the request, its `ServedBy` or its accounting changed.

**`--batch` rescues a refused entry in the same run.** The Batches API rejects
`fallbacks`, so a declined entry comes back through `results_by_custom_id`'s
`refusals`, and `_rescue_refused_batch_paper` in `main.py` sends that paper to
`claude-opus-4-8` as a direct streaming request (`model=`, `declined=` above)
once the batch is collected -- never a second Opus 5.5 attempt, which has just
declined it. The rescues run beside the batch's own validation, under a
semaphore of `max_concurrent_papers` and no rate limiter, and the run's papers
come off the batch's state file only after them, so a crash during one still
retrieves the batch. A rescued paper goes through `_validate_batch_paper` with
its `ServedBy`, so it is validated, checkpointed and counted like any batch
paper and carries `extraction_model` and `refusal` as a streaming fallback does,
which is what raises the `model_fallback` warning. Its tokens are billed at the
streaming rate, not the batch's half, so they are counted in
`streamed_token_usage` too, kept or not. A paper Opus 4.8 declines as well fails
with the streaming sentence plus the fallback's own category ("... (category:
bio; claude-opus-4-8 also declined: cyber)"), its `refusal` still the batch's
category; any other rescue failure fails that paper alone with its own message.
Either way the next run whose window still covers it retries it. The run's
`config.fallbackModel` names Opus 4.8 on a `--batch` run too
(`report_metadata`): it used to be null there, as if no batch run could use a
fallback, beside papers the fallback had extracted. The `model_fallback`
warning's detail names both ways a paper reaches it.

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
Those cassettes were prompt v7's; the v8 re-record (2026-11-11) measures Opus
5.5 at 40/46 pooled and 22/26 clean, and Opus 4.8 has not been measured on v8.
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
