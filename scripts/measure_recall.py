"""Measure what the production PubMed query retrieves of the gold set.

    uv run python -m scripts.measure_recall [--write-baseline]

Runs the same `(query) AND (uid disjunction)` request the recall test does,
prints every matched and missed PMID with its title, and with
--write-baseline records the result in disease/recall_baseline.json for
tests/pipeline/test_query_recall_gold.py to replay. Record that test's
cassette afterwards:

    uv run pytest tests/pipeline/test_query_recall_gold.py --record-mode=once

The gold set is disease/recall_gold.csv plus every PMID data/table1.json
cites (see pipeline/query_eval.py). With nothing in either there is nothing
to measure, and the script says so rather than printing a recall of zero.
"""

import argparse
import asyncio
import sys
from collections.abc import Sequence

from dotenv import load_dotenv

from pipeline.config import PROJECT_ROOT
from pipeline.pubmed_search import SVD_QUERY
from pipeline.query_eval import (
    RECALL_BASELINE_JSON,
    close_http_client,
    fetch_titles,
    gold_pmids,
    measure_recall,
    write_baseline,
)


async def _run(write: bool) -> int:
    gold = gold_pmids()
    if not gold:
        print(
            "disease/recall_gold.csv has no rows and data/table1.json cites "
            "nothing; nothing to measure.",
            file=sys.stderr,
        )
        return 1
    try:
        result = await measure_recall(SVD_QUERY, gold)
        titles = await fetch_titles(gold)
    finally:
        await close_http_client()
    print(f"Recall: {len(result.matched)} of {result.total}")
    for heading, pmids in (("Matched", result.matched), ("Missed", result.missed)):
        print(f"\n{heading} ({len(pmids)}):")
        for pmid in sorted(pmids):
            print(f"  {pmid}  {titles.get(pmid, '(title unavailable)')}")
    if write:
        write_baseline(result, SVD_QUERY, RECALL_BASELINE_JSON)
        print(f"\nWrote {RECALL_BASELINE_JSON.relative_to(PROJECT_ROOT)}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    load_dotenv(PROJECT_ROOT / ".env")
    parser = argparse.ArgumentParser(
        description="Measure the PubMed query's recall over the gold set."
    )
    parser.add_argument(
        "--write-baseline",
        action="store_true",
        help="record the result in disease/recall_baseline.json",
    )
    args = parser.parse_args(argv)
    return asyncio.run(_run(args.write_baseline))


if __name__ == "__main__":
    raise SystemExit(main())
