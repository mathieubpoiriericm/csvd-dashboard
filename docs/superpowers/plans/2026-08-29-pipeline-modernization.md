# cSVD Pipeline Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete ~16,000 lines of superseded tooling, port the R export layer to
Python, remove the Nominatim geocoding round-trip, and modernize the extraction
path onto the current Claude API — without changing a single byte of the JSON
contract the Fresh app consumes.

**Architecture:** Three independent phases meeting only at PostgreSQL and at
`data/*.json`. Phase 1 is correctness and subtraction (no new behaviour). Phase
2 replaces `data-prep/*.R` with a `pipeline/export/` package, making the export
testable in CI for the first time. Phase 3 modernizes ingest: current thinking
parameters, Europe PMC full-text XML as primary retrieval, Docling for the PDF
remainder, and a golden-file regression suite. Each phase ships on its own.

**Tech Stack:** Python 3.14, uv, ruff, ty, pytest + pytest-asyncio, asyncpg,
pydantic 2, pandera, httpx, anthropic SDK. Deno 2 / Fresh 2 on the consumer side
(touched only in Task 2).

**Spec:** `docs/superpowers/specs/2026-08-29-pipeline-teardown.md` (published as
an Artifact; commit a Markdown copy alongside this plan).

## Global Constraints

- **Python 3.14**, managed by `uv`. Every command runs as `uv run …`.
- **ruff**: line-length 88, `select = ["E", "F", "I", "UP", "B", "SIM"]`,
  `known-first-party = ["pipeline"]`.
- **No new runtime dependencies** except `docling` (Task 13). Phase 2 adds none
  — reuse `pipeline/database.py`'s asyncpg pool. DuckDB is deliberately **not**
  adopted: the cleaning rules are regex and string work that must run in Python
  anyway, so `Postgres → DuckDB → Python → JSON` would add a hop and a
  dependency to avoid a `json.dumps` on 103 KB.
- **JSON output format is a contract**: 2-space indent, one trailing newline,
  UTF-8 preserved (`ensure_ascii=False`). Deviating produces an unreviewable
  whole-file diff on first regeneration.
- **Four sentinel strings are byte-exact and load-bearing**: `"(none found)"`,
  `"(reference needed)"`, `"(unknown)"`, `"(none)"`. `lib/constants.ts` matches
  them literally.
- **Four `Gene` fields are always JSON arrays**, never bare strings:
  `gwasTrait`, `evidenceFromOtherOmicsStudies`, `linkToMonogenicDisease`,
  `references`.
- **`tests/data_contract_test.ts` must keep passing** unchanged throughout. It
  is the cross-language guardrail.
- **Adopt nothing structural** (recommendation 09): no orchestrator, no dlt, no
  dbt, no DVC/lakeFS/Dolt/git-lfs. Committed JSON bundled at build time stays.
  This constraint is why there is no task for it.
- **Never commit `.env` or credentials.** Tests must not require a live database
  or API key.

---

# Phase 1 — Correctness and subtraction

Ships independently. No new behaviour; the pipeline does the same thing with
less code and a working model override.

---

### Task 1: Fix the thinking and effort model gating

`ADAPTIVE_THINKING_MODELS` is an allowlist of two model strings. Any model
outside it takes the `else` branch and sends `budget_tokens`, which returns
**HTTP 400** on Fable 5, Opus 5, Opus 4.8 and Opus 4.7. The documented
`PIPELINE_LLM_MODEL` override therefore works for exactly two values. Invert the
sets: name the _legacy_ models that still need `budget_tokens`, and let
everything else default to adaptive — so a model added later is correct by
default rather than broken by default.

**Files:**

- Modify: `pipeline/config.py:150-170`
- Modify: `pipeline/llm_providers/anthropic_provider.py:37-41` (pricing),
  `:100-115` (thinking branch)
- Test: `tests/pipeline/test_config.py`,
  `tests/pipeline/test_anthropic_provider.py`

**Interfaces:**

- Consumes: nothing.
- Produces: `LEGACY_THINKING_MODELS: frozenset[str]`,
  `EFFORT_INCAPABLE_MODELS: frozenset[str]`,
  `uses_adaptive_thinking(model: str) -> bool`,
  `supports_effort(model: str) -> bool` in `pipeline/config.py`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/test_config.py
import pytest

from pipeline.config import supports_effort, uses_adaptive_thinking


@pytest.mark.parametrize(
    "model",
    [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-some-model-released-next-year",
    ],
)
def test_current_models_use_adaptive_thinking(model: str) -> None:
    """budget_tokens is a 400 on these; unknown models must default to safe."""
    assert uses_adaptive_thinking(model) is True


@pytest.mark.parametrize("model", ["claude-haiku-4-5", "claude-sonnet-4-5"])
def test_pre_46_models_still_need_a_token_budget(model: str) -> None:
    assert uses_adaptive_thinking(model) is False


def test_effort_is_unsupported_only_on_pre_46_models() -> None:
    assert supports_effort("claude-opus-5") is True
    assert supports_effort("claude-sonnet-5") is True
    assert supports_effort("claude-haiku-4-5") is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/test_config.py -k thinking -v` Expected: FAIL
with `ImportError: cannot import name 'uses_adaptive_thinking'`

- [ ] **Step 3: Invert the sets in `pipeline/config.py`**

Replace the `ADAPTIVE_THINKING_MODELS` / `EFFORT_CAPABLE_MODELS` block:

```python
# Models predating adaptive thinking, which still require an explicit
# {"type": "enabled", "budget_tokens": N} block. Everything else gets
# adaptive thinking: budget_tokens is REMOVED (HTTP 400) on Fable 5,
# Opus 5, Opus 4.8 and Opus 4.7, so an allowlist of adaptive models
# fails closed in the wrong direction — an unrecognised model would be
# sent a parameter the API rejects.
LEGACY_THINKING_MODELS: Final[frozenset[str]] = frozenset(
    {"claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5"}
)

# output_config.effort errors on the same pre-4.6 models.
EFFORT_INCAPABLE_MODELS: Final[frozenset[str]] = LEGACY_THINKING_MODELS


def uses_adaptive_thinking(model: str) -> bool:
    """True when the model takes thinking={"type": "adaptive"}."""
    return model not in LEGACY_THINKING_MODELS


def supports_effort(model: str) -> bool:
    """True when the model accepts output_config.effort."""
    return model not in EFFORT_INCAPABLE_MODELS


# Maximum output tokens per model — from the Anthropic model table.
MODEL_MAX_OUTPUT_TOKENS: Final[dict[str, int]] = {
    "claude-fable-5": 128_000,
    "claude-opus-5": 128_000,
    "claude-opus-4-8": 128_000,
    "claude-opus-4-7": 128_000,
    "claude-sonnet-5": 128_000,
    "claude-sonnet-4-6": 64_000,
    "claude-haiku-4-5": 64_000,
    "claude-haiku-4-5-20251001": 64_000,
}
```

Change the default model on the `llm_model` field:

```python
llm_model: str = field(
    default_factory=lambda: _env_str("PIPELINE_LLM_MODEL", "claude-opus-5")
)
```

- [ ] **Step 4: Update the provider's thinking branch**

In `pipeline/llm_providers/anthropic_provider.py`, replace the
`if config.llm_model in ADAPTIVE_THINKING_MODELS:` block inside
`_build_stream_kwargs`:

```python
    if uses_adaptive_thinking(config.llm_model):
        # display="summarized" keeps thinking blocks populated for the
        # thinking/text ratio estimator in _stream_and_parse. The API
        # default is "omitted", which would make that ratio always 0.
        thinking: dict[str, Any] = {
            "type": "adaptive",
            "display": "summarized",
        }
    else:
        budget = max(
            config.llm_max_tokens - THINKING_OUTPUT_RESERVE,
            config.llm_max_tokens // 2,
        )
        thinking = {"type": "enabled", "budget_tokens": budget}

    # "high" is the API default — only transmit when overridden.
    output_config = dict(_OUTPUT_CONFIG)
    if supports_effort(config.llm_model) and config.llm_effort != "high":
        output_config["effort"] = config.llm_effort
```

Update the imports at the top of the file from `pipeline.config` to pull
`supports_effort` and `uses_adaptive_thinking` instead of the two frozensets.

- [ ] **Step 5: Update the pricing table**

```python
# USD per million tokens, (input, output).
_MODEL_PRICING: dict[str, tuple[float, float]] = {
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}
```

Leave `_CACHE_WRITE_MULTIPLIER = 2.0` alone — it is correct for the 1-hour TTL
this pipeline writes. (1.25× is the five-minute default.)

- [ ] **Step 6: Add a provider-level regression test**

```python
# tests/pipeline/test_anthropic_provider.py
from pipeline.config import PipelineConfig
from pipeline.llm_providers.anthropic_provider import _build_stream_kwargs


def test_claude_5_request_carries_no_budget_tokens() -> None:
    """budget_tokens returns HTTP 400 on every Claude 5 model."""
    config = PipelineConfig(llm_model="claude-opus-5", llm_max_tokens=64_000)
    kwargs = _build_stream_kwargs("paper text", "12345678", config)
    assert kwargs["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert "budget_tokens" not in kwargs["thinking"]


def test_legacy_model_still_receives_a_budget() -> None:
    config = PipelineConfig(llm_model="claude-haiku-4-5", llm_max_tokens=64_000)
    kwargs = _build_stream_kwargs("paper text", "12345678", config)
    assert kwargs["thinking"]["type"] == "enabled"
    assert kwargs["thinking"]["budget_tokens"] > 0


def test_effort_is_omitted_at_the_api_default() -> None:
    config = PipelineConfig(llm_model="claude-opus-5", llm_effort="high")
    kwargs = _build_stream_kwargs("paper text", "12345678", config)
    assert "effort" not in kwargs["output_config"]
```

- [ ] **Step 7: Run the full Python suite**

Run: `uv run pytest tests/pipeline -q && uv run ruff check . && uv run ty check`
Expected: all pass. Existing tests referencing `ADAPTIVE_THINKING_MODELS` will
fail — update them to the new helpers rather than reintroducing the frozensets.

- [ ] **Step 8: Commit**

```bash
git add pipeline/config.py pipeline/llm_providers/anthropic_provider.py tests/pipeline/
git commit -m "Fix thinking and effort gating for current Claude models

An allowlist of two model strings meant any other PIPELINE_LLM_MODEL
value fell through to budget_tokens, which is a 400 on Fable 5, Opus 5,
Opus 4.8 and Opus 4.7. Invert to a legacy-model set so unrecognised
models default to adaptive thinking."
```

---

### Task 2: Relax the data-pinned end-to-end assertions

**This is a prerequisite for Phase 2 and for any data regeneration.**
`map.spec.ts:22` asserts the literal rendered string
`"… Locations resolved August 27, 2026."`, so a correct regeneration fails the
suite even when every coordinate is unchanged. Around thirty exact row counts
sit alongside it. Relax the assertions that pin _generation metadata_ to
patterns; keep the ones that pin _data volume_, because those genuinely guard
the contract — but centralize them so a legitimate data change is a one-line
edit.

**Files:**

- Create: `e2e/fixtures/expected-data.ts`
- Modify: `e2e/tests/map.spec.ts:19-22,164-166`, `e2e/tests/about.spec.ts:9-14`
- Modify: `e2e/helpers.ts` (re-export the fixture)

**Interfaces:**

- Consumes: nothing.
- Produces: `EXPECTED` —
  `{ genes: number; drugs: number; trials: number; publications: number; mapSites: number; mapCountries: number; mapTrials: number }`
  exported from `e2e/fixtures/expected-data.ts`.

- [ ] **Step 1: Create the single source of truth for pinned counts**

```typescript
// e2e/fixtures/expected-data.ts
/**
 * Counts derived from the committed data/*.json. Regenerating the data can
 * legitimately change every number here — verify the data is correct, then
 * update this file. It is deliberately the only place these numbers appear.
 */
export const EXPECTED = {
  genes: 63,
  drugs: 11,
  trials: 13,
  publications: 22,
  mapSites: 70,
  mapCountries: 10,
  mapTrials: 8,
} as const;
```

- [ ] **Step 2: Replace the map's brittle stats assertion**

In `e2e/tests/map.spec.ts`, replace the exact-string assertion:

```typescript
import { EXPECTED } from "../fixtures/expected-data.ts";

// The trailing date is generation metadata, not data: it changes on every
// geocode run even when no coordinate moves. Match its shape, not its value.
await expect(page.locator(".map-stats")).toHaveText(
  new RegExp(
    `${EXPECTED.mapSites} sites across ${EXPECTED.mapCountries} countries, ` +
      `for ${EXPECTED.mapTrials} registered trials\\. ` +
      `Locations resolved \\w+ \\d{1,2}, \\d{4}\\.`,
  ),
  { useInnerText: true },
);
```

- [ ] **Step 3: Replace the site-count and first-location assertions**

```typescript
await expect(items).toHaveCount(EXPECTED.mapSites);

// Assert the shape of a location entry, not one facility's name — the
// first row depends on source ordering that ClinicalTrials.gov may change.
await expect(items.first()).toHaveText(
  /^.+ — .+ — .+ — NCT\d{8}$/,
);
```

- [ ] **Step 4: Point the About totals at the fixture**

```typescript
// e2e/tests/about.spec.ts
import { EXPECTED } from "../fixtures/expected-data.ts";

const TOTALS = [
  ["Putative Causal Genes", String(EXPECTED.genes)],
  ["Drugs Tested", String(EXPECTED.drugs)],
  ["Clinical Trials", String(EXPECTED.trials)],
  ["Peer-Reviewed Publications", String(EXPECTED.publications)],
] as const;
```

- [ ] **Step 5: Run the suite to confirm it still passes against unchanged
      data**

Run: `deno task test:e2e` Expected: PASS. The refactor must be
behaviour-preserving against the current data — if anything fails now, the
fixture numbers are wrong.

- [ ] **Step 6: Commit**

```bash
git add e2e/fixtures/expected-data.ts e2e/tests/map.spec.ts e2e/tests/about.spec.ts
git commit -m "Centralize data-pinned e2e counts and unpin generation metadata

map.spec.ts asserted a rendered date string, so a correct geocode run
failed the suite. Match the date's shape and move volume counts into one
fixture so a legitimate data change is a single edit."
```

---

### Task 3: Delete the superseded tooling tree

Nothing in `pipeline/` imports `scripts/` — the single grep hit in
`pipeline/report.py:78` is a comment. The tree detaches with no import edge to
unpick.

**Files:**

- Delete: `scripts/` (entire tree, 10,026 lines)
- Delete: `tests/scripts/` (4,587 lines)
- Delete: `docs/pubmed_query_distillation/` (1,484 lines)
- Delete: `pipeline/tuning_schema.py`, `tests/pipeline/test_tuning_schema.py`,
  `tests/pipeline/test_build_dataset.py`
- Modify: `pipeline/prompts.py` (drop three non-Claude prompt variants),
  `pyproject.toml`, `README.md`, `CLAUDE.md`, `AGENTS.md`
- Keep: `data/test_data/gold_standard/gold_standard_v2.csv` — Task 16 consumes
  it

**Interfaces:**

- Consumes: nothing.
- Produces: nothing. Pure subtraction.

- [ ] **Step 1: Confirm the tree is unreferenced before deleting anything**

```bash
grep -rnE "^(from|import) scripts|from scripts\." pipeline/ tests/pipeline/ || echo "CLEAN"
grep -rn "tuning_schema" pipeline/ tests/pipeline/ | grep -v test_tuning_schema
```

Expected: `CLEAN`, and no `tuning_schema` hits outside its own test. **If either
produces output, stop and resolve the reference first.**

- [ ] **Step 2: Delete the trees**

```bash
git rm -r scripts tests/scripts docs/pubmed_query_distillation
git rm pipeline/tuning_schema.py tests/pipeline/test_tuning_schema.py tests/pipeline/test_build_dataset.py
```

- [ ] **Step 3: Drop the non-Claude prompt variants from `pipeline/prompts.py`**

Remove the `_SYSTEM_PROMPT_GEMMA_V1/V4/V5`,
`_EXTRACTION_INSTRUCTIONS_GEMMA_V1/V4/V5` and `_GEMMA_V1_SYSTEM` definitions,
and reduce the registry to the Claude versions:

```python
_PROMPTS: Final[dict[str, tuple[str, str]]] = {
    "v1": (_SYSTEM_PROMPT_V1, _EXTRACTION_INSTRUCTIONS_V1),
    "v2": (_SYSTEM_PROMPT_V2, _EXTRACTION_INSTRUCTIONS_V2),
    "v3": (_SYSTEM_PROMPT_V3, _EXTRACTION_INSTRUCTIONS_V3),
    "v4": (_SYSTEM_PROMPT_V4, _EXTRACTION_INSTRUCTIONS_V4),
    "v5": (_SYSTEM_PROMPT_V5, _EXTRACTION_INSTRUCTIONS_V5),
}
```

- [ ] **Step 4: Update `pyproject.toml`**

Four edits:

```toml
[project]
dependencies = [
    # ... remove these two lines:
    #   "matplotlib>=3.10.9",
    #   "scikit-learn>=1.8.0",
    # lxml and rich STAY — four pipeline/ modules use lxml,
    # main.py and report.py use rich.
]

# Delete the entire [project.optional-dependencies] block (the GPU extra).

[tool.ruff.lint.per-file-ignores]
"pipeline/prompts.py" = ["E501"]
"pipeline/main.py" = ["E402"]
# (delete the scripts/finetune/train_unsloth.py entry)

[tool.pytest.ini_options]
testpaths = ["tests/pipeline"]
# The repo root must be on sys.path so `pipeline` resolves as a top-level
# package. tests/pipeline/ deliberately carries no __init__.py: that would
# make pytest put tests/ on sys.path ahead of the root and shadow the real
# package with the test package of the same name.
pythonpath = ["."]

[tool.ty.environment]
python-version = "3.14"
# (delete extra-paths = ["scripts"])
```

- [ ] **Step 5: Re-lock and verify**

Run:

```bash
uv lock && uv sync --locked --group dev
uv run pytest -q && uv run ruff check . && uv run ty check
```

Expected: all pass, with `tests/scripts` no longer collected.

- [ ] **Step 6: Update the prose docs**

In `README.md`: delete the "Pipeline test data" section's references to
`scripts/validate_pipeline.py` and the tuning tools, delete the fine-tuning
paragraph, and remove `scripts/` from the Layout tree. In `CLAUDE.md` and
`AGENTS.md`, remove the same references. Add one line to `README.md` under
Pipeline:

```markdown
`SVD_QUERY` in `pipeline/pubmed_search.py` is a hand-maintained constant. The
tooling that used to measure its recall against a bibliography was removed;
`data/test_data/gold_standard/gold_standard_v2.csv` is retained as the fixture
for the extraction regression suite.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Remove the superseded scripts tree

Deletes scripts/ (10,026 lines), tests/scripts/ (4,587) and the query
distillation Quarto report (1,484), plus tuning_schema.py and the
non-Claude prompt variants. Nothing in pipeline/ imported any of it.
Drops scikit-learn, matplotlib and the GPU extra; lxml and rich stay."
```

---

### Task 4: Collapse the single-provider abstraction

`llm_providers/` is 597 lines of pluggable-backend machinery over one commercial
provider, with a registry containing a single entry. Native structured outputs
are GA and give the guarantee the abstraction existed for.

**Files:**

- Delete: `pipeline/llm_providers/__init__.py`,
  `pipeline/llm_providers/base.py`,
  `pipeline/llm_providers/anthropic_provider.py`
- Create: `pipeline/extraction_models.py` (the Pydantic models + parser),
  `pipeline/anthropic_client.py` (the provider body, de-protocoled)
- Modify: `pipeline/llm_extraction.py`, `pipeline/config.py` (drop
  `llm_provider`), `pipeline/main.py`, `pipeline/report.py`
- Test: rename `tests/pipeline/test_llm_providers_base.py` →
  `test_extraction_models.py`; `test_anthropic_provider.py` →
  `test_anthropic_client.py`; delete `test_llm_extraction_dispatch.py`

**Interfaces:**

- Consumes: `uses_adaptive_thinking`, `supports_effort` (Task 1).
- Produces: `GeneEntry`, `ExtractionResult`, `ExtractionFailedError`,
  `parse_extraction_response(text: str) -> ExtractionResult` from
  `pipeline/extraction_models.py`;
  `extract(text: str, pmid: str, config: PipelineConfig, rate_limiter: AsyncRateLimiter | None) -> tuple[list[GeneEntry], TokenUsage]`,
  `close()`, `report_metadata(config)`, `estimate_cost(usage, config)` from
  `pipeline/anthropic_client.py`.

- [ ] **Step 1: Move the models out of `base.py` unchanged**

```bash
git mv pipeline/llm_providers/base.py pipeline/extraction_models.py
git mv pipeline/llm_providers/anthropic_provider.py pipeline/anthropic_client.py
```

Then in `pipeline/extraction_models.py`, delete the `LLMProvider` Protocol class
and the now-unused `Protocol`/`runtime_checkable`/`Any`/`TYPE_CHECKING` imports
it required. Keep `GeneEntry`, `ExtractionResult`, `ExtractionFailedError` and
`parse_extraction_response` byte-identical.

- [ ] **Step 2: Rewrite `pipeline/llm_extraction.py` as a thin module-level
      client cache**

```python
"""LLM-based gene extraction over the Anthropic API."""

import logging

from pipeline.anthropic_client import AnthropicClient
from pipeline.config import PipelineConfig
from pipeline.extraction_models import ExtractionFailedError, GeneEntry
from pipeline.quality_metrics import TokenUsage
from pipeline.rate_limiter import AsyncRateLimiter

logger = logging.getLogger(__name__)

__all__ = [
    "ExtractionFailedError",
    "GeneEntry",
    "close_async_client",
    "extract_from_paper",
]

_client: AnthropicClient | None = None


async def extract_from_paper(
    text: str,
    pmid: str,
    config: PipelineConfig | None = None,
    rate_limiter: AsyncRateLimiter | None = None,
) -> tuple[list[GeneEntry], TokenUsage]:
    """Extract genes from paper text. Caches one client for the process."""
    global _client
    if not text or not text.strip():
        logger.warning("Empty text provided for PMID %s", pmid)
        return [], TokenUsage()

    config = config or PipelineConfig()
    if _client is None:
        _client = AnthropicClient()
    return await _client.extract(text, pmid, config, rate_limiter)


async def close_async_client() -> None:
    """Close the cached client. Idempotent: safe before any init."""
    global _client
    if _client is not None:
        await _client.close()
    _client = None
```

- [ ] **Step 3: Rename the class and drop the provider config field**

In `pipeline/anthropic_client.py`, rename `AnthropicProvider` →
`AnthropicClient` and update its imports (`pipeline.llm_providers.base` →
`pipeline.extraction_models`, `pipeline.config` for the two helpers from Task
1).

In `pipeline/config.py`, delete the `llm_provider` field, the `LLMProviderName`
type alias, the `LLM_PROVIDERS` constant, and the `llm_provider` validation in
`__post_init__`.

- [ ] **Step 4: Update the two remaining call sites**

In `pipeline/report.py` and `pipeline/main.py`, replace any
`config.llm_provider` reference. In `report.py`'s run-data assembly, the
provider name was a report field — replace with a literal:

```python
"llm_provider": "anthropic",
```

- [ ] **Step 5: Delete the package and update the conftest teardown**

```bash
git rm pipeline/llm_providers/__init__.py
git rm tests/pipeline/test_llm_extraction_dispatch.py
git mv tests/pipeline/test_llm_providers_base.py tests/pipeline/test_extraction_models.py
git mv tests/pipeline/test_anthropic_provider.py tests/pipeline/test_anthropic_client.py
```

In `tests/pipeline/conftest.py`, the autouse fixture resetting
`llm_extraction._provider` / `_provider_name` becomes:

```python
@pytest.fixture(autouse=True)
def _reset_llm_client() -> Iterator[None]:
    """The extraction module caches one client at module scope."""
    yield
    import pipeline.llm_extraction as llm_extraction

    llm_extraction._client = None
```

- [ ] **Step 6: Run the suite**

Run: `uv run pytest tests/pipeline -q && uv run ruff check . && uv run ty check`
Expected: PASS. Update the moved tests' imports; the assertions themselves
should not need changing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Collapse the single-provider LLM abstraction

597 lines of pluggable-backend machinery over one provider, with a
one-entry registry. Native structured outputs give the guarantee the
Protocol existed for. Models move to extraction_models.py, the client
body to anthropic_client.py."
```

---

# Phase 2 — Port the export layer to Python

Replaces `data-prep/*.R` with `pipeline/export/`. Ships independently of
Phase 3. **This is the phase that brings the export under CI for the first
time** — `data-prep/` currently has no lockfile, no tests and no CI, yet
produces the artifacts the site ships.

The porting rule throughout: **reproduce the R behaviour exactly, including its
documented workarounds.** Every helper below has a test asserting the specific
data defect it was written to handle.

---

### Task 5: Export package scaffolding and the JSON writer

**Files:**

- Create: `pipeline/export/__init__.py`, `pipeline/export/writer.py`
- Test: `tests/pipeline/export/test_writer.py`

**Interfaces:**

- Consumes: nothing.
- Produces: `to_camel(name: str) -> str`,
  `write_rows(rows: list[dict[str, Any]], path: Path) -> None`,
  `write_value(value: Any, path: Path) -> None` from
  `pipeline/export/writer.py`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/export/test_writer.py
import json
from pathlib import Path

from pipeline.export.writer import to_camel, write_rows, write_value


def test_to_camel_lowercases_mid_name_acronyms() -> None:
    """'Registry ID' -> 'registryId', not 'registryID'."""
    assert to_camel("Registry ID") == "registryId"
    assert to_camel("GWAS Trait") == "gwasTrait"
    assert to_camel("SVD Population Details") == "svdPopulationDetails"
    assert to_camel("Gene") == "gene"
    assert to_camel("Link to Monogenic Disease") == "linkToMonogenicDisease"


def test_write_rows_matches_the_committed_json_format(tmp_path: Path) -> None:
    """2-space indent, trailing newline, UTF-8 preserved."""
    path = tmp_path / "out.json"
    write_rows([{"Gene": "LAMB1", "GWAS Trait": ["(none found)"]}], path)
    raw = path.read_text(encoding="utf-8")
    assert raw.endswith("]\n")
    assert '\n  {\n    "gene": "LAMB1"' in raw
    assert json.loads(raw) == [{"gene": "LAMB1", "gwasTrait": ["(none found)"]}]


def test_single_element_lists_stay_arrays(tmp_path: Path) -> None:
    """The R I() invariant, now structural: a 1-element list is an array."""
    path = tmp_path / "out.json"
    write_rows([{"References": ["37063705"]}], path)
    assert json.loads(path.read_text())[0]["references"] == ["37063705"]


def test_write_value_emits_bare_null(tmp_path: Path) -> None:
    path = tmp_path / "status.json"
    write_value(None, path)
    assert path.read_text(encoding="utf-8") == "null\n"


def test_non_ascii_is_preserved_not_escaped(tmp_path: Path) -> None:
    path = tmp_path / "out.json"
    write_rows([{"City": "Zürich"}], path)
    assert "Zürich" in path.read_text(encoding="utf-8")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/export/test_writer.py -v` Expected: FAIL with
`ModuleNotFoundError: No module named 'pipeline.export'`

- [ ] **Step 3: Implement the writer**

```python
# pipeline/export/writer.py
"""JSON output for the dashboard export.

The committed data/*.json files are 2-space indented with a trailing
newline and unescaped UTF-8. That formatting is a contract: deviating
turns the first regeneration into an unreviewable whole-file diff.
"""

import json
import re
from pathlib import Path
from typing import Any

_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")


def to_camel(name: str) -> str:
    """Convert a display column name to its camelCase JSON key.

    The remainder is lower-cased before capitalising so mid-name acronyms
    normalise too: "Registry ID" -> "registryId", never "registryID".
    """
    parts = _NON_ALNUM.sub(" ", name).strip().split()
    if not parts:
        return ""
    head, *tail = parts
    return head.lower() + "".join(word.capitalize() for word in tail)


def _dump(value: Any, path: Path) -> None:
    text = json.dumps(value, indent=2, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8")


def write_rows(rows: list[dict[str, Any]], path: Path) -> None:
    """Write rows as a JSON array of objects, keys camelCased.

    Python lists serialise as JSON arrays unconditionally, so the four
    Gene list-columns need no equivalent of R's I() wrapping.
    """
    _dump([{to_camel(k): v for k, v in row.items()} for row in rows], path)


def write_value(value: Any, path: Path) -> None:
    """Write a single JSON value — an object, or a bare null."""
    _dump(value, path)
```

Create `pipeline/export/__init__.py` as an empty file, and
`tests/pipeline/export/` with **no** `__init__.py` (matching the existing
`tests/pipeline/` convention).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/export/test_writer.py -v` Expected: PASS (5
tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/export tests/pipeline/export
git commit -m "Add the export package's JSON writer

Reproduces jsonlite's committed output format exactly: 2-space indent,
trailing newline, unescaped UTF-8. The R I() list-column invariant is
structural in Python and needs no equivalent."
```

---

### Task 6: Port the text-cleaning helpers

These are `utils.R`'s helpers. Each carries a documented data defect it exists
to handle; each gets a test naming that defect.

**Files:**

- Create: `pipeline/export/text.py`
- Test: `tests/pipeline/export/test_text.py`

**Interfaces:**

- Consumes: nothing.
- Produces: from `pipeline/export/text.py` —
  `normalize_text(value: str | None) -> str | None`,
  `fill_missing_text(value: str | None, fallback: str, sentinels: tuple[str, ...] = ("NA", "N/A")) -> str`,
  `normalize_yes_no(value: str) -> str`, `clean_column_name(name: str) -> str`,
  `extract_matches_or(value: str | None, pattern: re.Pattern[str], fallback: str) -> list[str]`,
  `extract_pmids_or(value: str | None, fallback: str) -> list[str]`,
  `split_genetic_targets(targets: Iterable[str | None]) -> list[str]`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/export/test_text.py
import re

from pipeline.export.text import (
    clean_column_name,
    extract_matches_or,
    extract_pmids_or,
    fill_missing_text,
    normalize_text,
    normalize_yes_no,
    split_genetic_targets,
)


def test_normalize_text_blanks_become_none() -> None:
    assert normalize_text("  PSMD  ") == "PSMD"
    assert normalize_text("   ") is None
    assert normalize_text(None) is None


def test_fill_missing_text_catches_textual_na() -> None:
    assert fill_missing_text(None, "(unknown)") == "(unknown)"
    assert fill_missing_text("NA", "(unknown)") == "(unknown)"
    assert fill_missing_text("n/a", "(unknown)") == "(unknown)"
    assert fill_missing_text("Yes", "(unknown)") == "Yes"


def test_fill_missing_text_honours_a_custom_sentinel_set() -> None:
    """Genetic Target adds '-'; the omics column disables sentinels entirely."""
    assert fill_missing_text("-", "(none)", sentinels=("NA", "N/A", "-")) == "(none)"
    assert fill_missing_text("NA", "(none found)", sentinels=()) == "NA"


def test_normalize_yes_no_folds_both_variants() -> None:
    assert normalize_yes_no("Y") == "Yes"
    assert normalize_yes_no("yes") == "Yes"
    assert normalize_yes_no("N") == "No"
    assert normalize_yes_no("no") == "No"
    assert normalize_yes_no("Maybe") == "Maybe"


def test_clean_column_name_preserves_acronyms() -> None:
    assert clean_column_name("gwas_trait") == "GWAS Trait"
    assert clean_column_name("registry_id") == "Registry ID"
    assert clean_column_name("svd_population") == "SVD Population"
    assert clean_column_name("evidence_from_other_omics_studies") == (
        "Evidence from Other Omics Studies"
    )


def test_extract_matches_or_pulls_six_digit_omim_ids() -> None:
    pattern = re.compile(r"\b\d{6}\b")
    assert extract_matches_or("CADASIL 125310", pattern, "(none found)") == ["125310"]
    assert extract_matches_or(None, pattern, "(none found)") == ["(none found)"]
    assert extract_matches_or("no ids", pattern, "(none found)") == ["(none found)"]


def test_extract_pmids_accepts_urls_and_labels() -> None:
    assert extract_pmids_or(
        "https://pubmed.ncbi.nlm.nih.gov/12345 and PMID: 67890", "(reference needed)"
    ) == ["12345", "67890"]


def test_extract_pmids_applies_a_seven_digit_floor_in_prose() -> None:
    """A bare 4-digit number in prose is a year, not a PMID."""
    assert extract_pmids_or("published in 2019", "(reference needed)") == [
        "(reference needed)"
    ]
    assert extract_pmids_or("see 37063705", "(reference needed)") == ["37063705"]


def test_extract_pmids_allows_short_ids_in_an_all_numeric_list() -> None:
    assert extract_pmids_or("12345, 67890", "(reference needed)") == ["12345", "67890"]


def test_extract_pmids_ignores_doi_numeric_fragments() -> None:
    assert extract_pmids_or(
        "doi: 10.1212/NXG.0000000000200069", "(reference needed)"
    ) == ["(reference needed)"]


def test_split_genetic_targets_does_not_split_na_on_its_slash() -> None:
    assert split_genetic_targets(["N/A"]) == []
    assert split_genetic_targets(["NOTCH3, HTRA1"]) == ["NOTCH3", "HTRA1"]
    assert split_genetic_targets(["COL4A1/COL4A2"]) == ["COL4A1", "COL4A2"]
    assert split_genetic_targets(["(none)", None, ""]) == []


def test_split_genetic_targets_dedupes_preserving_order() -> None:
    assert split_genetic_targets(["HTRA1", "NOTCH3; HTRA1"]) == ["HTRA1", "NOTCH3"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/export/test_text.py -v` Expected: FAIL with
`ModuleNotFoundError: No module named 'pipeline.export.text'`

- [ ] **Step 3: Implement the helpers**

```python
# pipeline/export/text.py
"""Text-cleaning helpers ported from data-prep/utils.R.

Each helper here encodes a defect found in the real source data. The tests
name the defect; do not "simplify" a rule without checking the test first.
"""

import re
from collections.abc import Iterable
from typing import Final

_ACRONYMS: Final[tuple[str, ...]] = ("GWAS", "SVD", "ID", "Omics")

# toTitleCase in R lower-cases these short words. Reproduced so column
# names — and therefore JSON keys — match the committed files exactly.
_TITLE_CASE_STOPWORDS: Final[frozenset[str]] = frozenset(
    {"a", "an", "and", "are", "as", "at", "be", "but", "by", "en", "for",
     "if", "in", "is", "nor", "not", "of", "on", "or", "per", "so", "the",
     "to", "v", "via", "vs", "from", "into", "than", "that", "with"}
)

_PUBMED_URL = re.compile(
    r"https?://(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov/|"
    r"ncbi\.nlm\.nih\.gov/pubmed/)([1-9][0-9]*)",
    re.IGNORECASE,
)
_LABELLED_PMID = re.compile(r"\bPMID\s*:?\s*([1-9][0-9]*)\b", re.IGNORECASE)
_URL = re.compile(r"https?://\S+")
_DOI_LABEL = re.compile(r"\bdoi:\s*\S+", re.IGNORECASE)
_DOI_BARE = re.compile(r"\b10\.\d{4,9}/\S+")
_NUMERIC_LIST = re.compile(r"^\s*[1-9][0-9]*(?:\s*[,;]\s*[1-9][0-9]*)*\s*$")
_MARKER = "SVDPMIDTOKEN"
_MARKED_OR_LONG = re.compile(rf"{_MARKER}[1-9][0-9]*|\b[1-9][0-9]{{6,}}\b")
_ANY_NUMBER = re.compile(r"\b[1-9][0-9]*\b")
_TARGET_SPLIT = re.compile(r"[,;/]")
_NA_WORD = re.compile(r"\bN\s*/\s*A\b", re.IGNORECASE)
_TARGET_SENTINELS: Final[frozenset[str]] = frozenset(
    {"", "NA", "N/A", "-", "(NONE)", "(UNKNOWN)"}
)


def normalize_text(value: str | None) -> str | None:
    """Trim surrounding whitespace; a blank cell becomes None."""
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def fill_missing_text(
    value: str | None,
    fallback: str,
    sentinels: tuple[str, ...] = ("NA", "N/A"),
) -> str:
    """Replace a missing or sentinel value with one display fallback."""
    if value is None:
        return fallback
    normalized = value.strip().upper()
    if not normalized or normalized in {s.upper() for s in sentinels}:
        return fallback
    return value


def normalize_yes_no(value: str) -> str:
    """Fold the database's Y/N and Yes/No variants for the binary filters."""
    normalized = value.strip().upper()
    if normalized in {"Y", "YES"}:
        return "Yes"
    if normalized in {"N", "NO"}:
        return "No"
    return value


def clean_column_name(name: str) -> str:
    """Convert a database column name to its display label."""
    words = name.replace("_", " ").split()
    titled = [
        word.lower()
        if i > 0 and word.lower() in _TITLE_CASE_STOPWORDS
        else word.capitalize()
        for i, word in enumerate(words)
    ]
    restored = []
    for word in titled:
        match = next((a for a in _ACRONYMS if a.lower() == word.lower()), None)
        restored.append(match if match else word)
    return " ".join(restored)


def extract_matches_or(
    value: str | None, pattern: re.Pattern[str], fallback: str
) -> list[str]:
    """Every regex match, or a single-element fallback list."""
    if value is None:
        return [fallback]
    matches = pattern.findall(value)
    return matches if matches else [fallback]


def extract_pmids_or(value: str | None, fallback: str) -> list[str]:
    """Extract PubMed IDs without mistaking years or DOI fragments for them.

    Short IDs are accepted only when a PubMed URL, a PMID label, or an
    all-numeric cell makes their meaning explicit. Unlabelled prose keeps a
    seven-digit floor. The marker pass preserves source order across the two
    explicit forms and the bare-number scan.
    """
    if value is None:
        return [fallback]

    marked = _PUBMED_URL.sub(rf" {_MARKER}\1 ", value)
    marked = _LABELLED_PMID.sub(rf" {_MARKER}\1 ", marked)

    # Strip URLs and DOIs before scanning prose: DOI suffixes often carry
    # long numeric fragments that look like modern PMIDs.
    remainder = _URL.sub(" ", marked)
    remainder = _DOI_LABEL.sub(" ", remainder)
    remainder = _DOI_BARE.sub(" ", remainder)

    pattern = _ANY_NUMBER if _NUMERIC_LIST.match(remainder) else _MARKED_OR_LONG
    seen: dict[str, None] = {}
    for candidate in pattern.findall(remainder):
        seen.setdefault(candidate.removeprefix(_MARKER), None)
    return list(seen) if seen else [fallback]


def split_genetic_targets(targets: Iterable[str | None]) -> list[str]:
    """Split multi-target trial cells into unique gene symbols, in order.

    The N/A sentinel is removed before splitting: slash is also a delimiter,
    so "N/A" would otherwise yield two bogus symbols.
    """
    seen: dict[str, None] = {}
    for target in targets:
        if target is None or not target.strip():
            continue
        for gene in _TARGET_SPLIT.split(_NA_WORD.sub("", target)):
            gene = gene.strip()
            if gene.upper() not in _TARGET_SENTINELS:
                seen.setdefault(gene, None)
    return list(seen)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/export/test_text.py -v` Expected: PASS (12
tests). If `clean_column_name` fails on `"Evidence from Other Omics Studies"`,
the stopword list needs the failing word added — R's `toTitleCase` is the
reference.

- [ ] **Step 5: Commit**

```bash
git add pipeline/export/text.py tests/pipeline/export/test_text.py
git commit -m "Port the export text helpers from data-prep/utils.R

Each helper encodes a real source-data defect: the PMID seven-digit floor,
the N/A-is-not-two-genes split, textual NA sentinels. Tests name the defect."
```

---

### Task 7: Port the Table 1 (genes) cleaning rules

The omics chain is the most delicate part of the whole port: ten ordered
transformations plus a debris sweep whose comment is longer than the code. Order
matters — the sweep runs against source separators _before_ `:` becomes `;`.

**Files:**

- Create: `pipeline/export/tables.py`
- Test: `tests/pipeline/export/test_tables.py`

**Interfaces:**

- Consumes: everything from `pipeline/export/text.py` (Task 6).
- Produces: `clean_omics_value(value: str | None) -> list[str]`,
  `clean_gene_row(row: dict[str, Any]) -> dict[str, Any]` from
  `pipeline/export/tables.py`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/export/test_tables.py
from pipeline.export.tables import clean_gene_row, clean_omics_value


def test_omics_strips_the_star_suffix() -> None:
    assert clean_omics_value("TWAS*") == ["TWAS"]


def test_omics_expands_the_mentr_sentence() -> None:
    raw = (
        "Evidence for causal implication from ML-based "
        "functional prediction (MENTR)"
    )
    assert clean_omics_value(raw) == [
        "mutation effect prediction on ncRNA transcription"
    ]


def test_omics_leaves_no_dangling_separator() -> None:
    """Deleting a whole tissue name must not strand its separator.

    'TWAS:YFS.BLOOD.RNAARR' would otherwise render as 'TWAS;' in the cell.
    """
    assert clean_omics_value("TWAS:YFS.BLOOD.RNAARR") == ["TWAS"]


def test_omics_entry_that_is_only_a_deleted_tissue_collapses_away() -> None:
    assert clean_omics_value("YFS.BLOOD.RNAARR") == ["(none found)"]


def test_omics_rewrites_gtex_cross_tissue() -> None:
    assert clean_omics_value("TWAS:GTEX - Cross-tissue sCCA3") == [
        "TWAS;cross-tissue"
    ]


def test_omics_splits_multiple_studies_on_comma() -> None:
    assert clean_omics_value("TWAS*;PWAS*") == ["TWAS", "PWAS"]


def test_omics_missing_becomes_the_sentinel() -> None:
    assert clean_omics_value(None) == ["(none found)"]
    assert clean_omics_value("") == ["(none found)"]


def test_gene_row_produces_the_display_contract() -> None:
    row = clean_gene_row(
        {
            "gene": "LAMB1",
            "protein": "LAMB1",
            "chromosomal_location": "7q31.1",
            "gwas_trait": "small vessel stroke, WMH",
            "mendelian_randomization": None,
            "evidence_from_other_omics_studies": None,
            "link_to_monogenetic_disease": None,
            "brain_cell_types": "ALL",
            "affected_pathway": "Extracellular Matrix Organization",
            "references": "37063705, 34606115",
        }
    )
    assert row["Gene"] == "LAMB1"
    assert row["GWAS Trait"] == ["SVS", "WMH"]
    assert row["Mendelian Randomization"] == "No"
    assert row["Evidence From Other Omics Studies"] == ["(none found)"]
    assert row["Link to Monogenic Disease"] == ["(none found)"]
    assert row["Brain Cell Types"] == "all"
    assert row["Affected Pathway"] == "extracellular matrix organization"
    assert row["References"] == ["37063705", "34606115"]


def test_gene_row_puts_gene_first() -> None:
    row = clean_gene_row({"protein": "X", "gene": "ABC", "references": "1234567"})
    assert next(iter(row)) == "Gene"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/export/test_tables.py -v` Expected: FAIL with
`ModuleNotFoundError: No module named 'pipeline.export.tables'`

- [ ] **Step 3: Implement the Table 1 cleaning**

```python
# pipeline/export/tables.py
"""Row-level cleaning for the two exported tables.

Ported from data-prep/clean_table1.R and clean_table2.R. The omics chain's
step order is load-bearing: the debris sweep runs against the *source*
separators, before ":" becomes ";" and long before the tissue names are
deleted, so it cannot be reordered or merged.
"""

import re
from typing import Any, Final

from pipeline.export.text import (
    clean_column_name,
    extract_matches_or,
    extract_pmids_or,
    fill_missing_text,
    normalize_text,
    normalize_yes_no,
)

_OMIM_ID = re.compile(r"\b\d{6}\b")
_SPLIT_ON_COMMA = re.compile(r"\s*,\s*")
_EMPTY_SEPARATOR = re.compile(r";\s*(?=[,;]|$)")
_SEMICOLON_RUN = re.compile(r";\s*")
_DANGLING_SEMICOLON = re.compile(r";\s*(?=,|$)")
_DANGLING_COMMA = re.compile(r"\s*,\s*(?=,|$)")
_LEADING_COMMA = re.compile(r"^\s*,\s*")
_ALL_WORD = re.compile(r"\bALL\b")

_MENTR_SENTENCE: Final[str] = (
    "Evidence for causal implication from ML-based functional prediction (MENTR)"
)
_MENTR_LABEL: Final[str] = "mutation effect prediction on ncRNA transcription"


def clean_omics_value(value: str | None) -> list[str]:
    """Apply the omics-evidence transformation chain, then split on commas."""
    text = value or ""
    text = text.replace("*", "")
    # Remove only genuinely empty separators; deleting one merely because
    # whitespace follows would merge two distinct studies.
    text = _EMPTY_SEPARATOR.sub("", text)
    text = _SEMICOLON_RUN.sub(", ", text)
    text = text.replace(":", ";")
    text = text.replace(_MENTR_SENTENCE, _MENTR_LABEL)
    text = text.replace("YFS.BLOOD.RNAARR", "")
    text = text.replace("GTEX - Cross-tissue sCCA3", "cross-tissue")
    text = text.replace("GTEx.", "")
    text = text.replace("_", " ")

    # Sweep the debris the tissue deletions leave behind. Without this an
    # entry whose whole tissue was one of those tokens keeps a separator
    # pointing at nothing ("TWAS;"), and an entry that was nothing but such
    # a token collapses to an empty list item — breaking the nonblank half
    # of the list-column contract.
    text = _DANGLING_SEMICOLON.sub("", text)
    text = _DANGLING_COMMA.sub("", text)
    text = _LEADING_COMMA.sub("", text)
    text = text.strip()

    filled = fill_missing_text(text or None, "(none found)", sentinels=())
    return [part for part in _SPLIT_ON_COMMA.split(filled) if part]


def clean_gene_row(row: dict[str, Any]) -> dict[str, Any]:
    """Clean one `genes` row into its display-keyed form."""
    values = {k: normalize_text(v) if isinstance(v, str) else v for k, v in row.items()}

    # Missing and textual-NA both mean no MR support in the source schema.
    values["mendelian_randomization"] = fill_missing_text(
        values.get("mendelian_randomization"), "N"
    )

    ordered = ["gene", *[k for k in values if k != "gene"]]
    out: dict[str, Any] = {clean_column_name(k): values[k] for k in ordered}

    traits = fill_missing_text(out.get("GWAS Trait"), "(none found)")
    out["GWAS Trait"] = [
        part.replace("small vessel stroke", "SVS")
        for part in _SPLIT_ON_COMMA.split(traits)
        if part
    ]

    out["Evidence From Other Omics Studies"] = clean_omics_value(
        out.pop("Evidence from Other Omics Studies", None)
    )

    out["Link to Monogenic Disease"] = extract_matches_or(
        out.pop("Link to Monogenetic Disease", None), _OMIM_ID, "(none found)"
    )

    out["References"] = extract_pmids_or(out.get("References"), "(reference needed)")

    cell_types = _ALL_WORD.sub("all", out.get("Brain Cell Types") or "")
    out["Brain Cell Types"] = fill_missing_text(cell_types or None, "(unknown)")

    out["Affected Pathway"] = fill_missing_text(
        out.get("Affected Pathway"), "(unknown)"
    ).lower()

    out["Mendelian Randomization"] = normalize_yes_no(out["Mendelian Randomization"])
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/export/test_tables.py -v` Expected: PASS (9
tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/export/tables.py tests/pipeline/export/test_tables.py
git commit -m "Port the Table 1 cleaning rules

The omics chain's step order is load-bearing and now has tests naming the
two defects the debris sweep exists to prevent: a dangling 'TWAS;' and an
empty list item that would break the nonblank list-column contract."
```

---

### Task 8: Port the Table 2 (clinical trials) cleaning rules

**Files:**

- Modify: `pipeline/export/tables.py`
- Test: `tests/pipeline/export/test_tables.py`

**Interfaces:**

- Consumes: `pipeline/export/text.py` (Task 6).
- Produces: `clean_trial_row(row: dict[str, Any]) -> dict[str, Any]` from
  `pipeline/export/tables.py`.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/pipeline/export/test_tables.py
from pipeline.export.tables import clean_trial_row

_TRIAL = {
    "drug": "Butylphthalide (NBP)",
    "mechanism_of_action": "Neuroprotective",
    "genetic_target": None,
    "genetic_evidence": "N",
    "trial_name": "Isosorbide Mononitrate and Butylphthalide",
    "registry_id": "ChiCTR2500109773",
    "clinical_trial_phase": "III",
    "svd_population": "CAA",
    "svd_population_details": "CAA-related ICH",
    "target_sample_size": 3156,
    "estimated_completion_date": "7/2028",
    "primary_outcome": "Post-stroke disability at 6 months",
    "sponsor_type": "Academic",
}


def test_trial_row_is_string_only() -> None:
    row = clean_trial_row(dict(_TRIAL))
    assert all(isinstance(v, str) and v.strip() for v in row.values())


def test_target_sample_size_is_stringified_not_dropped() -> None:
    """The column is nullable and mixes formats, so it ships as a string."""
    assert clean_trial_row(dict(_TRIAL))["Target Sample Size"] == "3156"
    assert clean_trial_row({**_TRIAL, "target_sample_size": None})[
        "Target Sample Size"
    ] == "(unknown)"


def test_genetic_target_has_its_own_sentinel_set() -> None:
    assert clean_trial_row({**_TRIAL, "genetic_target": "-"})["Genetic Target"] == (
        "(none)"
    )
    assert clean_trial_row({**_TRIAL, "genetic_target": None})["Genetic Target"] == (
        "(none)"
    )


def test_completed_unpublished_is_normalized() -> None:
    for raw in ("Completed, unpublished", "Completed; unpublish", "completed unpublished"):
        row = clean_trial_row({**_TRIAL, "estimated_completion_date": raw})
        assert row["Estimated Completion Date"] == "Completed (unpublished)"


def test_genetic_evidence_is_folded_to_yes_no() -> None:
    assert clean_trial_row(dict(_TRIAL))["Genetic Evidence"] == "No"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/export/test_tables.py -k trial -v` Expected:
FAIL with `ImportError: cannot import name 'clean_trial_row'`

- [ ] **Step 3: Implement the Table 2 cleaning**

Append to `pipeline/export/tables.py`:

```python
_COMPLETED_UNPUBLISHED = re.compile(
    r"^Completed\s*[,;]?\s*unpublish(?:ed)?$", re.IGNORECASE
)

_UNKNOWN_COLUMNS: Final[tuple[str, ...]] = (
    "Drug",
    "Mechanism of Action",
    "Genetic Evidence",
    "Trial Name",
    "Registry ID",
    "Clinical Trial Phase",
    "SVD Population",
    "SVD Population Details",
    "Target Sample Size",
    "Estimated Completion Date",
    "Primary Outcome",
    "Sponsor Type",
)


def clean_trial_row(row: dict[str, Any]) -> dict[str, Any]:
    """Clean one `clinical_trials` row into its display-keyed form."""
    values = {k: normalize_text(v) if isinstance(v, str) else v for k, v in row.items()}
    out: dict[str, Any] = {clean_column_name(k): v for k, v in values.items()}

    out["Genetic Target"] = fill_missing_text(
        out.get("Genetic Target"), "(none)", sentinels=("NA", "N/A", "-")
    )

    # Stringify before filling: a None sample size must become the sentinel,
    # not the string "None".
    size = out.get("Target Sample Size")
    out["Target Sample Size"] = None if size is None else str(size)

    for column in _UNKNOWN_COLUMNS:
        out[column] = fill_missing_text(out.get(column), "(unknown)")

    if _COMPLETED_UNPUBLISHED.match(out["Estimated Completion Date"]):
        out["Estimated Completion Date"] = "Completed (unpublished)"

    out["Genetic Evidence"] = normalize_yes_no(out["Genetic Evidence"])
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/export/test_tables.py -v` Expected: PASS (14
tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/export/tables.py tests/pipeline/export/test_tables.py
git commit -m "Port the Table 2 cleaning rules"
```

---

### Task 9: Port the four database lookups

**Files:**

- Create: `pipeline/export/lookups.py`
- Test: `tests/pipeline/export/test_lookups.py`

**Interfaces:**

- Consumes: `pipeline.database.Database`.
- Produces: from `pipeline/export/lookups.py` —
  `complete_lookup(rows, requested, key, defaults) -> list[dict[str, Any]]`, and
  four async functions `read_ncbi_gene_info(symbols)`,
  `read_uniprot_info(symbols)`, `read_pubmed_refs(pmids)`,
  `read_pipeline_status()`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/export/test_lookups.py
from pipeline.export.lookups import complete_lookup


def test_complete_lookup_returns_one_row_per_request_in_order() -> None:
    rows = [{"name": "HTRA1", "uid": "5654"}, {"name": "LAMB1", "uid": "3912"}]
    out = complete_lookup(
        rows, ["LAMB1", "MISSING", "HTRA1"], "name", {"uid": None}
    )
    assert [r["name"] for r in out] == ["LAMB1", "MISSING", "HTRA1"]
    assert out[1] == {"name": "MISSING", "uid": None}


def test_complete_lookup_supports_a_computed_default() -> None:
    out = complete_lookup(
        [],
        ["12345678"],
        "pmid",
        {"formatted_ref": lambda key: f"PMID: {key} (citation not available)"},
    )
    assert out[0]["formatted_ref"] == "PMID: 12345678 (citation not available)"


def test_complete_lookup_on_empty_request_returns_empty() -> None:
    assert complete_lookup([], [], "name", {"uid": None}) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/export/test_lookups.py -v` Expected: FAIL
with `ModuleNotFoundError`

- [ ] **Step 3: Implement the lookups**

```python
# pipeline/export/lookups.py
"""Cache-table reads for the export, ported from read_external_data.R.

Every lookup returns exactly one row per requested key, in request order —
the dashboard indexes these by position-independent key, but the four JSON
files are asserted row-for-row against their request lists.
"""

from collections.abc import Callable, Sequence
from typing import Any

from pipeline.database import Database


def complete_lookup(
    rows: Sequence[dict[str, Any]],
    requested: Sequence[str],
    key: str,
    defaults: dict[str, Any | Callable[[str], Any]],
) -> list[dict[str, Any]]:
    """Add a fallback row per missing key, then restore request order."""
    by_key = {row[key]: row for row in rows}
    out: list[dict[str, Any]] = []
    for wanted in requested:
        found = by_key.get(wanted)
        if found is not None:
            out.append(found)
            continue
        filled: dict[str, Any] = {key: wanted}
        for column, default in defaults.items():
            filled[column] = default(wanted) if callable(default) else default
        out.append(filled)
    return out


async def read_ncbi_gene_info(symbols: Sequence[str]) -> list[dict[str, Any]]:
    """Cached NCBI gene metadata, one row per requested symbol."""
    if not symbols:
        return []
    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol AS name, ncbi_uid AS uid,
                   description, aliases AS otheraliases
            FROM ncbi_gene_info
            WHERE gene_symbol = ANY($1::text[])
            """,
            list(symbols),
        )
    records = [
        {
            "name": r["name"],
            # The dashboard's uid is a string; do not let an integer column
            # type leak into the generated wire format.
            "uid": None if r["uid"] is None else str(r["uid"]),
            "description": r["description"],
            "otheraliases": r["otheraliases"],
        }
        for r in rows
    ]
    return complete_lookup(
        records,
        symbols,
        "name",
        {"uid": None, "description": None, "otheraliases": None},
    )


async def read_uniprot_info(symbols: Sequence[str]) -> list[dict[str, Any]]:
    """Cached UniProt protein metadata, one row per requested symbol."""
    if not symbols:
        return []
    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol AS gene, accession, url
            FROM uniprot_info
            WHERE gene_symbol = ANY($1::text[])
            """,
            list(symbols),
        )
    records = [dict(r) for r in rows]
    return complete_lookup(
        records, symbols, "gene", {"accession": None, "url": None}
    )


async def read_pubmed_refs(pmids: Sequence[str]) -> list[dict[str, Any]]:
    """Cached PubMed citations, one row per requested PMID."""
    if not pmids:
        return []
    async with Database.connection() as conn:
        rows = await conn.fetch(
            "SELECT pmid, formatted_ref FROM pubmed_citations "
            "WHERE pmid::text = ANY($1::text[])",
            list(pmids),
        )
    records = [{"pmid": str(r["pmid"]), "formatted_ref": r["formatted_ref"]} for r in rows]
    return complete_lookup(
        records,
        pmids,
        "pmid",
        {"formatted_ref": lambda key: f"PMID: {key} (citation not available)"},
    )


async def read_pipeline_status() -> dict[str, Any] | None:
    """Latest run summary, or None when the table does not exist.

    pipeline_runs is absent from the current database; the About page
    reports the update date as unavailable and the contract test accepts
    a bare null.
    """
    try:
        async with Database.connection() as conn:
            row = await conn.fetchrow(
                """
                SELECT run_timestamp, papers_processed, fulltext_retrieved,
                       genes_extracted, genes_validated
                FROM pipeline_runs
                ORDER BY run_timestamp DESC
                LIMIT 1
                """
            )
    except Exception as exc:  # noqa: BLE001 — any DB error means "unavailable"
        import logging

        logging.getLogger(__name__).info("Could not read pipeline_runs: %s", exc)
        return None
    if row is None:
        return None
    return {
        "runTimestamp": row["run_timestamp"].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "papersProcessed": row["papers_processed"],
        "fulltextRetrieved": row["fulltext_retrieved"],
        "genesExtracted": row["genes_extracted"],
        "genesValidated": row["genes_validated"],
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/export/test_lookups.py -v` Expected: PASS (3
tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/export/lookups.py tests/pipeline/export/test_lookups.py
git commit -m "Port the export cache-table lookups

complete_lookup keeps one row per requested key in request order, and the
PMID/uid string coercions stop a schema detail leaking into the wire format."
```

---

### Task 10: Atomic publish, the OMIM CSV, and the export CLI

**Files:**

- Create: `pipeline/export/publish.py`, `pipeline/export/omim.py`,
  `pipeline/export/main.py`
- Move: `data-prep/omim_info.csv` → `pipeline/export/data/omim_info.csv`
- Delete: `data-prep/export.R`, `clean_table1.R`, `clean_table2.R`, `utils.R`,
  `read_external_data.R`, `env.R`
- Modify: `deno.json` (the `data` task)
- Test: `tests/pipeline/export/test_publish.py`,
  `tests/pipeline/export/test_omim.py`

**Interfaces:**

- Consumes: Tasks 5–9.
- Produces:
  `publish_atomically(staged: dict[str, Path], target_dir: Path) -> None`,
  `read_omim_csv(path: Path) -> list[dict[str, Any]]`,
  `async def run_export() -> None`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/export/test_publish.py
from pathlib import Path

import pytest

from pipeline.export.publish import publish_atomically


def test_publish_moves_every_staged_file(tmp_path: Path) -> None:
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir(), target.mkdir()
    for name in ("a.json", "b.json"):
        (staging / name).write_text("[]\n")
    publish_atomically(
        {n: staging / n for n in ("a.json", "b.json")}, target
    )
    assert (target / "a.json").read_text() == "[]\n"
    assert (target / "b.json").read_text() == "[]\n"


def test_a_failed_publish_restores_the_previous_generation(tmp_path: Path) -> None:
    """A partial publish must not leave a half-old, half-new data directory."""
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir(), target.mkdir()
    (target / "a.json").write_text("OLD\n")
    (target / "b.json").write_text("OLD\n")
    (staging / "a.json").write_text("NEW\n")
    # b.json is staged but missing on disk, so the second rename fails.
    with pytest.raises(RuntimeError, match="Could not publish"):
        publish_atomically(
            {"a.json": staging / "a.json", "b.json": staging / "b.json"}, target
        )
    assert (target / "a.json").read_text() == "OLD\n"
    assert (target / "b.json").read_text() == "OLD\n"
```

```python
# tests/pipeline/export/test_omim.py
from pathlib import Path

from pipeline.export.omim import read_omim_csv


def test_omim_csv_decodes_mac_roman(tmp_path: Path) -> None:
    """The committed CSV carries a stray 0xCA (non-breaking space)."""
    path = tmp_path / "omim.csv"
    path.write_bytes(
        b"omim_num,omim_link,phenotype,inheritance,gene_or_locus,"
        b"gene_or_locus_mim_number\n"
        b"617168,https://omim.org/entry/617168,Aortic\xca aneurysm,AD,LOX,153455\n"
    )
    rows = read_omim_csv(path)
    assert rows[0]["phenotype"] == "Aortic aneurysm"
    assert rows[0]["omim_num"] == 617168
    assert rows[0]["gene_or_locus_mim_number"] == "153455"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`uv run pytest tests/pipeline/export/test_publish.py tests/pipeline/export/test_omim.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement the publisher**

```python
# pipeline/export/publish.py
"""Atomic publication of the generated export.

Renames are atomic per file but not across all eight, so the previous
generation is snapshotted first and restored if any rename fails. A failed
publish must never leave the dashboard serving a mixed generation.
"""

import shutil
from pathlib import Path


def publish_atomically(staged: dict[str, Path], target_dir: Path) -> None:
    """Move every staged file into place, rolling back on any failure."""
    backup_dir = target_dir / ".previous-export"
    if backup_dir.exists():
        shutil.rmtree(backup_dir)
    backup_dir.mkdir()
    had_previous = {
        name: (target_dir / name).exists() for name in staged
    }
    try:
        for name, existed in had_previous.items():
            if existed:
                shutil.copy2(target_dir / name, backup_dir / name)

        for name, source in staged.items():
            source.replace(target_dir / name)
    except OSError as exc:
        failures: list[str] = []
        for name, existed in had_previous.items():
            final = target_dir / name
            if existed:
                try:
                    shutil.copy2(backup_dir / name, final)
                except OSError:
                    failures.append(name)
            elif final.exists():
                final.unlink(missing_ok=True)
        detail = (
            " The previous export was restored."
            if not failures
            else f" Rollback also failed for: {', '.join(failures)}."
        )
        raise RuntimeError(f"Could not publish the export: {exc}.{detail}") from exc
    finally:
        shutil.rmtree(backup_dir, ignore_errors=True)
```

- [ ] **Step 4: Implement the OMIM reader**

```python
# pipeline/export/omim.py
"""Static OMIM lookup, ported from export.R step 7.

The CSV is Mac Roman, not UTF-8: it carries a stray 0xCA (U+00A0
non-breaking space) inside at least one phenotype label. Decoding as
latin-1 would silently turn that into a visible "Ê".
"""

import csv
import io
from pathlib import Path
from typing import Any, Final

_COLUMNS: Final[tuple[str, ...]] = (
    "omim_num",
    "omim_link",
    "phenotype",
    "inheritance",
    "gene_or_locus",
    "gene_or_locus_mim_number",
)

DEFAULT_OMIM_CSV: Final[Path] = Path(__file__).parent / "data" / "omim_info.csv"


def read_omim_csv(path: Path = DEFAULT_OMIM_CSV) -> list[dict[str, Any]]:
    """Read the OMIM table, folding non-breaking spaces into normal ones."""
    text = path.read_bytes().decode("mac_roman")
    reader = csv.DictReader(io.StringIO(text))
    rows: list[dict[str, Any]] = []
    for raw in reader:
        row: dict[str, Any] = {}
        for column in _COLUMNS:
            value = (raw.get(column) or "").replace(" ", " ").strip()
            # omimNum is a number in the contract; every other field a string.
            row[column] = int(value) if column == "omim_num" and value else value
        rows.append(row)
    return rows
```

- [ ] **Step 5: Implement the export CLI**

```python
# pipeline/export/main.py
"""Generate the dashboard's committed JSON from PostgreSQL.

Replaces data-prep/export.R. Run with:  uv run python -m pipeline.export.main
"""

import asyncio
import logging
import tempfile
from pathlib import Path

from pipeline.config import PROJECT_ROOT
from pipeline.database import Database
from pipeline.export.lookups import (
    read_ncbi_gene_info,
    read_pipeline_status,
    read_pubmed_refs,
    read_uniprot_info,
)
from pipeline.export.omim import read_omim_csv
from pipeline.export.publish import publish_atomically
from pipeline.export.tables import clean_gene_row, clean_trial_row
from pipeline.export.text import split_genetic_targets
from pipeline.export.writer import write_rows, write_value

logger = logging.getLogger(__name__)

_METADATA_COLUMNS = frozenset({"id", "created_at", "updated_at"})


async def _read_table(name: str) -> list[dict[str, object]]:
    """Read a source table, dropping database-only metadata columns."""
    if name not in {"genes", "clinical_trials"}:
        raise ValueError(f"Unsupported dashboard table: {name}")
    async with Database.connection() as conn:
        rows = await conn.fetch(f"SELECT * FROM {name}")  # noqa: S608 — allowlisted
    return [
        {k: v for k, v in dict(row).items() if k not in _METADATA_COLUMNS}
        for row in rows
    ]


async def run_export(target_dir: Path | None = None) -> None:
    """Generate all nine files, publishing only after every step succeeds."""
    target = target_dir or PROJECT_ROOT / "data"
    target.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix=".dashboard-export-", dir=target
    ) as staging_name:
        staging = Path(staging_name)
        staged: dict[str, Path] = {}

        def stage(name: str) -> Path:
            path = staging / name
            staged[name] = path
            return path

        logger.info("[1/8] Cleaning Table 1 (genes)")
        genes = [clean_gene_row(row) for row in await _read_table("genes")]
        write_rows(genes, stage("table1.json"))
        gene_symbols = list(dict.fromkeys(row["Gene"] for row in genes))

        logger.info("[2/8] Cleaning Table 2 (clinical trials)")
        trials = [clean_trial_row(r) for r in await _read_table("clinical_trials")]
        write_rows(trials, stage("table2.json"))

        logger.info("[3/8] NCBI gene info for Table 1 genes")
        write_rows(await read_ncbi_gene_info(gene_symbols), stage("gene_info.json"))

        logger.info("[4/8] NCBI gene info for Table 2 targets")
        targets = split_genetic_targets(r["Genetic Target"] for r in trials)
        write_rows(
            await read_ncbi_gene_info(targets), stage("gene_info_table2.json")
        )

        logger.info("[5/8] UniProt protein info")
        write_rows(await read_uniprot_info(gene_symbols), stage("protein_info.json"))

        logger.info("[6/8] PubMed references")
        pmids = list(
            dict.fromkeys(
                ref
                for row in genes
                for ref in row["References"]
                if ref.isdigit() and not ref.startswith("0")
            )
        )
        write_rows(await read_pubmed_refs(pmids), stage("refs.json"))

        logger.info("[7/8] OMIM reference table")
        write_rows(read_omim_csv(), stage("omim_info.json"))

        logger.info("[8/8] Latest pipeline run status")
        write_value(await read_pipeline_status(), stage("pipeline_status.json"))

        publish_atomically(staged, target)

    logger.info("Export complete. Run `deno task geocode` for the map locations.")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        asyncio.run(run_export())
    finally:
        asyncio.run(Database.close())


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Move the CSV and delete the R export layer**

```bash
mkdir -p pipeline/export/data
git mv data-prep/omim_info.csv pipeline/export/data/omim_info.csv
git rm data-prep/export.R data-prep/clean_table1.R data-prep/clean_table2.R \
       data-prep/utils.R data-prep/read_external_data.R data-prep/env.R
```

In `deno.json`, replace the `data` task:

```json
"data": "uv run python -m pipeline.export.main",
```

- [ ] **Step 7: Run everything**

Run: `uv run pytest tests/pipeline -q && uv run ruff check . && uv run ty check`
Expected: PASS

- [ ] **Step 8: Verify against the real database and diff the output**

Run:

```bash
uv run python -m pipeline.export.main
git diff --stat data/
```

Expected: **no changes to the eight files**, or changes explainable by real data
movement. A whole-file reformat means the writer's format does not match; a key
rename means `to_camel` or `clean_column_name` diverged. Do not proceed until
the diff is understood.

Then: `deno task test && deno task test:e2e` Expected: PASS —
`tests/data_contract_test.ts` is the cross-language proof the port is faithful.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Port the JSON export from R to Python

Replaces data-prep/*.R with pipeline/export/. The export is now covered by
pytest and CI for the first time, the cross-language format_omics contract
is gone, and the three divergent PMID extractors collapse to one."
```

---

### Task 11: Replace the geocoding stage with ClinicalTrials.gov coordinates

`geocode.R` requests `protocolSection.contactsLocationsModule.locations` and
discards the `geoPoint` it already contains, then re-derives the same city-level
point from Nominatim at 1.1 s per unique location. Both sources are city-level —
verified: all four New York facilities share one coordinate — so **the jitter
must stay**, but Nominatim goes entirely.

**Files:**

- Create: `pipeline/export/geocode.py`
- Delete: `data-prep/geocode.R`, and the now-empty `data-prep/` directory
- Modify: `deno.json` (the `geocode` task), `.env.example` (drop
  `GEOCODE_CACHE_MAX_AGE_HOURS`)
- Test: `tests/pipeline/export/test_geocode.py`

**Interfaces:**

- Consumes: `pipeline/export/writer.py` (Task 5).
- Produces:
  `jitter_duplicate_coordinates(locations: list[dict[str, Any]], radius: float = 0.003) -> list[dict[str, Any]]`,
  `async def fetch_trial_locations(nct_ids: Sequence[str]) -> list[dict[str, Any]]`,
  `async def run_geocode() -> None`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/export/test_geocode.py
import math

from pipeline.export.geocode import jitter_duplicate_coordinates, parse_study_locations

_STUDY = {
    "protocolSection": {
        "identificationModule": {"nctId": "NCT05755997", "briefTitle": "CADASIL"},
        "statusModule": {"overallStatus": "ACTIVE_NOT_RECRUITING"},
        "contactsLocationsModule": {
            "locations": [
                {
                    "facility": "Motol University Hospital",
                    "city": "Prague",
                    "country": "Czechia",
                    "geoPoint": {"lat": 50.08804, "lon": 14.42076},
                },
                {"facility": "No Coordinates", "city": "Nowhere", "country": "X"},
            ]
        },
    }
}


def test_parse_uses_the_geopoint_the_api_already_returns() -> None:
    locations = parse_study_locations(_STUDY)
    assert len(locations) == 1
    assert locations[0] == {
        "nctId": "NCT05755997",
        "facilityName": "Motol University Hospital",
        "city": "Prague",
        "state": None,
        "country": "Czechia",
        "trialTitle": "CADASIL",
        "status": "ACTIVE_NOT_RECRUITING",
        "lat": 50.08804,
        "lon": 14.42076,
    }


def test_locations_without_coordinates_are_dropped_not_defaulted() -> None:
    assert all(loc["facilityName"] != "No Coordinates" for loc in parse_study_locations(_STUDY))


def test_jitter_fans_out_co_located_sites_deterministically() -> None:
    """CT.gov geoPoints are city-level, so same-city sites arrive identical."""
    same = [
        {"nctId": "A", "lat": 40.71427, "lon": -74.00597},
        {"nctId": "B", "lat": 40.71427, "lon": -74.00597},
        {"nctId": "C", "lat": 40.71427, "lon": -74.00597},
    ]
    out = jitter_duplicate_coordinates([dict(x) for x in same])
    coords = {(round(o["lat"], 6), round(o["lon"], 6)) for o in out}
    assert len(coords) == 3
    for original, moved in zip(same, out, strict=True):
        assert math.isclose(moved["lat"], original["lat"], abs_tol=0.01)
    # Deterministic: no RNG, no seed.
    assert jitter_duplicate_coordinates([dict(x) for x in same]) == out


def test_a_lone_location_is_not_moved() -> None:
    lone = [{"nctId": "A", "lat": 1.0, "lon": 2.0}]
    assert jitter_duplicate_coordinates([dict(x) for x in lone]) == lone
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/export/test_geocode.py -v` Expected: FAIL
with `ModuleNotFoundError`

- [ ] **Step 3: Implement the geocode stage**

```python
# pipeline/export/geocode.py
"""Trial facility locations for the map.

ClinicalTrials.gov returns a geoPoint per location, so no geocoding service
is involved: one request with filter.ids covers every trial. The geoPoint is
computed by the API as GeoPoint(City, State, Country) — city-level, not
facility-level — so co-located facilities arrive with identical coordinates
and still need fanning out. That was true of the Nominatim results too.
"""

import asyncio
import json
import logging
import math
from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

import httpx

from pipeline.config import PROJECT_ROOT
from pipeline.export.writer import write_value

logger = logging.getLogger(__name__)

CTG_STUDIES_URL: Final[str] = "https://clinicaltrials.gov/api/v2/studies"
_FIELDS: Final[str] = ",".join(
    (
        "protocolSection.identificationModule.nctId",
        "protocolSection.identificationModule.briefTitle",
        "protocolSection.statusModule.overallStatus",
        "protocolSection.contactsLocationsModule.locations",
    )
)
_TIMEOUT: Final[httpx.Timeout] = httpx.Timeout(30.0)
JITTER_RADIUS_DEGREES: Final[float] = 0.003


def parse_study_locations(study: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten one study into map-ready location rows."""
    protocol = study.get("protocolSection", {})
    identification = protocol.get("identificationModule", {})
    nct_id = identification.get("nctId")
    title = identification.get("briefTitle")
    status = protocol.get("statusModule", {}).get("overallStatus")

    out: list[dict[str, Any]] = []
    for location in protocol.get("contactsLocationsModule", {}).get("locations", []):
        point = location.get("geoPoint") or {}
        lat, lon = point.get("lat"), point.get("lon")
        # Drop rows without usable coordinates rather than defaulting them:
        # a marker at (0, 0) is worse than no marker.
        if not isinstance(lat, int | float) or not isinstance(lon, int | float):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        out.append(
            {
                "nctId": nct_id,
                "facilityName": location.get("facility"),
                "city": location.get("city"),
                "state": location.get("state"),
                "country": location.get("country"),
                "trialTitle": title,
                "status": status,
                "lat": float(lat),
                "lon": float(lon),
            }
        )
    return out


async def fetch_trial_locations(nct_ids: Sequence[str]) -> list[dict[str, Any]]:
    """Fetch every trial's locations in a single request.

    Fails closed: any HTTP error raises rather than publishing a partial map.
    """
    if not nct_ids:
        return []
    params = {
        "filter.ids": ",".join(nct_ids),
        "fields": _FIELDS,
        "pageSize": str(max(len(nct_ids), 10)),
        "countTotal": "true",
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        response = await client.get(CTG_STUDIES_URL, params=params)
        response.raise_for_status()
        body = response.json()

    studies = body.get("studies", [])
    returned = {
        s.get("protocolSection", {}).get("identificationModule", {}).get("nctId")
        for s in studies
    }
    if missing := [n for n in nct_ids if n not in returned]:
        raise RuntimeError(
            f"ClinicalTrials.gov returned no record for: {', '.join(missing)}; "
            "the previous geocode output was not replaced"
        )
    return [row for study in studies for row in parse_study_locations(study)]


def jitter_duplicate_coordinates(
    locations: list[dict[str, Any]], radius: float = JITTER_RADIUS_DEGREES
) -> list[dict[str, Any]]:
    """Fan co-located markers around a circle so each stays clickable.

    Deterministic by construction — position in the group sets the angle.
    No RNG, so regenerating produces byte-identical output.
    """
    groups: dict[tuple[float, float], list[dict[str, Any]]] = defaultdict(list)
    for location in locations:
        groups[(location["lat"], location["lon"])].append(location)

    for (lat, lon), group in groups.items():
        if len(group) < 2:
            continue
        for index, location in enumerate(group):
            angle = 2 * math.pi * index / len(group)
            location["lat"] = round(lat + radius * math.sin(angle), 6)
            location["lon"] = round(lon + radius * math.cos(angle), 6)
    return locations


async def run_geocode(target_dir: Path | None = None) -> None:
    """Regenerate data/geocoded_trials.json from the trials table."""
    target = target_dir or PROJECT_ROOT / "data"
    trials = json.loads((target / "table2.json").read_text(encoding="utf-8"))
    nct_ids = sorted(
        {
            registry.upper()
            for trial in trials
            if (registry := str(trial.get("registryId", "")).strip())
            and registry.upper().startswith("NCT")
            and len(registry) == 11
            and registry[3:].isdigit()
        }
    )
    logger.info("Fetching locations for %d trials in one request", len(nct_ids))
    locations = jitter_duplicate_coordinates(await fetch_trial_locations(nct_ids))
    write_value(
        {
            "nctIds": nct_ids,
            "generatedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "locations": locations,
        },
        target / "geocoded_trials.json",
    )
    logger.info("Wrote %d locations", len(locations))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    asyncio.run(run_geocode())


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/export/test_geocode.py -v` Expected: PASS (4
tests)

- [ ] **Step 5: Compare the new coordinates against the committed ones before
      deleting R**

```bash
cp data/geocoded_trials.json /tmp/geocoded-before.json
uv run python -m pipeline.export.geocode
uv run python - <<'PY'
import json
before = {(l["nctId"], l["facilityName"]): (l["lat"], l["lon"])
          for l in json.load(open("/tmp/geocoded-before.json"))["locations"]}
after = {(l["nctId"], l["facilityName"]): (l["lat"], l["lon"])
         for l in json.load(open("data/geocoded_trials.json"))["locations"]}
print(f"before={len(before)} after={len(after)}")
print("missing:", sorted(set(before) - set(after))[:5])
print("new:", sorted(set(after) - set(before))[:5])
moved = {k: (before[k], after[k]) for k in before & after
         if abs(before[k][0]-after[k][0]) > 0.05 or abs(before[k][1]-after[k][1]) > 0.05}
print(f"moved >0.05deg: {len(moved)}")
for k, v in list(moved.items())[:10]:
    print(" ", k, v)
PY
```

Expected: the same site count, and deltas at city scale. **Any site moving to a
different city is a bug — investigate before continuing.**

- [ ] **Step 6: Delete the R layer and rewire the task**

```bash
git rm data-prep/geocode.R
rmdir data-prep 2>/dev/null || true
```

In `deno.json`:

```json
"geocode": "uv run python -m pipeline.export.geocode",
```

In `.env.example`, delete the `GEOCODE_CACHE_MAX_AGE_HOURS` line and its comment
— there is no cache to age out when the whole stage is one request.

- [ ] **Step 7: Run the full verification**

Run: `deno task test && deno task test:e2e && uv run pytest -q` Expected: PASS.
The map spec's date assertion is a pattern after Task 2, so a fresh
`generatedAt` no longer fails it.

- [ ] **Step 8: Update the docs**

In `README.md` and `CLAUDE.md`: delete the Nominatim and geocode-cache
paragraphs, remove `data-prep/` from the layout tree and the architecture
diagram, and drop the R dependency install instructions. Replace the pipeline
diagram with:

```text
PostgreSQL ──> pipeline/export/ ──> data/*.json ──> Fresh islands
```

Add one line: _"Facility coordinates come from ClinicalTrials.gov's `geoPoint`,
which is city-level; `jitter_duplicate_coordinates()` fans out co-located sites
so each stays clickable."_

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Replace the Nominatim geocoding round-trip with CT.gov coordinates

geocode.R already fetched the object containing geoPoint and discarded it,
then re-derived the same city-level point from Nominatim at 1.1s per
location. filter.ids fetches every trial in one request. The jitter stays:
both sources are city-level, so co-located facilities still collapse.

Deletes the last R in the project."
```

---

# Phase 3 — Modernize the extraction path

Ships independently of Phase 2. Each task is separately valuable.

---

### Task 12: Add Europe PMC as the primary full-text source

Europe PMC has full text for ~85% of this corpus as JATS XML with real table
markup — free, no key. It goes _before_ PMC and Unpaywall in the cascade.

**Files:**

- Create: `pipeline/europepmc.py`
- Modify: `pipeline/pdf_retrieval.py:207-240` (the `get_fulltext` cascade and
  `FulltextResult`)
- Test: `tests/pipeline/test_europepmc.py`

**Interfaces:**

- Consumes: `pipeline.http_client.AsyncHttpClientManager`.
- Produces: `async def fetch_europepmc_fulltext(pmid: str) -> str | None`,
  `parse_jats(content: bytes) -> str | None` from `pipeline/europepmc.py`.
  Extends `FulltextResult["source"]` with `"europepmc"`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/test_europepmc.py
from pipeline.europepmc import parse_jats

_JATS = b"""<?xml version="1.0"?>
<article><body>
<sec><title>Results</title><p>NOTCH3 was associated with WMH.</p></sec>
<sec><title>Methods</title><p>We genotyped 500 samples.</p></sec>
<table-wrap><table><thead><tr><th>Gene</th><th>P</th></tr></thead>
<tbody><tr><td>HTRA1</td><td>1e-8</td></tr></tbody></table></table-wrap>
</body></article>"""


def test_parse_jats_keeps_section_prose() -> None:
    text = parse_jats(_JATS)
    assert text is not None
    assert "NOTCH3 was associated with WMH." in text
    assert "We genotyped 500 samples." in text


def test_parse_jats_preserves_table_cell_content() -> None:
    """Association tables are where the gene-trait evidence lives."""
    text = parse_jats(_JATS)
    assert text is not None
    assert "HTRA1" in text
    assert "1e-8" in text


def test_parse_jats_returns_none_for_a_body_less_document() -> None:
    assert parse_jats(b"<article><front/></article>") is None


def test_parse_jats_returns_none_for_malformed_xml() -> None:
    assert parse_jats(b"not xml at all") is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/test_europepmc.py -v` Expected: FAIL with
`ModuleNotFoundError: No module named 'pipeline.europepmc'`

- [ ] **Step 3: Implement the client**

```python
# pipeline/europepmc.py
"""Europe PMC full-text retrieval.

Europe PMC serves JATS XML for the large majority of open-access biomedical
literature with no key and no rate-limit registration. Unlike a PDF text
dump it preserves table structure, which is where gene-trait associations
live, and it never interleaves two-column layouts.
"""

import logging
from typing import Final

import httpx
from lxml import etree

from pipeline.http_client import AsyncHttpClientManager

logger = logging.getLogger(__name__)

SEARCH_URL: Final[str] = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
FULLTEXT_URL: Final[str] = (
    "https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
)
_TIMEOUT: Final[httpx.Timeout] = httpx.Timeout(30.0, connect=10.0)

_client_manager = AsyncHttpClientManager(timeout=_TIMEOUT, follow_redirects=True)


async def close_http_client() -> None:
    """Close the shared client (call at shutdown)."""
    await _client_manager.close()


def parse_jats(content: bytes) -> str | None:
    """Extract readable text from a JATS document, tables included."""
    try:
        root = etree.fromstring(content)  # noqa: S320 — trusted EBI endpoint
    except etree.XMLSyntaxError:
        logger.debug("Europe PMC returned malformed XML")
        return None

    body = root.find(".//body")
    if body is None:
        return None

    blocks: list[str] = []
    for element in body.iter("p", "title", "th", "td"):
        text = " ".join(element.itertext()).strip()
        if text:
            blocks.append(text)
    joined = "\n".join(blocks).strip()
    return joined or None


async def _resolve_pmcid(pmid: str) -> str | None:
    """Find the PMCID for a PMID, and whether full text is available."""
    client = await _client_manager.get()
    response = await client.get(
        SEARCH_URL,
        params={
            "query": f"EXT_ID:{pmid} AND SRC:MED",
            "resultType": "core",
            "format": "json",
            "pageSize": "1",
        },
    )
    response.raise_for_status()
    results = response.json().get("resultList", {}).get("result", [])
    if not results:
        return None
    record = results[0]
    if record.get("inEPMC") != "Y":
        return None
    return record.get("pmcid")


async def fetch_europepmc_fulltext(pmid: str) -> str | None:
    """Return Europe PMC full text for a PMID, or None if unavailable."""
    try:
        pmcid = await _resolve_pmcid(pmid)
        if not pmcid:
            return None
        client = await _client_manager.get()
        response = await client.get(FULLTEXT_URL.format(pmcid=pmcid))
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return parse_jats(response.content)
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        logger.warning("Europe PMC lookup failed for PMID %s: %s", pmid, exc)
        return None
```

- [ ] **Step 4: Insert it at the head of the cascade**

In `pipeline/pdf_retrieval.py`, widen the result type and add the first branch:

```python
class FulltextResult(TypedDict):
    """Result from fulltext retrieval attempt."""

    text: str | None
    source: Literal["europepmc", "pmc", "unpaywall", "abstract"]
    fulltext: bool
```

```python
async def get_fulltext(pmid: str, doi: str | None) -> FulltextResult:
    """Attempt full-text retrieval from multiple sources.

    Order: Europe PMC (JATS XML, tables preserved) -> PMC -> Unpaywall PDF
    -> abstract. Europe PMC leads because it is the only source that keeps
    table structure, and it covers ~85% of this corpus.
    """
    pmid = validate_pmid(pmid)

    if epmc_text := await fetch_europepmc_fulltext(pmid):
        return {"text": epmc_text, "source": "europepmc", "fulltext": True}

    if pmc_text := await fetch_pmc_fulltext(pmid):
        return {"text": pmc_text, "source": "pmc", "fulltext": True}

    if doi:
        try:
            doi = _validate_doi(doi)
            if (oa_url := await check_unpaywall(doi)) and (
                pdf_text := await download_and_parse_pdf(oa_url)
            ):
                return {"text": pdf_text, "source": "unpaywall", "fulltext": True}
        except ValueError:
            logger.debug(f"Invalid DOI format for PMID {pmid}: {doi}")

    abstract = await fetch_abstract(pmid)
    return {"text": abstract, "source": "abstract", "fulltext": False}
```

The Unpaywall and abstract branches are unchanged from the current
implementation — reproduced here in full so the function can be written in one
pass rather than diffed against memory.

Add `from pipeline.europepmc import fetch_europepmc_fulltext` to the imports,
and call `europepmc.close_http_client()` alongside the other shutdown calls in
`pipeline/main.py`.

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/pipeline -q && uv run ruff check . && uv run ty check`
Expected: PASS. Update any `test_pdf_retrieval.py` cascade test that asserts PMC
is tried first — it must now assert Europe PMC is.

- [ ] **Step 6: Commit**

```bash
git add pipeline/europepmc.py pipeline/pdf_retrieval.py pipeline/main.py tests/pipeline/
git commit -m "Add Europe PMC as the primary full-text source

JATS XML with real table markup, free and keyless, covering ~85% of this
corpus. Demotes PDF retrieval to a fallback for the remainder."
```

---

### Task 13: Replace PyMuPDF text extraction with Docling

For the PDF remainder, `page.get_text()` scores 0.17 end-to-end table F1 against
Docling's 0.69. Worse, in two-column layouts it manufactures false adjacency by
interleaving columns — the exact signal used to bind a gene to a trait — and
fuses reference superscripts onto tokens (`COL4A1` + ref 12 → `COL4A112`).
Docling is MIT; PyMuPDF is AGPL v3, so this also removes a licence encumbrance.

**Files:**

- Create: `pipeline/pdf_parse.py`
- Modify: `pipeline/pdf_retrieval.py` (replace `_extract_and_close_pdf`,
  `_extract_clean_pdf_text`, `parse_local_pdf`), `pyproject.toml`
- Test: `tests/pipeline/test_pdf_parse.py`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `parse_pdf_bytes(data: bytes) -> str | None`,
  `parse_pdf_file(path: Path) -> str | None` from `pipeline/pdf_parse.py`.

- [ ] **Step 1: Add the dependency**

```bash
uv add docling
uv remove pymupdf
```

Confirm `pymupdf` no longer appears:
`grep -rn "fitz\|pymupdf" pipeline/ pyproject.toml`

- [ ] **Step 2: Write the failing tests**

```python
# tests/pipeline/test_pdf_parse.py
from pathlib import Path
from unittest.mock import MagicMock, patch

from pipeline.pdf_parse import parse_pdf_bytes


def test_tables_are_exported_as_html_not_markdown() -> None:
    """GWAS tables have merged two-row headers that pipe tables flatten."""
    doc = MagicMock()
    doc.export_to_html.return_value = "<table><tr><td>HTRA1</td></tr></table>"
    with patch("pipeline.pdf_parse._convert", return_value=doc):
        text = parse_pdf_bytes(b"%PDF-1.7 fake")
    assert text is not None
    assert "HTRA1" in text
    doc.export_to_html.assert_called_once()


def test_a_conversion_failure_returns_none_rather_than_raising() -> None:
    with patch("pipeline.pdf_parse._convert", side_effect=RuntimeError("boom")):
        assert parse_pdf_bytes(b"%PDF-1.7 fake") is None


def test_empty_output_is_none() -> None:
    doc = MagicMock()
    doc.export_to_html.return_value = "   "
    with patch("pipeline.pdf_parse._convert", return_value=doc):
        assert parse_pdf_bytes(b"%PDF-1.7 fake") is None
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/test_pdf_parse.py -v` Expected: FAIL with
`ModuleNotFoundError: No module named 'pipeline.pdf_parse'`

- [ ] **Step 4: Implement the parser**

```python
# pipeline/pdf_parse.py
"""PDF text extraction for the retrieval fallback.

Docling rather than a raw text dump: on scientific papers a plain
page.get_text() loses all table structure, interleaves two-column layouts
into false adjacency, and fuses reference superscripts onto tokens
("COL4A1" + ref 12 -> "COL4A112") — poison when the extracted output *is*
gene symbols. OCR is disabled: open-access PDFs are born-digital, and
skipping it roughly halves runtime.
"""

import io
import logging
import tempfile
from functools import cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@cache
def _converter() -> Any:
    """Build the Docling converter once; model loading is expensive."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = False
    options.do_table_structure = True
    options.table_structure_options.do_cell_matching = True
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )


def _convert(data: bytes) -> Any:
    """Run Docling over PDF bytes, returning its document object."""
    from docling.datamodel.base_models import DocumentStream

    stream = DocumentStream(name="paper.pdf", stream=io.BytesIO(data))
    return _converter().convert(stream).document


def parse_pdf_bytes(data: bytes) -> str | None:
    """Extract text from PDF bytes, preserving table structure.

    Tables are exported as HTML, not Markdown: GWAS association tables
    routinely carry merged two-row headers that pipe tables silently
    flatten, losing which column a p-value belongs to.
    """
    try:
        document = _convert(data)
        text = document.export_to_html()
    except Exception as exc:  # noqa: BLE001 — a bad PDF must not kill the run
        logger.warning("Docling could not parse the PDF: %s", exc)
        return None
    return text.strip() or None


def parse_pdf_file(path: Path) -> str | None:
    """Extract text from a PDF on disk."""
    try:
        return parse_pdf_bytes(path.read_bytes())
    except OSError as exc:
        logger.warning("Could not read %s: %s", path, exc)
        return None


def _write_temp_pdf(data: bytes) -> Path:
    """Persist PDF bytes for tooling that needs a real path."""
    handle = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    with handle:
        handle.write(data)
    return Path(handle.name)
```

- [ ] **Step 5: Rewire `pdf_retrieval.py`**

Delete `_extract_and_close_pdf`, `_extract_clean_pdf_text`, `_PDF_TOP_MARGIN`,
`_PDF_BOTTOM_MARGIN` and the `fitz` import. Keep `_BACK_MATTER_PATTERN` and
apply it to Docling's output — truncating at the References section still
matters, because bibliography gene names would otherwise be extracted as
findings.

```python
from pipeline.pdf_parse import parse_pdf_bytes, parse_pdf_file


def _truncate_back_matter(text: str) -> str:
    """Cut the bibliography so its gene names are not read as findings.

    Only matches in the latter half of the document: a paper that mentions
    "Methods" in its abstract must not be truncated at the abstract.
    """
    midpoint = len(text) // 2
    match = _BACK_MATTER_PATTERN.search(text, midpoint)
    return text[: match.start()] if match else text


async def download_and_parse_pdf(url: str) -> str | None:
    """Download a PDF and extract its text."""
    # ... existing download, size-cap and magic-byte checks unchanged ...
    if (data := await _read_pdf_bytes(response, url)) is None:
        return None
    if (text := parse_pdf_bytes(data)) is None:
        return None
    return _truncate_back_matter(text)


def parse_local_pdf(path: Path) -> str | None:
    """Extract text from a PDF on disk (used by the --pdf run mode)."""
    if (text := parse_pdf_file(path)) is None:
        return None
    return _truncate_back_matter(text)
```

- [ ] **Step 6: Run the tests**

Run: `uv run pytest tests/pipeline -q && uv run ruff check . && uv run ty check`
Expected: PASS. Tests in `test_pdf_retrieval.py` that patch `fitz` need
repointing at `pipeline.pdf_parse.parse_pdf_bytes`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Replace PyMuPDF text extraction with Docling

0.17 -> 0.69 end-to-end table F1 on scientific papers. PyMuPDF's get_text()
interleaves two-column layouts into false adjacency and fuses reference
superscripts onto gene symbols. Also removes an AGPL dependency."
```

---

### Task 14: Record extraction provenance in the schema

The Citations API cannot be combined with structured outputs — enabling both
returns a 400 — so the schema itself has to carry the evidence. A required
`source_quote` per gene makes a public scientific dashboard defensible, and
gives the golden-file suite something to check beyond the symbol.

**Files:**

- Modify: `pipeline/extraction_models.py`, `pipeline/prompts.py` (v6),
  `pipeline/config.py` (default `prompt_version`), `pipeline/data_merger.py`,
  `pipeline/alembic/versions/` (new migration)
- Test: `tests/pipeline/test_extraction_models.py`,
  `tests/pipeline/test_prompts.py`

**Interfaces:**

- Consumes: `GeneEntry` (Task 4).
- Produces: `GeneEntry.source_quote: str`, and a `genes.source_quote` column.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/test_extraction_models.py
import pytest
from pydantic import ValidationError

from pipeline.extraction_models import GeneEntry


def test_source_quote_is_required() -> None:
    with pytest.raises(ValidationError, match="source_quote"):
        GeneEntry(gene_symbol="NOTCH3", confidence=0.9)


def test_source_quote_must_not_be_blank() -> None:
    with pytest.raises(ValidationError):
        GeneEntry(gene_symbol="NOTCH3", confidence=0.9, source_quote="   ")


def test_a_quoted_entry_validates() -> None:
    entry = GeneEntry(
        gene_symbol="NOTCH3",
        confidence=0.9,
        source_quote="NOTCH3 variants were associated with WMH (p=1e-12).",
    )
    assert entry.source_quote.startswith("NOTCH3 variants")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/test_extraction_models.py -k source_quote -v`
Expected: FAIL — `GeneEntry` accepts the construction without a quote.

- [ ] **Step 3: Add the field**

In `pipeline/extraction_models.py`:

```python
class GeneEntry(BaseModel):
    """Extracted gene entry from paper analysis."""

    model_config = ConfigDict(
        str_strip_whitespace=True,
        validate_default=True,
    )

    gene_symbol: str
    protein_name: str | None = None
    gwas_trait: list[str] = Field(default_factory=list)
    mendelian_randomization: bool = False
    omics_evidence: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    causal_evidence_summary: str | None = None
    pmid: str = ""
    # Verbatim sentence from the paper supporting this entry. Required: the
    # Citations API cannot be combined with structured outputs (400), so
    # provenance has to travel inside the schema.
    source_quote: str = Field(min_length=1)
```

Note `min_length` is enforced by Pydantic after parsing, not by the API schema —
the API rejects `minLength` in its JSON-schema subset. That is the intended
split: the API constrains shape, Pydantic constrains content.

- [ ] **Step 4: Add prompt version v6**

In `pipeline/prompts.py`, copy `_SYSTEM_PROMPT_V5`/`_EXTRACTION_INSTRUCTIONS_V5`
to `_V6` and append to the instructions:

```python
_EXTRACTION_INSTRUCTIONS_V6: Final[str] = _EXTRACTION_INSTRUCTIONS_V5 + """

## Provenance

For every gene you report, set `source_quote` to a single verbatim sentence
copied from the paper that supports the association. Copy it exactly — do
not paraphrase, summarise, or stitch two sentences together. If no single
sentence supports the entry, do not report the gene.
"""
```

Register it and make it the default:

```python
_PROMPTS[...] = {..., "v6": (_SYSTEM_PROMPT_V6, _EXTRACTION_INSTRUCTIONS_V6)}
```

```python
# pipeline/config.py
    prompt_version: str = field(
        default_factory=lambda: _env_str("PIPELINE_PROMPT_VERSION", "v6")
    )
```

- [ ] **Step 5: Add the migration and persist the column**

Create `pipeline/alembic/versions/004_add_source_quote.py`:

```python
"""Add source_quote to genes.

Revision ID: 004
Revises: 003
"""

from alembic import op

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE genes ADD COLUMN IF NOT EXISTS source_quote TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE genes DROP COLUMN IF EXISTS source_quote")
```

In `pipeline/data_merger.py`, carry `source_quote` through into the assembled
gene row alongside `causal_evidence_summary`, using the same
first-occurrence-wins rule the other single-valued columns use.

- [ ] **Step 6: Run the tests**

Run: `uv run pytest tests/pipeline -q && uv run ruff check . && uv run ty check`
Expected: PASS. Every existing `GeneEntry(...)` construction in the tests now
needs a `source_quote` — add a realistic one rather than an empty string.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Require a verbatim source quote per extracted gene

Citations and structured outputs cannot be combined (400), so provenance
travels in the schema instead. Adds prompt v6 and the genes.source_quote
column."
```

---

### Task 15: Add a Batch API submission path

The pipeline is offline and manual, so latency is free to give away for a 50%
discount. Batch runs alongside the streaming path rather than replacing it —
streaming stays the default for single-paper and `--pdf` runs.

**Files:**

- Create: `pipeline/batch_extraction.py`
- Modify: `pipeline/main.py` (add `--batch`), `pipeline/config.py`
- Test: `tests/pipeline/test_batch_extraction.py`

**Interfaces:**

- Consumes: `build_extraction_prompt` (prompts), `parse_extraction_response`,
  `GeneEntry` (Task 4/14).
- Produces:
  `build_batch_request(pmid: str, text: str, config: PipelineConfig) -> dict[str, Any]`,
  `async def submit_and_collect(papers: dict[str, str], config: PipelineConfig) -> dict[str, list[GeneEntry]]`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/pipeline/test_batch_extraction.py
from pipeline.batch_extraction import build_batch_request, results_by_custom_id
from pipeline.config import PipelineConfig


def test_custom_id_is_the_pmid() -> None:
    request = build_batch_request("37063705", "paper text", PipelineConfig())
    assert request["custom_id"] == "37063705"


def test_batch_requests_carry_the_1h_cache_ttl() -> None:
    """The 5-minute default would expire mid-batch."""
    request = build_batch_request("37063705", "paper text", PipelineConfig())
    system = request["params"]["system"]
    assert all(b["cache_control"]["ttl"] == "1h" for b in system)


def test_results_are_keyed_by_custom_id_not_position() -> None:
    """Batch results arrive in any order."""

    class _Result:
        def __init__(self, custom_id: str, text: str) -> None:
            self.custom_id = custom_id
            self.result = type(
                "R",
                (),
                {
                    "type": "succeeded",
                    "message": type(
                        "M", (), {"content": [type("B", (), {"type": "text", "text": text})()]}
                    )(),
                },
            )()

    out = results_by_custom_id(
        [_Result("B", '{"genes": []}'), _Result("A", '{"genes": []}')]
    )
    assert set(out) == {"A", "B"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/test_batch_extraction.py -v` Expected: FAIL
with `ModuleNotFoundError`

- [ ] **Step 3: Implement the batch path**

```python
# pipeline/batch_extraction.py
"""Batch API submission for gene extraction.

Half the price of the streaming path, and this pipeline is offline and
manual so the latency costs nothing. Caching uses the 1-hour TTL: the
5-minute default would expire partway through a batch.
"""

import asyncio
import logging
from typing import Any

import anthropic

from pipeline.config import PipelineConfig, supports_effort, uses_adaptive_thinking
from pipeline.extraction_models import GeneEntry, parse_extraction_response
from pipeline.prompts import build_extraction_prompt

logger = logging.getLogger(__name__)

_POLL_SECONDS = 30


def build_batch_request(
    pmid: str, text: str, config: PipelineConfig
) -> dict[str, Any]:
    """Build one batch request. custom_id is the PMID."""
    prompt = build_extraction_prompt(
        paper_text=text,
        pmid=pmid,
        max_chars=config.max_paper_text_chars,
        prompt_version=config.prompt_version,
    )
    thinking: dict[str, Any] = (
        {"type": "adaptive", "display": "summarized"}
        if uses_adaptive_thinking(config.llm_model)
        else {"type": "enabled", "budget_tokens": config.llm_max_tokens // 2}
    )
    output_config: dict[str, Any] = {"format": config.extraction_schema}
    if supports_effort(config.llm_model) and config.llm_effort != "high":
        output_config["effort"] = config.llm_effort

    return {
        "custom_id": pmid,
        "params": {
            "model": config.llm_model,
            "max_tokens": config.llm_max_tokens,
            "system": [
                {
                    "type": "text",
                    "text": prompt.system_prompt,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                },
                {
                    "type": "text",
                    "text": prompt.extraction_instructions,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                },
            ],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": prompt.user_text}]}
            ],
            "thinking": thinking,
            "output_config": output_config,
        },
    }


def results_by_custom_id(results: Any) -> dict[str, list[GeneEntry]]:
    """Key results by custom_id — batch results arrive in any order."""
    out: dict[str, list[GeneEntry]] = {}
    for entry in results:
        if entry.result.type != "succeeded":
            logger.warning("Batch entry %s: %s", entry.custom_id, entry.result.type)
            continue
        text = "".join(
            block.text
            for block in entry.result.message.content
            if block.type == "text"
        )
        try:
            parsed = parse_extraction_response(text)
        except Exception as exc:  # noqa: BLE001 — one bad row must not kill the batch
            logger.warning("Could not parse batch entry %s: %s", entry.custom_id, exc)
            continue
        for gene in parsed.genes:
            gene.pmid = entry.custom_id
        out[entry.custom_id] = parsed.genes
    return out


async def submit_and_collect(
    papers: dict[str, str], config: PipelineConfig
) -> dict[str, list[GeneEntry]]:
    """Submit every paper as one batch and poll until it ends."""
    client = anthropic.AsyncAnthropic()
    try:
        batch = await client.messages.batches.create(
            requests=[build_batch_request(p, t, config) for p, t in papers.items()]
        )
        logger.info("Submitted batch %s (%d papers)", batch.id, len(papers))
        while True:
            current = await client.messages.batches.retrieve(batch.id)
            if current.processing_status == "ended":
                break
            logger.info("Batch %s: %s", batch.id, current.processing_status)
            await asyncio.sleep(_POLL_SECONDS)
        return results_by_custom_id(
            [r async for r in await client.messages.batches.results(batch.id)]
        )
    finally:
        await client.close()
```

Add `extraction_schema` to `PipelineConfig` as a cached property returning the
same JSON schema `_build_stream_kwargs` uses, so both paths share one definition
(changing the schema invalidates the prompt cache, so it must not drift between
them).

- [ ] **Step 4: Wire the CLI flag**

In `pipeline/main.py`, add `--batch` to the parser and route `run_pipeline`
through `submit_and_collect` when set, keeping the streaming path as the
default. Document it in `README.md`:

```markdown
`--batch` submits every paper in one Batch API request at half price. Results
usually arrive within an hour. Use it for a full corpus run; the default
streaming path stays better for single papers and `--pdf` runs.
```

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/pipeline -q && uv run ruff check . && uv run ty check`
Expected: PASS (3 new tests)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add a Batch API extraction path

Half price, and an offline manual pipeline can spend the latency. Results
are keyed by custom_id because batch results arrive in any order."
```

---

### Task 16: Add the extraction regression suite

Replaces the deleted validation harness with something proportionate: golden
files, VCR cassettes so CI needs no API key, per-field set comparison folded the
same way `lib/filters.ts` folds.

**Files:**

- Create: `tests/pipeline/golden/__init__.py` is **not** created (matching
  convention); `tests/pipeline/test_extraction_golden.py`,
  `tests/pipeline/cassettes/.gitkeep`
- Modify: `pyproject.toml` (add `pytest-recording`, a `live` marker),
  `.github/workflows/ci.yml`
- Uses: `data/test_data/gold_standard/gold_standard_v2.csv` (retained in Task 3)

**Interfaces:**

- Consumes: `extract_from_paper` (Task 4), `GeneEntry.source_quote` (Task 14).
- Produces: `normalize_symbol(value: str) -> str`,
  `field_set_f1(expected: set[str], actual: set[str]) -> float`.

- [ ] **Step 1: Add the test dependency and marker**

```bash
uv add --group dev pytest-recording
```

```toml
[tool.pytest.ini_options]
markers = [
    "slow: marks tests as slow",
    "integration: marks integration tests",
    "live: hits the real Anthropic API; requires ANTHROPIC_API_KEY",
]
```

- [ ] **Step 2: Write the failing tests**

```python
# tests/pipeline/test_extraction_golden.py
"""Regression suite for LLM extraction.

Scored as per-field set F1 against a golden file, never equality: the model
is nondeterministic, so an equality assertion would flake. Cassettes let CI
run without an API key; `-m live` re-records against the real API.
"""

import csv
from pathlib import Path

import pytest

from pipeline.config import PipelineConfig
from pipeline.llm_extraction import extract_from_paper

GOLD = Path("data/test_data/gold_standard/gold_standard_v2.csv")
MIN_F1 = 0.80


def normalize_symbol(value: str) -> str:
    """Fold case and whitespace, matching lib/filters.ts.

    Without this the suite measures whitespace rather than extraction.
    """
    return " ".join(value.split()).casefold()


def field_set_f1(expected: set[str], actual: set[str]) -> float:
    """F1 over two sets. Two empty sets score 1.0."""
    if not expected and not actual:
        return 1.0
    overlap = len(expected & actual)
    if overlap == 0:
        return 0.0
    precision = overlap / len(actual)
    recall = overlap / len(expected)
    return 2 * precision * recall / (precision + recall)


def test_f1_is_1_for_two_empty_sets() -> None:
    assert field_set_f1(set(), set()) == 1.0


def test_f1_is_0_when_nothing_overlaps() -> None:
    assert field_set_f1({"a"}, {"b"}) == 0.0


def test_normalize_symbol_folds_case_and_whitespace() -> None:
    assert normalize_symbol("  PSMD ") == normalize_symbol("psmd")


def _gold_rows() -> list[dict[str, str]]:
    with GOLD.open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


@pytest.mark.vcr
@pytest.mark.parametrize("pmid", sorted({r["pmid"] for r in _gold_rows()})[:10])
async def test_extraction_recovers_the_golden_genes(pmid: str) -> None:
    """Set-F1 against the golden symbols, never equality."""
    rows = [r for r in _gold_rows() if r["pmid"] == pmid]
    expected = {normalize_symbol(r["gene_symbol"]) for r in rows}
    text = Path(f"tests/pipeline/fixtures/papers/{pmid}.txt").read_text(
        encoding="utf-8"
    )
    genes, _ = await extract_from_paper(text, pmid, PipelineConfig())
    actual = {normalize_symbol(g.gene_symbol) for g in genes}
    score = field_set_f1(expected, actual)
    assert score >= MIN_F1, f"PMID {pmid}: F1 {score:.2f} < {MIN_F1} (got {actual})"


@pytest.mark.vcr
async def test_every_extracted_gene_carries_a_source_quote() -> None:
    """Provenance is required; an empty quote must never reach the database."""
    pmid = sorted({r["pmid"] for r in _gold_rows()})[0]
    text = Path(f"tests/pipeline/fixtures/papers/{pmid}.txt").read_text(
        encoding="utf-8"
    )
    genes, _ = await extract_from_paper(text, pmid, PipelineConfig())
    assert genes, "expected at least one gene"
    for gene in genes:
        assert gene.source_quote.strip()
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/pipeline/test_extraction_golden.py -v` Expected: the
three pure-function tests PASS; the VCR tests FAIL on missing cassettes and
missing paper fixtures.

- [ ] **Step 4: Record the cassettes and commit the paper fixtures**

Create `tests/pipeline/fixtures/papers/<PMID>.txt` for the ten PMIDs by running
the retrieval stage against each and saving the extracted text. Then record
once, with a key present:

```bash
ANTHROPIC_API_KEY=... uv run pytest tests/pipeline/test_extraction_golden.py \
  --record-mode=once
```

Add a `conftest.py` scrubber so no key is committed:

```python
# tests/pipeline/conftest.py — append
@pytest.fixture(scope="module")
def vcr_config() -> dict[str, object]:
    """Never let an API key reach a committed cassette."""
    return {
        "filter_headers": [("x-api-key", "REDACTED"), ("authorization", "REDACTED")],
        "record_mode": "none",
    }
```

Inspect the cassettes for secrets before committing:

```bash
grep -riE "sk-ant|api[_-]?key" tests/pipeline/cassettes/ && echo "SECRET FOUND — do not commit"
```

- [ ] **Step 5: Run the suite offline to prove CI needs no key**

Run:
`env -u ANTHROPIC_API_KEY uv run pytest tests/pipeline/test_extraction_golden.py -v`
Expected: PASS, replaying from cassettes.

- [ ] **Step 6: Commit**

```bash
git add tests/pipeline/test_extraction_golden.py tests/pipeline/cassettes \
        tests/pipeline/fixtures/papers pyproject.toml uv.lock
git commit -m "Add a golden-file extraction regression suite

Per-field set F1 against the retained gold standard, never equality — the
model is nondeterministic. VCR cassettes let CI run without an API key."
```

---

### Task 17: Update CI and close out the documentation

**Files:**

- Modify: `.github/workflows/ci.yml`, `CLAUDE.md`, `README.md`
- Create: `docs/superpowers/specs/2026-08-29-pipeline-teardown.md` (Markdown
  copy of the published report)

- [ ] **Step 1: Add the export to CI**

The export is now Python and testable, so it belongs in the `python` job. Append
to that job:

```yaml
- name: Export unit tests
  run: uv run pytest tests/pipeline/export -q
```

No database is needed — every export test uses fixtures.

- [ ] **Step 2: Rewrite the architecture section of `CLAUDE.md`**

Replace the two-layer description with:

````markdown
## Architecture

One pipeline, one language, meeting the web app at a JSON file boundary.

```text
PubMed / Europe PMC / CT.gov ──> pipeline/ ──> PostgreSQL ──> pipeline/export/ ──> data/*.json ──> islands
```
````

**Nothing queries a database at request time, and nothing fetches JSON at
runtime.** `lib/data.ts` uses `import … with { type: "json" }`.

- Editing `data/*.json` requires a rebuild/HMR cycle to show up.
- `tests/data_contract_test.ts` asserts against the real committed rows, and is
  the guardrail that proved the R-to-Python export port faithful. Keep it.
- The export is covered by `tests/pipeline/export/` and runs in CI.
- Facility coordinates come from ClinicalTrials.gov's `geoPoint`, which is
  computed as `GeoPoint(City, State, Country)` — city-level, not facility-level.
  `jitter_duplicate_coordinates()` fans out co-located sites. No geocoding
  service is involved.

````
Delete the "Known data limitation" section's reference to R, the JSON-contract section's `to_camel`/`export.R` row (replace with `pipeline/export/writer.py`), and every mention of `data-prep/`.

- [ ] **Step 3: Verify the whole repo**

Run:
```bash
uv run pytest -q && uv run ruff check . && uv run ty check
deno task check && deno task test && deno task test:e2e
````

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Run the export tests in CI and update the architecture docs

The export layer is Python and covered by tests for the first time, so
CLAUDE.md's 'the R layer is never exercised by CI' caveat no longer applies."
```

---

## Self-review

**Spec coverage.** All nine recommendations map to tasks: 01 → Task 11; 02 →
Tasks 5–10; 03 → Task 1; 04 → Tasks 12–13; 05 → Task 4; 06 → Task 14; 07 → Task
15; 08 → Task 16; 09 → Global Constraints (a decision not to act needs no task).
The removal set → Task 3; the e2e prerequisite → Task 2; CI and docs → Task 17.

**Deviation from the report, flagged.** The report named DuckDB as the export
engine. Reading the actual cleaning rules changed that: the omics chain,
`extract_pmids_or`'s marker pass and the Mac Roman decode all have to run in
Python, so `Postgres → DuckDB → Python → JSON` would add a dependency and a hop
to save a `json.dumps` on 103 KB. Phase 2 reuses the existing asyncpg pool and
adds no dependency. The port itself — the recommendation that mattered — is
unchanged.

**Ordering constraints.** Task 2 must precede Task 11 (the map's date
assertion). Task 1 must precede Task 4 (it renames the config helpers the
collapsed client imports). Task 4 must precede Tasks 14–16. Task 3 must precede
Task 17's `pyproject.toml` cleanup. Phases 2 and 3 are otherwise independent.

**Risk concentrated in one step.** Task 10 Step 8 is the moment of truth:
`git diff --stat data/` after running the new export must show no unexplained
change. `tests/data_contract_test.ts` is the cross-language proof, which is why
the plan keeps it untouched throughout.
