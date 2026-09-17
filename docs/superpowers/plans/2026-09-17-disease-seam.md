# Disease Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every disease-specific string, vocabulary and encoding into one
`disease/` directory that TypeScript and Python read, with cSVD as its first
instance and the dashboard byte-for-byte unchanged.

**Architecture:** A `disease/` directory holds `manifest.json` (prose, terms,
populations, glossary, citation, gene lists), the moved `vocabulary.json` and
`omim_info.csv`, the disease halves of the two encodings, and `prompt.md`.
TypeScript reads it through `lib/disease/*` narrow modules; Python through a
stdlib-only `pipeline/disease.py`. The extraction prompt becomes a v7 template
in `pipeline/prompts.py` rendered with `prompt.md` sections, pinned
byte-identical to the v6 literals. One migration renames the `svd_population`
column. Greplist tests keep disease terms out of the code.

**Tech Stack:** Deno 2 / Fresh 2 / Preact (TypeScript), Python 3.14 with uv,
pytest, Alembic on PostgreSQL 18.

**Spec:** `docs/superpowers/specs/2026-09-17-disease-reuse-design.md` (sections
3 and 4.1; this plan is sub-project 2 of section 7).

## Global Constraints

- Work in a worktree on the branch `disease-reuse` (already exists, holds the
  spec). Run uv commands with `UV_PROJECT_ENVIRONMENT=<main checkout>/.venv`
  inside a worktree (root `CLAUDE.md`, "Worktrees").
- TypeScript gates: `deno task check` (fmt, lint, `deno check`) and
  `deno task test:coverage` (100 % under `lib/`, global 85/95/90). Python gates:
  `uv run ruff check .`, `uv run ty check`, `uv run pytest`, and
  `uv run pytest tests/scripts` separately. Never run `ruff format`.
- `data/*.json` is byte-gated by `tests/pipeline/export/test_writer.py`; the
  only data change this plan makes is the `svdPopulation` → `targetPopulation`
  key rename in `data/table2.json` (Task 13).
- The rendered cSVD prompt must equal the current v6 literals byte for byte:
  system prompt sha256
  `f571dedb6f88abf2291d4c8568482150db1c1b2e94f1f778d3fc145e01b5f3e4` (1062
  chars), instructions sha256
  `70908abc03022ed389fda9c8351cab8f1eb46a9afc1aa62383bd5d72812ba853` (18469
  chars), task instruction sha256
  `b3b2344a9a5d220b53f120985d4a1330dea6f301344e8bbf3f73c7209da4ba9a`.
- `pipeline/disease.py` imports nothing from `pipeline` (stdlib only) so
  `extraction_models.py` and `config.py` can both import it without a cycle.
- Islands import narrow modules under `lib/disease/`, never the barrel
  `lib/disease.ts` (root `CLAUDE.md`, "Import the narrow module, not the
  barrel").
- Sentinel strings, the `--svd-` CSS namespace, `svd_session`, `svd-theme`,
  `svd:themechange`, `svd-filters-collapsed` and `SVDPMIDTOKEN` do not change.
- Commit after every task with the attribution lines the session requires.

---

### Task 1: `disease/manifest.json` and the Python loader

**Files:**

- Create: `disease/manifest.json`
- Create: `disease/manifest.schema.json`
- Create: `pipeline/disease.py`
- Test: `tests/pipeline/test_disease.py`

**Interfaces:**

- Produces: `pipeline.disease.DISEASE_DIR: Path`, `VOCABULARY_PATH`,
  `OMIM_CSV_PATH`, `PROMPT_PATH`, `PHENOGRAM_PATH`, `TIMELINE_PATH`;
  `@dataclass(frozen=True, slots=True) Disease` with the fields listed in Step
  3; `load_disease() -> Disease` (cached).

- [ ] **Step 1: Write the manifest**

Create `disease/manifest.json` with exactly this content (values are the current
literals, quoted from the files named in the spec's section 3.1):

```json
{
  "schemaVersion": 1,
  "disease": {
    "key": "csvd",
    "name": "cerebral small vessel disease",
    "short": "SVD",
    "abbreviation": "cSVD",
    "adjective": "Cerebral SVD"
  },
  "site": {
    "title": "ICM Cerebral SVD Dashboard",
    "heading": "Putative Causal Genes and Clinical Trial Drugs for Cerebral Small Vessel Disease",
    "metaDescription": "Interactive dashboard of putative causal genes and clinical trial drugs for cerebral small vessel disease, from the Paris Brain Institute (ICM).",
    "aboutTitle": "Welcome to the Paris Brain Institute's Cerebral SVD Dashboard",
    "aboutLede": "This dashboard provides up-to-date and standardized information on putative cerebral small vessel disease (SVD) causal genes and drugs tested in planned or ongoing cerebral SVD clinical trials.",
    "loginLede": "Putative causal genes and clinical trial drugs for cerebral small vessel disease (SVD).",
    "pages": {
      "genes": "Genes implicated in cerebral small vessel disease (SVD), with the GWAS, omics and monogenic evidence supporting each one.",
      "trials": "Drugs tested in planned or ongoing cerebral small vessel disease (SVD) trials, grouped by drug.",
      "timeline": "Planned and ongoing cerebral small vessel disease (SVD) trials, arranged by target population and trial phase.",
      "map": "Facility locations for the registered cerebral small vessel disease (SVD) trials."
    }
  },
  "institute": {
    "name": "Paris Brain Institute",
    "short": "ICM",
    "url": "https://institutducerveau-icm.org",
    "copyright": "Paris Brain Institute (ICM)",
    "logo": {
      "src": "/institute/logo-light.svg",
      "srcOnDark": "/institute/logo-dark.svg",
      "alt": "Paris Brain Institute"
    }
  },
  "contact": {
    "maintainer": {
      "name": "Mathieu B. Poirier",
      "email": "mathieu.poirier@icm-institute.org"
    }
  },
  "about": {
    "citation": null,
    "board": null,
    "contactUs": null,
    "acknowledgements": null,
    "additionalSources": []
  },
  "hosting": {
    "url": "https://csvd-dashboard.mathieubpoiriericm.deno.net"
  },
  "search": {
    "pubmed": {
      "diseaseTerms": ["cerebral small vessel disease"],
      "markerTerms": [
        "stroke",
        "dementia",
        "lacunes",
        "lacunar stroke",
        "white matter hyperintensities",
        "perivascular spaces",
        "cerebral microbleeds"
      ],
      "meshTerms": ["Cerebral Small Vessel Diseases", "White Matter"]
    },
    "clinicalTrials": {
      "searchTerms": [
        "cerebral small vessel disease",
        "lacunar stroke",
        "lacunar infarction",
        "CADASIL",
        "CARASIL",
        "cerebral microbleeds",
        "white matter hyperintensities",
        "vascular cognitive impairment",
        "vascular dementia",
        "cerebral amyloid angiopathy"
      ],
      "conditions": [
        "small vessel disease",
        "small vascular disease",
        "lacunar",
        "lacune",
        "cadasil",
        "carasil",
        "microbleed",
        "white matter hyperintensit",
        "white matter lesion",
        "white matter disease",
        "leukoaraiosis",
        "amyloid angiopathy",
        "binswanger",
        "perivascular space",
        "subcortical infarct",
        "subcortical ischemi",
        "covert brain infarct",
        "silent brain infarct",
        "silent cerebral infarct"
      ],
      "conditionPairs": [["vascular", "dementia"], ["vascular", "cognitive"]]
    }
  },
  "populations": [
    { "key": "CAA", "label": "CAA" },
    { "key": "Cognitive Impairment", "label": "Cognitive Impairment" },
    { "key": "Stroke", "label": "Stroke" },
    { "key": "SVD", "label": "SVD" }
  ],
  "populationField": {
    "label": "SVD Population",
    "detailsLabel": "SVD Population Details"
  },
  "cellTypes": {
    "label": "Brain Cell Types",
    "glossary": {
      "EC": "Endothelial Cells",
      "SMC": "Smooth Muscle Cells",
      "VSMC": "Vascular Smooth Muscle Cells",
      "AC": "Astrocytes",
      "MG": "Microglia",
      "OL": "Oligodendrocytes",
      "PC": "Pericytes",
      "FB": "Fibroblasts"
    }
  },
  "citationStandard": {
    "name": "STRIVE-2",
    "label": "Duering, M. et al. Neuroimaging standards for research into small vessel disease—advances since 2013. The Lancet Neurology 22, 602–618 (2023).",
    "doi": "10.1016/S1474-4422(23)00131-X",
    "linkLabel": "View STRIVE-2 (Lancet Neurol 2023)"
  },
  "monogenicGenes": ["NOTCH3", "COL4A1", "COL4A2", "HTRA1", "TREX1", "GLA"],
  "geneAliases": {
    "COL4A1/2": ["COL4A1", "COL4A2"],
    "C6orf195": ["LINC01600"]
  },
  "pipeline": {
    "runLabel": "SVD Pipeline",
    "maxGenesPerPaper": 20
  }
}
```

Run `deno fmt disease/manifest.json` so the file passes `deno fmt --check .`.

- [ ] **Step 2: Write the JSON Schema**

Create `disease/manifest.schema.json`. It is documentation for editors and the
future skill; the loaders in both languages enforce the same shape in code.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Disease manifest",
  "type": "object",
  "required": [
    "schemaVersion",
    "disease",
    "site",
    "institute",
    "contact",
    "about",
    "hosting",
    "search",
    "populations",
    "populationField",
    "cellTypes",
    "citationStandard",
    "monogenicGenes",
    "geneAliases",
    "pipeline"
  ],
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "const": 1 },
    "disease": {
      "type": "object",
      "required": ["key", "name", "short", "abbreviation", "adjective"],
      "additionalProperties": false,
      "properties": {
        "key": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
        "name": { "type": "string", "minLength": 1 },
        "short": { "type": "string", "minLength": 1 },
        "abbreviation": { "type": "string", "minLength": 1 },
        "adjective": { "type": "string", "minLength": 1 }
      }
    },
    "site": {
      "type": "object",
      "required": [
        "title",
        "heading",
        "metaDescription",
        "aboutTitle",
        "aboutLede",
        "loginLede",
        "pages"
      ],
      "additionalProperties": false,
      "properties": {
        "title": { "type": "string" },
        "heading": { "type": "string" },
        "metaDescription": { "type": "string" },
        "aboutTitle": { "type": "string" },
        "aboutLede": { "type": "string" },
        "loginLede": { "type": "string" },
        "pages": {
          "type": "object",
          "required": ["genes", "trials", "timeline", "map"],
          "additionalProperties": false,
          "properties": {
            "genes": { "type": "string" },
            "trials": { "type": "string" },
            "timeline": { "type": "string" },
            "map": { "type": "string" }
          }
        }
      }
    },
    "institute": {
      "type": "object",
      "required": ["name", "short", "copyright", "logo"],
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string" },
        "short": { "type": "string" },
        "url": { "type": ["string", "null"] },
        "copyright": { "type": "string" },
        "logo": {
          "type": "object",
          "required": ["src", "alt"],
          "additionalProperties": false,
          "properties": {
            "src": { "type": "string" },
            "srcOnDark": { "type": ["string", "null"] },
            "alt": { "type": "string" }
          }
        }
      }
    },
    "contact": {
      "type": "object",
      "required": ["maintainer"],
      "additionalProperties": false,
      "properties": {
        "maintainer": {
          "type": "object",
          "required": ["name", "email"],
          "properties": {
            "name": { "type": "string" },
            "email": { "type": "string" }
          }
        }
      }
    },
    "about": {
      "type": "object",
      "required": [
        "citation",
        "board",
        "contactUs",
        "acknowledgements",
        "additionalSources"
      ],
      "additionalProperties": false,
      "properties": {
        "citation": {
          "oneOf": [
            { "type": "null" },
            {
              "type": "object",
              "required": ["authors", "title", "journal", "year", "doi"],
              "properties": {
                "authors": { "type": "string" },
                "title": { "type": "string" },
                "journal": { "type": "string" },
                "year": { "type": "integer" },
                "doi": { "type": "string" }
              }
            }
          ]
        },
        "board": { "type": ["string", "null"] },
        "contactUs": { "type": ["string", "null"] },
        "acknowledgements": { "type": ["string", "null"] },
        "additionalSources": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["name", "href", "licence", "provides"],
            "properties": {
              "name": { "type": "string" },
              "href": { "type": "string" },
              "provides": { "type": "string" },
              "licence": {
                "type": "object",
                "required": ["label"],
                "properties": {
                  "label": { "type": "string" },
                  "href": { "type": ["string", "null"] }
                }
              }
            }
          }
        }
      }
    },
    "hosting": {
      "type": "object",
      "required": ["url"],
      "properties": { "url": { "type": ["string", "null"] } }
    },
    "search": {
      "type": "object",
      "required": ["pubmed", "clinicalTrials"],
      "additionalProperties": false,
      "properties": {
        "pubmed": {
          "type": "object",
          "required": ["diseaseTerms", "markerTerms", "meshTerms"],
          "properties": {
            "diseaseTerms": { "$ref": "#/$defs/terms" },
            "markerTerms": { "$ref": "#/$defs/terms" },
            "meshTerms": { "$ref": "#/$defs/terms" }
          }
        },
        "clinicalTrials": {
          "type": "object",
          "required": ["searchTerms", "conditions", "conditionPairs"],
          "properties": {
            "searchTerms": { "$ref": "#/$defs/terms" },
            "conditions": { "$ref": "#/$defs/terms" },
            "conditionPairs": {
              "type": "array",
              "items": {
                "type": "array",
                "items": { "type": "string" },
                "minItems": 2,
                "maxItems": 2
              }
            }
          }
        }
      }
    },
    "populations": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["key", "label"],
        "properties": {
          "key": { "type": "string" },
          "label": { "type": "string" }
        }
      }
    },
    "populationField": {
      "type": "object",
      "required": ["label", "detailsLabel"],
      "properties": {
        "label": { "type": "string" },
        "detailsLabel": { "type": "string" }
      }
    },
    "cellTypes": {
      "type": "object",
      "required": ["label", "glossary"],
      "properties": {
        "label": { "type": "string" },
        "glossary": {
          "type": "object",
          "additionalProperties": { "type": "string" }
        }
      }
    },
    "citationStandard": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "required": ["name", "label", "doi", "linkLabel"],
          "properties": {
            "name": { "type": "string" },
            "label": { "type": "string" },
            "doi": { "type": "string" },
            "linkLabel": { "type": "string" }
          }
        }
      ]
    },
    "monogenicGenes": { "$ref": "#/$defs/terms" },
    "geneAliases": {
      "type": "object",
      "additionalProperties": {
        "type": "array",
        "minItems": 1,
        "items": { "type": "string" }
      }
    },
    "pipeline": {
      "type": "object",
      "required": ["runLabel", "maxGenesPerPaper"],
      "properties": {
        "runLabel": { "type": "string" },
        "maxGenesPerPaper": { "type": "integer", "minimum": 1 }
      }
    }
  },
  "$defs": {
    "terms": { "type": "array", "items": { "type": "string", "minLength": 1 } }
  }
}
```

Run `deno fmt disease/manifest.schema.json`.

- [ ] **Step 3: Write the failing loader test**

Create `tests/pipeline/test_disease.py`:

```python
"""The disease manifest is the one place the pipeline learns which disease it serves."""

import json
from pathlib import Path

import pytest

from pipeline import disease as disease_module
from pipeline.disease import DISEASE_DIR, Disease, load_disease

_ROOT = Path(__file__).resolve().parents[2]


def test_the_directory_is_the_repository_s_disease_folder() -> None:
    assert DISEASE_DIR == _ROOT / "disease"
    assert (DISEASE_DIR / "manifest.json").is_file()


def test_load_disease_is_cached() -> None:
    assert load_disease() is load_disease()


def test_the_manifest_fills_every_field() -> None:
    d = load_disease()
    assert isinstance(d, Disease)
    assert d.key == "csvd"
    assert d.name == "cerebral small vessel disease"
    assert d.abbreviation == "cSVD"
    assert d.short == "SVD"
    assert d.run_label == "SVD Pipeline"
    assert d.pubmed_disease_terms == ("cerebral small vessel disease",)
    assert d.pubmed_mesh_terms == ("Cerebral Small Vessel Diseases", "White Matter")
    assert len(d.pubmed_marker_terms) == 7
    assert len(d.ct_search_terms) == 10
    assert len(d.ct_condition_substrings) == 19
    assert d.ct_condition_pairs == (("vascular", "dementia"), ("vascular", "cognitive"))
    assert d.gene_aliases == {"COL4A1/2": ("COL4A1", "COL4A2"), "C6orf195": ("LINC01600",)}
    assert d.monogenic_genes == ("NOTCH3", "COL4A1", "COL4A2", "HTRA1", "TREX1", "GLA")
    assert d.max_genes_per_paper == 20
    assert d.population_keys == ("CAA", "Cognitive Impairment", "Stroke", "SVD")
    assert d.population_label == "SVD Population"


def test_the_parser_refuses_a_missing_key(tmp_path: Path) -> None:
    raw = json.loads((DISEASE_DIR / "manifest.json").read_text(encoding="utf-8"))
    del raw["search"]["pubmed"]["meshTerms"]
    with pytest.raises(ValueError, match="search.pubmed.meshTerms"):
        disease_module._parse_manifest(raw)


def test_the_parser_refuses_a_wrong_schema_version() -> None:
    raw = json.loads((DISEASE_DIR / "manifest.json").read_text(encoding="utf-8"))
    raw["schemaVersion"] = 2
    with pytest.raises(ValueError, match="schemaVersion"):
        disease_module._parse_manifest(raw)


def test_the_parser_refuses_an_empty_term() -> None:
    raw = json.loads((DISEASE_DIR / "manifest.json").read_text(encoding="utf-8"))
    raw["search"]["clinicalTrials"]["searchTerms"].append("  ")
    with pytest.raises(ValueError, match="search.clinicalTrials.searchTerms"):
        disease_module._parse_manifest(raw)
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `uv run pytest tests/pipeline/test_disease.py -v` Expected: FAIL with
`ModuleNotFoundError: No module named 'pipeline.disease'`.

- [ ] **Step 5: Write the loader**

Create `pipeline/disease.py`:

```python
"""The disease this pipeline serves, read once from ``disease/manifest.json``.

Stdlib only, and it imports nothing from ``pipeline``: ``extraction_models``
and ``config`` both read it, and ``config`` imports ``extraction_models``,
so anything heavier here is a cycle waiting to happen. The directory is
resolved from this file rather than from ``config.PROJECT_ROOT`` for the
same reason.

Every term list is a tuple and every mapping is read-only so a caller
cannot mutate the shared instance; ``load_disease`` is cached and the
dataclass is frozen.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

DISEASE_DIR: Final[Path] = Path(__file__).resolve().parent.parent / "disease"
MANIFEST_PATH: Final[Path] = DISEASE_DIR / "manifest.json"
VOCABULARY_PATH: Final[Path] = DISEASE_DIR / "vocabulary.json"
OMIM_CSV_PATH: Final[Path] = DISEASE_DIR / "omim_info.csv"
PROMPT_PATH: Final[Path] = DISEASE_DIR / "prompt.md"
PHENOGRAM_PATH: Final[Path] = DISEASE_DIR / "phenogram.json"
TIMELINE_PATH: Final[Path] = DISEASE_DIR / "timeline.json"

SCHEMA_VERSION: Final[int] = 1


@dataclass(frozen=True, slots=True)
class Disease:
    """What the manifest says, in the shapes the pipeline consumes."""

    key: str
    name: str
    short: str
    abbreviation: str
    run_label: str
    pubmed_disease_terms: tuple[str, ...]
    pubmed_marker_terms: tuple[str, ...]
    pubmed_mesh_terms: tuple[str, ...]
    ct_search_terms: tuple[str, ...]
    ct_condition_substrings: tuple[str, ...]
    ct_condition_pairs: tuple[tuple[str, str], ...]
    gene_aliases: Mapping[str, tuple[str, ...]]
    monogenic_genes: tuple[str, ...]
    max_genes_per_paper: int
    population_keys: tuple[str, ...]
    population_label: str
    population_details_label: str


def _at(raw: Mapping[str, Any], path: str) -> Any:
    """Walk a dotted path, naming the missing key in the error."""
    node: Any = raw
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            raise ValueError(f"disease/manifest.json: missing {path}")
        node = node[part]
    return node


def _text(raw: Mapping[str, Any], path: str) -> str:
    value = _at(raw, path)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"disease/manifest.json: {path} must be a non-empty string")
    return value.strip()


def _terms(raw: Mapping[str, Any], path: str) -> tuple[str, ...]:
    value = _at(raw, path)
    if not isinstance(value, list) or not all(
        isinstance(t, str) and t.strip() for t in value
    ):
        raise ValueError(
            f"disease/manifest.json: {path} must be a list of non-empty strings"
        )
    return tuple(t.strip() for t in value)


def _parse_manifest(raw: Mapping[str, Any]) -> Disease:
    if _at(raw, "schemaVersion") != SCHEMA_VERSION:
        raise ValueError(
            f"disease/manifest.json: schemaVersion must be {SCHEMA_VERSION}"
        )
    pairs_raw = _at(raw, "search.clinicalTrials.conditionPairs")
    if not isinstance(pairs_raw, list) or not all(
        isinstance(p, list) and len(p) == 2 and all(isinstance(w, str) for w in p)
        for p in pairs_raw
    ):
        raise ValueError(
            "disease/manifest.json: search.clinicalTrials.conditionPairs must be "
            "a list of two-string lists"
        )
    aliases_raw = _at(raw, "geneAliases")
    if not isinstance(aliases_raw, Mapping):
        raise ValueError("disease/manifest.json: geneAliases must be an object")
    aliases = {
        key: tuple(_terms({"v": members}, "v"))
        for key, members in aliases_raw.items()
    }
    populations = _at(raw, "populations")
    if not isinstance(populations, list) or not populations:
        raise ValueError("disease/manifest.json: populations must be a non-empty list")
    keys = tuple(_text(p, "key") for p in populations)
    cap = _at(raw, "pipeline.maxGenesPerPaper")
    if not isinstance(cap, int) or cap < 1:
        raise ValueError(
            "disease/manifest.json: pipeline.maxGenesPerPaper must be a positive integer"
        )
    return Disease(
        key=_text(raw, "disease.key"),
        name=_text(raw, "disease.name"),
        short=_text(raw, "disease.short"),
        abbreviation=_text(raw, "disease.abbreviation"),
        run_label=_text(raw, "pipeline.runLabel"),
        pubmed_disease_terms=_terms(raw, "search.pubmed.diseaseTerms"),
        pubmed_marker_terms=_terms(raw, "search.pubmed.markerTerms"),
        pubmed_mesh_terms=_terms(raw, "search.pubmed.meshTerms"),
        ct_search_terms=_terms(raw, "search.clinicalTrials.searchTerms"),
        ct_condition_substrings=_terms(raw, "search.clinicalTrials.conditions"),
        ct_condition_pairs=tuple((a, b) for a, b in pairs_raw),
        gene_aliases=MappingProxyType(aliases),
        monogenic_genes=_terms(raw, "monogenicGenes"),
        max_genes_per_paper=cap,
        population_keys=keys,
        population_label=_text(raw, "populationField.label"),
        population_details_label=_text(raw, "populationField.detailsLabel"),
    )


@cache
def load_disease() -> Disease:
    """Read the manifest once for the life of the process."""
    with MANIFEST_PATH.open(encoding="utf-8") as handle:
        return _parse_manifest(json.load(handle))
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `uv run pytest tests/pipeline/test_disease.py -v` Expected: 6 passed.

- [ ] **Step 7: Lint, type-check, commit**

Run:
`uv run ruff check pipeline/disease.py tests/pipeline/test_disease.py && uv run ty check`
Expected: no findings.

```bash
git add disease/manifest.json disease/manifest.schema.json pipeline/disease.py tests/pipeline/test_disease.py
git commit -m "Add disease/manifest.json and the pipeline loader"
```

---

### Task 2: `lib/disease/manifest.ts` and the TypeScript contract test

**Files:**

- Create: `lib/disease/manifest.ts`
- Create: `lib/disease.ts`
- Modify: `lib/types.ts` (append the `DiseaseManifest` types after `RunConfig`)
- Test: `tests/disease_manifest_test.ts`

**Interfaces:**

- Produces: `normalizeManifest(raw: unknown): DiseaseManifest` (throws on a
  wrong `schemaVersion`), `export const manifest: DiseaseManifest`; types
  `DiseaseManifest`, `Population`, `CitationStandard`, `AdditionalSource`,
  `AboutCitation` in `lib/types.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/disease_manifest_test.ts`:

```ts
import { assert, assertEquals, assertThrows } from "@std/assert";

import manifestJson from "../disease/manifest.json" with { type: "json" };
import { manifest, normalizeManifest } from "../lib/disease.ts";

Deno.test("the manifest normalizes to the committed values", () => {
  assertEquals(manifest.schemaVersion, 1);
  assertEquals(manifest.disease.key, "csvd");
  assertEquals(manifest.site.title, "ICM Cerebral SVD Dashboard");
  assertEquals(manifest.populations.map((p) => p.key), [
    "CAA",
    "Cognitive Impairment",
    "Stroke",
    "SVD",
  ]);
  assertEquals(manifest.populationField.label, "SVD Population");
  assertEquals(manifest.cellTypes.glossary.EC, "Endothelial Cells");
  assertEquals(manifest.citationStandard?.name, "STRIVE-2");
  assertEquals(manifest.about.citation, null);
  assertEquals(manifest.about.additionalSources, []);
  assertEquals(manifest.institute.logo.srcOnDark, "/institute/logo-dark.svg");
});

Deno.test("strings are trimmed and empty optional strings become null", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  (raw.site as Record<string, unknown>).title = "  Padded  ";
  (raw.institute as Record<string, unknown>).url = "   ";
  (raw.hosting as Record<string, unknown>).url = "";
  const normalized = normalizeManifest(raw);
  assertEquals(normalized.site.title, "Padded");
  assertEquals(normalized.institute.url, null);
  assertEquals(normalized.hosting.url, null);
});

Deno.test("a wrong schemaVersion throws at load, never falls back", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  raw.schemaVersion = 2;
  assertThrows(() => normalizeManifest(raw), Error, "schemaVersion");
});

Deno.test("a missing required string throws and names the key", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  delete (raw.site as Record<string, unknown>).heading;
  assertThrows(() => normalizeManifest(raw), Error, "site.heading");
});

Deno.test("every population key is unique and non-empty", () => {
  const keys = manifest.populations.map((p) => p.key);
  assertEquals(new Set(keys).size, keys.length);
  assert(keys.every((k) => k.length > 0));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test -A tests/disease_manifest_test.ts` Expected: FAIL, module
`../lib/disease.ts` not found.

- [ ] **Step 3: Add the types**

Append to `lib/types.ts` after the `RunConfig` interface:

```ts
/** One trial population of the radar and the population filter. */
export interface Population {
  key: string;
  label: string;
}

export interface CitationStandard {
  name: string;
  label: string;
  doi: string;
  linkLabel: string;
}

export interface AboutCitation {
  authors: string;
  title: string;
  journal: string;
  year: number;
  doi: string;
}

export interface AdditionalSource {
  name: string;
  href: string;
  licence: { label: string; href: string | null };
  provides: string;
}

/** `disease/manifest.json`, normalized. See docs/superpowers/specs/2026-09-17-disease-reuse-design.md §3.1. */
export interface DiseaseManifest {
  schemaVersion: 1;
  disease: {
    key: string;
    name: string;
    short: string;
    abbreviation: string;
    adjective: string;
  };
  site: {
    title: string;
    heading: string;
    metaDescription: string;
    aboutTitle: string;
    aboutLede: string;
    loginLede: string;
    pages: { genes: string; trials: string; timeline: string; map: string };
  };
  institute: {
    name: string;
    short: string;
    url: string | null;
    copyright: string;
    logo: { src: string; srcOnDark: string | null; alt: string };
  };
  contact: { maintainer: { name: string; email: string } };
  about: {
    citation: AboutCitation | null;
    board: string | null;
    contactUs: string | null;
    acknowledgements: string | null;
    additionalSources: AdditionalSource[];
  };
  hosting: { url: string | null };
  populations: Population[];
  populationField: { label: string; detailsLabel: string };
  cellTypes: { label: string; glossary: Record<string, string> };
  citationStandard: CitationStandard | null;
  monogenicGenes: string[];
}
```

The search terms, gene aliases and pipeline block are not typed on the web side:
nothing under `lib/`, `routes/` or `islands/` reads them.

- [ ] **Step 4: Write the normalizer and the barrel**

Create `lib/disease/manifest.ts`:

```ts
/**
 * The disease manifest at the web boundary.
 *
 * Mirrors `lib/data/normalize.ts`: strings are trimmed and an optional
 * string that is empty becomes null. The one difference is failure: a
 * required key that is missing or a `schemaVersion` this code does not
 * know throws at module load. A manifest is authored, not fetched, so a
 * wrong one is a build error rather than a data gap to paper over.
 */

import manifestJson from "../../disease/manifest.json" with { type: "json" };

import type {
  AboutCitation,
  AdditionalSource,
  CitationStandard,
  DiseaseManifest,
  Population,
} from "../types.ts";
import { list, nullableText, record } from "../data/normalize.ts";

function required(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = nullableText(source[key]);
  if (value === null) throw new Error(`disease/manifest.json: missing ${path}`);
  return value;
}

function optional(source: Record<string, unknown>, key: string): string | null {
  return nullableText(source[key]);
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    const text = nullableText(entry);
    if (text !== null) out[key.trim()] = text;
  }
  return out;
}

function population(value: unknown, index: number): Population {
  const source = record(value);
  return {
    key: required(source, "key", `populations[${index}].key`),
    label: required(source, "label", `populations[${index}].label`),
  };
}

function citationStandard(value: unknown): CitationStandard | null {
  if (value === null || value === undefined) return null;
  const source = record(value);
  return {
    name: required(source, "name", "citationStandard.name"),
    label: required(source, "label", "citationStandard.label"),
    doi: required(source, "doi", "citationStandard.doi"),
    linkLabel: required(source, "linkLabel", "citationStandard.linkLabel"),
  };
}

function aboutCitation(value: unknown): AboutCitation | null {
  if (value === null || value === undefined) return null;
  const source = record(value);
  const year = source.year;
  if (typeof year !== "number" || !Number.isInteger(year)) {
    throw new Error(
      "disease/manifest.json: about.citation.year must be an integer",
    );
  }
  return {
    authors: required(source, "authors", "about.citation.authors"),
    title: required(source, "title", "about.citation.title"),
    journal: required(source, "journal", "about.citation.journal"),
    year,
    doi: required(source, "doi", "about.citation.doi"),
  };
}

function additionalSource(value: unknown, index: number): AdditionalSource {
  const source = record(value);
  const licence = record(source.licence);
  const at = `about.additionalSources[${index}]`;
  return {
    name: required(source, "name", `${at}.name`),
    href: required(source, "href", `${at}.href`),
    licence: {
      label: required(licence, "label", `${at}.licence.label`),
      href: optional(licence, "href"),
    },
    provides: required(source, "provides", `${at}.provides`),
  };
}

export function normalizeManifest(raw: unknown): DiseaseManifest {
  const source = record(raw);
  if (source.schemaVersion !== 1) {
    throw new Error(
      `disease/manifest.json: schemaVersion must be 1, got ${
        JSON.stringify(source.schemaVersion)
      }`,
    );
  }
  const disease = record(source.disease);
  const site = record(source.site);
  const pages = record(site.pages);
  const institute = record(source.institute);
  const logo = record(institute.logo);
  const maintainer = record(record(source.contact).maintainer);
  const about = record(source.about);
  const hosting = record(source.hosting);
  const populationField = record(source.populationField);
  const cellTypes = record(source.cellTypes);
  const populations = list(source.populations).map(population);
  if (populations.length === 0) {
    throw new Error("disease/manifest.json: populations must not be empty");
  }

  return {
    schemaVersion: 1,
    disease: {
      key: required(disease, "key", "disease.key"),
      name: required(disease, "name", "disease.name"),
      short: required(disease, "short", "disease.short"),
      abbreviation: required(disease, "abbreviation", "disease.abbreviation"),
      adjective: required(disease, "adjective", "disease.adjective"),
    },
    site: {
      title: required(site, "title", "site.title"),
      heading: required(site, "heading", "site.heading"),
      metaDescription: required(
        site,
        "metaDescription",
        "site.metaDescription",
      ),
      aboutTitle: required(site, "aboutTitle", "site.aboutTitle"),
      aboutLede: required(site, "aboutLede", "site.aboutLede"),
      loginLede: required(site, "loginLede", "site.loginLede"),
      pages: {
        genes: required(pages, "genes", "site.pages.genes"),
        trials: required(pages, "trials", "site.pages.trials"),
        timeline: required(pages, "timeline", "site.pages.timeline"),
        map: required(pages, "map", "site.pages.map"),
      },
    },
    institute: {
      name: required(institute, "name", "institute.name"),
      short: required(institute, "short", "institute.short"),
      url: optional(institute, "url"),
      copyright: required(institute, "copyright", "institute.copyright"),
      logo: {
        src: required(logo, "src", "institute.logo.src"),
        srcOnDark: optional(logo, "srcOnDark"),
        alt: required(logo, "alt", "institute.logo.alt"),
      },
    },
    contact: {
      maintainer: {
        name: required(maintainer, "name", "contact.maintainer.name"),
        email: required(maintainer, "email", "contact.maintainer.email"),
      },
    },
    about: {
      citation: aboutCitation(about.citation),
      board: optional(about, "board"),
      contactUs: optional(about, "contactUs"),
      acknowledgements: optional(about, "acknowledgements"),
      additionalSources: list(about.additionalSources).map(additionalSource),
    },
    hosting: { url: optional(hosting, "url") },
    populations,
    populationField: {
      label: required(populationField, "label", "populationField.label"),
      detailsLabel: required(
        populationField,
        "detailsLabel",
        "populationField.detailsLabel",
      ),
    },
    cellTypes: {
      label: required(cellTypes, "label", "cellTypes.label"),
      glossary: stringMap(cellTypes.glossary),
    },
    citationStandard: citationStandard(source.citationStandard),
    monogenicGenes: list(source.monogenicGenes)
      .map(nullableText)
      .filter((g): g is string => g !== null),
  };
}

export const manifest: DiseaseManifest = normalizeManifest(manifestJson);
```

Create `lib/disease.ts`, the barrel for tests only:

```ts
/**
 * Every disease-manifest module in one import, for the tests that exercise
 * the whole boundary. Islands import the narrow module they render from
 * (`lib/disease/site.ts`, `populations.ts`, `cell_types.ts`, `citation.ts`).
 */
export * from "./disease/manifest.ts";
```

The narrow modules are added in Tasks 5 to 7 and each re-exported here as it
lands.

- [ ] **Step 5: Run the test to verify it passes**

Run: `deno test -A tests/disease_manifest_test.ts` Expected: 5 passed.

- [ ] **Step 6: Check and commit**

Run: `deno task check` Expected: clean.

```bash
git add lib/disease/manifest.ts lib/disease.ts lib/types.ts tests/disease_manifest_test.ts
git commit -m "Add lib/disease/manifest.ts, the manifest's web boundary"
```

---

### Task 3: Move `vocabulary.json` to `disease/` and rename `strive` to `standard`

**Files:**

- Move: `lib/vocabulary.json` → `disease/vocabulary.json`
- Modify: `lib/constants.ts:14`, `lib/phenogram.ts:19,45`,
  `lib/phenogram_tooltips.ts:7,74`, `pipeline/extraction_models.py:18-20`,
  `pipeline/export/tables.py:54`, `scripts/phenogram_figure.py:33`,
  `tests/pipeline/test_prompt_vocabulary.py:37`,
  `tests/pipeline/test_config.py:142`,
  `tests/pipeline/test_extraction_models.py`,
  `tests/pipeline/test_data_merger.py`, `tests/pipeline/export/test_tables.py`,
  `tests/phenogram_encoding_test.ts:4,207-208`,
  `tests/phenogram_layout_test.ts:4`, `tests/components_test.tsx:40`,
  `e2e/fixtures/expected-data.ts:20`, `.claude/rules/phenogram.md:7`,
  `CLAUDE.md`, `README.md`, `pipeline/CLAUDE.md`, `lib/phenogram_encoding.json`
  (`$comment`).
- Test: the existing suites.

**Interfaces:**

- Produces: `disease/vocabulary.json` at the new path with `traits[].standard`
  in place of `traits[].strive`; `TraitEncoding.standard?: boolean` in
  `lib/phenogram.ts`.

- [ ] **Step 1: Move the file and rename the field**

```bash
git mv lib/vocabulary.json disease/vocabulary.json
sed -i '' 's/"strive": true/"standard": true/' disease/vocabulary.json
grep -c '"standard": true' disease/vocabulary.json
```

Expected count: 4 (BG-PVS, WMH, CMB, lacunes).

- [ ] **Step 2: Update every reader's path**

TypeScript (each is an import specifier change):

- `lib/constants.ts:14`:
  `import vocabulary from "../disease/vocabulary.json" with { type: "json" };`
- `lib/phenogram.ts:19`:
  `import vocabulary from "../disease/vocabulary.json" with { type: "json" };`
  and in `TraitEncoding` (line 45) rename `strive?: boolean;` to
  `standard?: boolean;` with the comment
  `/** Has a definition quoted from the manifest's citation standard. */`.
- `lib/phenogram_tooltips.ts:7`: same specifier; line 74
  `link: trait.strive ? STRIVE_LINK : undefined` becomes
  `link: trait.standard ? STRIVE_LINK : undefined` (the link itself moves in
  Task 4).
- `tests/phenogram_encoding_test.ts:4`, `tests/phenogram_layout_test.ts:4`,
  `tests/components_test.tsx:40`: `"../disease/vocabulary.json"`. In
  `tests/phenogram_encoding_test.ts` the test near line 207 reads
  `trait.strive`; change to `trait.standard`.
- `e2e/fixtures/expected-data.ts:20`:
  `join(__dirname, "..", "..", "disease", "vocabulary.json")`.

Python:

- `pipeline/extraction_models.py:15-20`: replace the `_VOCABULARY` definition
  with
  ```python
  from pipeline.disease import VOCABULARY_PATH

  _VOCABULARY: Final[Path] = VOCABULARY_PATH
  ```
  and rewrite the comment above it: "Resolved through `pipeline.disease`, which
  is stdlib-only: config imports ExtractionResult from here to build the tool
  schema, so importing config back would be a cycle."
- `pipeline/export/tables.py:54`: `_VOCABULARY: Final[Path] = VOCABULARY_PATH`
  with `from pipeline.disease import VOCABULARY_PATH` added to the imports;
  update the comment "Read from lib/vocabulary.json" to "Read from
  disease/vocabulary.json".
- `scripts/phenogram_figure.py:33`:
  `DEFAULT_VOCABULARY = _PROJECT_ROOT / "disease" / "vocabulary.json"`.
- `tests/pipeline/test_prompt_vocabulary.py:37`:
  `_VOCABULARY: Final[Path] = PROJECT_ROOT / "disease" / "vocabulary.json"`; in
  the module docstring replace `lib/vocabulary.json` with
  `disease/vocabulary.json`.
- `tests/pipeline/test_config.py:142`:
  `(PROJECT_ROOT / "disease" / "vocabulary.json")`.
- `tests/pipeline/test_extraction_models.py`,
  `tests/pipeline/test_data_merger.py`, `tests/pipeline/export/test_tables.py`:
  `grep -n 'vocabulary.json' tests/pipeline/*.py tests/pipeline/export/*.py` and
  change each `"lib" / "vocabulary.json"` to `"disease" / "vocabulary.json"` and
  each prose mention likewise.

Docs and rules:

- `.claude/rules/phenogram.md:7`: `- "disease/vocabulary.json"`; body mentions
  of `lib/vocabulary.json` become `disease/vocabulary.json`.
- `CLAUDE.md`, `README.md`, `pipeline/CLAUDE.md`, `lib/phenogram_encoding.json`
  `$comment`:
  `grep -rn 'lib/vocabulary.json' CLAUDE.md README.md pipeline/CLAUDE.md lib/phenogram_encoding.json`
  and replace each with `disease/vocabulary.json`.

- [ ] **Step 3: Run the gates**

Run:
`deno task check && deno test -A && uv run pytest tests/pipeline/test_prompt_vocabulary.py tests/pipeline/test_config.py tests/pipeline/test_extraction_models.py tests/pipeline/export/test_tables.py -q && uv run pytest tests/scripts -q`
Expected: all green;
`grep -rn 'lib/vocabulary.json' --include='*.ts' --include='*.tsx' --include='*.py' --include='*.md' --include='*.json' . | grep -v node_modules | grep -v docs/superpowers`
prints nothing.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Move the trait vocabulary to disease/ and rename strive to standard"
```

---

### Task 4: Split the phenogram encoding; citation standard from the manifest

**Files:**

- Create: `disease/phenogram.json`, `lib/disease/citation.ts`
- Modify: `lib/phenogram_encoding.json` (remove `families` and `citation`),
  `lib/phenogram.ts:18-20`, `lib/phenogram_tooltips.ts:6,24-27,72`,
  `scripts/phenogram_figure.py:32,188-201`,
  `tests/phenogram_encoding_test.ts:3,21-29`,
  `tests/scripts/test_phenogram_figure.py` (loader fixture),
  `.claude/rules/phenogram.md` (paths), `lib/disease.ts`.
- Test: `tests/phenogram_encoding_test.ts`, `tests/phenogram_layout_test.ts`,
  `tests/tooltips_test.ts`, `tests/scripts/test_phenogram_figure.py`.

**Interfaces:**

- Produces: `disease/phenogram.json` = `{ "families": [...] }`;
  `lib/disease/citation.ts` exporting
  `CITATION_STANDARD: CitationStandard | null` and
  `citationLink(): { href: string; label: string } | undefined`;
  `scripts/phenogram_figure.load_encoding(path, families, vocabulary)`.

- [ ] **Step 1: Write the failing encoding test change**

In `tests/phenogram_encoding_test.ts` replace lines 3-4 and the `FAMILY_ORDER`
literal (lines 21-29) with:

```ts
import appearance from "../lib/phenogram_encoding.json" with { type: "json" };
import families from "../disease/phenogram.json" with { type: "json" };
import vocabulary from "../disease/vocabulary.json" with { type: "json" };
```

```ts
// Order is the disease's, read from its file; the assertions below check the
// vocabulary groups into exactly these families in exactly this order.
const FAMILY_ORDER = families.families.map((f) => f.key);
```

Every later use of `encoding.families` in that file becomes `families.families`;
every use of `encoding.citation` is deleted (the citation moves to the manifest
and is tested in `tests/disease_manifest_test.ts`). Every use of
`encoding.evidence`, `encoding.stains`, `encoding.layout`, `encoding.glyphs`
becomes `appearance.<key>`. Add one assertion:

```ts
Deno.test("the family keys equal the set of vocabulary families", () => {
  const used = new Set(vocabulary.traits.map((t) => t.family));
  assertEquals(new Set(FAMILY_ORDER), used);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test -A tests/phenogram_encoding_test.ts` Expected: FAIL,
`../disease/phenogram.json` not found.

- [ ] **Step 3: Split the file**

Create `disease/phenogram.json` with the seven family objects exactly as they
are in `lib/phenogram_encoding.json` today:

```json
{
  "$comment": "The phenogram's pill families: one per `family` value in disease/vocabulary.json, in legend order, with the hue and tint lib/phenogram.ts and scripts/phenogram_figure.py draw. Appearance that is not the disease's (evidence glyphs, cytoband stains, layout) stays in lib/phenogram_encoding.json.",
  "families": [
    {
      "key": "pvs",
      "label": "Perivascular spaces",
      "hue": "#2a78d6",
      "tint": "#d8edff"
    },
    {
      "key": "diffusion",
      "label": "Diffusion MRI",
      "hue": "#eb6834",
      "tint": "#ffe2d5"
    },
    {
      "key": "extreme",
      "label": "Extreme cSVD",
      "hue": "#1baf7a",
      "tint": "#d2f5e2"
    },
    {
      "key": "wmh",
      "label": "White matter hyperintensities",
      "hue": "#008300",
      "tint": "#dbf3d8"
    },
    { "key": "stroke", "label": "Stroke", "hue": "#e87ba4", "tint": "#ffdfeb" },
    {
      "key": "cmb",
      "label": "Cerebral microbleeds",
      "hue": "#4a3aa7",
      "tint": "#e7e8ff"
    },
    {
      "key": "lacunes",
      "label": "Lacunes",
      "hue": "#e34948",
      "tint": "#ffe0dc"
    }
  ]
}
```

Then delete the `families` and `citation` keys from
`lib/phenogram_encoding.json` (keep `$comment`, `evidence`, `glyphs`, `stains`,
`layout`; update `$comment` to say families live in `disease/phenogram.json`).
Run `deno fmt disease/phenogram.json lib/phenogram_encoding.json`.

- [ ] **Step 4: Compose in `lib/phenogram.ts`**

Replace lines 18-19 with:

```ts
import appearanceJson from "./phenogram_encoding.json" with { type: "json" };
import familiesJson from "../disease/phenogram.json" with { type: "json" };
import vocabulary from "../disease/vocabulary.json" with { type: "json" };
```

Find the line that builds `encoding` from `encodingJson` (search for
`encodingJson` in the file; it composes `traits: vocabulary.traits` today) and
make it:

```ts
export const encoding: PhenogramEncoding = {
  ...appearanceJson,
  families: familiesJson.families,
  traits: vocabulary.traits,
};
```

Every other `encodingJson` reference in the file becomes `appearanceJson`.
Update the module doc comment (lines 9-13): "Both read
`lib/phenogram_encoding.json` for appearance, `disease/phenogram.json` for the
families and `disease/vocabulary.json` for trait identity".

- [ ] **Step 5: Add `lib/disease/citation.ts` and use it in the tooltips**

Create `lib/disease/citation.ts`:

```ts
/** The imaging or clinical standard the vocabulary's definitions are quoted from. */

import type { CitationStandard } from "../types.ts";
import { manifest } from "./manifest.ts";

export const CITATION_STANDARD: CitationStandard | null =
  manifest.citationStandard;

/** The tooltip link for a trait whose definition comes from the standard. */
export function citationLink(): { href: string; label: string } | undefined {
  if (CITATION_STANDARD === null) return undefined;
  return {
    href: `https://doi.org/${CITATION_STANDARD.doi}`,
    label: CITATION_STANDARD.linkLabel,
  };
}

/** Row label for a definition, e.g. "STRIVE-2 definition". */
export function definitionLabel(): string {
  return CITATION_STANDARD === null
    ? "Definition"
    : `${CITATION_STANDARD.name} definition`;
}
```

In `lib/phenogram_tooltips.ts`: delete line 6 (`encodingJson` import) and lines
24-27 (`STRIVE_LINK`); add
`import { citationLink, definitionLabel } from "./disease/citation.ts";`; in
`phenotypeTooltip` replace `"STRIVE-2 definition"` with `definitionLabel()` and
`trait.strive ? STRIVE_LINK : undefined` with
`trait.standard ? citationLink() : undefined`. Update the comment at lines 17-19
to say the citation comes from the manifest.

Add `export * from "./disease/citation.ts";` to `lib/disease.ts`.

- [ ] **Step 6: Python twin**

In `scripts/phenogram_figure.py` replace line 32 and the loader:

```python
DEFAULT_ENCODING = _PROJECT_ROOT / "lib" / "phenogram_encoding.json"
DEFAULT_FAMILIES = _PROJECT_ROOT / "disease" / "phenogram.json"
DEFAULT_VOCABULARY = _PROJECT_ROOT / "disease" / "vocabulary.json"
```

```python
def load_encoding(
    path: Path = DEFAULT_ENCODING,
    families: Path = DEFAULT_FAMILIES,
    vocabulary: Path = DEFAULT_VOCABULARY,
) -> dict[str, Any]:
    """Appearance from the encoding, families and trait identity from disease/.

    Composed so the rest of this module keeps reading one ``encoding``,
    matching ``lib/phenogram.ts``.
    """
    with path.open(encoding="utf-8") as handle:
        encoding = json.load(handle)
    with families.open(encoding="utf-8") as handle:
        encoding["families"] = json.load(handle)["families"]
    with vocabulary.open(encoding="utf-8") as handle:
        encoding["traits"] = json.load(handle)["traits"]
    return encoding
```

In `tests/scripts/test_phenogram_figure.py`, find every call that builds an
encoding from `lib/phenogram_encoding.json` directly (grep
`phenogram_encoding.json`) and route it through `load_encoding()` with defaults.

- [ ] **Step 7: Rules paths**

In `.claude/rules/phenogram.md` `paths:` add `- "disease/phenogram.json"` and
`- "lib/disease/citation.ts"` after `lib/phenogram_encoding.json`; in the body,
where it says the encoding is the only place styling lives, add "families and
their hues are the disease's and live in `disease/phenogram.json`; the citation
standard is `citationStandard` in `disease/manifest.json`".

- [ ] **Step 8: Run the gates**

Run: `deno task check && deno test -A && uv run pytest tests/scripts -q`
Expected: all green. In particular `tests/phenogram_layout_test.ts`,
`tests/tooltips_test.ts` (the STRIVE rows at :406-422 still render the same
strings because the manifest carries them) and the phenogram figure suite pass
unchanged.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Move phenogram families to disease/ and the citation standard to the manifest"
```

---

### Task 5: Split the timeline encoding; populations from the manifest

**Files:**

- Create: `disease/timeline.json`, `lib/disease/populations.ts`
- Modify: `lib/timeline_encoding.json` (remove `populations`, `mechanisms`,
  `unknownMechanism`, `families`), `lib/timeline.ts:16,101`,
  `lib/constants.ts:166-172`, `scripts/timeline_figure.py` (`DEFAULT_ENCODING`,
  `load_encoding`), `tests/timeline_encoding_test.ts:1-10,58-63`,
  `tests/scripts/test_timeline_figure.py` (loader), `.claude/rules/timeline.md`
  (paths), `lib/disease.ts`.
- Test: `tests/timeline_encoding_test.ts`, `tests/timeline_layout_test.ts`,
  `tests/data_contract_test.ts`, `tests/scripts/test_timeline_figure.py`,
  `tests/disease_manifest_test.ts`.

**Interfaces:**

- Produces: `disease/timeline.json` =
  `{ populations, mechanisms, unknownMechanism, families }`;
  `lib/disease/populations.ts` exporting `POPULATIONS: readonly Population[]`
  and `POPULATION_FIELD: { label: string; detailsLabel: string }`;
  `POPULATION_CHOICES` in `lib/constants.ts` derived from `POPULATIONS`;
  `scripts/timeline_figure.load_encoding(path, disease)`.

- [ ] **Step 1: Write the failing tests**

In `tests/timeline_encoding_test.ts` change the encoding import to two imports
and make the population-order test read the manifest:

```ts
import appearance from "../lib/timeline_encoding.json" with { type: "json" };
import diseaseTimeline from "../disease/timeline.json" with { type: "json" };
import { encoding } from "../lib/timeline.ts";
import { manifest } from "../lib/disease.ts";
```

```ts
Deno.test("every population in the data has an encoding entry, in the manifest's order", () => {
  const keys = encoding.populations.map((p) => p.key);
  assertEquals(keys, manifest.populations.map((p) => p.key));
  assertEquals(unique(keys).size, keys.length, "population keys repeat");
  // ... the rest of the test body unchanged
```

`raw` (line 56) becomes
`{ ...appearance, ...diseaseTimeline } as unknown as Partial<ExpectedEncoding>`.

Add to `tests/disease_manifest_test.ts`:

```ts
import diseaseTimeline from "../disease/timeline.json" with { type: "json" };
import { POPULATION_CHOICES, SHOW_ALL } from "../lib/constants.ts";

Deno.test("the radar's populations are the manifest's, in order", () => {
  assertEquals(
    diseaseTimeline.populations.map((p) => p.key),
    manifest.populations.map((p) => p.key),
  );
});

Deno.test("POPULATION_CHOICES is Show All followed by the manifest's populations", () => {
  assertEquals(POPULATION_CHOICES.map((c) => c.value), [
    SHOW_ALL,
    ...manifest.populations.map((p) => p.key),
  ]);
  assertEquals(POPULATION_CHOICES.map((c) => c.label), [
    "Show All",
    ...manifest.populations.map((p) => p.label),
  ]);
});
```

- [ ] **Step 2: Run to verify failure**

Run:
`deno test -A tests/timeline_encoding_test.ts tests/disease_manifest_test.ts`
Expected: FAIL, `../disease/timeline.json` not found.

- [ ] **Step 3: Split the file**

Write `disease/timeline.json` by moving the four keys out of
`lib/timeline_encoding.json` verbatim. Use a script so no value is retyped:

```bash
python3 - <<'EOF'
import json
src = json.load(open("lib/timeline_encoding.json"))
disease = {
    "$comment": "The radar's disease content: the sectors (populations, in the manifest's order, with label lines and colours), the curated mechanism strings with their colours, the fallback colour, and the mechanism families. Rings, rim band, evidence states and the record flag are registry facts and stay in lib/timeline_encoding.json.",
    "populations": src.pop("populations"),
    "mechanisms": src.pop("mechanisms"),
    "unknownMechanism": src.pop("unknownMechanism"),
    "families": src.pop("families"),
}
json.dump(disease, open("disease/timeline.json", "w"), indent=2, ensure_ascii=False)
json.dump(src, open("lib/timeline_encoding.json", "w"), indent=2, ensure_ascii=False)
EOF
deno fmt disease/timeline.json lib/timeline_encoding.json
```

Then edit the `$comment` in `lib/timeline_encoding.json` to say populations,
mechanisms and families live in `disease/timeline.json`.

- [ ] **Step 4: Compose in `lib/timeline.ts`**

Line 16 becomes two imports:

```ts
import appearanceJson from "./timeline_encoding.json" with { type: "json" };
import diseaseJson from "../disease/timeline.json" with { type: "json" };
```

Line 101 becomes:

```ts
export const encoding: TimelineEncoding = { ...appearanceJson, ...diseaseJson };
```

Update the module doc (lines 6-9): "Both read `lib/timeline_encoding.json` for
the rings and chrome and `disease/timeline.json` for populations, mechanisms and
families".

- [ ] **Step 5: `lib/disease/populations.ts` and `POPULATION_CHOICES`**

Create `lib/disease/populations.ts`:

```ts
/** The trial populations: the radar's sectors and the population filter. */

import type { Population } from "../types.ts";
import { manifest } from "./manifest.ts";

export const POPULATIONS: readonly Population[] = manifest.populations;

/** Column header and filter label for the population column. */
export const POPULATION_FIELD: { label: string; detailsLabel: string } =
  manifest.populationField;
```

In `lib/constants.ts` add
`import { POPULATIONS } from "./disease/populations.ts";` and replace lines
166-172 with:

```ts
export const POPULATION_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  // Derived, never listed: `disease/manifest.json` is the one place a
  // population's key and label live, and `disease/timeline.json` gives the
  // same keys their sector colours. tests/disease_manifest_test.ts holds the
  // two in the same order.
  ...POPULATIONS.map((p) => ({ label: p.label, value: p.key })),
];
```

Add `export * from "./disease/populations.ts";` to `lib/disease.ts`.

- [ ] **Step 6: Python twin**

In `scripts/timeline_figure.py`:

```python
DEFAULT_ENCODING = _PROJECT_ROOT / "lib" / "timeline_encoding.json"
DEFAULT_DISEASE_ENCODING = _PROJECT_ROOT / "disease" / "timeline.json"
```

```python
def load_encoding(
    path: Path = DEFAULT_ENCODING,
    disease: Path = DEFAULT_DISEASE_ENCODING,
) -> dict[str, Any]:
    """Rings and chrome from lib/, populations and mechanisms from disease/."""
    with path.open(encoding="utf-8") as handle:
        encoding = json.load(handle)
    with disease.open(encoding="utf-8") as handle:
        encoding.update(json.load(handle))
    return encoding
```

In `tests/scripts/test_timeline_figure.py` route any direct read of
`lib/timeline_encoding.json` through `load_encoding()`.

`pipeline/clinical_trials_fetch.py:201` (`_TIMELINE_ENCODING`, rings only) is
unchanged.

- [ ] **Step 7: Rules paths**

In `.claude/rules/timeline.md` `paths:` add `- "disease/timeline.json"` and
`- "lib/disease/populations.ts"`; in the body's "`lib/timeline_encoding.json` is
the only place styling lives" sentence, add that populations, mechanisms and
families are the disease's and live in `disease/timeline.json`, and that
population _identity_ (key, label, order) is `populations[]` in
`disease/manifest.json`.

- [ ] **Step 8: Run the gates**

Run:
`deno task check && deno test -A && uv run pytest tests/scripts -q && uv run pytest tests/pipeline/test_clinical_trials_fetch.py -q`
Expected: all green; `tests/timeline_layout_test.ts:185` still sees
`["Any SVD", "(including monogenic)"]`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Move the radar's populations and mechanisms to disease/; derive POPULATION_CHOICES"
```

---

### Task 6: Cell-type glossary and column labels from the manifest

**Files:**

- Create: `lib/disease/cell_types.ts`
- Modify: `lib/constants.ts:219-229`, `lib/tooltips.ts:13`,
  `islands/GenesView.tsx:291`, `islands/TrialsView.tsx:159-166,221-224`,
  `islands/TrialsTimeline.tsx:143`, `lib/disease.ts`
- Test: `tests/disease_manifest_test.ts`, `tests/components_test.tsx:524`,
  `tests/tooltips_test.ts`

**Interfaces:**

- Produces: `CELL_TYPE_NAMES: Record<string, string>` and
  `CELL_TYPES_LABEL: string` from `lib/disease/cell_types.ts`;
  `lib/constants.ts` re-exports `CELL_TYPE_NAMES`.

- [ ] **Step 1: Write the failing test**

Add to `tests/disease_manifest_test.ts`:

```ts
import { CELL_TYPE_NAMES, CELL_TYPES_LABEL } from "../lib/disease.ts";
import { genes } from "../lib/data/genes.ts";
import { splitCellTypes } from "../lib/tooltips.ts";

Deno.test("the cell-type glossary is the manifest's and covers the committed rows", () => {
  assertEquals(CELL_TYPE_NAMES, manifest.cellTypes.glossary);
  assertEquals(CELL_TYPES_LABEL, "Brain Cell Types");
  const used = new Set(genes.flatMap((g) => splitCellTypes(g.brainCellTypes)));
  const missing = [...used].filter((abbr) => !(abbr in CELL_TYPE_NAMES));
  assertEquals(missing, []);
});
```

If `splitCellTypes` is not exported from `lib/tooltips.ts`, export the existing
splitter that `cellTypeTooltip` uses (search for how `brainCellTypes` is split
near line 185); do not write a second one.

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A tests/disease_manifest_test.ts` Expected: FAIL,
`CELL_TYPE_NAMES` is not exported from `../lib/disease.ts`.

- [ ] **Step 3: Implement**

Create `lib/disease/cell_types.ts`:

```ts
/** Abbreviation expansions for the curated cell-type column. */

import { manifest } from "./manifest.ts";

/** Column header, e.g. "Brain Cell Types". */
export const CELL_TYPES_LABEL: string = manifest.cellTypes.label;

/** Abbreviation → full name, shown in the column's tooltips. */
export const CELL_TYPE_NAMES: Record<string, string> =
  manifest.cellTypes.glossary;
```

In `lib/constants.ts` delete lines 219-229 and add
`export { CELL_TYPE_NAMES } from "./disease/cell_types.ts";` so
`lib/tooltips.ts:13` keeps importing from `constants.ts` unchanged. In
`islands/GenesView.tsx:291` replace `header: "Brain Cell Types"` with
`header: CELL_TYPES_LABEL` and add
`import { CELL_TYPES_LABEL } from "../lib/disease/cell_types.ts";`.

In `islands/TrialsView.tsx` add
`import { POPULATION_FIELD } from "../lib/disease/populations.ts";`, and replace
`header: "SVD Population"` (line 160) with `header: POPULATION_FIELD.label`,
`header: "SVD Population Details"` (line 165) with
`header: POPULATION_FIELD.detailsLabel`, and the filter group
`label: "SVD Population"` (line 222) with `label: POPULATION_FIELD.label`. In
`islands/TrialsTimeline.tsx:143` replace `label: "SVD Population Details"` with
`label: POPULATION_FIELD.detailsLabel` and add the same import.

Add `export * from "./disease/cell_types.ts";` to `lib/disease.ts`.

- [ ] **Step 4: Run the gates**

Run: `deno task check && deno test -A` Expected: green;
`tests/components_test.tsx:524` still finds "SVD Population" because the
manifest supplies it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Read the cell-type glossary and population labels from the manifest"
```

---

### Task 7: Site prose from the manifest

**Files:**

- Create: `lib/disease/site.ts`
- Modify: `lib/constants.ts:21-22`, `routes/_app.tsx:48-49,74-77,205-210`,
  `routes/index.tsx:21,28-72,199-205`, `routes/login.tsx:67-72`,
  `routes/genes.tsx:10`, `routes/trials.tsx:10`, `routes/timeline.tsx:16`,
  `routes/map.tsx:10`, `islands/TrialsTimeline.tsx:1220-1222`,
  `tests/routes_test.tsx:238,286,311`, `e2e/tests/navigation.spec.ts:10,27`,
  `e2e/tests/login.spec.ts:21,23`, `e2e/fixtures/expected-data.ts`,
  `lib/disease.ts`
- Test: `tests/routes_test.tsx`, `tests/disease_manifest_test.ts`

**Interfaces:**

- Produces from `lib/disease/site.ts`: `SITE_TITLE`, `HEADING`,
  `META_DESCRIPTION`, `ABOUT_TITLE`, `ABOUT_LEDE`, `LOGIN_LEDE`,
  `PAGE_DESCRIPTIONS: { genes; trials; timeline; map }`, `RADAR_TITLE`,
  `INSTITUTE`, `MAINTAINER`, `ABOUT`; `e2e/fixtures/expected-data.ts` exports
  `SITE_TITLE`, `ABOUT_HEADING`, `POPULATION_LABEL`.

- [ ] **Step 1: Write the failing test**

Add to `tests/disease_manifest_test.ts`:

```ts
import { RADAR_TITLE, SITE_TITLE } from "../lib/disease.ts";
import { SITE_TITLE as CONSTANTS_SITE_TITLE } from "../lib/constants.ts";

Deno.test("site strings derive from the manifest", () => {
  assertEquals(SITE_TITLE, manifest.site.title);
  assertEquals(CONSTANTS_SITE_TITLE, SITE_TITLE);
  assertEquals(
    RADAR_TITLE,
    "Cerebral SVD clinical trials by population and phase",
  );
});
```

In `tests/routes_test.tsx` replace the three literals: line 238
`"Cerebral SVD clinical trials by population and phase"` → `RADAR_TITLE`; line
286 `"<title>Genes | ICM Cerebral SVD Dashboard</title>"` →
`` `<title>Genes | ${SITE_TITLE}</title>` ``; line 311
`"<title>ICM Cerebral SVD Dashboard</title>"` →
`` `<title>${SITE_TITLE}</title>` ``; import both from `../lib/disease.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A tests/disease_manifest_test.ts tests/routes_test.tsx`
Expected: FAIL, `RADAR_TITLE` not exported.

- [ ] **Step 3: Write `lib/disease/site.ts`**

```ts
/** Every piece of page prose that names the disease or the institute. */

import { manifest } from "./manifest.ts";

const { site, disease, institute, contact, about } = manifest;

/** Tab title, login card heading, footer. */
export const SITE_TITLE: string = site.title;
/** Navbar centre title. */
export const HEADING: string = site.heading;
export const META_DESCRIPTION: string = site.metaDescription;
export const ABOUT_TITLE: string = site.aboutTitle;
export const ABOUT_LEDE: string = site.aboutLede;
/** First sentence of the login card; the passphrase sentence is chrome. */
export const LOGIN_LEDE: string = site.loginLede;
export const PAGE_DESCRIPTIONS = site.pages;
/** Accessible name of the radar SVG. */
export const RADAR_TITLE: string =
  `${disease.adjective} clinical trials by population and phase`;
export const INSTITUTE = institute;
export const MAINTAINER = contact.maintainer;
export const ABOUT = about;
```

Add `export * from "./disease/site.ts";` to `lib/disease.ts`. In
`lib/constants.ts` replace lines 21-22 with
`export { SITE_TITLE } from "./disease/site.ts";` keeping the doc comment.

- [ ] **Step 4: Rewire the routes and the island**

`routes/_app.tsx`: import `{ HEADING, INSTITUTE, META_DESCRIPTION }` from
`../lib/disease/site.ts`; delete the `HEADING` literal (lines 48-49); replace
the meta `content` (line 76) with `{META_DESCRIPTION}`; replace
`Paris Brain Institute (ICM)` in the footer (line 209) with
`{INSTITUTE.copyright}`.

`routes/index.tsx`: import `{ ABOUT, ABOUT_LEDE, ABOUT_TITLE, MAINTAINER }` from
`../lib/disease/site.ts`; delete the `TITLE` literal (line 21) and use
`ABOUT_TITLE` where `TITLE` was rendered; replace the lede paragraph (lines
199-205) with `<p class="about-lede">{ABOUT_LEDE}</p>`; rewrite `INFO_ROWS` so
each row reads the manifest:

```tsx
const INFO_ROWS: ReadonlyArray<{
  icon: IconName;
  label: string;
  value: ComponentChildren;
  /** Rendered muted and italic: a placeholder, not a value. */
  pending?: boolean;
}> = [
  ABOUT.citation === null
    ? {
      icon: "chatQuote",
      label: "How to Cite:",
      value: (
        <>
          Last Name, Initial. <i>et al.</i> Publication Title. <i>Journal.</i>
          {" "}
          (Publication Year) DOI
        </>
      ),
      pending: true,
    }
    : {
      icon: "chatQuote",
      label: "How to Cite:",
      value: (
        <>
          {ABOUT.citation.authors} {ABOUT.citation.title}.{" "}
          <i>{ABOUT.citation.journal}.</i> ({ABOUT.citation.year}){" "}
          <a href={`https://doi.org/${ABOUT.citation.doi}`}>
            {ABOUT.citation.doi}
          </a>
        </>
      ),
    },
  {
    icon: "userGroup",
    label: "Scientific Board:",
    value: ABOUT.board ?? "To be confirmed",
    pending: ABOUT.board === null,
  },
  {
    icon: "identification",
    label: "Contact Us:",
    value: ABOUT.contactUs ?? "To be confirmed",
    pending: ABOUT.contactUs === null,
  },
  {
    icon: "arrowPath",
    label: "Maintenance:",
    value: (
      <a
        class="about-contact"
        href={`mailto:${MAINTAINER.email}`}
        aria-label={`Email ${MAINTAINER.name} at ${MAINTAINER.email}`}
      >
        <Icon name="envelope" />
        {MAINTAINER.name}
      </a>
    ),
  },
  {
    icon: "checkBadge",
    label: "Acknowledgements:",
    value: ABOUT.acknowledgements ?? "To be confirmed",
    pending: ABOUT.acknowledgements === null,
  },
];
```

After `DATA_SOURCES`, append the manifest's extra sources so the render loop
needs no change:

```tsx
const ALL_SOURCES = [
  ...DATA_SOURCES,
  ...ABOUT.additionalSources.map((s) => ({
    name: s.name,
    href: s.href,
    licence: s.licence.href
      ? (
        <a href={s.licence.href} target="_blank" rel="noopener noreferrer">
          {s.licence.label}
        </a>
      )
      : s.licence.label,
    provides: s.provides,
  })),
];
```

and render `ALL_SOURCES.map(...)` where `DATA_SOURCES.map(...)` is today.

`routes/login.tsx`: import `LOGIN_LEDE` from `../lib/disease/site.ts` and
replace the lede paragraph with:

```tsx
<p class="login-lede">
  {LOGIN_LEDE}{" "}
  This preview is shared with collaborators; enter the passphrase to continue.
</p>;
```

`routes/genes.tsx`, `trials.tsx`, `timeline.tsx`, `map.tsx`:
`description={PAGE_DESCRIPTIONS.genes}` etc., importing `PAGE_DESCRIPTIONS` from
`../lib/disease/site.ts`.

`islands/TrialsTimeline.tsx:1221`: replace the literal with `{RADAR_TITLE}`,
importing from `../lib/disease/site.ts` (site prose only; the island's bundle
grows by the manifest's few KB, which is the accepted cost stated in the spec).

- [ ] **Step 5: e2e fixtures and specs**

In `e2e/fixtures/expected-data.ts` add, after `TRAIT_COUNT`:

```ts
const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "disease", "manifest.json"), "utf8"),
) as {
  disease: { adjective: string };
  site: { title: string; aboutTitle: string };
  populationField: { label: string };
};

export const SITE_TITLE = manifest.site.title;
export const ABOUT_HEADING = manifest.site.aboutTitle;
export const POPULATION_LABEL = manifest.populationField.label;
```

`e2e/tests/navigation.spec.ts:10` → `heading: ABOUT_HEADING`; `:27` →
`` `${route.label} | ${SITE_TITLE}` ``. `e2e/tests/login.spec.ts:21` →
``toHaveTitle(`Sign in | ${SITE_TITLE}`)``; `:23` → `SITE_TITLE`.
`e2e/tests/trials-filters.spec.ts:25` → `const POPULATION = POPULATION_LABEL;`;
`e2e/tests/filter-collapse.spec.ts:16` → `group: POPULATION_LABEL`. Import from
`../fixtures/expected-data.ts` in each.

- [ ] **Step 6: Run the gates**

Run:
`deno task check && deno test -A && cd e2e && npx playwright test tests/navigation.spec.ts tests/login.spec.ts tests/about.spec.ts tests/trials-filters.spec.ts tests/filter-collapse.spec.ts; cd ..`
Expected: all green. The About page renders identically: run
`deno task build && deno task start` in one shell and
`curl -s http://127.0.0.1:8000/login | grep -c "cerebral small vessel disease (SVD)"`
in another; expected `1`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Read site prose, the About rows and route descriptions from the manifest"
```

---

### Task 8: `InstituteLogo` from two static files

**Files:**

- Create: `components/InstituteLogo.tsx`, `static/institute/logo-light.svg`,
  `static/institute/logo-dark.svg`
- Delete: `components/IcmLogo.tsx`
- Modify: `routes/_app.tsx:6,135`, `routes/login.tsx:4,66`,
  `tests/components_test.tsx:22,188`, `assets/app.css:946,2507,2590,5170`
- Test: `tests/components_test.tsx`

**Interfaces:**

- Produces: `InstituteLogo({ dark?: boolean; decorative?: boolean })` rendering
  `<img class="institute-logo" src alt>`.

- [ ] **Step 1: Write the failing test**

In `tests/components_test.tsx` replace the `IcmLogo` import (line 22) with
`import { InstituteLogo } from "../components/InstituteLogo.tsx";` and line 188
with `<InstituteLogo />`. Add:

```tsx
Deno.test("InstituteLogo renders the manifest's logo and swaps the file on dark", () => {
  const light = renderToString(<InstituteLogo />);
  assertStringIncludes(light, 'src="/institute/logo-light.svg"');
  assertStringIncludes(light, 'alt="Paris Brain Institute"');
  const dark = renderToString(<InstituteLogo dark />);
  assertStringIncludes(dark, 'src="/institute/logo-dark.svg"');
  const decorative = renderToString(<InstituteLogo decorative />);
  assertStringIncludes(decorative, 'alt=""');
  assertStringIncludes(decorative, 'aria-hidden="true"');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test -A tests/components_test.tsx` Expected: FAIL, module not found.

- [ ] **Step 3: Export the SVG twice and write the component**

Create `static/institute/logo-light.svg` from the `<svg>` in
`components/IcmLogo.tsx`: same `viewBox="0 0 826 235.45"`, the mark `<g>` with
`fill="#e94e14"` (the value of `--svd-icm-mark` in `assets/app.css`; confirm
with `grep -n -- '--svd-icm-mark:' assets/app.css`) and the wordmark paths with
`fill="#2d2678"`. Create `logo-dark.svg` identical but with the wordmark
`fill="#ffffff"`. Add `xmlns="http://www.w3.org/2000/svg"` on the root of each.

Create `components/InstituteLogo.tsx`:

```tsx
/**
 * The institute's mark, from the manifest.
 *
 * Two static files rather than one inline SVG recoloured through
 * currentColor: a fork replaces two files under static/institute/ and
 * touches nothing under components/. The navbar is dark in both themes, so
 * it asks for the dark file; the login card sits on a light surface.
 */
import { INSTITUTE } from "../lib/disease/site.ts";

export function InstituteLogo(
  { dark = false, decorative = false }: {
    dark?: boolean;
    decorative?: boolean;
  },
) {
  const src = dark
    ? INSTITUTE.logo.srcOnDark ?? INSTITUTE.logo.src
    : INSTITUTE.logo.src;
  return (
    <img
      class="institute-logo"
      src={src}
      alt={decorative ? "" : INSTITUTE.logo.alt}
      aria-hidden={decorative ? "true" : undefined}
    />
  );
}
```

`routes/_app.tsx:135` → `<InstituteLogo dark decorative />`;
`routes/login.tsx:66` → `<InstituteLogo />`; update both imports. Delete
`components/IcmLogo.tsx`. In `assets/app.css` rename the four `.icm-logo`
selectors to `.institute-logo`; the `--svd-icm-mark` token stays (the
styles-contract test names it).

- [ ] **Step 4: Run the gates**

Run:
`deno task check && deno test -A && cd e2e && npx playwright test tests/login.spec.ts tests/navigation.spec.ts; cd ..`
Expected: green. Look once: `deno task build && deno task start`, open `/login`
and the navbar, confirm the mark and wordmark render at the old size.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Replace the inline ICM logo with InstituteLogo over two static files"
```

---

### Task 9: Move `omim_info.csv`

**Files:**

- Move: `pipeline/export/data/omim_info.csv` → `disease/omim_info.csv`
- Modify: `pipeline/export/omim.py:29`, `scripts/reconcile_omim.py:8`,
  `tests/pipeline/export/test_omim.py:87`
- Test: `tests/pipeline/export/test_omim.py`,
  `tests/pipeline/export/test_writer.py`

- [ ] **Step 1: Write the failing test change**

In `tests/pipeline/export/test_omim.py` after line 88 add:

```python
def test_the_csv_lives_in_the_disease_directory() -> None:
    from pipeline.disease import OMIM_CSV_PATH

    assert DEFAULT_OMIM_CSV == OMIM_CSV_PATH
    assert DEFAULT_OMIM_CSV.parent.name == "disease"
```

Run: `uv run pytest tests/pipeline/export/test_omim.py -q` — expected FAIL on
the parent name.

- [ ] **Step 2: Move and repoint**

```bash
git mv pipeline/export/data/omim_info.csv disease/omim_info.csv
rmdir pipeline/export/data 2>/dev/null || true
```

`pipeline/export/omim.py:29` → `DEFAULT_OMIM_CSV: Final[Path] = OMIM_CSV_PATH`
with `from pipeline.disease import OMIM_CSV_PATH`. `scripts/reconcile_omim.py:8`
docstring → `disease/omim_info.csv`.
`grep -rn 'export/data/omim_info' . --include='*.py' --include='*.md' --include='*.toml' | grep -v node_modules`
and fix each hit (README, CLAUDE.md, the `regenerate-data` skill if it names it;
`pyproject.toml` if the package data glob names the directory).

- [ ] **Step 3: Verify and commit**

Run:
`uv run pytest tests/pipeline/export -q && uv run ruff check . && uv run ty check`
Expected: green; `data/omim_info.json` byte-identical (`git status` shows no
change under `data/`).

```bash
git add -A
git commit -m "Move the curated OMIM table to disease/"
```

---

### Task 10: Prompt v7: template plus `disease/prompt.md`, pinned byte-identical to v6

**Files:**

- Create: `tests/pipeline/fixtures/prompt_v6_system.txt`,
  `tests/pipeline/fixtures/prompt_v6_instructions.txt`,
  `tests/pipeline/test_prompt_assembly.py`, `disease/prompt.md`
- Modify: `pipeline/prompts.py` (whole file), `pipeline/disease.py` (prompt
  sections), `pipeline/config.py:288,761-764`, `tests/pipeline/test_prompts.py`,
  `tests/pipeline/test_prompt_vocabulary.py` (docstring),
  `tests/pipeline/test_extraction_golden.py:422`,
  `tests/pipeline/test_config.py`, `pyproject.toml:103`, `pipeline/CLAUDE.md`
- Test: as named

**Interfaces:**

- Produces:
  `pipeline.prompts.render_prompt(template: str, sections: Mapping[str, str]) -> str`;
  `_PROMPTS == {"v7": (system, instructions)}`; `prompt_sha256() -> str`;
  `Disease.prompt_sections: Mapping[str, str]` and `Disease.prompt_sha256: str`
  (of the file bytes); `PipelineConfig.prompt_version` default `"v7"`;
  `build_extraction_prompt(..., prompt_version="v7")`.

- [ ] **Step 1: Freeze the v6 bytes as fixtures**

```bash
uv run python - <<'EOF'
from pathlib import Path
from pipeline import prompts
Path("tests/pipeline/fixtures/prompt_v6_system.txt").write_text(prompts._SYSTEM_PROMPT, encoding="utf-8")
Path("tests/pipeline/fixtures/prompt_v6_instructions.txt").write_text(prompts._EXTRACTION_INSTRUCTIONS_V6, encoding="utf-8")
EOF
shasum -a 256 tests/pipeline/fixtures/prompt_v6_*.txt
```

Expected: `f571dedb6f88abf2291d4c8568482150db1c1b2e94f1f778d3fc145e01b5f3e4` and
`70908abc03022ed389fda9c8351cab8f1eb46a9afc1aa62383bd5d72812ba853`. Check
`tests/pipeline/.gitignore` (or the root one) does not ignore `fixtures/*.txt` —
the paper fixtures are ignored by name pattern under `fixtures/papers/`; these
two must be committed.

- [ ] **Step 2: Write the failing byte-identity test**

Create `tests/pipeline/test_prompt_assembly.py`:

```python
"""v7 plus the cSVD disease file *is* v6, byte for byte.

The fixtures are the v6 literals as they were before the split, pinned by
sha256 so the fixture itself cannot drift. Every recorded cassette, the
recall baseline and Anthropic's prompt cache depend on these bytes.
"""

import hashlib
from pathlib import Path

import pytest

from pipeline.config import PipelineConfig
from pipeline.disease import load_disease
from pipeline.prompts import (
    _PROMPTS,
    PROMPT_VERSIONS,
    build_extraction_prompt,
    prompt_sha256,
    render_prompt,
)

_FIXTURES = Path(__file__).parent / "fixtures"
_SYSTEM_SHA = "f571dedb6f88abf2291d4c8568482150db1c1b2e94f1f778d3fc145e01b5f3e4"
_INSTRUCTIONS_SHA = "70908abc03022ed389fda9c8351cab8f1eb46a9afc1aa62383bd5d72812ba853"
_TASK_SHA = "b3b2344a9a5d220b53f120985d4a1330dea6f301344e8bbf3f73c7209da4ba9a"


def _fixture(name: str, sha: str) -> str:
    text = (_FIXTURES / name).read_text(encoding="utf-8")
    assert hashlib.sha256(text.encode("utf-8")).hexdigest() == sha, name
    return text


def test_v7_with_the_csvd_sections_reproduces_v6_byte_for_byte() -> None:
    system, instructions = _PROMPTS["v7"]
    assert system == _fixture("prompt_v6_system.txt", _SYSTEM_SHA)
    assert instructions == _fixture("prompt_v6_instructions.txt", _INSTRUCTIONS_SHA)
    assert len(instructions) == 18469


def test_the_task_instruction_and_tool_description_are_unchanged() -> None:
    prompt = build_extraction_prompt("paper", "1", 1000, prompt_version="v7")
    assert (
        hashlib.sha256(prompt.task_instruction.encode("utf-8")).hexdigest()
        == _TASK_SHA
    )
    assert PipelineConfig().extraction_tool["description"] == (
        "Report every gene with a putative causal link to cerebral small vessel "
        "disease found in the document."
    )


def test_only_v7_exists() -> None:
    assert PROMPT_VERSIONS == frozenset({"v7"})


def test_prompt_sha256_covers_system_and_instructions() -> None:
    system, instructions = _PROMPTS["v7"]
    expected = hashlib.sha256(
        system.encode("utf-8") + b"\n\n" + instructions.encode("utf-8")
    ).hexdigest()
    assert prompt_sha256() == expected


class TestRenderer:
    def test_substitutes_a_slot(self) -> None:
        assert render_prompt("a {{ x.y }} b", {"x.y": "Z"}) == "a Z b"

    def test_refuses_an_unknown_slot(self) -> None:
        with pytest.raises(ValueError, match="x.y"):
            render_prompt("{{ x.y }}", {})

    def test_refuses_an_unreferenced_section(self) -> None:
        with pytest.raises(ValueError, match="unused"):
            render_prompt("plain", {"unused": "v"})

    def test_refuses_a_residual_brace_pair(self) -> None:
        with pytest.raises(ValueError, match="unrendered"):
            render_prompt("{{ a }}", {"a": "{{ b }}", "b": "x"})


def test_the_monogenic_list_in_the_prompt_matches_the_manifest() -> None:
    d = load_disease()
    listed = tuple(
        s.strip() for s in d.prompt_sections["strategy.monogenic_genes"].split(",")
    )
    assert listed == d.monogenic_genes
```

Run: `uv run pytest tests/pipeline/test_prompt_assembly.py -q` — expected FAIL
(`render_prompt` and `prompt_sha256` do not exist; `_PROMPTS` has no `v7`).

- [ ] **Step 3: Write `disease/prompt.md`**

The file holds only prose. Each section is `## <id>` followed by its body. The
bodies are the exact substrings of the v6 literal listed in the spec's section
3.3 table. Write it with this script so nothing is retyped:

```bash
uv run python - <<'EOF'
from pathlib import Path
v6 = Path("tests/pipeline/fixtures/prompt_v6_instructions.txt").read_text(encoding="utf-8")
sys6 = Path("tests/pipeline/fixtures/prompt_v6_system.txt").read_text(encoding="utf-8")

def between(text, start, end):
    i = text.index(start); j = text.index(end, i + len(start))
    return text[i:j + len(end)]

sections = {
  "persona.specificity": between(sys6, "You carefully distinguish", "neurodegeneration findings."),
  "criteria.phenotypes": between(v6, "Primary cSVD phenotypes:", "- WM-BAG (white matter brain age gap)"),
  "strategy.phenotype_shortlist": "SVS, WMH, lacunes, PVS, microbleeds",
  "strategy.neighbouring_conditions": "general stroke, cardioembolic stroke, or large-artery stroke",
  "strategy.monogenic_genes": "NOTCH3, COL4A1, COL4A2, HTRA1, TREX1, GLA",
  "strategy.background_example": "CADASIL is caused by NOTCH3 mutations.",
  "strategy.causal_gene_example": between(v6, "For example, if a locus is labeled by LINC01600", "extract C6orf195."),
  "strategy.mr_example": "genetically proxied ACE inhibition reduces WMH",
  "strategy.ortholog_example": "mouse Trim47 → TRIM47, zebrafish col4a1 → COL4A1",
  "strategy.disease_steps": between(v6, "For PVS (perivascular space) GWAS studies:", "locus/positional candidate tables."),
  "strategy.convergence_example": "both WM-PVS and HIP-PVS, or WMH and SVS",
  "traits.canonical": between(v6, "WMH, DWMH, PVWMH, SVS, BG-PVS", "WM-BAG, retinal-vessels"),
  "guidance.specificity_note": "Note stroke-subtype specificity (cSVD-specific vs. general stroke).",
  "rubric.subgroup_example": "WMH/DWMH",
  "rubric.monogenic_examples": "NOTCH3, COL4A1/COL4A2, HTRA1",
  "rubric.cell_types": "brain endothelial, pericyte, VSMC",
  "rubric.neighbour_gwas_gene": "general stroke GWAS gene without cSVD-specific evidence",
  "rubric.modifiers": between(v6, "- Stroke-specificity penalty:", "independently of monogenic status."),
  "examples": between(v6, '<example type="include_validated">', "</example>\n</examples>")[:-len("\n</examples>")],
}
for k, v in sections.items():
    assert v in v6 or v in sys6, k
out = ["# Disease sections of the extraction prompt", "",
       "Rendered into the v7 template in `pipeline/prompts.py`. Each `## id` is one",
       "slot; the body is the text between headings with surrounding blank lines",
       "stripped. `disease.name` and `disease.abbreviation` come from manifest.json.",
       "tests/pipeline/test_prompt_assembly.py pins the cSVD rendering to the v6 bytes.", ""]
for k, v in sections.items():
    out += [f"## {k}", "", v, ""]
Path("disease/prompt.md").write_text("\n".join(out), encoding="utf-8")
EOF
```

Check `strategy.disease_steps` renders as one item and `examples` contains 14
`<example` opens: `grep -c '<example type=' disease/prompt.md` → 14.

- [ ] **Step 4: Extend `pipeline/disease.py` with the prompt sections**

Add to `Disease`:

```python
prompt_sections: Mapping[str, str]
prompt_file_sha256: str
```

Add the parser and wire it into `load_disease`:

```python
_HEADING = re.compile(r"^## (?P<id>[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*$", re.M)


def _parse_prompt_sections(text: str) -> dict[str, str]:
    """``## id`` headings to bodies, blank lines at either end stripped."""
    matches = list(_HEADING.finditer(text))
    if not matches:
        raise ValueError("disease/prompt.md: no '## <section.id>' headings")
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        key = match.group("id")
        if key in sections:
            raise ValueError(f"disease/prompt.md: duplicate section {key}")
        sections[key] = text[start:end].strip("\n")
    return sections
```

(`import re` and `import hashlib` at the top.) In `load_disease`:

```python
@cache
def load_disease() -> Disease:
    """Read the manifest and the prompt sections once for the life of the process."""
    with MANIFEST_PATH.open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    prompt_bytes = PROMPT_PATH.read_bytes()
    sections = _parse_prompt_sections(prompt_bytes.decode("utf-8"))
    return _parse_manifest(
        manifest,
        prompt_sections=MappingProxyType(sections),
        prompt_file_sha256=hashlib.sha256(prompt_bytes).hexdigest(),
    )
```

and give `_parse_manifest` the two keyword parameters (defaulting to an empty
mapping and `""` so `tests/pipeline/test_disease.py`'s direct calls keep
working), passing them into `Disease(...)`.

- [ ] **Step 5: Rewrite `pipeline/prompts.py`**

Replace the two literals and the dispatch with the template and renderer. Keep
the module docstring's measurement history and add a paragraph: "v7 is v6 with
every disease noun moved to `disease/prompt.md`;
`tests/pipeline/test_prompt_assembly.py` pins the cSVD rendering to the v6
bytes, so the recall baseline and the golden cassettes are v7's too."

```python
import hashlib
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from pipeline.disease import load_disease

logger = logging.getLogger(__name__)

_SLOT: Final[re.Pattern[str]] = re.compile(r"\{\{ (?P<id>[a-z][a-z0-9_.]*) \}\}")


def render_prompt(template: str, sections: Mapping[str, str]) -> str:
    """Substitute ``{{ id }}`` slots; refuse anything that would change bytes silently.

    A slot the sections lack, a section the template never asks for, and a
    ``{{`` surviving the render are each an error rather than a fallback:
    the rendered string is the recorded method, and a quiet default would
    publish a prompt nobody wrote.
    """
    used: set[str] = set()

    def fill(match: re.Match[str]) -> str:
        key = match.group("id")
        if key not in sections:
            raise ValueError(f"prompt template names {key}, which the disease file lacks")
        used.add(key)
        return sections[key]

    rendered = _SLOT.sub(fill, template)
    unused = sorted(set(sections) - used)
    if unused:
        raise ValueError(f"disease sections never referenced by the template: {unused}")
    if "{{" in rendered:
        raise ValueError("unrendered '{{' left in the prompt")
    return rendered
```

Then the template. `_SYSTEM_TEMPLATE_V7` is `_SYSTEM_PROMPT` with these two
exact edits: `"cerebral small vessel disease "\n"(cSVD) genetics"` →
`"{{ disease.name }} ({{ disease.abbreviation }}) genetics"`;
`"causal links to cSVD, identified"` →
`"causal links to {{ disease.abbreviation }}, identified"`; and the sentence
`"You carefully distinguish cSVD-specific evidence (small vessel stroke, WMH, "\n"lacunes, PVS, microbleeds) from general stroke or neurodegeneration findings. "`
→ `"{{ persona.specificity }} "`.

`_INSTRUCTIONS_TEMPLATE_V7` is the v6 literal with these exact edits, applied in
this order (each `old` occurs once unless stated):

| old (in v6)                                                                                                                                                | new                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Primary cSVD phenotypes:` … `- WM-BAG (white matter brain age gap)` (the whole block, lines 83-100)                                                       | `{{ criteria.phenotypes }}`                                                                                                                |
| `(SVS, WMH, lacunes, PVS, microbleeds, or another cSVD phenotype) — not just general stroke, cardioembolic stroke, or large-artery stroke.`                | `({{ strategy.phenotype_shortlist }}, or another {{ disease.abbreviation }} phenotype) — not just {{ strategy.neighbouring_conditions }}.` |
| `genes (NOTCH3, COL4A1, COL4A2, HTRA1, TREX1, GLA), only`                                                                                                  | `genes ({{ strategy.monogenic_genes }}), only`                                                                                             |
| `like "CADASIL is caused by NOTCH3 mutations."`                                                                                                            | `like "{{ strategy.background_example }}"`                                                                                                 |
| `For example, if a locus is labeled by LINC01600 in the locus table but TWAS identifies C6orf195 as the causal gene, extract C6orf195.`                    | `{{ strategy.causal_gene_example }}`                                                                                                       |
| `(e.g., "genetically proxied ACE inhibition reduces WMH")`                                                                                                 | `(e.g., "{{ strategy.mr_example }}")`                                                                                                      |
| `(e.g., mouse Trim47 → TRIM47, zebrafish col4a1 → COL4A1)`                                                                                                 | `(e.g., {{ strategy.ortholog_example }})`                                                                                                  |
| the whole line `10. For PVS (perivascular space) GWAS studies: … locus/positional candidate tables.`                                                       | `{{ strategy.steps }}` (see the splice below)                                                                                              |
| `(e.g., both WM-PVS and HIP-PVS, or WMH and SVS)`                                                                                                          | `(e.g., {{ strategy.convergence_example }})`                                                                                               |
| `abbreviations: WMH, DWMH, PVWMH, … WM-BAG, retinal-vessels. Do not`                                                                                       | `abbreviations: {{ traits.canonical }}. Do not`                                                                                            |
| `Note stroke-subtype specificity (cSVD-specific vs. general stroke).`                                                                                      | `{{ guidance.specificity_note }}`                                                                                                          |
| `not subgroups like WMH/DWMH)`                                                                                                                             | `not subgroups like {{ rubric.subgroup_example }})`                                                                                        |
| `(e.g., NOTCH3, COL4A1/COL4A2, HTRA1) OR GWAS`                                                                                                             | `(e.g., {{ rubric.monogenic_examples }}) OR GWAS`                                                                                          |
| `cell type (brain endothelial, pericyte, VSMC)`                                                                                                            | `cell type ({{ rubric.cell_types }})`                                                                                                      |
| `general stroke GWAS gene without cSVD-specific evidence;`                                                                                                 | `{{ rubric.neighbour_gwas_gene }};`                                                                                                        |
| the two bullets `- Stroke-specificity penalty: …` and `- Monogenic-to-sporadic: … independently of monogenic status.`                                      | `{{ rubric.modifiers }}`                                                                                                                   |
| everything between `<examples>\n` and `\n</examples>`                                                                                                      | `{{ examples }}`                                                                                                                           |
| every remaining `cerebral small vessel disease`                                                                                                            | `{{ disease.name }}`                                                                                                                       |
| every remaining `cSVD` (whole word, including inside `cSVD-specific`, `cSVD-related`, `cSVD-relevant`, `extreme-cSVD` does not occur outside the sections) | `{{ disease.abbreviation }}`                                                                                                               |

The numbered strategy list is rendered by Python. In the template, replace the
entire `<extraction_strategy>` body from `1. Identify` to the end of step 13
with the single line `{{ strategy.steps }}`, and hold the steps as:

```python
class _DiseaseSteps:
    """Sentinel: splice the disease's own steps here, numbered in sequence."""


_STRATEGY_STEPS: Final[tuple[str | type[_DiseaseSteps], ...]] = (
    "Identify all passages that mention specific genes in the context of {{ disease.abbreviation }} causality.",
    "Verify that each gene was tested in a {{ disease.abbreviation }}-specific analysis ({{ strategy.phenotype_shortlist }}, or another {{ disease.abbreviation }} phenotype) — not just {{ strategy.neighbouring_conditions }}.",
    # ... steps 3 to 9 verbatim from v6 with the slot edits from the table ...
    _DiseaseSteps,
    # ... v6 steps 11, 12 (with the convergence slot) and 13 verbatim ...
)


def _render_steps(disease_steps: str) -> str:
    items: list[str] = []
    for step in _STRATEGY_STEPS:
        if step is _DiseaseSteps:
            items.extend(s for s in disease_steps.split("\n\n") if s.strip())
        else:
            items.append(step)
    return "\n".join(f"{n}. {body}" for n, body in enumerate(items, 1))
```

Copy steps 3 to 9 and 11 to 13 from the fixture verbatim (they are one line each
in v6); the byte-identity test is what proves the copy. Assemble at import:

```python
def _sections() -> dict[str, str]:
    d = load_disease()
    sections = dict(d.prompt_sections)
    disease_steps = sections.pop("strategy.disease_steps", "")
    sections["disease.name"] = d.name
    sections["disease.abbreviation"] = d.abbreviation
    sections["strategy.steps"] = render_prompt(_render_steps(disease_steps), {
        k: v for k, v in sections.items() if k.startswith(("disease.", "strategy."))
    } | {})
    return sections


def _assemble_v7() -> tuple[str, str]:
    sections = _sections()
    system = render_prompt(_SYSTEM_TEMPLATE_V7, {
        "disease.name": sections["disease.name"],
        "disease.abbreviation": sections["disease.abbreviation"],
        "persona.specificity": sections["persona.specificity"],
    })
    body_sections = {k: v for k, v in sections.items() if k != "persona.specificity"}
    return system, render_prompt(_INSTRUCTIONS_TEMPLATE_V7, body_sections)


_PROMPTS: Final[dict[str, tuple[str, str]]] = {"v7": _assemble_v7()}
```

Note `render_prompt` refuses unreferenced sections, so `_sections()` must hand
each render exactly the keys its template uses: the steps render gets the
`disease.*` and `strategy.*` keys it needs (drop `strategy.*` keys the steps do
not use by filtering on what `_SLOT.findall(_render_steps(...))` returns, rather
than the prefix filter shown, if the refusal fires); the instructions render
gets everything but `persona.specificity` and the raw `strategy.disease_steps`.
Adjust the two filters until `test_prompt_assembly.py` is green; the refusals
are the point.

Add:

```python
def prompt_sha256(version: str = "v7") -> str:
    """The rendered prompt's hash: what a run report records as the method's bytes."""
    system, instructions = _PROMPTS[version]
    return hashlib.sha256(
        system.encode("utf-8") + b"\n\n" + instructions.encode("utf-8")
    ).hexdigest()
```

`build_extraction_prompt`'s default becomes `prompt_version: str = "v7"` and the
task instruction becomes:

```python
abbreviation = load_disease().abbreviation
task_instruction = (
    f"For each gene with a putative causal link to {abbreviation} in the document "
    "above, first state the supporting evidence in one sentence, quoting "
    "the sentence from the document that supports it. Then call "
    "report_genes with the structured result."
)
```

`_PROVENANCE_HEADING`, `PROMPT_VERSIONS`, `PROMPT_VERSIONS_WITHOUT_PROVENANCE`,
`paper_text_truncated` and `ExtractionPrompt` are unchanged.

- [ ] **Step 6: Config**

`pipeline/config.py:288`: default `"v7"`; in the refusal message at :681 change
`Use 'v6' (the default)` to `Use 'v7' (the default)`. The tool description
(:761-764):

```python
disease = load_disease()
return {
    "name": EXTRACTION_TOOL_NAME,
    "description": (
        f"Report every gene with a putative causal link to {disease.name} "
        "found in the document."
    ),
```

with `from pipeline.disease import load_disease` in the imports.

- [ ] **Step 7: Update the sibling tests**

`tests/pipeline/test_prompts.py`: `_PROMPTS["v6"]` → `_PROMPTS["v7"]`; rename
`test_only_v6_remains` to `test_only_v7_remains` asserting `{"v7"}` and extend
its docstring with one sentence: "v7 is v6 split into template and disease file;
the bytes are pinned in test_prompt_assembly.py." `test_contains_csvd` →
`assert load_disease().abbreviation in DEFAULT_SYSTEM_PROMPT`.

`tests/pipeline/test_prompt_vocabulary.py`: the module docstring's "stays a
frozen literal" paragraph becomes "is prose in `disease/prompt.md`, rendered
into the v7 template; the cSVD rendering is pinned byte-for-byte by
`test_prompt_assembly.py`, so an edit is a visible fixture change rather than a
silent one." No code change: `_CANONICAL` parses the rendered instructions.

`tests/pipeline/test_extraction_golden.py:422` →
`prompt_version=PipelineConfig().prompt_version`.
`tests/pipeline/test_config.py`: any `"v6"` literal in a prompt-version
assertion → `"v7"` (grep `v6`).

`pyproject.toml:103` keep the `E501` ignore for `pipeline/prompts.py`.

- [ ] **Step 8: Run the gates**

Run:
`uv run pytest tests/pipeline/test_prompt_assembly.py tests/pipeline/test_prompts.py tests/pipeline/test_prompt_vocabulary.py tests/pipeline/test_config.py tests/pipeline/test_disease.py -q`
Expected: green. Then the whole suite:
`uv run pytest -q && uv run ruff check . && uv run ty check`. The golden and
recall suites replay unchanged cassettes.

- [ ] **Step 9: `pipeline/CLAUDE.md`**

Rewrite the section "The prompt is v6, and v4's guards were measured rather than
assumed" heading to "The prompt is v7: a template plus `disease/prompt.md`, and
v4's guards were measured rather than assumed" and add one paragraph at its top:
"`pipeline/prompts.py` holds the methodology as a template with
`{{ section.id }}` slots and `disease/prompt.md` holds the disease prose, one
`## id` per slot. `render_prompt` refuses an unknown slot, an unreferenced
section and a residual `{{`, and `tests/pipeline/test_prompt_assembly.py` pins
the cSVD rendering byte-identical to the v6 literals (sha256 `70908abc…`), which
is why the recall baseline and the golden cassettes carried over without
re-recording. The run report records `promptSha256` of the rendered bytes beside
`promptVersion`." Update "Use 'v6'" mentions in the file to v7.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Split the extraction prompt into a v7 template and disease/prompt.md, pinned to v6 bytes"
```

---

### Task 11: Search terms, the CT.gov gate, aliases, the gene cap and run labels from the manifest

**Files:**

- Modify: `pipeline/pubmed_search.py:60-87`, `pipeline/config.py:198-211`,
  `pipeline/clinical_trials_fetch.py:52-97,116,658,695,697-704,925,980`,
  `pipeline/data_merger.py:19-43`, `pipeline/annotations.py:16-45`,
  `pipeline/batch_validation.py:27,128`, `pipeline/notifications.py:100,185`,
  `pipeline/templates/digest.md.j2:1`,
  `pipeline/main.py:4,37,1326,1351,2275,2710`
- Test: `tests/pipeline/test_disease_manifest.py` (new),
  `tests/pipeline/test_clinical_trials_fetch.py:25-27`,
  `tests/pipeline/test_annotations.py:137-142`,
  `tests/pipeline/test_notifications.py`, `tests/pipeline/test_query_recall.py`
  (unchanged, must stay green)

**Interfaces:**

- Produces: `is_disease_study`, `fetch_disease_studies` (renamed from
  `is_csvd_study`, `fetch_csvd_studies`); `DEFAULT_CT_SEARCH_TERMS`,
  `DISEASE_TERMS`, `MARKER_TERMS`, `MESH_TERMS`, `_CANONICAL_GENE_SYMBOLS`,
  `_LOOKUP_ALIASES`, `_MAX_GENES_PER_PAPER` derived from `load_disease()`.

- [ ] **Step 1: Write the failing wiring test**

Create `tests/pipeline/test_disease_manifest.py`:

```python
"""The pipeline's disease-specific constants are the manifest's, not restated."""

from pipeline import annotations, batch_validation, data_merger, pubmed_search
from pipeline.config import DEFAULT_CT_SEARCH_TERMS
from pipeline.clinical_trials_fetch import _CONDITION_PAIRS, _CONDITIONS
from pipeline.disease import load_disease


def test_the_pubmed_term_lists_are_the_manifest_s() -> None:
    d = load_disease()
    assert pubmed_search.DISEASE_TERMS == d.pubmed_disease_terms
    assert pubmed_search.MARKER_TERMS == d.pubmed_marker_terms
    assert pubmed_search.MESH_TERMS == d.pubmed_mesh_terms


def test_the_clinical_trials_terms_and_gate_are_the_manifest_s() -> None:
    d = load_disease()
    assert DEFAULT_CT_SEARCH_TERMS == d.ct_search_terms
    assert _CONDITIONS == d.ct_condition_substrings
    assert _CONDITION_PAIRS == d.ct_condition_pairs


def test_the_gene_aliases_feed_both_directions() -> None:
    d = load_disease()
    assert annotations._LOOKUP_ALIASES == dict(d.gene_aliases)
    inverted = {m: k for k, members in d.gene_aliases.items() for m in members}
    assert data_merger._CANONICAL_GENE_SYMBOLS == inverted


def test_the_gene_cap_is_the_manifest_s() -> None:
    assert batch_validation._MAX_GENES_PER_PAPER == load_disease().max_genes_per_paper
```

Run: `uv run pytest tests/pipeline/test_disease_manifest.py -q` — expected FAIL
(`_CONDITIONS` does not exist; the lists are literals).

- [ ] **Step 2: Derive the constants**

`pipeline/pubmed_search.py` lines 60-87: replace the three literal tuples with

```python
from pipeline.disease import load_disease

_DISEASE = load_disease()

# The disease's anchor phrases, markers and MeSH headings come from
# disease/manifest.json; the genetics vocabulary below is the method's and
# stays in code. The comments that used to sit here about which MeSH
# headings were tried and dropped now live beside the terms in the manifest's
# git history and in disease/README.md.
DISEASE_TERMS: Final[tuple[str, ...]] = _DISEASE.pubmed_disease_terms
MARKER_TERMS: Final[tuple[str, ...]] = _DISEASE.pubmed_marker_terms
MESH_TERMS: Final[tuple[str, ...]] = _DISEASE.pubmed_mesh_terms
```

Keep `GENETIC_TERMS`, `_build_query` and `SVD_QUERY` exactly as they are (the
name `SVD_QUERY` is an identifier the recall test imports; it stays).

`pipeline/config.py:198-211`:
`DEFAULT_CT_SEARCH_TERMS: Final[tuple[str, ...]] = load_disease().ct_search_terms`
(import already added in Task 10); keep the comment about
`PIPELINE_CT_SEARCH_TERMS`.

`pipeline/clinical_trials_fetch.py`: replace `_CSVD_CONDITIONS` (:67-87) and
`_CSVD_CONDITION_PAIRS` (:94-97) with

```python
_DISEASE = load_disease()
_CONDITIONS: Final[tuple[str, ...]] = _DISEASE.ct_condition_substrings
_CONDITION_PAIRS: Final[tuple[tuple[str, str], ...]] = _DISEASE.ct_condition_pairs
```

keeping the two explanatory comments (the Fabry measurement and the MeSH
inversion) above them, reworded from "cSVD" to "the disease". Rename
`is_csvd_study` → `is_disease_study` and `fetch_csvd_studies` →
`fetch_disease_studies` at every site (`:116, :658, :695, :780, :925, :980`);
docstrings "names a cSVD entity" → "names an entity of the disease"; the log
line at :697-699 `"CTG: %d/%d studies state no cSVD condition (skipped)"` →
`"CTG: %d/%d studies state no %s condition (skipped)"` with
`_DISEASE.abbreviation` as the extra argument. Update
`tests/pipeline/test_clinical_trials_fetch.py:25-27` and every call in that file
to the new names.

`pipeline/data_merger.py:39-43`:

```python
_CANONICAL_GENE_SYMBOLS: Final[dict[str, str]] = {
    member: curated
    for curated, members in load_disease().gene_aliases.items()
    for member in members
}
```

with `from pipeline.disease import load_disease`; keep the comment above it,
replacing "The curated dataset records the COL4A1/COL4A2 pair" wording with a
pointer to `geneAliases` in the manifest.

`pipeline/annotations.py:43-46`:
`_LOOKUP_ALIASES: Final[dict[str, tuple[str, ...]]] = dict(load_disease().gene_aliases)`
(stdlib import of `pipeline.disease` keeps this module free of pipeline
dependencies, which its docstring promises).
`tests/pipeline/test_annotations.py:137-142` keeps its assertion; update the
docstring to say both derive from `geneAliases` and the test guards that neither
stops doing so.

`pipeline/batch_validation.py:27`:
`_MAX_GENES_PER_PAPER = load_disease().max_genes_per_paper`; comment at :128
"unusual for cSVD literature" → "unusual for this literature; the cap is
`pipeline.maxGenesPerPaper` in the manifest".

`pipeline/notifications.py:185`:
`title = f"[{load_disease().run_label}] Run Summary — {mode_label} ({date_str})"`;
at :100 add `"run_label": load_disease().run_label,` to the template context;
`pipeline/templates/digest.md.j2:1` →
`**{{ run_label }} {{ mode_label }}** ({{ duration }})`. Update the notification
tests that assert on `[SVD Pipeline]` or `**SVD Pipeline` to build the expected
string from `load_disease().run_label`.

`pipeline/main.py`: `:4` and `:37` → "Disease dashboard data pipeline" (no
manifest read in the argcomplete fast path); `:1326` →
`f"Step 1: Searching PubMed for recent {load_disease().short} genetic papers..."`,
`:1351` and `:2275` likewise with `.short`; `:2710` docstring "cSVD-relevant" →
"disease-relevant". Import `load_disease` where the heavy imports already sit
(after the parser), not at the top.

- [ ] **Step 3: Run the gates**

Run: `uv run pytest -q && uv run ruff check . && uv run ty check` Expected:
green, including `tests/pipeline/test_query_recall.py` on its untouched
cassettes (the built query string is byte-identical).

- [ ] **Step 4: Skill and docs mentions**

`grep -rn 'is_csvd_study\|fetch_csvd_studies\|_CSVD_CONDITIONS' .claude pipeline/CLAUDE.md CLAUDE.md README.md`
and rename each mention.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Derive search terms, the trial gate, gene aliases and run labels from the manifest"
```

---

### Task 12: Provenance: disease key and prompt hash in the run report

**Files:**

- Modify: `pipeline/anthropic_client.py:604-611`,
  `pipeline/run_report.py:56-71`, `pipeline/checkpoint.py:61-71`, `lib/types.ts`
  (`RunConfig`), `lib/data/pipeline_run.ts:56-70`, `lib/pipeline_encoding.json`
  (`fields`), `islands/PipelineRun.tsx:439,521-526`
- Test: `tests/pipeline/test_anthropic_client.py` (or wherever `report_metadata`
  is asserted; grep `prompt_version`), `tests/pipeline/test_run_report.py:45`,
  `tests/pipeline/test_checkpoint.py`, `tests/pipeline_run_data_test.ts:40,124`,
  `tests/pipeline_widget_test.tsx`

**Interfaces:**

- Produces: `report_metadata()` keys `disease` and `prompt_sha256`;
  `RunConfigRecord.disease: str | None`,
  `RunConfigRecord.prompt_sha256: str | None` (wire `disease`, `promptSha256`);
  `RunConfig.disease`, `RunConfig.promptSha256` in `lib/types.ts`;
  `fields.promptSha256` in `lib/pipeline_encoding.json`.

- [ ] **Step 1: Failing Python tests**

In the test that asserts `report_metadata` (grep `"prompt_version": "v6"` under
`tests/pipeline`), add to the expected dict `"disease": "csvd"` and
`"prompt_sha256": prompt_sha256()` (import from `pipeline.prompts`). In
`tests/pipeline/test_run_report.py` add:

```python
def test_run_config_record_carries_disease_and_prompt_hash() -> None:
    record = RunConfigRecord.model_validate(
        {"prompt_version": "v7", "disease": "csvd", "prompt_sha256": "ab" * 32}
    )
    assert record.model_dump(by_alias=True)["promptSha256"] == "ab" * 32
    assert record.model_dump(by_alias=True)["disease"] == "csvd"
    # A row written before the fields existed still validates.
    assert RunConfigRecord.model_validate({"prompt_version": "v6"}).disease is None
```

In `tests/pipeline/test_checkpoint.py` add a test that `fingerprint(config)` (or
whatever the public name is; grep `def fingerprint`) contains `"prompt_sha256"`
equal to `prompt_sha256()`.

Run them: expected FAIL.

- [ ] **Step 2: Implement**

`pipeline/anthropic_client.py:604-611`:

```python
def report_metadata(self, config: PipelineConfig) -> dict[str, Any]:
    return {
        "model": config.llm_model,
        "model_version": config.model_version,
        "thinking_mode": config.thinking_mode,
        "effort": config.llm_effort,
        "prompt_version": config.prompt_version,
        "disease": load_disease().key,
        "prompt_sha256": prompt_sha256(config.prompt_version),
    }
```

`pipeline/run_report.py` `RunConfigRecord`: add `disease: str | None = None` and
`prompt_sha256: str | None = None` after `prompt_version` (field order is wire
order; the export is byte-gated, and `data/pipeline_run.json` will gain two
`null` keys on the next `deno task data` — that diff is expected and is
regenerated in Task 13's data step). `pipeline/checkpoint.py:66`: add
`"prompt_sha256": prompt_sha256(config.prompt_version),` after
`"prompt_version"`.

Also the batch path: grep `prompt_version` in `pipeline/batch_extraction.py` and
add the same two keys wherever a metadata dict mirrors `report_metadata`.

- [ ] **Step 3: Web side**

`lib/types.ts` `RunConfig`: add `disease: string | null;` and
`promptSha256: string | null;` after `promptVersion`.
`lib/data/pipeline_run.ts:61`: add `disease: nullableText(source.disease),` and
`promptSha256: nullableText(source.promptSha256),`. `lib/pipeline_encoding.json`
`fields`: after `promptVersion` add
`"promptSha256": { "label": "Prompt bytes", "icon": "documentText" }`.
`islands/PipelineRun.tsx:521-526`:

```tsx
{
  run.config.promptVersion && (
    <span class="pipeline-head-meta">
      <Icon name={prompt.icon} />
      {prompt.label} {run.config.promptVersion}
      {run.config.disease && run.config.promptSha256 && (
        <>
          {" · "}
          {run.config.disease} {run.config.promptSha256.slice(0, 12)}
        </>
      )}
    </span>
  );
}
```

`tests/pipeline_run_data_test.ts:40`: add
`disease: "csvd", promptSha256: "70908abc0302" + "0".repeat(52)` to the fixture
and assert both normalize; add a case where they are absent and normalize to
`null`. `tests/pipeline_widget_test.tsx`: one render asserting
`csvd 70908abc0302` appears when both are set.

- [ ] **Step 4: Run the gates**

Run: `uv run pytest -q && deno task check && deno test -A` Expected: green.
`tests/pipeline_encoding_test.ts` passes because the new field has a label and
an icon `Icon.tsx` draws.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Record the disease key and the rendered prompt's hash in the run report"
```

---

### Task 13: Migration 014 and the population rename

**Files:**

- Create: `pipeline/alembic/versions/014_rename_trial_population.py`
- Modify: `pipeline/export/text.py:11`, `pipeline/export/tables.py:251-252`,
  `pipeline/export/main.py:135-146`,
  `pipeline/database.py:1065,1094,1107,1164,1169,1214,1222,1315`,
  `pipeline/clinical_trials_fetch.py:8,854,1014`,
  `scripts/normalize_drug_names.py:46-47`, `scripts/timeline_figure.py:197`,
  `lib/types.ts:44-45`, `lib/data/trials.ts:23-24`, `lib/filters.ts:242`,
  `lib/timeline.ts:400`, `islands/TrialsView.tsx:159,164`,
  `islands/TrialsTimeline.tsx:143`, `data/table2.json`,
  `data/pipeline_run.json`, tests listed in Step 4,
  `.claude/skills/sync-clinical-trials/SKILL.md`, `CLAUDE.md`,
  `pipeline/CLAUDE.md`, `README.md`
- Test: `tests/pipeline/test_alembic_migrations.py`,
  `tests/pipeline/export/test_writer.py`, `tests/data_contract_test.ts`

**Interfaces:**

- Produces: column `clinical_trials.target_population` /
  `target_population_details`; wire keys `targetPopulation` /
  `targetPopulationDetails`; `Trial.targetPopulation`,
  `Trial.targetPopulationDetails`.

- [ ] **Step 1: Failing migration test**

In `tests/pipeline/test_alembic_migrations.py` `_SQL_CASES` append
`("014_rename_trial_population.py", "RENAME COLUMN", "RENAME COLUMN")`. Run:
`uv run pytest tests/pipeline/test_alembic_migrations.py -q` — expected FAIL,
file not found.

- [ ] **Step 2: Write the migration**

```python
"""Rename clinical_trials.svd_population to target_population.

The column name reaches the JSON contract: ``clean_column_name`` turns it
into the display name, ``to_camel`` into the wire key, and the trials
table and the population filter read that key. With the dashboard
re-targetable to another disease, a wire key that spells one disease's
abbreviation is the one identifier this work renames; the header text a
reader sees comes from ``populationField`` in ``disease/manifest.json``.

``ALTER TABLE ... RENAME COLUMN`` keeps the data, the NOT NULL state and
every index; nothing is copied.

Revision ID: 014
Revises: 013
Create Date: 2026-09-17
"""

from collections.abc import Sequence

from alembic import op

revision: str = "014"
down_revision: str | None = "013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE clinical_trials RENAME COLUMN svd_population TO target_population"
    )
    op.execute(
        "ALTER TABLE clinical_trials RENAME COLUMN svd_population_details "
        "TO target_population_details"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE clinical_trials RENAME COLUMN target_population TO svd_population"
    )
    op.execute(
        "ALTER TABLE clinical_trials RENAME COLUMN target_population_details "
        "TO svd_population_details"
    )
```

- [ ] **Step 3: Rename in the pipeline**

- `pipeline/export/text.py:11`: `for acronym in ("GWAS", "ID", "Omics")` (drop
  `"SVD"`; it existed for this column). Update the artifact-era comment if one
  names it.
- `pipeline/export/tables.py:251-252`: `"Target Population"`,
  `"Target Population Details"`.
- `pipeline/export/main.py:135-146`: `row.get("target_population")`; docstring
  `svd_population` → `target_population`.
- `pipeline/database.py`: every `svd_population` → `target_population` (SQL and
  prose; eight sites).
- `pipeline/clinical_trials_fetch.py:8,854,1014`: same.
- `scripts/normalize_drug_names.py:46-47`, `scripts/timeline_figure.py:197`
  (`row["svdPopulation"]` → `row["targetPopulation"]`).

- [ ] **Step 4: Rename in tests (Python)**

`grep -rln 'svd_population\|svdPopulation\|SVD Population' tests/pipeline tests/scripts`
lists `test_database.py`, `test_clinical_trials_fetch.py`,
`test_database_integration.py`, `export/test_writer.py`, `export/test_text.py`,
`export/test_tables.py`, `export/test_export_main.py`,
`tests/scripts/test_timeline_figure.py`. In each: `svd_population` →
`target_population`, `svdPopulation` → `targetPopulation`, `"SVD Population"` →
`"Target Population"` where the string is the _computed display name_
(`test_text.py`, `test_tables.py` `_UNKNOWN_COLUMNS`), and left alone where it
is the _header label_ the manifest supplies. `test_text.py` has a case that
`clean_column_name("svd_population") == "SVD Population"`; change it to
`clean_column_name("target_population") == "Target Population"` and delete any
assertion that `SVD` is an acronym.

- [ ] **Step 5: Rename in TypeScript**

- `lib/types.ts:44-45`:
  `targetPopulation: string; targetPopulationDetails: string;`
- `lib/data/trials.ts:23-24`:
  `targetPopulation: text(source.targetPopulation, UNKNOWN), targetPopulationDetails: text(source.targetPopulationDetails, UNKNOWN),`
- `lib/filters.ts:242`: `trial.targetPopulation`; `lib/timeline.ts:400`:
  `row.targetPopulation`
- `islands/TrialsView.tsx:159,164`: `column.accessor("targetPopulation", …)`,
  `column.accessor("targetPopulationDetails", …)` (headers already read
  `POPULATION_FIELD`, Task 6); `islands/TrialsTimeline.tsx:143`:
  `key: "targetPopulationDetails"`.
- Tests: `tests/timeline_layout_test.ts:233,424`,
  `tests/data_normalization_test.ts:76-77,93-94`,
  `tests/data_contract_test.ts:51-52,140-141`,
  `tests/timeline_encoding_test.ts:63`: `svdPopulation` → `targetPopulation`
  (and `Details`).

- [ ] **Step 6: Rewrite the committed data**

Without a database, rewrite the key in place and let the byte gate prove the
writer agrees:

```bash
uv run python - <<'EOF'
from pathlib import Path
p = Path("data/table2.json"); s = p.read_text(encoding="utf-8")
s = s.replace('"svdPopulationDetails":', '"targetPopulationDetails":').replace('"svdPopulation":', '"targetPopulation":')
p.write_text(s, encoding="utf-8")
EOF
uv run pytest tests/pipeline/export/test_writer.py -q
```

Expected: green. Also apply the migration to the local production database
(`cd pipeline && uv run alembic upgrade head`, per the `regenerate-data` skill)
so the next `deno task data` reads the renamed column; then run `deno task data`
and confirm `git diff --stat data/` shows only `table2.json` (the key rename)
and `pipeline_run.json` (the two new `null` config keys from Task 12). If the
database is not reachable, leave the two files as rewritten and say so in the
commit message.

- [ ] **Step 7: Docs**

`.claude/skills/sync-clinical-trials/SKILL.md`, `CLAUDE.md:241`,
`pipeline/CLAUDE.md` (the "curator-owned once `svd_population` is filled in"
section and the misalignment note), `README.md:689`: `svd_population` →
`target_population`, `svdPopulation` → `targetPopulation`, with one sentence
where the rename is first mentioned: "renamed from `svd_population` by migration
014 so the wire key does not spell the disease".

- [ ] **Step 8: Run every gate**

Run:
`deno task check && deno task test:coverage && uv run pytest -q && uv run pytest tests/scripts -q && uv run ruff check . && uv run ty check && cd e2e && npx playwright test; cd ..`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Rename svd_population to target_population (migration 014) and the wire key with it"
```

---

### Task 14: Greplist tests on both sides

**Files:**

- Create: `tests/no_disease_literals_test.ts`,
  `tests/pipeline/test_no_disease_literals.py`
- Modify: whatever the two tests name (comments and log strings under `lib/`,
  `routes/`, `islands/`, `components/`, `pipeline/`, `scripts/`)
- Test: the two new files

**Interfaces:**

- Produces: two greplist tests with reasoned allow-lists.

- [ ] **Step 1: Write the TypeScript test**

Create `tests/no_disease_literals_test.ts`:

```ts
/**
 * No disease term survives in the web code outside disease/.
 *
 * The terms are the manifest's own, so a fork's test scans for *its*
 * disease. Every hit not on the allow-list fails, comments included: a
 * comment naming "the SVD rim" is reworded rather than listed.
 */
import { assertEquals } from "@std/assert";
import { walk } from "jsr:@std/fs@^1/walk";

import { manifest } from "../lib/disease.ts";

const ROOTS = ["lib", "routes", "islands", "components"];

// (path, regex source) → why it is allowed. The --svd- custom properties,
// the theme storage key and event, the session cookie and the filter
// panel's storage key are internal namespaces nobody reads.
const ALLOWED: ReadonlyArray<[RegExp, RegExp, string]> = [
  [/.*/, /--svd-[a-z0-9-]+/, "CSS custom-property namespace"],
  [
    /^lib\/theme\.ts$/,
    /"svd-theme"|"svd:themechange"/,
    "storage key and event name",
  ],
  [/^lib\/auth\.ts$/, /"svd_session"/, "session cookie name"],
  [/^components\/FilterPanel\.tsx$/, /"svd-filters-collapsed"/, "storage key"],
  [
    /^routes\/_app\.tsx$/,
    /--svd-nav/,
    "comment tying THEME_COLORS to the token",
  ],
];

const terms = [
  manifest.disease.name,
  manifest.disease.abbreviation,
  manifest.disease.short,
  manifest.institute.name,
  manifest.institute.short,
  ...manifest.monogenicGenes,
];
const TERM = new RegExp(
  `\\b(${
    terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  })\\b`,
  "i",
);

Deno.test("no disease literal remains in lib/, routes/, islands/ or components/", async () => {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for await (
      const entry of walk(root, { exts: [".ts", ".tsx"], includeDirs: false })
    ) {
      const lines = (await Deno.readTextFile(entry.path)).split("\n");
      lines.forEach((line, i) => {
        if (!TERM.test(line)) return;
        const allowed = ALLOWED.some(([path, pat]) =>
          path.test(entry.path) && pat.test(line)
        );
        if (!allowed) hits.push(`${entry.path}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assertEquals(hits, []);
});
```

Run it and fix every hit: reword comments (`lib/timeline.ts:788-789,1040-1043`,
`lib/sorting.ts:79`, `lib/filters.ts:14-15`, `islands/PipelineRun.tsx:589-590`,
`islands/TrialsTimeline.tsx:757,794,1287`) to name the concept, not the cSVD
instance, or add a reasoned allow-list entry only for a namespace identifier.
`lib/disease/*` will hit on nothing because they read the manifest rather than
spelling it. If `jsr:@std/fs` is not in the import map, add
`"@std/fs": "jsr:@std/fs@^1.0.0"` to `deno.json` imports and import from
`@std/fs/walk`.

- [ ] **Step 2: Write the Python test**

Create `tests/pipeline/test_no_disease_literals.py`:

```python
"""No disease term survives in pipeline/ or scripts/ outside disease/."""

import re
from pathlib import Path

from pipeline.disease import load_disease

_ROOT = Path(__file__).resolve().parents[2]
_ROOTS = ("pipeline", "scripts")

# (relative path, term) -> reason. Whole-word matching means SVDPMIDTOKEN
# and _svd_started_monotonic never match and need no entry.
_ALLOWED: dict[tuple[str, str], str] = {
    ("pipeline/pdf_retrieval.py", "csvd-dashboard"): "the tool name NCBI knows the pipeline by",
    ("pipeline/clinvar_fetch.py", "HTRA1"): "comment quoting a measured ClinVar record count",
    ("pipeline/clinvar_fetch.py", "NOTCH3"): "comment quoting a measured ClinVar record count",
    ("pipeline/clinvar_fetch.py", "TREX1"): "comment quoting a measured ClinVar record count",
    ("pipeline/citations.py", "NOTCH3"): "worked example for the single-sentence rule",
}


def test_no_disease_literal_remains_outside_disease() -> None:
    d = load_disease()
    terms = [d.name, d.abbreviation, d.short, *d.monogenic_genes, "csvd-dashboard"]
    pattern = re.compile(
        r"\b(" + "|".join(re.escape(t) for t in terms) + r")\b", re.IGNORECASE
    )
    hits: list[str] = []
    for root in _ROOTS:
        for path in sorted((_ROOT / root).rglob("*")):
            if path.suffix not in {".py", ".j2"} or "alembic/versions" in str(path):
                continue
            rel = path.relative_to(_ROOT).as_posix()
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for match in pattern.finditer(line):
                    if (rel, match.group(0)) in _ALLOWED:
                        continue
                    hits.append(f"{rel}:{number}: {line.strip()}")
    assert hits == []


def test_every_allow_list_entry_is_still_needed() -> None:
    for (rel, term), _reason in _ALLOWED.items():
        text = (_ROOT / rel).read_text(encoding="utf-8")
        assert re.search(rf"\b{re.escape(term)}\b", text), f"{rel} no longer names {term}"
```

Migrations are excluded because 001 and 014 name `svd_population` as history.
Run it and fix every hit: log strings in `main.py` were handled in Task 11;
reword remaining comments in `pipeline/opentargets_fetch.py:19,208-209`,
`pipeline/clinvar_fetch.py` beyond the allowed counts, `pipeline/data_merger.py`
and `pipeline/annotations.py` comments that name `COL4A1/2` as prose (they may
keep naming the _alias mechanism_ without the symbol), and any docstring naming
"cSVD". Add an allow-list entry only where the line records a measurement.

- [ ] **Step 3: Run the gates and commit**

Run:
`deno task check && deno test -A && uv run pytest -q && uv run ruff check . && uv run ty check`
Expected: green.

```bash
git add -A
git commit -m "Add greplist tests keeping disease terms out of the code"
```

---

### Task 15: Documentation of the seam

**Files:**

- Modify: `CLAUDE.md` (Architecture), `pipeline/CLAUDE.md` (one pointer),
  `README.md` (path mentions only), `.claude/skills/regenerate-data/SKILL.md`
  (if it names `omim_info.csv`'s old path), `AGENTS.md` (if it lists top-level
  directories)

- [ ] **Step 1: Root `CLAUDE.md`**

Under "## Architecture", after the diagram, add:

```markdown
**The disease seam is `disease/`.** Everything that names the disease lives
there and nowhere else: `manifest.json` (prose, institute, search terms,
populations, cell-type glossary, citation standard, monogenic genes, gene
aliases, run label, gene cap), `vocabulary.json`, `prompt.md` (the disease half
of the extraction prompt; the methodology is the v7 template in
`pipeline/prompts.py`), `phenogram.json` (families), `timeline.json`
(populations, mechanisms, families) and `omim_info.csv`. TypeScript reads it
through the narrow modules under `lib/disease/` — `site.ts`, `populations.ts`,
`cell_types.ts`, `citation.ts` — and Python through `pipeline/disease.py`, which
is stdlib-only so `config.py` and `extraction_models.py` can both import it.
`tests/no_disease_literals_test.ts` and
`tests/pipeline/test_no_disease_literals.py` scan the code for the manifest's
own terms and fail on any hit outside a reasoned allow-list;
`tests/pipeline/test_prompt_assembly.py` pins the cSVD prompt rendering to the
v6 bytes. Every measurement in this file and in `pipeline/CLAUDE.md` is of the
cSVD dataset this repository was built on. The design is
`docs/superpowers/specs/2026-09-17-disease-reuse-design.md`.
```

Fix the remaining path mentions:
`grep -n 'lib/vocabulary.json\|lib/timeline_encoding.json\|lib/phenogram_encoding.json\|export/data/omim' CLAUDE.md`
and make each accurate (the two encodings still exist under `lib/` for
appearance; say so where the sentence claims they hold populations or families).

- [ ] **Step 2: `pipeline/CLAUDE.md` and `README.md`**

`pipeline/CLAUDE.md`: in the opening paragraph add "The disease the pipeline
serves is read from `disease/manifest.json` through `pipeline/disease.py`; see
the root `CLAUDE.md`, 'The disease seam'." `README.md`: fix path mentions only
(`grep -n 'lib/vocabulary.json\|omim_info.csv\|is_csvd_study' README.md`); the
generic/disease split of the README is sub-project 3.

- [ ] **Step 3: Verify and commit**

Run:
`deno fmt --check . && grep -rn 'lib/vocabulary.json' --include='*.md' . | grep -v node_modules | grep -v docs/superpowers`
Expected: clean, no hits.

```bash
git add -A
git commit -m "Document the disease seam"
```

---

## Verification at the end

1. `deno task check && deno task test:coverage` — green, 100 % under `lib/`.
2. `uv run pytest -q && uv run pytest tests/scripts -q && uv run ruff check . && uv run ty check`
   — green.
3. `cd e2e && npx playwright test` — green.
4. `git diff main --stat -- data/` shows only `data/table2.json` (key rename)
   and `data/pipeline_run.json` (two null keys).
5. `shasum -a 256 tests/pipeline/fixtures/prompt_v6_instructions.txt` prints
   `70908abc03022ed389fda9c8351cab8f1eb46a9afc1aa62383bd5d72812ba853`.
6. `deno task build && deno task start`, sign in, and walk the six tabs: titles,
   descriptions, the About rows, the radar's accessible name and the trials
   table's population column all read exactly as on `main`.
