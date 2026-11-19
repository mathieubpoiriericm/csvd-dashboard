"""Where a paper's answer lives once validation has decided, over every case.

`pipeline.main._disposition` is the one place the pipeline decides it; the
call sites do the checkpoint and batch-record writes the answer names. The
expected home here is written from the law (PR C row 1 of
docs/superpowers/specs/2026-11-19-open-items-design.md, restated on
19 November), not read from the function, and the example tests of each call
site stay in `test_main_orchestration.py`.

The names are plain strings so the law reads without the code's types; the
test turns them into the enum members by name.
"""

import itertools
from collections import Counter

import pipeline.main as pipeline_main

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
HOMES = ("FINISHED", "UNVALIDATED", "BATCH_RECORD", "NONE")

# One label per answer the law gives, so a clause no cell reaches fails.
CLAUSES = (
    "no such case",
    "a run that writes nothing keeps nothing",
    "(d) a failed fetch stays owed on --batch, as today",
    "(d) no text is finished, as today",
    "(d) no text whose append failed: --batch record, else no home",
    "no answer to keep",
    "a failed rescue request leaves the refusal owed on --batch",
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
    without its validation or a validation without an answer.
    """
    if (validation is not None) != (outcome in ANSWERED):
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
        return no_append, "a failed rescue request leaves the refusal owed on --batch"

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


def cells():
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


def test_the_questions_a_call_site_cannot_tell_apart_have_one_answer() -> None:
    """Two call sites ask about outcomes they cannot distinguish.

    `_paper_finished_hook` sees a finished `PaperResult`, which does not say
    whether its answer was extracted, rescued, replayed or never asked for
    (no text), so it asks as an extraction that held. `process_paper` does
    not tell a streaming fallback's answer from the primary's, so it asks
    as an extraction. Each is right only while those outcomes share a home.
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
        finished = {
            (outcome, validation): disposition(
                **run, outcome=outcome, validation=validation
            )
            for outcome, validation in (
                ("EXTRACTED", "HELD"),
                ("RESCUED", "HELD"),
                ("REPLAYED", "HELD"),
                ("NO_TEXT", None),
            )
        }
        compared += len(finished)
        assert len(set(finished.values())) == 1, (
            name({**run, "outcome": "*", "validation": "HELD"}),
            finished,
        )
        if batched:
            continue
        for validation in VALIDATIONS[1:]:
            pair = [
                disposition(**run, outcome=outcome, validation=validation)
                for outcome in ("EXTRACTED", "RESCUED")
            ]
            compared += len(pair)
            assert pair[0] == pair[1], (
                name({**run, "outcome": "EXTRACTED/RESCUED", "validation": validation}),
                pair,
            )

    # 8 runs x 4 finished outcomes, and 4 streaming runs x 3 validations x 2.
    assert compared == 8 * 4 + 4 * 3 * 2
