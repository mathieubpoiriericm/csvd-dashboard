"""Canonical cross-reference identifiers.

Three APIs spell the same identifier three ways. ClinVar returns
``db_source="MONDO"`` with ``db_id="MONDO:0010829"`` but ``db_source="Orphanet"``
with a bare ``199354``; Orphadata returns a bare ``0010829`` for MONDO; Open
Targets returns ``MONDO_0014768`` and ``Orphanet_199354``. Nothing cross-links
until one spelling wins, so every identifier is normalised on the way in and
only the canonical ``PREFIX:LOCALID`` form is stored.

A prefix this pipeline does not store returns ``None`` rather than a
pass-through. Orphadata alone returns GARD, ICD-10, ICD-11, MedDRA and MeSH
alongside the ones here; storing an identifier nothing can interpret would make
the annotations table look richer than it is.
"""

import logging
import re
from typing import Final

logger = logging.getLogger(__name__)

# Output capitalisation for each prefix this pipeline stores. Lookup is
# case-insensitive; the value is what gets written.
_PREFIXES: Final[dict[str, str]] = {
    "efo": "EFO",
    "ensembl": "Ensembl",
    "hgnc": "HGNC",
    "go": "GO",
    "hp": "HP",
    "medgen": "MedGen",
    "mesh": "MeSH",
    "mondo": "MONDO",
    "omim": "OMIM",
    "orphanet": "Orphanet",
    "umls": "UMLS",
}

# Orphadata calls it an ORPHAcode, ClinVar's db_source is "Orphanet", and OMIM
# is "MIM" in some payloads. All three name the same authority.
_PREFIX_ALIASES: Final[dict[str, str]] = {
    "orpha": "orphanet",
    "orphacode": "orphanet",
    "mim": "omim",
}

# ClinVar separates with ":", Open Targets with "_".
_SEPARATOR: Final[re.Pattern[str]] = re.compile(r"[:_]")

# Authorities whose local id is a fixed-width zero-padded number. Orphadata
# returns MONDO both ways -- ``MONDO:0018831`` and ``MONDO:18831`` name one
# disease -- so nothing joins until the width is normalised, and the short form
# resolves to nothing at all if it is published. Six of the 575 MONDO
# identifiers in the live table arrive short. ORPHAcodes and HGNC ids are
# genuinely unpadded and are deliberately absent from this table.
_ZERO_PADDED_WIDTH: Final[dict[str, int]] = {
    "EFO": 7,
    "GO": 7,
    "HP": 7,
    "MONDO": 7,
}

# The shape each authority's local id takes. A prefix this pipeline stores
# carrying a value it cannot interpret is rejected rather than stored, for the
# same reason an unknown prefix is: the table must not look richer than it is.
# Measured against every distinct identifier in the live table -- MeSH runs to
# nine digits (D000090542), MedGen has a CN series, and OMIM has phenotypic
# series alongside its six-digit entries.
_PADDED_NUMERIC_ID: Final[re.Pattern[str]] = re.compile(r"\d{1,7}$")
_NUMERIC_ID: Final[re.Pattern[str]] = re.compile(r"\d+$")
_LOCAL_ID_SHAPES: Final[dict[str, re.Pattern[str]]] = {
    "EFO": _PADDED_NUMERIC_ID,
    "Ensembl": re.compile(r"ENSG\d+$"),
    "GO": _PADDED_NUMERIC_ID,
    "HGNC": _NUMERIC_ID,
    "HP": _PADDED_NUMERIC_ID,
    "MONDO": _PADDED_NUMERIC_ID,
    "MedGen": re.compile(r"CN?\d+$"),
    "MeSH": re.compile(r"[CD]\d+$"),
    "OMIM": re.compile(r"(?:PS)?\d{6}$"),
    "Orphanet": _NUMERIC_ID,
    "UMLS": re.compile(r"C\d+$"),
}

# An OMIM phenotypic series names a *group* of phenotypes, not one entry.
# ClinVar returns them beside six-digit entry numbers, and they are kept --
# they are real identifiers -- but a consumer keyed on entry numbers can never
# resolve one, so the export publishes them as a broader concept rather than as
# the disease's own OMIM number.
_OMIM_SERIES: Final[re.Pattern[str]] = re.compile(r"PS\d+$")


def canonical_xref(source: str, reference: str) -> str | None:
    """Return ``PREFIX:LOCALID`` for one source/reference pair, or None.

    ``reference`` may already carry a prefix -- ClinVar's MONDO does, its
    Orphanet does not. Any prefix on the value is dropped and ``source`` wins,
    because that is the field the API guarantees.

    The local id is normalised too, not only the prefix. Zero-padding is what
    makes Orphadata's MONDO ids join ClinVar's; a value whose shape the
    authority does not use is rejected and logged rather than stored.
    """
    key = source.strip().lower()
    key = _PREFIX_ALIASES.get(key, key)
    prefix = _PREFIXES.get(key)
    if prefix is None:
        return None
    local = _SEPARATOR.split(reference.strip(), maxsplit=1)[-1].strip()
    if not local:
        return None
    if not _LOCAL_ID_SHAPES[prefix].fullmatch(local):
        # Logged rather than dropped in silence: an authority that changes its
        # identifier format should show up as a message, not as rows going
        # quietly missing from the next run.
        logger.warning(f"Unrecognised {prefix} identifier {local!r}, dropping")
        return None
    if width := _ZERO_PADDED_WIDTH.get(prefix):
        local = local.zfill(width)
    return f"{prefix}:{local}"


def is_omim_series(xref: str) -> bool:
    """True for an OMIM phenotypic series -- a group of phenotypes, not one."""
    prefix, _, local = xref.partition(":")
    return prefix == "OMIM" and bool(_OMIM_SERIES.fullmatch(local))


def canonical_from_compact(identifier: str) -> str | None:
    """Normalise a single-token identifier such as ``MONDO_0014768``.

    Open Targets returns disease IDs as one token with no separate source
    field, so the prefix has to be split back off before ``canonical_xref``
    can vet it.
    """
    parts = _SEPARATOR.split(identifier.strip(), maxsplit=1)
    if len(parts) != 2:
        return None
    return canonical_xref(parts[0], parts[1])


def xref_prefix(xref: str) -> str:
    """Return the authority of a canonical xref -- ``"MONDO"`` for MONDO:0010829."""
    return xref.split(":", 1)[0]
