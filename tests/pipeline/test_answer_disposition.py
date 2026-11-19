"""Where a paper's answer lives once validation has decided, over every case.

`pipeline.main._disposition` gives the home; the call sites do the
checkpoint and batch-record writes it names. The expected home here is
written from this law, not read from the function:

(a) An answer whose validation held is checkpointed as finished; if that
    append fails, it stays on the batch record on the ``--batch`` path.
(b) An answer an NCBI outage cut short keeps the home it already has. One
    paid at the streaming rate (a streaming paper, or a ``--batch`` rescue)
    is checkpointed as unvalidated, or, if that append fails, stays on the
    batch record on ``--batch``. A replay keeps its stored unvalidated
    record. On the streaming path a failed append of either kind has no
    home: it is logged, and the paper is extracted afresh next run.
(c) An answer that failed validation on its own is kept nowhere and leaves
    the batch record.
(d) A paper whose fetch failed or that has no text paid for no answer and
    is decided as the code decides it: a failed fetch
    stays owed on the batch record on ``--batch`` and has no home on the
    streaming path; no text is checkpointed as finished, as in (a).

A refused paper the fallback model rescued is a fresh answer, under (a) to
(c). Two rulings of 19 November 2026 settle cases the law above leaves
open: a ``--batch`` run's own answer cut short by an outage stays on the
batch record with nothing appended, so the next run collects the same paid
answer again; and a replay that held but whose finished append failed is
decided as (a) decides it, while its stored unvalidated record survives
until the merge and the next run replays it.

Beside the law, four cases are pinned as the code decides them: a run that
writes nothing (a dry run, test mode, an offline mode) keeps nothing; no
usable answer (a failed extraction, a paper both models declined, a batch
entry with no result) is kept nowhere; a rescue whose request failed leaves
the batch's refusal on the batch record; and a replay that failed on its
own is dropped, whether or not the best-effort removal succeeds.

The names are plain strings so the law reads without the code's types; the
test turns them into the enum members by name. The example tests of each
call site are in `test_main_orchestration.py`, and the rescue an outage cut
short is driven through the real code at the end of this file.
"""

import itertools
from collections import Counter
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pipeline.main as pipeline_main
from pipeline import batch_state, checkpoint
from pipeline.batch_state import PendingBatch
from pipeline.citations import reset_tally
from pipeline.config import PipelineConfig
from pipeline.extraction_models import GeneEntry, ServedBy
from pipeline.quality_metrics import PipelineMetrics, TokenUsage
from pipeline.validation import NcbiUnavailableError

# How a paper reached the question: the five outcomes the law names, then
# the two the code decides beside them (a model that answered nothing
# usable, and a rescue whose request failed before either model answered).
OUTCOMES = (
    "FETCH_FAILED",
    "NO_TEXT",
    "EXTRACTED",
    "RESCUED",
    "REPLAYED",
    "NO_ANSWER",
    "RESCUE_FAILED",
)
# None: no validation ran, which is every outcome that brought no answer.
VALIDATIONS = (None, "HELD", "NCBI_OUTAGE", "OWN_FAILURE")
ANSWERED = frozenset({"EXTRACTED", "RESCUED", "REPLAYED"})
# The rescue is the --batch path's own request; streaming has none.
BATCH_ONLY = frozenset({"RESCUED", "RESCUE_FAILED"})
HOMES = ("FINISHED", "UNVALIDATED", "BATCH_RECORD", "NONE")

# One label per answer the law gives, so a clause no cell reaches fails.
CLAUSES = (
    "no such case",
    "a run that writes nothing keeps nothing",
    "(d) a failed fetch stays owed on --batch, as today",
    "(d) no text is finished, as today",
    "(d) no text whose append failed: --batch record, else no home",
    "no answer to keep",
    "a failed rescue request leaves the refusal on the batch record",
    "(c) an answer that failed on its own is kept nowhere",
    "(a) held: finished",
    "(a) held, append failed: --batch record, else no home",
    "(b) a replay keeps its stored record",
    "(b) the batch's own answer stays on the batch record",
    "(b) a streaming-rate answer is stored unvalidated",
    "(b) a streaming-rate answer whose append failed: --batch record, else no home",
)


def home_by_law(
    *,
    batched: bool,
    checkpointing: bool,
    outcome: str,
    validation: str | None,
    append_ok: bool,
) -> tuple[str, str]:
    """The home the law gives a paper, and the clause that gives it.

    "REFUSED" is not a home: it is a question no run can ask, an answer
    without its validation, a validation without an answer, or a rescue on
    the streaming path.
    """
    if (validation is not None) != (outcome in ANSWERED):
        return "REFUSED", "no such case"
    if not batched and outcome in BATCH_ONLY:
        return "REFUSED", "no such case"
    if not checkpointing:
        # A dry run, test mode or an offline mode writes nothing at all.
        return "NONE", "a run that writes nothing keeps nothing"
    # Where an append that failed leaves a paper: the --batch path keeps it
    # on the batch record, and the streaming path has no other copy.
    no_append = "BATCH_RECORD" if batched else "NONE"

    # (d) and the two cases beside it: nothing reached validation.
    if outcome == "FETCH_FAILED":
        return no_append, "(d) a failed fetch stays owed on --batch, as today"
    if outcome == "NO_TEXT":
        if append_ok:
            return "FINISHED", "(d) no text is finished, as today"
        return (
            no_append,
            "(d) no text whose append failed: --batch record, else no home",
        )
    if outcome == "NO_ANSWER":
        return "NONE", "no answer to keep"
    if outcome == "RESCUE_FAILED":
        return (
            "BATCH_RECORD",
            "a failed rescue request leaves the refusal on the batch record",
        )

    # (c)
    if validation == "OWN_FAILURE":
        return "NONE", "(c) an answer that failed on its own is kept nowhere"
    # (a), whatever the answer's outcome. For a replay whose append failed
    # this is the call sites' decision; its stored record survives as well.
    if validation == "HELD":
        if append_ok:
            return "FINISHED", "(a) held: finished"
        return no_append, "(a) held, append failed: --batch record, else no home"
    # (b) an NCBI outage keeps the home the answer already has.
    if outcome == "REPLAYED":
        return "UNVALIDATED", "(b) a replay keeps its stored record"
    if batched and outcome == "EXTRACTED":
        return "BATCH_RECORD", "(b) the batch's own answer stays on the batch record"
    # Paid at the streaming rate: a streaming paper or a --batch rescue.
    if append_ok:
        return "UNVALIDATED", "(b) a streaming-rate answer is stored unvalidated"
    return (
        no_append,
        "(b) a streaming-rate answer whose append failed: --batch record, else no home",
    )


def disposition(
    *,
    batched: bool,
    checkpointing: bool,
    outcome: str,
    validation: str | None,
    append_ok: bool,
) -> str:
    """`_disposition`'s home for the cell, by name, or "REFUSED" if it raised."""
    try:
        home = pipeline_main._disposition(
            pipeline_main._Outcome[outcome],
            None if validation is None else pipeline_main._Validation[validation],
            batched=batched,
            checkpointing=checkpointing,
            append_ok=append_ok,
        )
    except ValueError:
        return "REFUSED"
    return home.name


def cells() -> Iterator[dict[str, Any]]:
    """Every cell: path, checkpointing, outcome, validation, append."""
    for batched, checkpointing, outcome, validation, append_ok in itertools.product(
        (False, True), (True, False), OUTCOMES, VALIDATIONS, (True, False)
    ):
        yield {
            "batched": batched,
            "checkpointing": checkpointing,
            "outcome": outcome,
            "validation": validation,
            "append_ok": append_ok,
        }


def name(cell: dict) -> str:
    path = "--batch" if cell["batched"] else "streaming"
    run = "" if cell["checkpointing"] else ", writing nothing"
    append = "append ok" if cell["append_ok"] else "append failed"
    return (
        f"{path}{run}: {cell['outcome']}, validation {cell['validation']}, {append}"
    )


def test_every_paid_answer_has_the_home_the_law_gives_it() -> None:
    homes: Counter[str] = Counter()
    clauses: Counter[str] = Counter()
    wrong: list[str] = []

    for cell in cells():
        expected, clause = home_by_law(**cell)
        actual = disposition(**cell)
        homes[expected] += 1
        clauses[clause] += 1
        if actual != expected:
            wrong.append(f"{name(cell)}: the law says {expected}, got {actual}")

    assert not wrong, "\n".join(wrong)
    # 2 paths x 2 run kinds x 7 outcomes x 4 validations x 2 appends.
    assert homes.total() == 224
    assert set(homes) == {*HOMES, "REFUSED"}, homes
    assert set(clauses) == set(CLAUSES), set(CLAUSES) ^ set(clauses)


def test_every_finished_paper_has_the_home_the_hook_asks_for() -> None:
    """The hook asks one question for every finished paper.

    `_paper_finished_hook` sees a finished `PaperResult`, which does not say
    whether its answer was extracted, rescued, replayed or never asked for
    (no text), so it asks as an extraction that held. That is right only
    while each of those has the home an extraction that held has.
    """
    compared = 0
    for batched, checkpointing, append_ok in itertools.product(
        (False, True), (True, False), (True, False)
    ):
        run = {
            "batched": batched,
            "checkpointing": checkpointing,
            "append_ok": append_ok,
        }
        finished = [("EXTRACTED", "HELD"), ("REPLAYED", "HELD"), ("NO_TEXT", None)]
        if batched:
            finished.append(("RESCUED", "HELD"))
        homes = {
            (outcome, validation): disposition(
                **run, outcome=outcome, validation=validation
            )
            for outcome, validation in finished
        }
        compared += len(homes)
        assert "REFUSED" not in homes.values(), homes
        assert len(set(homes.values())) == 1, (
            name({**run, "outcome": "*", "validation": "HELD"}),
            homes,
        )

    # 4 streaming runs x 3 finished outcomes, and 4 --batch runs x 4.
    assert compared == 4 * 3 + 4 * 4


def _gene(symbol: str, pmid: str | None = None) -> GeneEntry:
    return GeneEntry(
        gene_symbol=symbol,
        confidence=0.9,
        source_quote=f"{symbol} is mentioned.",
        pmid=pmid,
    )


async def test_an_unstorable_rescue_cut_short_by_an_outage_stays_on_the_batch_record(
    mocker, tmp_path: Path
) -> None:
    """(b) on --batch, through the real code: a rescue whose append failed.

    The batch declined 222 and the fallback model answered it at the
    streaming rate; NCBI did not answer its validation, and the checkpoint
    would not take the unvalidated record. The batch record is then the only
    durable trace of the paper: its entry is the batch's refusal, which the
    next run collects for nothing before rescuing again, instead of paying
    for a new entry the primary model declines once more. 111, which the
    batch answered and validation passed, is checkpointed as finished and
    comes off the record.
    """
    reset_tally()
    config = PipelineConfig(
        checkpoint_file=str(tmp_path / "checkpoint.jsonl"),
        batch_state_file=str(tmp_path / "batch_state.json"),
        progress_file=str(tmp_path / "progress.json"),
    )
    batch_state.save(
        config.batch_state_file,
        checkpoint.fingerprint(config),
        [PendingBatch("msgbatch_old", {"111": "ab", "222": "cd"})],
    )
    mocker.patch(
        "pipeline.main._fetch_paper_text_for_batch",
        new=AsyncMock(return_value=("paper text", False, "abstract")),
    )

    async def submit(
        papers, config, *, usage=None, refusals=None, state_path=None, reused=None
    ):
        assert refusals is not None
        refusals["222"] = "bio"
        return {"111": [_gene("GENE1", "111")]}

    async def rescue(text, pmid, *, config, rate_limiter, model, declined):
        return (
            [_gene("GENE2")],
            TokenUsage(input_tokens=700, output_tokens=70),
            ServedBy(model=model, declined=declined),
        )

    async def validate(genes, metrics, config):
        if genes[0].gene_symbol == "GENE2":
            raise NcbiUnavailableError("NCBI down")
        return genes, []

    real_append = checkpoint.append

    def append(path, fingerprint, record):
        if "unvalidated" in record:
            raise OSError("read-only file system")
        real_append(path, fingerprint, record)

    mocker.patch("pipeline.main.submit_and_collect", new=submit)
    mocker.patch("pipeline.main.extract_from_paper", new=AsyncMock(side_effect=rescue))
    mocker.patch("pipeline.main._validate_genes", new=validate)
    mocker.patch("pipeline.checkpoint.append", side_effect=append)

    batch = await pipeline_main._process_new_pmids_via_batch(
        ["111", "222"],
        PipelineMetrics(),
        config,
        pipeline_main._ProgressReporter(config),
    )

    results = {r.pmid: r for r in batch.results}
    assert results["111"].succeeded
    assert results["222"].error == "NCBI down"
    records = checkpoint.load(config.checkpoint_file, checkpoint.fingerprint(config))
    assert [r["result"]["pmid"] for r in records if "result" in r] == ["111"]
    assert not [r for r in records if "unvalidated" in r]
    on_record = {
        pmid
        for pending in batch_state.load(
            config.batch_state_file, checkpoint.fingerprint(config)
        )
        for pmid in pending.document_sha256
    }
    assert on_record == {"222"}
