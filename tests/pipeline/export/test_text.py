import json
import re
from pathlib import Path

from pipeline.export.text import (
    clean_column_name,
    extract_matches,
    extract_pmids,
    fill_missing_text,
    normalize_text,
    normalize_yes_no,
    split_genetic_targets,
)
from pipeline.export.writer import to_camel


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
    assert clean_column_name("target_population") == "Target Population"
    assert clean_column_name("evidence_from_other_omics_studies") == (
        "Evidence from Other Omics Studies"
    )


def test_clean_column_name_never_capitalizes_single_character_words() -> None:
    """Confirmed directly against R: tools::toTitleCase("v something") ->
    "v Something", tools::toTitleCase("gene v") -> "Gene v". A single-
    character word stays lower-case in any position, including the first --
    this is a length rule, not a stopword-list membership rule. Latent for
    the real schema (no column starts or ends with a solo letter), but the
    port's whole contract is fidelity to R, not just to the columns that
    happen to exist today.
    """
    assert clean_column_name("v_something") == "v Something"
    assert clean_column_name("a_gene") == "a Gene"
    assert clean_column_name("gene_v") == "Gene v"


def test_extract_pmids_accepts_urls_and_labels() -> None:
    assert extract_pmids(
        "https://pubmed.ncbi.nlm.nih.gov/12345 and PMID: 67890"
    ) == ["12345", "67890"]


def test_extract_pmids_applies_a_seven_digit_floor_in_prose() -> None:
    """A bare 4-digit number in prose is a year, not a PMID."""
    assert extract_pmids("published in 2019") == []
    assert extract_pmids("see 37063705") == ["37063705"]


def test_extract_pmids_allows_short_ids_in_an_all_numeric_list() -> None:
    assert extract_pmids("12345, 67890") == ["12345", "67890"]


def test_extract_pmids_refuses_a_spreadsheet_mangled_number() -> None:
    """A PMID list opened in a spreadsheet comes back as one formatted number.

    "26063658,33773637,..." is parsed as a float and re-rendered as
    "2,606,365,833,773,630,000,000,..." -- the trailing zeros are float64
    precision loss. Grammatically that is indistinguishable from a list of
    short PMIDs, and the all-numeric branch happily mined it for digits,
    publishing "3", "329" and "540" as citations. Refusing the cell keeps a
    visible "(reference needed)" instead of fabricating provenance. Values
    below are real, from the genes table.
    """
    for mangled in (
        "3,329,354,932,358,540",
        "1,953,923,630,859,180",
        "2,606,365,833,773,630,000,000,000,000,000,000,000,000",
        "332,935,493,551,119,000,000",
    ):
        assert extract_pmids(mangled) == []


def test_a_mangled_run_is_dropped_when_a_real_pmid_is_merged_beside_it() -> None:
    """The shape a merge produces, which the whole-cell guard missed.

    merge_genes_transactional unions references rather than replacing them,
    so the first extraction to touch one of these rows leaves
    "1,953,923,630,859,180; 42437605" in the column. That is an all-numeric
    list by the grammar, so the short-id branch published "1", "953" and
    "923" as citations beside the real PMID. NOTCH3 and BTN3A2 are the two
    rows this would have hit -- the others are protected only accidentally,
    by zero groups that fail the all-numeric test.
    """
    for mangled in (
        "1,953,923,630,859,180",  # NOTCH3
        "3,235,854,739,114,920",  # BTN3A2
        "2,606,365,833,773,630,000,000,000",  # HTRA1, zero groups
    ):
        assert extract_pmids(f"{mangled}; 42437605") == [
            "42437605"
        ]


def test_extract_pmids_still_accepts_lists_that_only_look_similar() -> None:
    """The guard keys on three-digit grouping, so real lists are untouched."""
    assert extract_pmids("12345, 67890") == ["12345", "67890"]
    assert extract_pmids("32358547,33293549") == [
        "32358547",
        "33293549",
    ]


def test_extract_pmids_ignores_doi_numeric_fragments() -> None:
    assert extract_pmids("doi: 10.1212/NXG.0000000000200069") == []


def test_extract_pmids_preserves_source_order_across_mixed_forms() -> None:
    """Every other ordering test here uses a homogeneous pair -- two marked
    forms, or two bare numbers in the all-numeric branch. Source order
    across a *mixed* marked/bare pair is exactly the property the marker
    pass exists for, and rests on the single-pass alternation regex
    scanning left to right regardless of which branch fires; a plausible
    two-pass refactor (marked IDs, then bare numbers, concatenated) would
    silently break it. Confirmed against the real R implementation directly
    (Rscript, data-prep/utils.R): the first case returns "9999999, 123".
    """
    assert extract_pmids("see 9999999, then PMID: 123") == [
        "9999999",
        "123",
    ]
    assert extract_pmids("PMID: 123, then see 9999999") == [
        "123",
        "9999999",
    ]


def test_extract_pmids_returns_empty_list_when_nothing_matches() -> None:
    assert extract_pmids(None) == []
    assert extract_pmids("no identifiers here") == []


def test_extract_pmids_preserves_source_order_and_dedupes() -> None:
    assert extract_pmids("33773636, 32358547, 33773636") == [
        "33773636",
        "32358547",
    ]


def test_extract_pmids_still_refuses_a_mangled_thousands_run() -> None:
    """The corruption guard must survive the refactor."""
    assert extract_pmids("2,606,365,833,773,630,000") == []


def test_extract_matches_returns_empty_list_when_nothing_matches() -> None:
    pattern = re.compile(r"\b\d{6}\b")
    assert extract_matches(None, pattern) == []
    assert extract_matches("no ids", pattern) == []
    assert extract_matches("CADASIL 125310", pattern) == ["125310"]


def test_split_genetic_targets_does_not_split_na_on_its_slash() -> None:
    assert split_genetic_targets(["N/A"]) == []
    assert split_genetic_targets(["NOTCH3, HTRA1"]) == ["NOTCH3", "HTRA1"]
    assert split_genetic_targets(["COL4A1/COL4A2"]) == ["COL4A1", "COL4A2"]
    assert split_genetic_targets(["(none)", None, ""]) == []


def test_split_genetic_targets_expands_the_curated_pair_shorthand() -> None:
    """`COL4A1/2` is the curated label for the pair, not COL4A1 and a gene "2"."""
    assert split_genetic_targets(["COL4A1/2"]) == ["COL4A1", "COL4A2"]
    assert split_genetic_targets(["COL4A1/2, NOTCH3"]) == [
        "COL4A1",
        "COL4A2",
        "NOTCH3",
    ]
    # Already spelled out, or not a pair at all: untouched.
    assert split_genetic_targets(["COL4A1/COL4A2"]) == ["COL4A1", "COL4A2"]
    assert split_genetic_targets(["HTRA1/NOTCH3"]) == ["HTRA1", "NOTCH3"]


def test_split_genetic_targets_dedupes_preserving_order() -> None:
    assert split_genetic_targets(["HTRA1", "NOTCH3; HTRA1"]) == ["HTRA1", "NOTCH3"]


# ---------------------------------------------------------------------------
# Real-data verification for clean_column_name's stopword list.
#
# _TITLE_CASE_STOPWORDS is a reproduction of tools::toTitleCase's lower-cased
# short-word list, and a guess until it is checked against what the R
# pipeline actually committed. These columns are the real PostgreSQL schema
# (pipeline/alembic/versions/001_baseline_schema.py: the `genes` and
# `clinical_trials` tables, id/created_at/updated_at dropped the same way
# read_dashboard_table() drops them in R). The expected side of each
# assertion is read from the committed JSON rather than hard-coded, so a
# future schema or cleaning change breaks this test instead of rotting
# silently.
# ---------------------------------------------------------------------------

_GENES_TABLE_COLUMNS = [
    "gene",
    "protein",
    "chromosomal_location",
    "gwas_trait",
    "mendelian_randomization",
    "evidence_from_other_omics_studies",
    "link_to_monogenetic_disease",
    "brain_cell_types",
    "affected_pathway",
    "references",
    "source_quote",
    "confidence",
]

_CLINICAL_TRIALS_COLUMNS = [
    "drug",
    "mechanism_of_action",
    "genetic_target",
    "genetic_evidence",
    "trial_name",
    "registry_id",
    "clinical_trial_phase",
    "target_population",
    "target_population_details",
    "target_sample_size",
    "estimated_completion_date",
    "primary_outcome",
    "sponsor_type",
    "overall_status",
]


def _committed_keys(filename: str) -> set[str]:
    repo_root = Path(__file__).resolve().parents[3]
    rows = json.loads((repo_root / "data" / filename).read_text(encoding="utf-8"))
    return {key for row in rows for key in row}


def test_clean_column_name_then_to_camel_reproduces_table1_wire_keys() -> None:
    """Chains clean_column_name -> to_camel (pipeline/export/writer.py, Task
    5) over the real genes-table columns and checks every key against
    data/table1.json as actually committed.

    link_to_monogenetic_disease is the one expected divergence at this
    layer: the Monogenetic -> Monogenic rename happens in Task 7's cleaning
    rules, not here, so it is asserted as the display name this helper
    actually produces rather than folded into the wire-key comparison.
    """
    assert clean_column_name("link_to_monogenetic_disease") == (
        "Link to Monogenetic Disease"
    )

    produced = {
        to_camel(clean_column_name(column))
        for column in _GENES_TABLE_COLUMNS
        if column != "link_to_monogenetic_disease"
    }
    expected = _committed_keys("table1.json") - {"linkToMonogenicDisease"}
    assert produced == expected


def test_clean_column_name_then_to_camel_reproduces_table2_wire_keys() -> None:
    """Same chain over the clinical_trials columns. No exceptions here, so
    this is a full-match check against data/table2.json -- including
    registry_id -> registryId (never registryID) and target_population ->
    targetPopulation, the two cases the brief calls out by name, and
    overall_status -> overallStatus, migration 013's column (Task 5)."""
    produced = {
        to_camel(clean_column_name(column)) for column in _CLINICAL_TRIALS_COLUMNS
    }
    assert produced == _committed_keys("table2.json")


# The two tests above prove clean_column_name preserves word boundaries and
# spelling, but NOT that its stopword casing is right: to_camel re-derives
# every word's case with its own .capitalize()/.lower(), so it cannot tell a
# correct stopword decision from a wrong one --
# to_camel("Evidence FROM other omics studies") and
# to_camel("Evidence from Other Omics Studies") both give
# "evidenceFromOtherOmicsStudies". Confirmed directly:
#
#   >>> to_camel("Evidence FROM other omics studies")
#   'evidenceFromOtherOmicsStudies'
#
# islands/GenesView.tsx and islands/TrialsView.tsx's `header:` strings are
# hand-authored independently of both this port and data-prep/utils.R, so
# they are the real check on what the stopword list does to a word's case
# (e.g. "Mechanism of Action" keeping "of" lower-case). Confirmed to have
# real discriminating power with a negative control: dropping "of" from
# _TITLE_CASE_STOPWORDS makes clean_column_name("mechanism_of_action")
# wrongly produce "Mechanism Of Action", and this test catches it (the
# to_camel wire key does not change either way, so the pair of tests above
# would not).
#
# One known gap: this cannot catch a missing "from". The rename lambda for
# evidence_from_other_omics_studies below does a literal .replace("Evidence
# from Other Omics", ...); with "from" missing, clean_column_name already
# (wrongly) produces "...From..." with a capital F, the .replace() finds
# nothing to match and is a silent no-op, and the untouched wrong value
# happens to equal the correct post-rename header. So this one column's
# stopword coverage still rests on test_clean_column_name_preserves_acronyms
# and the R-vs-Python cross-check, not on this test.
_TSX_ACCESSOR_HEADER = re.compile(r'accessor\("(\w+)",\s*\{\s*header:\s*"([^"]+)"')
_TSX_ID_HEADER = re.compile(r'id:\s*"(\w+)",\s*\n\s*header:\s*"([^"]+)"')

# Task 6 moved three headers -- the cell-type column and the two SVD
# Population ones -- off their string literals and onto manifest-derived
# constants, so `header:` there is an identifier rather than a `"..."`
# literal and the two regexes above no longer see it. This regex captures
# that identifier (dotted, for `POPULATION_FIELD.label`); _MANIFEST_HEADERS
# below is where it gets resolved back to the string this test still checks
# against the tsx file's own accessor key. An identifier missing from that
# table raises rather than silently reporting no header at all, so a future
# manifest-sourced column has to be added here on purpose.
_TSX_ACCESSOR_HEADER_IDENTIFIER = re.compile(
    r'accessor\("(\w+)",\s*\{\s*header:\s*([A-Za-z_][\w.]*),'
)

_MANIFEST = json.loads(
    (Path(__file__).resolve().parents[3] / "disease" / "manifest.json").read_text(
        encoding="utf-8"
    )
)

_MANIFEST_HEADERS = {
    "CELL_TYPES_LABEL": _MANIFEST["cellTypes"]["label"],
    "POPULATION_FIELD.label": _MANIFEST["populationField"]["label"],
    "POPULATION_FIELD.detailsLabel": _MANIFEST["populationField"]["detailsLabel"],
}

# clean_table1.R renames these two names *after* clean_column_name runs (see
# its final gsub() calls), so the raw helper output is transformed before
# comparing it to the committed header.
_RENAMED_AFTER_CLEAN_COLUMN_NAME = {
    "evidence_from_other_omics_studies": lambda s: s.replace(
        "Evidence from Other Omics", "Evidence From Other Omics"
    ),
    "link_to_monogenetic_disease": lambda s: s.replace("Monogenetic", "Monogenic"),
}


def _tsx_headers(relative_path: str) -> dict[str, str]:
    """{camelCase column key: header label} pairs from a TableShell column
    definition file. Keyed the same way to_camel keys a JSON row, so a
    result can be looked up by to_camel(clean_column_name(...)) without
    re-deriving anything this port is responsible for."""
    repo_root = Path(__file__).resolve().parents[3]
    text = (repo_root / relative_path).read_text(encoding="utf-8")
    headers = dict(_TSX_ACCESSOR_HEADER.findall(text))
    headers.update(_TSX_ID_HEADER.findall(text))
    for accessor_key, identifier in _TSX_ACCESSOR_HEADER_IDENTIFIER.findall(text):
        if identifier not in _MANIFEST_HEADERS:
            raise KeyError(
                f"{relative_path}: accessor {accessor_key!r} has a header "
                f"identifier {identifier!r} not in _MANIFEST_HEADERS -- add "
                "it there deliberately"
            )
        headers[accessor_key] = _MANIFEST_HEADERS[identifier]
    return headers


# TrialsView.tsx deliberately does not header overall_status with
# clean_column_name's literal reading ("Overall Status"): the dashboard's
# "Study status" filter group (STATUS_CHOICES / DEFAULT_TRIAL_STATUSES in
# lib/constants.ts) already names the concept this column filters on, and
# Task 8 gave the column the matching "Study Status" header rather than the
# raw database name. This is a dashboard naming choice, not an R-port
# artifact like the genes renames above, so it gets its own map.
#
# target_population and target_population_details are here for a different
# reason: migration 014 renamed the column so the wire key does not spell
# the disease, but the header text a reader sees still comes from
# populationField in disease/manifest.json (Task 6), read through the same
# _MANIFEST_HEADERS table _tsx_headers resolves POPULATION_FIELD.label /
# .detailsLabel against. clean_column_name("target_population") now yields
# "Target Population", which is not what the manifest ships, so the rename
# reads the manifest label rather than hard-coding it.
_TRIALS_RENAMED_AFTER_CLEAN_COLUMN_NAME = {
    "overall_status": lambda s: "Study Status",
    "target_population": lambda s: _MANIFEST["populationField"]["label"],
    "target_population_details": lambda s: _MANIFEST["populationField"][
        "detailsLabel"
    ],
}


def test_clean_column_name_matches_the_dashboards_committed_headers() -> None:
    """Real ground truth for the stopword list itself, not just for word
    boundaries: every genes/clinical_trials column's cleaned display name
    (after Task 7's two pending renames and Task 8's one, where they apply)
    must equal the header GenesView.tsx / TrialsView.tsx actually ships.
    """
    genes_headers = _tsx_headers("islands/GenesView.tsx")
    trials_headers = _tsx_headers("islands/TrialsView.tsx")

    for column in _GENES_TABLE_COLUMNS:
        label = clean_column_name(column)
        rename = _RENAMED_AFTER_CLEAN_COLUMN_NAME.get(column, lambda s: s)
        expected_label = rename(label)
        # The wire/accessor key is derived from the name *after* Task 7's
        # rename, same as export.R's to_camel(names(table1)) call order.
        key = to_camel(expected_label)
        assert genes_headers[key] == expected_label, column

    for column in _CLINICAL_TRIALS_COLUMNS:
        label = clean_column_name(column)
        # Unlike the genes renames above, the trials accessor key is always
        # the wire key (to_camel of the *un*renamed label) -- TrialsView.tsx
        # keys "overallStatus" off the JSON field, not off its own header
        # text, so the rename below only changes what header string is
        # expected at that key.
        key = to_camel(label)
        rename = _TRIALS_RENAMED_AFTER_CLEAN_COLUMN_NAME.get(column, lambda s: s)
        expected_label = rename(label)
        assert trials_headers[key] == expected_label, column
