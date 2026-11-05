---
paths:
  - "pipeline/ncbi_http.py"
  - "pipeline/clinvar_fetch.py"
  - "pipeline/validation.py"
  - "pipeline/ncbi_gene_fetch.py"
  - "pipeline/pubmed_citations.py"
  - "pipeline/pdf_retrieval.py"
  - "tests/pipeline/test_ncbi_http.py"
  - "tests/pipeline/test_clinvar_fetch.py"
  - "tests/pipeline/test_ncbi_gene_fetch.py"
  - "tests/pipeline/test_pdf_retrieval.py"
  - "tests/pipeline/test_pubmed_citations.py"
  - "tests/pipeline/test_validation.py"
---

# NCBI request pacing

**NCBI limits requests per second, and a semaphore does not.**
`clinvar_rate_limit` bounds concurrency; E-utilities bounds rate — 10 a second
with an API key, counted across every endpoint. Ten in flight over calls that
return in 30 ms is roughly 300 a second, and the first full 63-gene run put
every request out inside half a second and was answered 429 on 53 of them.
`_throttle` spaces request _starts_ instead, and `_send_throttled` retries a 429
three times over a widening delay, because the limit is per API key and another
process on the same key can still bounce a correctly-spaced request. Concurrency
and rate are different quantities; do not "simplify" the pacing back into the
semaphore.

The E-utilities callers share the same rule through `pipeline/ncbi_http.py`:
gene validation, gene info, citations, the PMC and abstract fetches and the
metadata lookup all go through `get_with_retry`, which paces starts on one
module-level clock (10/s with a key, 3/s without) and retries a 429. Only
validation had it; the others each had a semaphore and nothing else, and a burst
of papers put every one of their requests out at once.
`PIPELINE_MAX_RATE_LIMIT_RETRIES` counts _retries_ there, as it does in the
Anthropic client: N retries is N+1 requests and zero is still one. The loop used
to count attempts, so NCBI got one request fewer than Anthropic for the same
setting, and a setting of 1 gave it no retry at all.
