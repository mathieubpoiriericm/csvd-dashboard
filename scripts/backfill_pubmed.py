"""Walk a long PubMed window as a sequence of committed runs.

**This is optional.** `pipeline/checkpoint.py` already makes a single
`--days-back 365` run survivable: every paper is appended to
`logs/pipeline_checkpoint.jsonl` as it finishes, so re-running the same command
after a crash restores the extraction instead of paying for it again. Reach for
this script for the other thing chunking gives you -- the database updated as
the backfill proceeds rather than in one write at the end, and a bound on how
much any single run holds in memory.

`--days-back` always means "the last N days from now", so the chunks are
*cumulative* rather than tiled: 30, 60, 90 ... Each one records its own PMIDs
in `pubmed_refs` before the next begins, and every later window deduplicates
against them in `_discover_new_pmids`, so the overlap costs one PubMed search
and no extraction.

The chunks are separate runs, so batch cross-validation (`_run_batch_validation`)
sees one chunk at a time rather than the whole year. That is the trade, and it
is why chunking is not the default answer to a crash: the checkpoint costs
nothing in that direction.

Run it as a module, not as a path: `uv run scripts/...` puts scripts/ on
sys.path rather than the repo root, and the pipeline imports below would not
resolve.

    uv run python -m scripts.backfill_pubmed [--days-back 365] [--step 30]
"""

import argparse
import asyncio
import logging
from collections.abc import Sequence

from dotenv import load_dotenv

from pipeline.config import PipelineConfig
from pipeline.database import Database
from pipeline.main import run_pipeline

logger = logging.getLogger(__name__)

DEFAULT_DAYS_BACK = 365
DEFAULT_STEP = 30


def plan_windows(days_back: int, step: int) -> list[int]:
    """The ascending ``--days-back`` windows that cover *days_back*.

    Cumulative, because that is what the flag means, and ending exactly on
    *days_back* so the last chunk is never skipped or double-counted.
    """
    if days_back < 1:
        raise ValueError(f"days_back must be >= 1, got {days_back}")
    if step < 1:
        raise ValueError(f"step must be >= 1, got {step}")
    windows = list(range(step, days_back, step))
    windows.append(days_back)
    return windows


async def run_backfill(
    windows: Sequence[int],
    *,
    use_batch_api: bool = False,
    config: PipelineConfig | None = None,
) -> list[int]:
    """Run each window in turn; return papers processed per completed window.

    ``manage_lifecycle=False`` keeps the connection pool open across windows
    and suppresses a completion notification per chunk -- the same thing
    `main()` does when it dispatches several pipelines in one invocation. The
    pool is closed here instead, once, including on the way out of a failure.
    """
    processed: list[int] = []
    try:
        for index, window in enumerate(windows, start=1):
            logger.info(
                "Window %d/%d: last %d days", index, len(windows), window
            )
            metrics, _ = await run_pipeline(
                days_back=window,
                use_batch_api=use_batch_api,
                config=config,
                manage_lifecycle=False,
            )
            processed.append(metrics.papers_processed)
            logger.info(
                "Window %d/%d done: %d papers processed and committed",
                index,
                len(windows),
                metrics.papers_processed,
            )
    finally:
        await Database.close()
    return processed


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Backfill PubMed in committed chunks."
    )
    parser.add_argument(
        "--days-back",
        type=int,
        default=DEFAULT_DAYS_BACK,
        help=f"Total window to cover (default: {DEFAULT_DAYS_BACK}).",
    )
    parser.add_argument(
        "--step",
        type=int,
        default=DEFAULT_STEP,
        help=(
            "Days added per chunk (default: %(default)s). Smaller chunks lose"
            " less to a crash and narrow the batch cross-validation window."
        ),
    )
    parser.add_argument(
        "--batch",
        action="store_true",
        help="Extract via the Batch API at half price, as pipeline/main.py does.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    load_dotenv()
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    args = _build_parser().parse_args(argv)

    try:
        windows = plan_windows(args.days_back, args.step)
    except ValueError as exc:
        logger.error("%s", exc)
        return 2

    logger.info(
        "Backfilling %d days in %d chunks: %s",
        args.days_back,
        len(windows),
        ", ".join(str(w) for w in windows),
    )
    try:
        processed = asyncio.run(run_backfill(windows, use_batch_api=args.batch))
    except Exception:
        logger.exception(
            "Backfill stopped. Completed chunks have committed their PMIDs; "
            "re-run the same command to resume from where it stopped."
        )
        return 1

    logger.info("Backfill complete: %d papers processed", sum(processed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
