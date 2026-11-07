"""The curated gold GWAS traits are vocabulary keys and publish verbatim."""

import json
from pathlib import Path

from pipeline.export.tables import publishable_traits

VOCABULARY_PATH = (
    Path(__file__).resolve().parents[3] / "disease" / "vocabulary.json"
)

GOLD_TERMS = [
    "MTAG (all ICH, SVS, WMH, FA, MD, AD)",
    "ICH",
    "non-lobar ICH",
    "All ICH & lobar ICH only",
    "lacunes (suggestive significance)",
]


def test_gold_terms_publish_verbatim() -> None:
    assert publishable_traits(GOLD_TERMS) == GOLD_TERMS


def test_lacunar_case_variant_folds() -> None:
    assert publishable_traits(["Lacunar stroke"]) == ["lacunar stroke"]


def test_gold_terms_are_vocabulary_keys() -> None:
    keys = {
        t["key"]
        for t in json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))[
            "traits"
        ]
    }
    assert set(GOLD_TERMS) <= keys
