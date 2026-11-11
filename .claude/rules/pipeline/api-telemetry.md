---
paths:
  - "pipeline/api_telemetry.py"
  - "pipeline/http_client.py"
  - "pipeline/anthropic_client.py"
  - "pipeline/notifications.py"
  - "pipeline/export/geocode.py"
  - "tests/pipeline/test_api_telemetry.py"
  - "tests/pipeline/test_api_inventory_wiring.py"
  - "tests/pipeline/test_http_client.py"
  - "tests/pipeline/test_anthropic_client.py"
  - "tests/pipeline/export/test_geocode.py"
  - "tests/pipeline/test_notifications.py"
---

# API telemetry

`pipeline/api_telemetry.py` records which external services a run talked to,
through `event_hooks` installed once on `AsyncHttpClientManager`, and the
module's docstrings carry what was measured (why a 404 is not an error, a
followed redirect is one call, timing comes from a monotonic stamp, and why the
Anthropic row undercounts the SDK's own retries -- `build_async_client` keeps
`anthropic.DEFAULT_MAX_RETRIES` -- and is left that way). An unregistered host
records under its own hostname rather than being dropped.

**A DOI in a path is one identifier.** `normalize_path` collapses a segment that
holds a digit, and a DOI's suffix has slashes and digit-free segments, so
Unpaywall's one endpoint was published as three rows (`/v2/:id/:id`,
`/v2/:id/brain/:id`, `/v2/:id/clinexprheumatol/:id`), each with its own retry
and error warnings. The registrant prefix (`10.` and four to nine digits) now
opens an identifier that runs to the end of the path. A report stored before
that lost the prefix with the rest of the path, so `relabel_api_rows` folds only
an endpoint known to end in a DOI (`_DOI_ENDPOINTS`: Unpaywall's `/v2`), sums
the rows that become one, and re-sorts as the recorder does; a publisher host's
stored path is left alone.

**What stays out of `SERVICES`, and why.** The fallback above exists for one
real case, not as a waiting room: `download_and_parse_pdf` follows whatever
open-access URL Unpaywall reported, so the host set is the publishing world and
no allow-list could be written for it — a row reading `link.springer.com` is the
answer, not a gap. Four more absences are decisions:

- **ClinVar** calls the same `esearch.fcgi` and `esummary.fcgi` on the same
  `eutils.ncbi.nlm.nih.gov` as gene validation, gene info and citations. Only
  the query parameters differ, and the recorder never sees those. An entry for
  it would have to precede `ncbi_eutils` and would then swallow every other
  E-utilities call rather than distinguishing its own, so ClinVar is reported as
  "NCBI E-utilities" — one service at the URL, one row.
- **Notification egress** (`notifications.py`). A row could never reach the
  report of the run that sent it: `_record_and_notify` runs _after_
  `_finalize_run` has sealed the recorder, so it would land in the next run's
  inventory. Apprise also owns a transport per plugin, so the only available row
  would carry a fabricated endpoint and a status synthesised from a boolean, and
  per-URL detail would mean parsing credential-bearing URLs. Making a failed
  notification visible is a real gap, but the fix is a warning on the report and
  an ordering change, not a service row.
- **Docling's model weights.** Fetched by `huggingface_hub` inside Docling's own
  loader, inside `asyncio.to_thread` — three layers at which this repo owns no
  transport. `PIPELINE_PDF_ARTIFACTS_PATH` exists so they are not fetched during
  a run at all.
- **`scripts/`.** `SERVICES` describes what a pipeline _run_ talked to;
  `scripts/fetch_cytobands.py` is its own process and builds no run report for a
  row to reach.

`tests/pipeline/test_api_inventory_wiring.py` keeps that list honest from both
ends. One walk reads every URL literal under `pipeline/` out of the AST and
fails on a host `resolve_service` cannot name — held out only through
`_UNREGISTERED_BY_DESIGN`, which is declared empty. The other fails on any
module but `http_client.py` constructing its own `httpx.AsyncClient`, which is
the way a provider drops out of the inventory that no URL can show:
`export/geocode.py` called ClinicalTrials.gov — a registered host — on a client
of its own, so every host it touched was named and not one of its calls was
recorded.
