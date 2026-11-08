"""Static OMIM lookup, ported from export.R step 7.

The CSV is UTF-8, as every file in this repository is. It was Mac Roman
until the seven stray 0xCA bytes it carried -- U+00A0 non-breaking spaces
pasted in from omim.org -- were folded into ordinary spaces at the source,
which left the file pure ASCII. A UTF-8 decode now raises on a Mac Roman
re-paste instead of quietly admitting one, which is the point: the old
decode accepted that byte silently, and a latin-1 decode would have turned
it into a visible "Ê".

The reader still folds U+00A0 because the source of this data is web
copy-paste and a correctly-encoded non-breaking space is the next thing to
arrive that way.
"""

import csv
import io
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Final

from pipeline.disease import OMIM_CSV_PATH

_COLUMNS: Final[tuple[str, ...]] = (
    "omim_num",
    "omim_link",
    "phenotype",
    "inheritance",
    "gene_or_locus",
    "gene_or_locus_mim_number",
)

DEFAULT_OMIM_CSV: Final[Path] = OMIM_CSV_PATH

# A published monogenic link is a six-digit MIM number or a sentinel such as
# "(none found)"; only the numbers name an OMIM entry.
_MIM_NUMBER: Final[re.Pattern[str]] = re.compile(r"\d{6}")


def read_omim_csv(path: Path = DEFAULT_OMIM_CSV) -> list[dict[str, Any]]:
    """Read the OMIM table, folding non-breaking spaces into normal ones."""
    text = path.read_text(encoding="utf-8")
    reader = csv.DictReader(io.StringIO(text))
    rows: list[dict[str, Any]] = []
    for raw in reader:
        row: dict[str, Any] = {}
        for column in _COLUMNS:
            # Fold the non-breaking space into a normal one, then collapse
            # whitespace runs rather than a bare .strip(): a nbsp at a field
            # boundary would yield to .strip() alone, but one adjacent to an
            # already-present space -- as in "AD,<nbsp>AR", the row that
            # motivated this before the source was cleaned -- would otherwise
            # leave a double space in the display text. split()/join()
            # collapses that case too and is a no-op everywhere the committed
            # CSV doesn't need it (verified by the byte-identity test).
            value = " ".join((raw.get(column) or "").replace("\xa0", " ").split())
            # omimNum is a number in the contract; every other field a string.
            row[column] = int(value) if column == "omim_num" and value else value
        rows.append(row)
    return rows


def referenced_omim_rows(
    rows: Iterable[dict[str, Any]], links: Iterable[str]
) -> list[dict[str, Any]]:
    """The OMIM rows a published gene links to, in the CSV's order.

    `disease/omim_info.csv` is a reference table that outlives the genes
    that cite it: a row for a gene curation removed, or a number nobody
    links to, would otherwise ship in a public bundle and be read as part
    of the dashboard's evidence. `links` are the published genes' monogenic
    links; anything in them that is not a six-digit number is ignored.
    """
    numbers = (link.strip() for link in links)
    wanted = {int(number) for number in numbers if _MIM_NUMBER.fullmatch(number)}
    return [row for row in rows if row["omim_num"] in wanted]
