# LLM Setup Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the extraction path in line with the current Claude API —
API-verified provenance via citations, refusal handling — and collapse the
multi-model configuration matrix down to the one model and effort level this
pipeline actually runs.

**Architecture:** Three independent strands, ordered so each lands on a smaller
surface than the last. First a correctness fix and a deletion pass that shrink
`config.py` and `anthropic_client.py`. Then the provenance migration: the paper
moves from an XML-wrapped text block into a real `document` block, structured
output moves from `output_config.format` to strict tool use, and citations are
switched on — which the first two make legal. Last, three measurement tasks that
the extraction harness (landed 2026-08-31) makes possible for the first time.

**Tech Stack:** Python 3.14, uv, ruff, ty, pytest, `anthropic==1.2.0`,
pydantic 2. No new runtime dependencies.

**Spec:** No separate spec document. The brainstorming that produced this plan
ran as a spike, so its findings are reproduced in **Findings** below and this
plan is self-contained. Every claim there was verified against the live API or
the repository on 2026-08-31; the probe scripts are quoted in the tasks that
depend on them.

---

## Global Constraints

- **Python coverage floor is 99.5%** line+branch
  (`[tool.coverage.report]
  fail_under` in `pyproject.toml`). The suite
  currently sits at 100%. Deleting a branch is the preferred way to satisfy it;
  adding an untested one fails the build.
- **`uv run pytest` collects only `tests/pipeline`** (`testpaths`). After
  touching `scripts/`, run `uv run pytest tests/scripts` explicitly.
- **The JSON output contract is byte-exact.**
  `tests/pipeline/export/test_writer.py` re-encodes each `data/*.json` and
  compares bytes. No task in this plan should change `data/`; if one does,
  regenerate with `deno task data` rather than hand-editing.
- **Any task that changes `data/` must run the e2e suite**
  (`deno task build && deno task test:e2e`) before its PR. No task here is
  expected to, but the rule stands.
- **`tests/pipeline/cassettes/` is excluded from `deno fmt`** via `deno.json`'s
  top-level `exclude`. Re-recording cassettes must not add files outside that
  directory.
- **Cassettes are recorded artifacts.** Re-recording requires both
  `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID` exported from `.env`; see the
  recording command in `tests/pipeline/test_extraction_golden.py`'s module
  docstring. `--record-mode=once` will not overwrite an existing cassette, so a
  re-record needs `rm -rf` first, and it records failures as readily as
  successes.
- **The only supported extraction model after Task 2 is `claude-opus-5`** at
  effort `high`.

---

## Findings

The five findings this plan implements, with the evidence for each. An executor
does not need to re-derive these, but Tasks 6, 8 and 9 turn on the numbers, so
they are recorded rather than summarized.

### F1 — Citations are reachable, via strict tool use

The pipeline's `source_quote` is model-reported: the v6 prompt instructs the
model to copy a verbatim sentence, and nothing verifies that it did.
`pipeline/extraction_models.py` records the reason:

```python
# Verbatim sentence from the paper supporting this entry. Required: the
# Citations API cannot be combined with structured outputs (400), so
# provenance has to travel inside the schema.
```

That is still true **of `output_config.format`**, which is the form this
pipeline uses. Probed against the live API on 2026-08-31:

| Probe                                                                                                      | Result                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| citations + `output_config.format`                                                                         | **400** — `"Citations cannot be enabled when output format is set."`                                     |
| citations + strict tool use, `tool_choice` forced                                                          | **200**, but **0 citation objects** — citations attach to text blocks, and a forced tool call emits none |
| citations + strict tool use, `tool_choice: {"type": "auto"}`, prompt asking for prose _then_ the tool call | **200, 3 citations _and_ a schema-valid `tool_use` block**                                               |

The third shape is the one this plan adopts. Its decisive property: the
`source_quote` the model put in the tool call was **character-identical** to the
`cited_text` of the span the API returned —

```
tool_use: {"genes": [{"gene_symbol": "ICA1L", "source_quote":
  "TWAS analysis identified ICA1L as transcriptome-wide significant
   (p = 3.1e-9) with colocalization PP4 = 0.91."}]}

citation:  chars 89-199, cited_text "TWAS analysis identified ICA1L as
   transcriptome-wide significant (p = 3.1e-9) with colocalization PP4 = 0.91. "
```

so a quote can be checked against an API-returned span by string comparison.
That converts provenance from _model-reported_ to _API-verified_, and retires
the manual "open three papers and check the sentence" step in
`docs/superpowers/plans/2026-08-30-extraction-transparency.md`.

### F2 — `stop_reason: "refusal"` is unhandled

Claude Opus 5 runs safety classifiers. A declined request returns a **normal 200
response** with `stop_reason: "refusal"`, not an error.
`pipeline/anthropic_client.py:144` checks only `max_tokens`, so a refusal falls
through to `_extract_response_text`, yields no parseable JSON, and is retried by
`_retry_validation` until the budget is spent — surfacing as a parse failure
rather than a refusal.

The server-side `fallbacks` parameter **is not supported on the Message Batches
API**, so the `--batch` path has to recognize refusals client-side regardless.

### F3 — The model matrix is dead weight

`config.py` carries `LEGACY_THINKING_MODELS`, `EFFORT_INCAPABLE_MODELS`,
`uses_adaptive_thinking()`, `supports_effort()`, `THINKING_OUTPUT_RESERVE`, a
manual-thinking branch in `thinking_config`, an 8-entry
`MODEL_MAX_OUTPUT_TOKENS`, and `anthropic_client.py` carries a 9-entry
`_MODEL_PRICING`. Every branch that is not `claude-opus-5` is unreachable in
practice and untestable in production.

### F4 — v6 is **not** a superset of v4

Verified by string comparison. `_EXTRACTION_INSTRUCTIONS_V6` starts with
`_EXTRACTION_INSTRUCTIONS_V5` verbatim, so v6 ⊇ v5. But v5 rewrote one
confidence-tier line and **loosened two guards v4 had**:

|                       | v4                                                                                   | v5 / v6                                                        |
| --------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| MTAG                  | gene-level evidence _"when the gene is the nearest gene at the MTAG-specific locus"_ | _"even a single mention as an MTAG locus label is sufficient"_ |
| Positional candidates | _"positional candidates do NOT qualify"_                                             | _"**single-phenotype** positional candidates do NOT qualify"_  |

So the requested "delete v4 and v5 if v6 is a superset" cannot be done for v4 as
stated. v5 is safe to delete (v6 contains it verbatim); **v4 is retained until
Task 8 measures whether its stricter guards recover precision**, then deleted
with the losing arm.

This matters because the harness measured 44 extracted genes against 17 curated
rows on PMID 37069360 — and v5's two relaxations are the most plausible cause.

### F5 — The harness's headline number is inflated by prompt contamination

13 of the 36 gold-standard genes are named verbatim in the v6 prompt, and six
(`C6orf195`, `CENPF`, `FOXF2`, `NBEAL1`, `TFPI`, `VWA2`) appear in `<example>`
blocks _with their expected `gwas_trait` and `confidence`_. Measured on the
committed cassettes:

```
genes named in the prompt:     19/20 = 95% recall
genes not named in the prompt: 23/26 = 88% recall
pooled (what the harness reports): 42/46 = 91%
```

Real, publication-relevant, and modest: the clean subset still scores 88%, so
91% is inflated by ~3 points rather than being an artifact.

### Not applicable — checked and ruled out

Recorded so they are not re-investigated: the **Skills API** is for agentic
multi-turn work, not one-shot batch extraction; **compaction** and **context
editing** manage multi-turn context; the **300K batch output beta** is
irrelevant when typical output is ~2.5K tokens; the **use-case guides** cover
ticket routing, support chat, moderation and legal summarization, none of them
scientific extraction. `temperature`/`top_p`/`top_k` are already absent, there
is no assistant prefill, and `anthropic==1.2.0` is the current v1 line.

---

## File Structure

| File                                       | Responsibility after this plan                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pipeline/config.py`                       | One model, one effort default, one thinking block. Loses the model matrix and its predicates.                                        |
| `pipeline/anthropic_client.py`             | Builds the request (document block + strict tool), handles refusal, parses `tool_use` input, verifies quotes against citation spans. |
| `pipeline/batch_extraction.py`             | Same request shape as the streaming path, from the same config properties.                                                           |
| `pipeline/prompts.py`                      | v4 and v6 only (v7 after Task 8). Emits document text and task instruction separately.                                               |
| `pipeline/citations.py`                    | **New.** Pure functions: collect citation spans from a response, match a quote to a span. No API calls, no I/O.                      |
| `pipeline/extraction_models.py`            | Unchanged shape; comment updated once provenance is verified.                                                                        |
| `tests/pipeline/test_extraction_golden.py` | Gains the contamination split (Task 7).                                                                                              |

`pipeline/citations.py` is new rather than folded into `anthropic_client.py`
because span-matching is pure and deserves direct unit tests;
`anthropic_client.py` is already 448 lines and every test of it has to mock a
streaming client.

---

## Task 1: Handle `stop_reason: "refusal"`

**Files:**

- Modify: `pipeline/anthropic_client.py:144` (the `max_tokens` check)
- Test: `tests/pipeline/test_anthropic_client.py`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `ExtractionFailedError` raised with a message beginning
  `"Refused by safety classifier for PMID "`. Task 2 does not depend on it.

- [ ] **Step 1: Write the failing test**

Add to `tests/pipeline/test_anthropic_client.py`, in the same class as
`test_empty_response_text`. It uses that class's existing conventions:
`_make_mock_client` (module-level in that file) and `MockAnthropicResponse` /
`MockTextBlock` from `tests/pipeline/conftest.py`.

The `mock_anthropic_response` fixture does **not** expose `stop_reason`, so
build the response directly rather than extending the fixture — this is the only
test that needs a non-default stop reason.

```python
    async def test_refusal_is_reported_as_a_refusal_not_a_parse_failure(
        self, mocker
    ) -> None:
        """A refusal is a 200 with stop_reason='refusal', not an exception.

        Reading its content and failing to parse JSON would burn the
        validation-retry budget and then report a malformed response,
        which is the wrong diagnosis and the wrong cost.
        """
        from pipeline.config import PipelineConfig
        from tests.pipeline.conftest import MockAnthropicResponse, MockTextBlock

        response = MockAnthropicResponse(
            content=[MockTextBlock(text="")],
            stop_reason="refusal",
        )
        mock_client = _make_mock_client(response)

        client = AnthropicClient()
        mocker.patch.object(client, "_get_client", return_value=mock_client)

        with pytest.raises(ExtractionFailedError, match="Refused by safety"):
            await client.extract("paper text", "12345678", PipelineConfig(), None)
```

If importing from `tests.pipeline.conftest` does not resolve, the two mock
classes are already in scope in that module via its existing imports — use them
directly and drop the import line.

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run pytest tests/pipeline/test_anthropic_client.py -k refusal -v
```

Expected: FAIL. Without the guard the empty text raises
`ExtractionFailedError("Empty text response for PMID 12345678", ...)`, so the
`match="Refused by safety"` assertion fails on the message.

- [ ] **Step 3: Add the guard before any content is read**

In `pipeline/anthropic_client.py`, immediately **above** the existing
`if response.stop_reason == "max_tokens":` block at line 144:

```python
if response.stop_reason == "refusal":
    # A declined request is a normal 200 whose content is not an
    # extraction. Reading it would fail JSON parsing and burn the
    # validation-retry budget reporting a malformed response, so the
    # check has to come before _extract_response_text. The server-side
    # `fallbacks` parameter is not available on the Message Batches
    # API, so this path stays client-side for both callers.
    logger.error(f"Request refused by safety classifier for PMID {pmid}")
    raise ExtractionFailedError(
        f"Refused by safety classifier for PMID {pmid}", usage
    )
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
uv run pytest tests/pipeline/test_anthropic_client.py -k refusal -v
```

Expected: PASS.

- [ ] **Step 5: Run the full suite and the coverage floor**

```bash
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
uv run ruff check . && uv run ty check
```

Expected: all pass, coverage at 100%.

- [ ] **Step 6: Commit**

```bash
git add pipeline/anthropic_client.py tests/pipeline/test_anthropic_client.py
git commit -m "Report a safety refusal as a refusal, not a parse failure"
```

---

## Task 2: Collapse the model matrix to Claude Opus 5

**Files:**

- Modify: `pipeline/config.py:217-250` (predicates and tables),
  `pipeline/config.py:261-270` (`llm_model`, `llm_effort`),
  `pipeline/config.py:527-552` (`thinking_config`)
- Modify: `pipeline/anthropic_client.py:28-46` (`_MODEL_PRICING`)
- Test: `tests/pipeline/test_config.py`,
  `tests/pipeline/test_anthropic_client.py`, `tests/pipeline/test_report.py`,
  `tests/pipeline/test_notifications.py`,
  `tests/pipeline/test_batch_extraction.py`

**Interfaces:**

- Consumes: nothing.
- Produces: `EXTRACTION_MODEL: Final[str] = "claude-opus-5"`,
  `MODEL_MAX_OUTPUT_TOKENS: Final[int] = 128_000`,
  `MODEL_PRICING: Final[tuple[float, float]] = (5.0, 25.0)`.
  `PipelineConfig.llm_model` becomes a read-only property returning
  `EXTRACTION_MODEL`. `PipelineConfig.llm_effort` keeps its
  `PIPELINE_LLM_EFFORT` override, default `"high"`. `uses_adaptive_thinking()`
  and `supports_effort()` are **removed** — do not reference them in later
  tasks.

**A note on scope, for the executor.** The request was "only Claude Opus 5 at
high effort." The model is therefore pinned with no environment override. The
_effort_ environment override is kept deliberately: Task 9 sweeps it, and the
Anthropic guidance is explicit that carried-over effort defaults should be
re-measured. `"high"` remains the default, so the configured behaviour is
exactly as requested.

- [ ] **Step 1: Write the failing tests**

In `tests/pipeline/test_config.py`, inside `TestPipelineConfigDefaults`:

```python
def test_the_model_is_pinned_and_not_environment_overridable(
    self, monkeypatch
) -> None:
    """One model, so a stray env var cannot silently change the corpus.

    Extraction output is compared across runs and against recorded
    cassettes; a per-machine model override would make two runs of the
    same code incomparable without anything saying so.
    """
    monkeypatch.setenv("PIPELINE_LLM_MODEL", "claude-haiku-4-5")
    assert PipelineConfig().llm_model == "claude-opus-5"


def test_effort_defaults_to_high_and_stays_overridable(
    self, monkeypatch
) -> None:
    assert PipelineConfig().llm_effort == "high"
    monkeypatch.setenv("PIPELINE_LLM_EFFORT", "medium")
    assert PipelineConfig().llm_effort == "medium"


def test_thinking_is_always_adaptive(self) -> None:
    assert PipelineConfig().thinking_config == {
        "type": "adaptive",
        "display": "summarized",
    }
```

- [ ] **Step 2: Run them to verify they fail**

```bash
uv run pytest tests/pipeline/test_config.py -k "pinned or effort_defaults or always_adaptive" -v
```

Expected: `test_the_model_is_pinned...` FAILS (the env var currently wins). The
other two may already pass; that is fine, they are regression guards for this
task's deletions.

- [ ] **Step 3: Replace the matrix in `config.py`**

Delete `LEGACY_THINKING_MODELS`, `EFFORT_INCAPABLE_MODELS`,
`uses_adaptive_thinking`, `supports_effort`, `THINKING_OUTPUT_RESERVE`, and the
dict form of `MODEL_MAX_OUTPUT_TOKENS`. Replace with:

```python
# One extraction model, pinned. The pipeline's output is compared across
# runs, against recorded cassettes, and against a gold standard, so the
# model is part of the method rather than a deployment knob. Changing it
# is a code change with a re-recorded harness, not an environment
# variable. Effort stays overridable -- see PipelineConfig.llm_effort.
EXTRACTION_MODEL: Final[str] = "claude-opus-5"
MODEL_MAX_OUTPUT_TOKENS: Final[int] = 128_000
```

Replace the `llm_model` field with a property, and simplify `thinking_config`:

```python
    @property
    def llm_model(self) -> str:
        """The pinned extraction model. See EXTRACTION_MODEL."""
        return EXTRACTION_MODEL

    @property
    def thinking_config(self) -> dict[str, Any]:
        """`thinking` block shared by the streaming and batch paths.

        Adaptive is the only mode Claude Opus 5 accepts: manual thinking
        with `budget_tokens` returns a 400 on 4.7 and later. Hoisted here
        so the streaming and batch paths cannot drift, which they once did
        -- streaming reserved tokens for the response text while batch
        took half of max_tokens unconditionally, giving the same paper a
        different reasoning allowance depending on the API it went through.

        display="summarized" keeps thinking blocks populated for the
        thinking/text ratio estimator in _stream_and_parse. The API
        default is "omitted", which would make that ratio always 0.
        """
        return {"type": "adaptive", "display": "summarized"}
```

In `__post_init__`, the `llm_max_tokens == 0` auto-resolve becomes:

```python
if self.llm_max_tokens == 0:
    self.llm_max_tokens = MODEL_MAX_OUTPUT_TOKENS
```

Because `llm_model` is now a property on a dataclass, remove its `field(...)`
declaration entirely; a property and a field of the same name cannot coexist.

- [ ] **Step 4: Collapse `_MODEL_PRICING`**

In `pipeline/anthropic_client.py`, replace the dict with:

```python
# Pricing per 1M tokens (input, output) for EXTRACTION_MODEL. Bump when
# Anthropic changes published rates.
MODEL_PRICING: Final[tuple[float, float]] = (5.0, 25.0)
```

Update `estimate_cost` to use it unconditionally. The dict's "a selectable model
missing from this table silently drops the cost line" hazard disappears with the
dict, so delete that comment along with it.

- [ ] **Step 5: Update the tests that parametrise over models**

`tests/pipeline/test_report.py` prices `claude-opus-4-7` and `claude-sonnet-4-6`
through `AnthropicClient.estimate_cost`. Replace those cases with a single Opus
5 case:

```python
def test_opus_5_pricing(self):
    cost = _cost("claude-opus-5", 1_000_000, 100_000)
    # $5/M input + $25/M output -> 5 + 2.5 = 7.5
    assert cost == pytest.approx(7.5)
```

Then sweep the remaining references:

```bash
grep -rn "LEGACY_THINKING_MODELS\|uses_adaptive_thinking\|supports_effort\|THINKING_OUTPUT_RESERVE\|sonnet-4-5\|sonnet-4-6\|haiku-4-5\|opus-4-7\|opus-4-8\|fable-5" pipeline/ tests/
```

Every hit must be deleted or repointed at `claude-opus-5`. Expect hits in
`test_config.py`, `test_anthropic_client.py`, `test_batch_extraction.py` and
`test_notifications.py`.

- [ ] **Step 6: Update `.env.example` and the docs**

Remove `PIPELINE_LLM_MODEL` from `.env.example` if present; keep
`PIPELINE_LLM_EFFORT` with a comment that `high` is the default and that
lowering it is the cost lever. In `CLAUDE.md`, state that the extraction model
is pinned in code and why.

- [ ] **Step 7: Run everything**

```bash
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
uv run ruff check . && uv run ty check
```

Expected: pass, 100% coverage. Coverage should be _easier_ to hold — this task
deletes branches rather than adding them.

- [ ] **Step 8: Commit**

```bash
git add pipeline/config.py pipeline/anthropic_client.py tests/ .env.example CLAUDE.md
git commit -m "Pin extraction to Claude Opus 5 and delete the model matrix"
```

---

## Task 3: Delete prompt versions v1, v2 and v3

> **Vocabulary hook.** `tests/pipeline/test_prompt_vocabulary.py` reconciles
> each usable prompt's canonical-abbreviation sentence against
> `lib/vocabulary.json`. It derives the usable set from `_PROMPTS` minus
> `PROMPT_VERSIONS_WITHOUT_PROVENANCE`, so deleting versions needs no edit there
> — it just shrinks what the test covers. Ordering note only, no code
> dependency.

**Files:**

- Modify: `pipeline/prompts.py:47-470` (v1–v3 literals),
  `pipeline/prompts.py:826-856` (`_PROMPTS`,
  `PROMPT_VERSIONS_WITHOUT_PROVENANCE`)
- Test: `tests/pipeline/test_prompts.py`, `tests/pipeline/test_config.py`

**Interfaces:**

- Consumes: nothing.
- Produces: `_PROMPTS` containing exactly `{"v4": ..., "v6": ...}`.
  `PROMPT_VERSIONS_WITHOUT_PROVENANCE` still derives itself from `_PROMPTS` and
  will equal `frozenset({"v4"})`. Task 8 depends on `v4` remaining present and
  on `PipelineConfig` still refusing it for production runs.

**Why v4 survives this task.** v6 contains v5 verbatim, so v5 is redundant. v6
does **not** contain v4: v5 loosened the MTAG rule and the positional-candidate
rule (see F4). Task 8 measures whether those guards recover precision. Deleting
v4 now would throw away the stricter arm before the experiment.

- [ ] **Step 1: Write the failing test**

In `tests/pipeline/test_prompts.py`:

```python
def test_only_v4_and_v6_remain() -> None:
    """v5 is inside v6 verbatim; v1-v3 are the pre-provenance lineage.

    v4 is kept deliberately: it holds two exclusion guards v5 relaxed
    (MTAG locus labels, multi-phenotype positional candidates), and the
    extraction harness has not yet measured which arm is better.
    """
    from pipeline.prompts import _PROMPTS

    assert set(_PROMPTS) == {"v4", "v6"}


def test_v6_is_its_body_plus_the_shared_provenance_block() -> None:
    """Keep the provenance block separable from the instruction body.

    v6 was `v5 + provenance`, and deleting v5 makes it tempting to
    collapse the two into one literal. Task 8 needs to append the same
    block to v4 so the two arms differ only in the guards under test,
    which is impossible once the block is inlined.
    """
    from pipeline.prompts import (
        _EXTRACTION_INSTRUCTIONS_V6,
        _EXTRACTION_INSTRUCTIONS_V6_BODY,
        _PROVENANCE_BLOCK,
    )

    assert (
        _EXTRACTION_INSTRUCTIONS_V6
        == _EXTRACTION_INSTRUCTIONS_V6_BODY + _PROVENANCE_BLOCK
    )
    assert "MULTI-PHENOTYPE CONVERGENCE" in _EXTRACTION_INSTRUCTIONS_V6_BODY
```

- [ ] **Step 2: Run it to verify it fails**

```bash
uv run pytest tests/pipeline/test_prompts.py -k "only_v4_and_v6" -v
```

Expected: FAIL — `_PROMPTS` currently has six keys.

- [ ] **Step 3: Delete the literals**

Remove `_SYSTEM_PROMPT_V1`, `_EXTRACTION_INSTRUCTIONS_V1`, `_SYSTEM_PROMPT_V2`,
`_EXTRACTION_INSTRUCTIONS_V2`, `_SYSTEM_PROMPT_V3`,
`_EXTRACTION_INSTRUCTIONS_V3`, and `_EXTRACTION_INSTRUCTIONS_V5`.

`_SYSTEM_PROMPT_V4` currently aliases `_SYSTEM_PROMPT_V3`, and
`_SYSTEM_PROMPT_V5`/`_SYSTEM_PROMPT_V6` alias down the chain. Promote the
literal: make the surviving system prompt a single definition named
`_SYSTEM_PROMPT` and have both `v4` and `v6` use it.

`_EXTRACTION_INSTRUCTIONS_V6` is currently
`_EXTRACTION_INSTRUCTIONS_V5 +
provenance`. **Do not collapse it into one
literal.** Rename v5's body and name the appended block, so v6 stays a
composition:

```python
# v5's instruction body, renamed: v5 is gone as a selectable version, but
# its text is v6 minus the provenance block and Task 8 needs the two
# separable to build a v4 arm that differs only in the guards under test.
_EXTRACTION_INSTRUCTIONS_V6_BODY: Final[str] = """\
...the former _EXTRACTION_INSTRUCTIONS_V5 text, unchanged...
"""

# Appended to any prompt version that carries provenance. Kept as its own
# constant so it can be appended to a second version without duplication;
# PROMPT_VERSIONS_WITHOUT_PROVENANCE detects it via _PROVENANCE_HEADING.
_PROVENANCE_BLOCK: Final[str] = """

## Provenance

For every gene you report, set `source_quote` to a single verbatim sentence
copied from the paper that supports the association. Copy it exactly — do
not paraphrase, summarise, or stitch two sentences together. If no single
sentence supports the entry, do not report the gene.
"""

_EXTRACTION_INSTRUCTIONS_V6: Final[str] = (
    _EXTRACTION_INSTRUCTIONS_V6_BODY + _PROVENANCE_BLOCK
)
```

`_PROVENANCE_HEADING` (`"## Provenance"`) stays as it is —
`PROMPT_VERSIONS_WITHOUT_PROVENANCE` derives from it and must keep working.

Update `_PROMPTS`:

```python
_PROMPTS: Final[dict[str, tuple[str, str]]] = {
    "v4": (_SYSTEM_PROMPT, _EXTRACTION_INSTRUCTIONS_V4),
    "v6": (_SYSTEM_PROMPT, _EXTRACTION_INSTRUCTIONS_V6),
}
```

Update the module docstring: it currently says "v1-v5 are kept as the historical
record". Replace with the v4/v6 rationale from this task.

- [ ] **Step 4: Run the tests**

```bash
uv run pytest tests/pipeline/ -q
```

Expected: PASS. `PROMPT_VERSIONS_WITHOUT_PROVENANCE` now equals
`frozenset({"v4"})`, so `PipelineConfig` still refuses `v4` for production runs
— check `tests/pipeline/test_config.py` for a test asserting the old
five-element set and update it to `{"v4"}`.

- [ ] **Step 5: Full suite and commit**

```bash
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
uv run ruff check . && uv run ty check
git add pipeline/prompts.py tests/
git commit -m "Delete prompt versions v1-v3 and v5, keeping v4 as the strict arm"
```

---

## Task 4: Emit the paper as a document block

**Files:**

- Modify: `pipeline/prompts.py:22-40` (`ExtractionPrompt`),
  `pipeline/prompts.py:878-904` (`build_extraction_prompt`)
- Modify: `pipeline/anthropic_client.py:80-118` (`_build_stream_kwargs`)
- Modify: `pipeline/batch_extraction.py:36-70` (`build_batch_request`)
- Test: `tests/pipeline/test_prompts.py`,
  `tests/pipeline/test_anthropic_client.py`,
  `tests/pipeline/test_batch_extraction.py`

**Interfaces:**

- Consumes: `_PROMPTS` from Task 3.
- Produces: `ExtractionPrompt` gains `document_text: str` and
  `task_instruction: str`; `user_text` is **removed**. Task 6 requires
  `document_text` to be the raw paper text with no XML wrapper, because citation
  offsets index into exactly the bytes sent in the `document` block.

This task is a pure refactor: no behavioural change, no citations yet. It lands
separately so the request-shape change is reviewable on its own.

- [ ] **Step 1: Write the failing test**

```python
def test_document_text_is_raw_paper_text_without_an_xml_wrapper() -> None:
    """Citation offsets index the document block's bytes.

    The old user_text wrapped the paper in <document source="PubMed">
    and escaped </document> to stop the tag closing early. A real
    document block needs neither, and a wrapper would shift every
    citation offset by the length of the opening tag.
    """
    prompt = build_extraction_prompt(
        paper_text="ICA1L is significant.",
        pmid="12345678",
        max_chars=1000,
        prompt_version="v6",
    )
    assert prompt.document_text == "ICA1L is significant."
    assert "<document" not in prompt.document_text
    assert "12345678" not in prompt.document_text


def test_truncation_still_applies_to_the_document_text() -> None:
    prompt = build_extraction_prompt(
        paper_text="x" * 500,
        pmid="12345678",
        max_chars=100,
        prompt_version="v6",
    )
    assert len(prompt.document_text) == 100
```

- [ ] **Step 2: Run to verify failure**

```bash
uv run pytest tests/pipeline/test_prompts.py -k "document_text" -v
```

Expected: FAIL with
`AttributeError: 'ExtractionPrompt' object has no
attribute 'document_text'`.

- [ ] **Step 3: Change `ExtractionPrompt` and the builder**

```python
@dataclass(slots=True, frozen=True)
class ExtractionPrompt:
    """Provider-agnostic prompt payload for gene extraction."""

    system_prompt: str
    extraction_instructions: str
    document_text: str
    task_instruction: str

    @property
    def combined_system_text(self) -> str:
        """Single system string for providers that take one system message."""
        return f"{self.system_prompt}\n\n{self.extraction_instructions}"
```

In `build_extraction_prompt`, replace the `user_text` construction with:

```python
    # No XML wrapper and no </document> escaping: the paper now travels in
    # a real document content block, so the API owns the boundary. This is
    # load-bearing for citations -- start_char_index/end_char_index index
    # into exactly these bytes, and a wrapper would shift every offset.
    task_instruction = (
        "Extract all genes with putative causal links to cSVD from the "
        "document above."
    )

    return ExtractionPrompt(
        system_prompt=system_prompt,
        extraction_instructions=extraction_instructions,
        document_text=paper_text,
        task_instruction=task_instruction,
    )
```

- [ ] **Step 4: Update both request builders**

In `_build_stream_kwargs` and `build_batch_request`, replace the `messages`
value with the same structure in both (they must not drift):

```python
"messages": [
    {
        "role": "user",
        "content": [
            {
                "type": "document",
                "source": {
                    "type": "text",
                    "media_type": "text/plain",
                    "data": prompt.document_text,
                },
                "title": f"PMID {pmid}",
            },
            {"type": "text", "text": prompt.task_instruction},
        ],
    }
],
```

- [ ] **Step 5: Run the tests**

```bash
uv run pytest tests/pipeline/ -q
```

Expected: PASS. Tests asserting on `user_text` will fail — update them to assert
on `document_text` / `task_instruction`. Grep for stragglers:

```bash
grep -rn "user_text" pipeline/ tests/
```

Expected: no hits.

- [ ] **Step 6: Full suite and commit**

```bash
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
uv run ruff check . && uv run ty check
git add pipeline/ tests/
git commit -m "Send the paper as a document block instead of an XML-wrapped string"
```

---

## Task 5: Move structured output from `output_config.format` to strict tool use

> **Vocabulary hook — enforce the trait vocabulary in the schema.** Verified
> against the pinned `anthropic==1.2.0`: a Pydantic `Literal` survives
> `transform_schema` as a real JSON-Schema `enum`, while unsupported constraints
> are demoted to description strings —
> `gwas_trait -> {"type":"array","items":{"type":"string","enum":[...]}}` beside
> `source_quote -> {"type":"string","description":"{minLength: 1}"}`. So when
> `gwas_trait` moves onto the strict tool, type it `list[Literal[...]]`
> generated from `lib/vocabulary.json`. Doing it here rather than now means
> writing it once instead of authoring it against `output_config.format` and
> then migrating it.
>
> **Enumerate the full canonical list — tracked ∪ untracked — not just the
> tracked traits.** Constraining to the tracked set destroys the signal the
> vocabulary work exists to surface: `PVWMH` was emitted 29 times because the
> model was correctly naming a phenotype the dashboard lacked. Narrow the enum
> and it silently becomes `WMH`, or vanishes. The full list keeps the model able
> to say a term the dashboard does not carry, guarantees the string is a _known_
> one, and leaves disposition to the export layer.

**Files:**

- Modify: `pipeline/config.py:513-525` (`extraction_schema`),
  `pipeline/config.py:554-563` (`output_config`)
- Modify: `pipeline/anthropic_client.py` (`_build_stream_kwargs`,
  `_stream_and_parse`)
- Modify: `pipeline/batch_extraction.py` (`build_batch_request`, its result
  parser)
- Test: `tests/pipeline/test_config.py`,
  `tests/pipeline/test_anthropic_client.py`,
  `tests/pipeline/test_batch_extraction.py`

**Interfaces:**

- Consumes: `ExtractionPrompt.document_text` (Task 4).
- Produces: `PipelineConfig.extraction_tool` returning the strict tool
  definition; `PipelineConfig.output_config` returning **only** `effort` (or
  `{}` at the default), since `format` moves onto the tool.
  `EXTRACTION_TOOL_NAME: Final[str] = "report_genes"`. Task 6 depends on the
  tool name and on `tool_choice` being `{"type": "auto"}`.

**Why this must precede citations.** The 400 is specific to
`output_config.format`. Strict tool use carries the same schema guarantee
through a different channel and is accepted alongside citations — verified by
probe (F1).

- [ ] **Step 1: Write the failing tests**

```python
def test_the_schema_travels_on_a_strict_tool_not_output_format(self) -> None:
    """output_config.format is the exact parameter citations reject.

    The API's message is "Citations cannot be enabled when output format
    is set." Strict tool use gives the same schema guarantee without
    setting it.
    """
    config = PipelineConfig()
    tool = config.extraction_tool

    assert tool["name"] == "report_genes"
    assert tool["strict"] is True
    assert tool["input_schema"]["type"] == "object"
    assert "format" not in config.output_config


def test_output_config_is_empty_at_the_default_effort(self) -> None:
    assert PipelineConfig().output_config == {}


def test_output_config_carries_a_non_default_effort(self, monkeypatch) -> None:
    monkeypatch.setenv("PIPELINE_LLM_EFFORT", "medium")
    assert PipelineConfig().output_config == {"effort": "medium"}
```

- [ ] **Step 2: Run to verify failure**

```bash
uv run pytest tests/pipeline/test_config.py -k "strict_tool or output_config" -v
```

Expected: FAIL — `extraction_tool` does not exist.

- [ ] **Step 3: Add `extraction_tool`, shrink `output_config`**

In `pipeline/config.py`:

```python
EXTRACTION_TOOL_NAME: Final[str] = "report_genes"
```

```python
    @property
    def extraction_tool(self) -> dict[str, Any]:
        """Strict-tool definition shared by the streaming and batch paths.

        The schema rides on a tool rather than in output_config.format
        because citations and output_config.format are mutually
        exclusive -- the API returns 400 "Citations cannot be enabled
        when output format is set." Strict tool use is grammar-constrained
        the same way, so the schema guarantee is unchanged.
        """
        return {
            "name": EXTRACTION_TOOL_NAME,
            "description": (
                "Report every gene with a putative causal link to cerebral "
                "small vessel disease found in the document."
            ),
            "input_schema": transform_schema(ExtractionResult),
            "strict": True,
        }

    @property
    def output_config(self) -> dict[str, Any]:
        """`output_config` block shared by the streaming and batch paths.

        Carries effort only. "high" is the API default, so effort is
        transmitted only when overridden; the schema moved to
        extraction_tool.
        """
        if self.llm_effort != "high":
            return {"effort": self.llm_effort}
        return {}
```

Delete `extraction_schema`.

- [ ] **Step 4: Send the tool and parse its input**

In `_build_stream_kwargs`, drop `"output_config": config.output_config` when it
is empty and add the tool:

```python
kwargs: dict[str, Any] = {
    "model": config.llm_model,
    "max_tokens": config.llm_max_tokens,
    "system": [...],          # unchanged
    "messages": [...],        # from Task 4
    "thinking": config.thinking_config,
    "tools": [config.extraction_tool],
    # auto, not a forced call: a forced tool call produces no text
    # blocks, and citations attach to text. Task 6 depends on this.
    "tool_choice": {"type": "auto"},
}
if output_config := config.output_config:
    kwargs["output_config"] = output_config
return kwargs
```

Replace the text-JSON parse in `_stream_and_parse`. Where it currently calls
`parse_extraction_response(text_content)`:

```python
tool_blocks = [
    block for block in response.content
    if getattr(block, "type", None) == "tool_use"
    and block.name == EXTRACTION_TOOL_NAME
]
if not tool_blocks:
    # tool_choice is "auto", so a turn that answers in prose without
    # calling the tool is possible. It is a retryable malformed
    # response, not a refusal and not an empty one.
    raise ValueError(
        f"No {EXTRACTION_TOOL_NAME} tool call in response for PMID {pmid}"
    )
result = ExtractionResult.model_validate(tool_blocks[0].input)
```

`ValueError` is already caught by the validation-retry branch at
`anthropic_client.py:~420`, so a missing tool call retries rather than failing
the paper outright. Keep the empty-text guard, but move it **after** the
tool-block check — with `tool_choice: auto` the model may legitimately emit
little prose.

Apply the same parse change to `batch_extraction.py`'s result handler.

- [ ] **Step 5: Run the tests**

```bash
uv run pytest tests/pipeline/ -q
uv run ruff check . && uv run ty check
```

Expected: PASS after updating mocks in `test_anthropic_client.py` and
`test_batch_extraction.py` to return a `tool_use` block instead of a text block.
`conftest.py` will need a `MockToolUseBlock`:

```python
@dataclass
class MockToolUseBlock:
    """Mimics a tool_use content block."""

    type: str = "tool_use"
    name: str = "report_genes"
    input: dict[str, Any] | None = None

    def __post_init__(self):
        if self.input is None:
            self.input = {"genes": []}
```

- [ ] **Step 6: Re-record the extraction cassettes**

The request shape changed, so every committed cassette is stale.

```bash
set -a; . ./.env; set +a
rm -rf tests/pipeline/cassettes/test_extraction_golden
uv run pytest tests/pipeline/test_extraction_golden.py --record-mode=once -q -rs
```

Then confirm the recording succeeded before committing — `--record-mode=once`
records failures too:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_WORKSPACE_ID \
  uv run pytest tests/pipeline/test_extraction_golden.py -q -rs
```

Expected: 19 passed, 3 skipped. If recall moved, update `_RECALL_BASELINE` with
the measured values **and say so in the commit message** — a baseline change is
a finding, not bookkeeping.

Then scrub the account identifiers, which `before_record_response` handles on a
fresh recording but which the leak test will confirm:

```bash
uv run pytest tests/pipeline/test_extraction_golden.py -k credential -v
```

- [ ] **Step 7: Full suite and commit**

```bash
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
git add pipeline/ tests/
git commit -m "Carry the extraction schema on a strict tool instead of output_config.format"
```

---

## Task 6: Enable citations and verify every quote against a cited span

**Files:**

- Create: `pipeline/citations.py`
- Create: `tests/pipeline/test_citations.py`
- Modify: `pipeline/anthropic_client.py` (request + post-parse verification),
  `pipeline/batch_extraction.py` (request)
- Modify: `pipeline/extraction_models.py` (the comment that explains
  `source_quote`)
- Modify: `pipeline/config.py` (one new field)

**Interfaces:**

- Consumes: `config.extraction_tool`, `tool_choice: {"type": "auto"}` (Task 5);
  `prompt.document_text` (Task 4).
- Produces: `pipeline.citations.collect_spans(response) -> list[CitedSpan]`,
  `pipeline.citations.verify_quote(quote: str, spans: Sequence[CitedSpan]) -> CitedSpan | None`,
  and `CitedSpan` — a frozen dataclass with `cited_text: str`,
  `start_char_index: int`, `end_char_index: int`.
  `PipelineConfig.require_verified_quotes: bool`
  (`PIPELINE_REQUIRE_VERIFIED_QUOTES`, default `False`).

**What this buys.** `source_quote` stops being a sentence the model says it
copied and becomes a sentence the API located in the document, at known
character offsets. That is the difference between "the prompt forbade
paraphrase" and "here is the span" for a reviewer.

**Default is off.** `require_verified_quotes` defaults to `False` so this lands
as measurement, not as a gate that silently drops genes. Task 8's measurement
decides whether to flip it.

- [ ] **Step 1: Write the failing tests for the pure module**

`tests/pipeline/test_citations.py`:

```python
"""Span matching for API-returned citations. No API calls here."""

import pytest

from pipeline.citations import CitedSpan, collect_spans, verify_quote


def _span(text: str, start: int = 0) -> CitedSpan:
    return CitedSpan(
        cited_text=text, start_char_index=start, end_char_index=start + len(text)
    )


def test_an_exact_quote_matches_its_span() -> None:
    spans = [_span("TWAS analysis identified ICA1L as significant.")]
    assert verify_quote("TWAS analysis identified ICA1L as significant.", spans)


def test_trailing_whitespace_in_the_span_does_not_block_a_match() -> None:
    """The API's cited_text keeps the source's trailing space.

    The probe returned "...PP4 = 0.91. " with a trailing space while the
    model's source_quote had none. Comparing raw would reject a quote
    that is in fact verbatim.
    """
    spans = [_span("TWAS analysis identified ICA1L as significant. ")]
    assert verify_quote("TWAS analysis identified ICA1L as significant.", spans)


def test_a_quote_spanning_two_citations_does_not_match() -> None:
    """Provenance is one sentence; a stitched quote is not verbatim."""
    spans = [_span("First sentence."), _span("Second sentence.", 16)]
    assert verify_quote("First sentence. Second sentence.", spans) is None


def test_a_paraphrase_does_not_match() -> None:
    spans = [_span("TWAS analysis identified ICA1L as significant.")]
    assert verify_quote("ICA1L was found to be significant by TWAS.", spans) is None


def test_no_spans_means_no_match() -> None:
    assert verify_quote("anything", []) is None


def test_collect_spans_reads_citations_off_text_blocks() -> None:
    class _Cite:
        type = "char_location"
        cited_text = "ICA1L is significant. "
        start_char_index = 10
        end_char_index = 32

    class _Text:
        type = "text"
        text = "ICA1L is significant."
        citations = [_Cite()]

    class _Tool:
        type = "tool_use"
        name = "report_genes"
        input = {"genes": []}

    class _Response:
        content = [_Text(), _Tool()]

    spans = collect_spans(_Response())
    assert len(spans) == 1
    assert spans[0].start_char_index == 10
    assert spans[0].cited_text == "ICA1L is significant. "
```

- [ ] **Step 2: Run to verify failure**

```bash
uv run pytest tests/pipeline/test_citations.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.citations'`.

- [ ] **Step 3: Write `pipeline/citations.py`**

```python
"""Span matching for API-returned citations.

Citations turn `source_quote` from a sentence the model reports having
copied into one the API located in the document, at character offsets into
exactly the bytes sent in the document block. Everything here is pure: the
request side lives in anthropic_client, and these functions are unit-tested
without a client.

Matching is exact after stripping surrounding whitespace, and deliberately
not fuzzy. The API's `cited_text` preserves the source's trailing space,
which the model's quote does not, so a raw comparison would reject a
genuinely verbatim quote -- but anything looser would accept a paraphrase,
which is the one thing this check exists to catch.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True, frozen=True)
class CitedSpan:
    """One API-returned citation: its text and where it sits."""

    cited_text: str
    start_char_index: int
    end_char_index: int


def collect_spans(response: Any) -> list[CitedSpan]:
    """Every citation on every text block of one response.

    Citations attach to text blocks only, never to a tool_use block --
    which is why the request uses tool_choice "auto" rather than forcing
    the call: a forced call emits no text and therefore no citations.
    """
    spans: list[CitedSpan] = []
    for block in getattr(response, "content", []) or []:
        if getattr(block, "type", None) != "text":
            continue
        for citation in getattr(block, "citations", None) or []:
            start = getattr(citation, "start_char_index", None)
            end = getattr(citation, "end_char_index", None)
            text = getattr(citation, "cited_text", None)
            if start is None or end is None or text is None:
                continue
            spans.append(
                CitedSpan(cited_text=text, start_char_index=start, end_char_index=end)
            )
    return spans


def verify_quote(quote: str, spans: Sequence[CitedSpan]) -> CitedSpan | None:
    """The span whose text is `quote`, or None when nothing matches."""
    needle = quote.strip()
    if not needle:
        return None
    for span in spans:
        if span.cited_text.strip() == needle:
            return span
    return None
```

- [ ] **Step 4: Run the tests**

```bash
uv run pytest tests/pipeline/test_citations.py -v
```

Expected: PASS, all seven.

- [ ] **Step 5: Enable citations on the document block**

In **both** `_build_stream_kwargs` and `build_batch_request`, add the
`citations` key to the document block from Task 4:

```python
{
    "type": "document",
    "source": {
        "type": "text",
        "media_type": "text/plain",
        "data": prompt.document_text,
    },
    "title": f"PMID {pmid}",
    # Legal only because the schema moved to a strict
    # tool in Task 5: citations plus
    # output_config.format is a 400.
    "citations": {"enabled": True},
},
```

The `task_instruction` must now ask for prose _before_ the tool call, or there
will be no text block for citations to attach to. In `build_extraction_prompt`:

```python
task_instruction = (
    "For each gene with a putative causal link to cSVD in the document "
    "above, first state the supporting evidence in one sentence, quoting "
    "the sentence from the document that supports it. Then call "
    "report_genes with the structured result."
)
```

- [ ] **Step 6: Verify quotes after parsing**

In `_stream_and_parse`, after `result` is built and PMIDs are assigned:

```python
spans = collect_spans(response)
verified = 0
for gene in result.genes:
    if verify_quote(gene.source_quote, spans) is not None:
        verified += 1
if result.genes:
    logger.info(
        f"  Provenance: {verified}/{len(result.genes)} quotes matched an "
        f"API citation span ({len(spans)} spans returned)"
    )
if config.require_verified_quotes:
    result.genes = [
        gene for gene in result.genes
        if verify_quote(gene.source_quote, spans) is not None
    ]
```

Add the config field beside the other LLM settings:

```python
# When True, drop any gene whose source_quote does not match an
# API-returned citation span. Default False: this lands as a
# measurement first, so a mismatch shows up in the logs rather than
# silently removing a gene.
require_verified_quotes: bool = field(
    default_factory=lambda: _env_bool("PIPELINE_REQUIRE_VERIFIED_QUOTES", False)
)
```

- [ ] **Step 7: Test the wiring**

In `tests/pipeline/test_anthropic_client.py`:

```python
async def test_unverified_quotes_are_kept_by_default(self, mocker) -> None:
    """Default is measurement, not enforcement."""
    ...  # response with one gene whose quote matches no span
    genes = await client.extract("paper", "12345678", PipelineConfig())
    assert len(genes) == 1


async def test_unverified_quotes_are_dropped_when_required(
    self, mocker, monkeypatch
) -> None:
    monkeypatch.setenv("PIPELINE_REQUIRE_VERIFIED_QUOTES", "true")
    ...  # same response
    genes = await client.extract("paper", "12345678", PipelineConfig())
    assert genes == []
```

- [ ] **Step 8: Update the comment that justified the old design**

In `pipeline/extraction_models.py`, the `source_quote` comment says citations
cannot be combined with structured outputs. Replace with:

```python
# Verbatim sentence from the paper supporting this entry. Required.
# Citations cannot be combined with output_config.format (400), which
# is why the schema travels on a strict tool instead -- see
# PipelineConfig.extraction_tool. With that in place the API also
# returns citation spans, and pipeline/citations.py checks this field
# against them, so the quote is verified rather than merely requested.
source_quote: str = Field(min_length=1)
```

- [ ] **Step 9: Re-record cassettes and measure**

```bash
set -a; . ./.env; set +a
rm -rf tests/pipeline/cassettes/test_extraction_golden
uv run pytest tests/pipeline/test_extraction_golden.py --record-mode=once -q -rs
env -u ANTHROPIC_API_KEY -u ANTHROPIC_WORKSPACE_ID \
  uv run pytest tests/pipeline/test_extraction_golden.py -q -rs
```

Record in the commit message what fraction of quotes matched a span across the
ten fixtures. **That number is the deliverable of this task** — it is the first
direct measurement of whether the model's "verbatim" quotes really are.

- [ ] **Step 10: Full suite, docs, commit**

Update `CLAUDE.md`'s provenance notes and `.env.example` with
`PIPELINE_REQUIRE_VERIFIED_QUOTES`.

```bash
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
uv run ruff check . && uv run ty check
git add pipeline/ tests/ CLAUDE.md .env.example
git commit -m "Verify every source_quote against an API-returned citation span"
```

---

## Task 7: Split the harness metric on prompt contamination

**Files:**

- Modify: `tests/pipeline/test_extraction_golden.py`
- Modify: `CLAUDE.md`, `README.md` (the reported accuracy figure)

**Interfaces:**

- Consumes: `_GOLDEN_PMIDS`, `_reachable_genes`, `normalize_symbol` (existing).
- Produces: `_genes_named_in_the_prompt() -> set[str]`. No production code
  changes.

**Why.** 13 of 36 gold genes are named in the v6 prompt and six carry their
expected trait and confidence. Measured: 95% recall on named genes, 88% on the
rest, 91% pooled. The headline is inflated by ~3 points. The fix is to report
the honest number, not to cripple the prompt — the examples are load-bearing for
extraction quality.

- [ ] **Step 1: Write the failing test**

```python
def _genes_named_in_the_prompt() -> set[str]:
    """Gold-standard genes that appear verbatim in the production prompt."""
    prompt = build_extraction_prompt(
        paper_text="", pmid="0", max_chars=1, prompt_version="v6"
    )
    text = f"{prompt.system_prompt}\n{prompt.extraction_instructions}"
    named = set()
    for genes in _expected_genes_by_pmid().values():
        for gene in genes:
            patterns = (rf"\b{re.escape(n)}\b" for n in _search_names(gene))
            if any(re.search(p, text) for p in patterns):
                named.add(normalize_symbol(gene))
    return named


def test_the_prompt_names_part_of_its_own_answer_key() -> None:
    """Pin the contamination so it cannot grow unnoticed.

    The v6 prompt's few-shot examples name 13 of the 36 gold-standard
    genes, six of them with the expected gwas_trait and confidence. That
    inflates measured recall on those genes -- 95% against 88% for the
    rest -- so the harness reports the two separately and the paper
    should quote the uncontaminated figure.

    This is not a licence to add more. If a prompt edit names another
    gold gene, this fails and the number has to be re-measured.
    """
    named = _genes_named_in_the_prompt()
    assert len(named) == 13, (
        f"{len(named)} gold genes are named in the prompt, was 13: "
        f"{sorted(named)}"
    )
```

- [ ] **Step 2: Run to verify it passes at 13, then confirm it bites**

```bash
uv run pytest tests/pipeline/test_extraction_golden.py -k answer_key -v
```

Expected: PASS at 13. Then temporarily add `LAMB1` to a prompt example, re-run,
confirm FAIL at 14, and revert. A guard that has never been seen to fail is not
a guard.

- [ ] **Step 3: Report the split**

Change the per-paper assertion message in
`test_extraction_recovers_the_reachable_genes` to name whether each missed gene
was prompt-named, and add a pooled reporting test:

```python
@requires_recording
def test_recall_is_reported_separately_for_contaminated_genes() -> None:
    """The honest headline is the clean subset, not the pooled figure."""
    named = _genes_named_in_the_prompt()
    seen_hit = seen_tot = clean_hit = clean_tot = 0
    for pmid in _GOLDEN_PMIDS:
        reachable = _reachable_genes(pmid)
        if not reachable:
            continue
        actual = _recorded_extraction(pmid)     # reads the committed cassette
        for gene in reachable:
            hit = gene in actual
            if gene in named:
                seen_tot += 1
                seen_hit += hit
            else:
                clean_tot += 1
                clean_hit += hit
    assert clean_tot >= 20, "clean subset too small to report"
    assert clean_hit / clean_tot >= 0.80, (
        f"uncontaminated recall {clean_hit}/{clean_tot}; "
        f"prompt-named {seen_hit}/{seen_tot}"
    )
```

`_recorded_extraction(pmid)` reads the committed cassette rather than calling
the API, so this test costs nothing and needs no credentials. Add it beside the
other helpers in the same module:

```python
def _recorded_extraction(pmid: str) -> set[str]:
    """The normalized gene symbols in this PMID's committed cassette.

    Reads the recorded response directly instead of replaying through
    VCR: this test compares two subsets of one run, so it needs the
    extraction output as data rather than as an assertion, and decoding
    is cheaper than standing up a client per PMID.

    The response body is a gzipped SSE stream whose text_delta events
    concatenate into the assistant's JSON.
    """
    import base64
    import gzip
    import json

    import yaml

    cassette = CASSETTE_DIR / (
        f"test_extraction_recovers_the_reachable_genes[{pmid}].yaml"
    )
    loaded = yaml.safe_load(cassette.read_text(encoding="utf-8"))
    body = loaded["interactions"][0]["response"]["body"]["string"]
    raw = body if isinstance(body, bytes) else base64.b64decode(body)
    try:
        raw = gzip.decompress(raw)
    except (OSError, gzip.BadGzipFile):
        pass  # already decompressed by the recorder
    stream = raw.decode("utf-8", "replace")
    deltas = re.findall(r'"text_delta","text":"((?:[^"\\]|\\.)*)"', stream)
    payload = json.loads("".join(json.loads(f'"{d}"') for d in deltas))
    return {normalize_symbol(g["gene_symbol"]) for g in payload.get("genes", [])}
```

**Task 5 changes this decode.** Once the schema rides on a strict tool, the
genes arrive in an `input_json_delta` stream on a `tool_use` block rather than
as `text_delta`. If Task 5 has already landed, match
`"input_json_delta","partial_json":"..."` instead, and drop the outer
`json.loads` of the assembled string — the concatenated partials _are_ the JSON.
Run the helper against one cassette and print the result before trusting either
form.

- [ ] **Step 4: Update the reported figure in the docs**

`CLAUDE.md` and `README.md` both currently say "91% pooled". Replace with the
split — the uncontaminated figure as the headline, the pooled figure and the
reason for the gap alongside.

- [ ] **Step 5: Full suite and commit**

```bash
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
git add tests/ CLAUDE.md README.md
git commit -m "Report extraction recall separately for genes the prompt names"
```

---

## Task 8: Measure v4's guards against v5's relaxation, then write v7

> **Vocabulary hook — v7's canonical sentence.** Widening or narrowing the
> prompt's trait list is a curation decision, and `lib/vocabulary.json` is where
> it is recorded: every term is a tracked trait, a synonym fold, or an
> `untracked` entry with a reason. Author v7's canonical-abbreviation sentence
> from that file and it lands reconciled;
> `tests/pipeline/test_prompt_vocabulary.py` fails otherwise, in both directions
> (a term the vocabulary does not declare, and a vocabulary entry the prompt no
> longer asks for). `_RECALL_BASELINE`'s existing note — "Raise it when the
> prompt is widened" — is the same decision seen from the harness side.
>
> Two entries are already waiting on this task: `ICH-lobar` and `ICH-non-lobar`
> are recorded as `untracked` with the reason that intracerebral haemorrhage is
> haemorrhagic stroke rather than a cSVD imaging marker. If v7 takes on
> haemorrhagic manifestations, promote them to tracked traits in the `stroke`
> family.

**Files:**

- Create: `tests/pipeline/cassettes/test_extraction_golden_v4/` (recorded)
- Modify: `pipeline/prompts.py` (adds `v7`, deletes the losing arm)
- Modify: `tests/pipeline/test_extraction_golden.py` (records both arms)
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: `_PROMPTS` with `v4` and `v6` (Task 3); the verified-quote
  measurement (Task 6).
- Produces: `_PROMPTS` containing `{"v7": ...}` only, and
  `PipelineConfig.prompt_version` defaulting to `"v7"`.

**The question.** v5 loosened two guards (F4). The harness measured 44 extracted
genes against 17 curated rows on PMID 37069360 — high recall, low precision.
Does v4's stricter MTAG and positional-candidate wording recover precision
without costing recall?

**This task's deliverable is a number and a decision, not a refactor.** If v4
does not win, say so and keep v6's wording; the guards are then ruled out rather
than assumed.

- [ ] **Step 1: Temporarily allow v4 for the experiment**

`PipelineConfig.__post_init__` refuses any version in
`PROMPT_VERSIONS_WITHOUT_PROVENANCE`, which after Task 3 is `{"v4"}` — v4
predates the provenance instruction. For the experiment, build a v4 variant that
carries the provenance block, so the only difference between arms is the two
guards:

```python
# v4's guards plus the same provenance block v6 carries, so the two arms
# differ only in the MTAG and positional-candidate wording under test.
# _PROVENANCE_BLOCK was named in Task 3 for exactly this.
_EXTRACTION_INSTRUCTIONS_V4_PROV: Final[str] = (
    _EXTRACTION_INSTRUCTIONS_V4 + _PROVENANCE_BLOCK
)
```

Register it as `"v4p"` in `_PROMPTS`. Because it now contains
`_PROVENANCE_HEADING`, `PROMPT_VERSIONS_WITHOUT_PROVENANCE` will not include it
and `PipelineConfig` will accept `PIPELINE_PROMPT_VERSION=v4p` — which is what
makes the experiment runnable without weakening that guard.

- [ ] **Step 2: Record the v4p arm**

```bash
set -a; . ./.env; set +a
PIPELINE_PROMPT_VERSION=v4p uv run pytest \
  tests/pipeline/test_extraction_golden.py --record-mode=once -q -rs
```

Cassettes must land in a distinct directory so the v6 arm is not overwritten —
parametrise `CASSETTE_DIR` on the prompt version, or record into a scratch
checkout and copy.

- [ ] **Step 3: Compare the two arms on the same fixtures**

Compute, for each of the ten fixtures and both arms: reachable-gene recall, raw
extracted count, and precision against the gold rows. Write the table into the
commit message and into `CLAUDE.md`. The decision rule, fixed **before** looking
at the numbers so it cannot be fitted to them:

> Adopt v4's guards if they raise mean precision by at least 10 percentage
> points while costing no more than 3 points of pooled reachable recall.
> Otherwise keep v6's wording.

- [ ] **Step 4: Write v7**

v7 is the winning arm plus the provenance block plus, per the Opus 5 guidance on
literal instruction-following, the removal of any instruction that duplicates
the confidence gate. The gate at 0.65 already filters; a prompt rule that also
suppresses the same genes filters twice, once irreversibly. Concretely: keep the
`exclude_*` examples that define _what is not evidence_, and drop any wording
that tells the model to withhold a gene it believes has evidence.

Register `v7`, delete `v4`, `v4p` and `v6`, and set
`PipelineConfig.prompt_version`'s default to `"v7"`.

- [ ] **Step 5: Re-record the production cassettes on v7 and re-baseline**

```bash
rm -rf tests/pipeline/cassettes/test_extraction_golden
uv run pytest tests/pipeline/test_extraction_golden.py --record-mode=once -q -rs
```

Update `_RECALL_BASELINE` to the measured values. If PMID 36180795 (GIGASTROKE,
baseline 0.20) improves, say so explicitly — that entry exists because the
prompt targets cSVD while the paper is broad stroke, and it is the one the guard
change is most likely to move.

- [ ] **Step 6: Full suite and commit**

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_WORKSPACE_ID uv run pytest -q -rs
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
git add pipeline/prompts.py tests/ CLAUDE.md
git commit -m "Adopt prompt v7 after measuring v4's guards against v5's relaxation"
```

---

## Task 9: Sweep the effort parameter

**Files:**

- Modify: `CLAUDE.md` (records the measurement)
- Modify: `pipeline/config.py` only if the default changes

**Interfaces:**

- Consumes: `PIPELINE_LLM_EFFORT` (Task 2), the v7 cassettes (Task 8).
- Produces: no new API. Possibly a changed default.

**Why now.** Anthropic's guidance is explicit: `low` and `medium` give strong
quality at a fraction of the tokens, and _"if you carried effort defaults over
from a prior model, re-run an effort sweep on your own evals."_ Until the
extraction harness landed there were no evals to sweep against. There are now.

- [ ] **Step 1: Record each arm**

For `effort` in `low`, `medium`, `high`:

```bash
set -a; . ./.env; set +a
rm -rf /tmp/effort-$EFFORT && mkdir -p /tmp/effort-$EFFORT
PIPELINE_LLM_EFFORT=$EFFORT uv run pytest \
  tests/pipeline/test_extraction_golden.py --record-mode=once -q -rs
```

Record per arm: pooled reachable recall, total output tokens, wall-clock, and
estimated cost. `xhigh` and `max` are out of scope — this task is looking for a
cheaper setting that holds quality, not a more expensive one.

- [ ] **Step 2: Decide and record**

Decision rule, fixed in advance:

> Lower the default to the cheapest arm whose pooled reachable recall is within
> 2 points of `high` and whose verified-quote rate (Task 6) is within 2 points.
> Otherwise keep `high`.

- [ ] **Step 3: Write the numbers into `CLAUDE.md`**

Whatever the outcome, the table goes into `CLAUDE.md` beside the extraction
notes, in the style of the Docling measurements already there — so the next
person does not re-run it, and a future model change has a baseline to beat.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md pipeline/config.py
git commit -m "Sweep extraction effort against the golden harness"
```

---

## Task 10: Raise the paper truncation limit

**Files:**

- Modify: `pipeline/config.py:280-282` (`max_paper_text_chars`)
- Test: `tests/pipeline/test_config.py`

**Interfaces:** none new.

**Why it is last.** `max_paper_text_chars` is 100,000 (~25K tokens), sized for a
200K-token context. Claude Opus 5 has 1M. **This is not currently biting** — the
largest of the ten fixtures is 90 KB — so it is a latent limit rather than an
active fault, and it earns the lowest priority accordingly. A long review or a
supplement-heavy paper would be silently cut.

- [ ] **Step 1: Write the failing test**

```python
def test_the_truncation_limit_is_sized_for_a_1m_context(self) -> None:
    """100,000 chars was a 200K-context limit; Opus 5 has 1M.

    Truncation is still wanted -- an unbounded paper is an unbounded
    bill, and _read_pdf_bytes already caps input at 100 MB -- but the
    ceiling should be a deliberate cost decision rather than a leftover
    from a smaller context window.
    """
    assert PipelineConfig().max_paper_text_chars == 400_000
```

- [ ] **Step 2: Run to verify failure**

```bash
uv run pytest tests/pipeline/test_config.py -k truncation_limit -v
```

Expected: FAIL, `100000 != 400000`.

- [ ] **Step 3: Raise it**

```python
# ~100K tokens of a 1M-token context window, leaving ample room for
# the system prompt, the tool schema, thinking and the response. The
# previous 100,000 was sized for a 200K context. Truncation is still
# wanted: an unbounded paper is an unbounded bill.
max_paper_text_chars: int = field(
    default_factory=lambda: _env_int("PIPELINE_MAX_PAPER_TEXT_CHARS", 400_000)
)
```

- [ ] **Step 4: Confirm no fixture behaviour changes**

```bash
uv run pytest tests/pipeline/ -q
```

Expected: PASS with no cassette re-recording — no fixture exceeds 100,000 chars,
so no request changes.

- [ ] **Step 5: Commit**

```bash
git add pipeline/config.py tests/pipeline/test_config.py .env.example
git commit -m "Size the paper truncation limit for a 1M-token context"
```

---

## Task 11: Split the confidence floor by insert versus update

**Files:**

- Modify: `pipeline/config.py:325` (`confidence_threshold` becomes two fields)
- Modify: `pipeline/data_merger.py:145-155` (apply the insert floor at the
  split)
- Modify: `pipeline/validation.py:221`, `pipeline/main.py:478-498` (the gate
  that runs first becomes the permissive one)
- Modify: `pipeline/report.py:188,216` (the run report names both floors)
- Test: `tests/pipeline/test_data_merger.py`, `tests/pipeline/test_config.py`,
  `tests/pipeline/test_extraction_golden.py` (the sweep)
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: the committed cassettes (Task 8's, on v7) and `_reachable_genes`
  from `tests/pipeline/test_extraction_golden.py`.
- Produces: `PipelineConfig.confidence_threshold_update` (default measured here)
  and `PipelineConfig.confidence_threshold_insert` (default `0.65`).
  `confidence_threshold` is **removed**; every call site names one of the two.

**Why the floor is two numbers.** The gate decides two different things with one
value, and their risk profiles are opposite. Adding a reference to a gene
already in the table is cheap, reversible, and visible in `git diff data/`.
Creating a _new_ row is a scientific claim in a published dataset. Measured
across the 76 extractions in `logs/json/pipeline_report_*.json`, the 0.50-0.64
band holds 23 (gene, paper) pairs: 8 would only update an existing gene — and
that is where every independently confirmed case sits, including `BTN3A2` at
**0.50** — while 15 would insert new rows, taking the table from 63 to 78 in one
step.

**Why the scores cannot be trusted to rank them.** In that same band `BTN3A2`,
confirmed correct by two independent methods, scores 0.50; `LMNB1`, `MRPL38`,
`ACOX1`, `UNK` and `EVPL`, none of them reviewed, score 0.60; and `MAP3K7`
scores 0.50 alongside `RIPK1` and `MLKL` at 0.35, which is the shape of a
pathway-level extraction the prompt explicitly excludes. A single threshold
cannot separate those, which is why this task splits the decision rather than
retuning one number.

**The structural obstacle, and it is the real work here.** The gate currently
runs during _validation_ — `validation.py:221` and, for `--skip-validation`,
`_filter_genes_by_confidence` in `main.py:478` — which is **before**
`merge_gene_entries` calls `get_existing_genes()` and learns which genes are
new. So the split cannot be a config change alone. The permissive floor stays
where the gate is now; the strict floor moves to the insert/update split in
`data_merger.py`. A consequence to handle deliberately: a 0.55 gene will now
pass validation, reach the merge, and be dropped there if it is new, so the run
report's rejected list has to account for genes rejected at the merge and not
only at validation.

**What is swept, and what is not.** Only the update floor. The insert floor
stays at 0.65 as a curation policy, because there is no ground truth for "is
this new gene correct" — the gold standard is a curated subset, so a gene absent
from it is unreviewed, not wrong (the same confound Task 7 documents). Sweeping
a number against a metric that cannot see its errors would produce a figure that
looks measured and is not.

- [ ] **Step 1: Write the sweep**

Post-hoc arithmetic over the committed cassettes: the recorded extractions carry
per-gene `confidence`, so **no new API spend**. Add to
`tests/pipeline/test_extraction_golden.py`:

```python
@requires_recording
def test_the_update_floor_is_set_where_gold_recall_saturates() -> None:
    """Sweep the update floor against recall over reachable gold genes.

    Recall is the only quantity the gold standard can measure honestly
    here: a gene it does not list is unreviewed rather than wrong, so
    "precision" against it would count the curators' inclusion criteria
    as extraction errors. The sweep therefore reports how many non-gold
    genes each floor admits, and asserts only on recall.
    """
    floors = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]
    table: list[tuple[float, float, int]] = []
    for floor in floors:
        hit = total = extra = 0
        for pmid in _GOLDEN_PMIDS:
            reachable = _reachable_genes(pmid)
            if not reachable:
                continue
            admitted = {
                normalize_symbol(g["gene_symbol"])
                for g in _recorded_genes(pmid)
                if g.get("confidence", 0.0) >= floor
            }
            hit += len(reachable & admitted)
            total += len(reachable)
            extra += len(admitted - reachable)
        table.append((floor, hit / total, extra))

    best = max(recall for _, recall, _ in table)
    saturating = min(
        floor for floor, recall, _ in table if recall >= best - 0.02
    )
    report = "\n".join(
        f"    {f:.2f}  recall {r:.0%}  non-gold admitted {e}"
        for f, r, e in table
    )
    assert saturating <= PipelineConfig().confidence_threshold_update + 1e-9, (
        f"the update floor is above where recall saturates ({saturating:.2f}):"
        f"\n{report}"
    )
```

`_recorded_genes(pmid)` returns the full gene dicts, `confidence` included, from
the committed cassette. It is `_recorded_extraction` from Task 7 with the final
`normalize_symbol` set-comprehension removed — factor the decode into a shared
helper rather than writing it twice.

- [ ] **Step 2: Run it and read the table**

```bash
uv run pytest tests/pipeline/test_extraction_golden.py -k update_floor -v
```

It will fail while `confidence_threshold_update` does not exist. Add the field
first with the current 0.65, re-run, and **read the printed table** — the
saturating floor it names is the value Step 3 adopts. Do not pick a number
before seeing it.

- [ ] **Step 3: Split the field**

In `pipeline/config.py`, replace `confidence_threshold`:

```python
# Floor for adding a reference to a gene already in the table. Cheap
# and reversible, so it sits where recall saturates -- see the sweep
# in tests/pipeline/test_extraction_golden.py.
confidence_threshold_update: float = field(
    default_factory=lambda: _env_float(
        "PIPELINE_CONFIDENCE_THRESHOLD_UPDATE", 0.50
    )
)
# Floor for creating a new curated row. Deliberately not swept: the
# gold standard is a curated subset, so it cannot tell an incorrect
# new gene from an unreviewed one, and a number tuned against it
# would look measured without being so. 0.65 is a curation policy.
confidence_threshold_insert: float = field(
    default_factory=lambda: _env_float(
        "PIPELINE_CONFIDENCE_THRESHOLD_INSERT", 0.65
    )
)
```

Replace the 0.50 default with whatever Step 2 actually printed.

- [ ] **Step 4: Point the two gates at the two floors**

`validation.py:221` and `main.py:487` use `confidence_threshold_update` — they
run before the merge knows what is new, so they must be the permissive one. Then
in `data_merger.py`, apply the strict floor at the split:

```python
    to_insert: list[dict[str, Any]] = []
    to_update: list[dict[str, Any]] = []
    below_insert_floor: list[str] = []

    for gene_upper, entries_for_gene in grouped.items():
        gene_data = _build_combined_gene_data(entries_for_gene)
        if gene_upper in existing_genes:
            to_update.append(gene_data)
            continue
        # A new row is a scientific claim in a published dataset, so it
        # answers to the stricter floor. The permissive floor upstream
        # let this entry through on purpose: it may still be a correct
        # reference for a gene that already exists.
        best = max(entry.confidence for entry in entries_for_gene)
        if best < config.confidence_threshold_insert:
            below_insert_floor.append(gene_upper)
            continue
        to_insert.append(gene_data)

    if below_insert_floor:
        logger.info(
            f"  {len(below_insert_floor)} new gene(s) held below the "
            f"{config.confidence_threshold_insert} insert floor: "
            f"{', '.join(sorted(below_insert_floor))}"
        )
```

`merge_gene_entries` takes no `config` today — add
`config: PipelineConfig |
None = None` defaulting to `PipelineConfig()`,
matching `llm_extraction.extract_from_paper`.

- [ ] **Step 5: Test the asymmetry directly**

```python
async def test_a_low_confidence_entry_updates_an_existing_gene(self, mocker):
    """The case this task exists for: BTN3A2 at 0.50 was correct."""
    ...  # existing_genes contains "NOTCH3"; entry confidence 0.50
    inserted, updated = await merge_gene_entries([entry])
    assert (inserted, updated) == (0, 1)


async def test_a_low_confidence_entry_does_not_create_a_new_gene(self, mocker):
    """The same score on an unknown gene creates nothing."""
    ...  # existing_genes empty; entry confidence 0.50
    inserted, updated = await merge_gene_entries([entry])
    assert (inserted, updated) == (0, 0)
```

- [ ] **Step 6: Report both floors**

`report.py:188,216` write `confidence_threshold` into the run data. Emit both
names, and add the merge-held genes to the rejected section so a gene dropped at
the merge is as visible as one dropped at validation.

- [ ] **Step 7: Update `CLAUDE.md` and `.env.example`**

Replace the calibration bullet's closing pointer — it currently says the finding
is what Task 8 has to argue against, and Task 8 is about prompt guards. It is
this task. Record the swept value and the reason the insert floor was not swept.

- [ ] **Step 8: Full suite and commit**

```bash
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch
uv run ruff check . && uv run ty check
git add pipeline/ tests/ CLAUDE.md .env.example
git commit -m "Split the confidence floor by insert versus update"
```

---

## Verification

Run after the final task:

```bash
# Python: lint, types, tests, coverage floor
uv run ruff check .
uv run ty check
uv run pytest -q --cov=pipeline --cov=pipeline/alembic --cov-branch

# The harness replays with no credentials, exactly as CI does
env -u ANTHROPIC_API_KEY -u ANTHROPIC_WORKSPACE_ID \
  uv run pytest tests/pipeline/test_extraction_golden.py -q -rs

# No credential or account identifier reached a cassette
uv run pytest tests/pipeline/test_extraction_golden.py -k credential -v

# The TypeScript side is untouched, but the repo gates on both
deno task check
deno task test
```

Manual checks no test can make:

1. **A real end-to-end run.** `uv run python pipeline/main.py --pmids <file>`
   over three papers, with `PIPELINE_REQUIRE_VERIFIED_QUOTES` unset. Confirm the
   log's `Provenance: N/M quotes matched` line, and that N/M is high. A low rate
   is a finding about the prompt, not a bug in Task 6.
2. **One quote checked by hand.** Take a verified span's
   `start_char_index`/`end_char_index`, slice the fixture file at those offsets,
   and confirm it is the sentence. This proves the offsets index the bytes
   actually sent — the assumption Task 4 rests on.
3. **A batch run.** `--batch` shares the request shape through `config`, but
   citations plus strict tool use on the Batch API has not been probed here. Run
   one small batch before trusting it, and note that the server-side `fallbacks`
   parameter is unavailable on that path, so Task 1's client-side refusal
   handling is the only guard there.
