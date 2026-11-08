"""The dashboard's gold-only switch, read from ``lib/gold_only.ts``.

While ``GOLD_ONLY`` is true the dashboard publishes only the hand-curated
tables, so nothing may put a row the curators did not write into the
database the next export reads: ``pipeline.main`` refuses ``--pubmed`` and
``--clinical-trials``. The TypeScript constant is the one switch, and this
reads it rather than restating it, so flipping that one line lifts the
refusal too. The undo checklist is the constant's doc comment.

Stdlib only, like ``pipeline.disease``.
"""

import re
from pathlib import Path
from typing import Final

GOLD_ONLY_SOURCE: Final = (
    Path(__file__).resolve().parent.parent / "lib" / "gold_only.ts"
)

_DECLARATION: Final = re.compile(r"^export const GOLD_ONLY = (true|false);$", re.M)


def gold_only(source: Path = GOLD_ONLY_SOURCE) -> bool:
    """Whether *source* sets ``GOLD_ONLY`` to ``true``.

    Raises ValueError when the file no longer declares it as a bare boolean
    literal: a reader that guessed would either refuse every run or let a
    run through while the dashboard is gold-only.
    """
    match = _DECLARATION.search(source.read_text(encoding="utf-8"))
    if match is None:
        raise ValueError(
            f"{source} no longer declares `export const GOLD_ONLY = true;` "
            "or `= false;` on a line of its own"
        )
    return match.group(1) == "true"
