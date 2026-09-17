# Phenogram Karyogram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raster-and-pixel-lookup phenogram with an in-app karyogram
island drawn from `data/table1.json` and a committed hg38 cytoband table, add a
matplotlib print twin, and retire the iframe embed scaffolding.

**Architecture:** One committed encoding JSON (phenotype families, colours,
definitions, band stains, geometry constants) and one committed cytoband table
feed two renderers: a pure, DOM-free layout module (`lib/phenogram.ts`) rendered
by a Preact island as a decorative SVG plus an HTML layer of gene buttons that
reuse `components/Tooltip.tsx`, and `scripts/phenogram_figure.py` for print.
Guardrail tests pin the encoding, the cytobands and the layout to the committed
data, in Deno and in pytest.

**Tech Stack:** Deno 2.9 / Fresh 2 / Preact 10 (`with { type: "json" }` imports,
`@std/assert`), Playwright in `e2e/` (npm, production build), Python 3.14 via uv
(matplotlib 3.11, pytest, ruff, ty).

**Spec:** `docs/superpowers/specs/2026-08-29-phenogram-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/phenogram-karyogram` on branch
  `phenogram-karyogram` (based on `timeline-radar`, which already draws the
  timeline in-app). Every command below runs from that directory.
- `deno task check` = `deno fmt --check . && deno lint . && deno check`.
  `deno fmt` also formats `.md` and `.json`, so run `deno fmt <file>` on every
  file you create, including `data/*.json` and this plan's docs.
- Colour literals belong in `lib/phenogram_encoding.json` and inline SVG/style
  attributes only — never in `assets/app.css` outside its token block
  (`tests/styles_contract_test.ts` fails otherwise). New CSS uses the semantic
  `--svd-*` tokens listed in that file; every token you reference must be
  declared. The one new token is `--svd-figure-plate`, declared once in the
  light `:root` block beside `--svd-figure-ink` and never overridden by the dark
  blocks (Task 5).
- The figure's plate and its data colours stay fixed in dark mode (hue encodes
  meaning). Fixed ink is `--svd-figure-ink`.
- The sentinel `"(none found)"` is `NONE_FOUND` from `lib/constants.ts`
  (exported in Task 2). Trait `key`s are the raw data values (`"extreme-cSVD"`,
  `"lacunes"`, `"stroke"`, `"lacunar stroke"`).
- Python: `requires-python >= 3.14`; ruff
  `select = ["E","F","I","UP","B","SIM"]`, line length 88; `uv run ty check`
  clean; tests under `tests/scripts/` run with `uv run pytest`. No
  `from __future__ import annotations`.
- Commit after every task. Commit messages end with the trailer:

  ```text
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

- Numbers pinned by the tests (verified against the committed data on
  2026-08-29): 63 genes; 19 chromosomes carry a gene (1–11, 13, 14, 16, 17,
  19–22); 862 hg38 bands over 24 chromosomes; chr1 = 248 956 422 bp; chr13 = 114
  364 328 bp; `7q31.1` = 107 800 000–115 000 000; NCBI uids LAMB1 3912, JAK1
  3716, CENPF 1063; OMIM 618999 = "Autoinflammation, immune dysregulation, and
  eosinophilia", 243605 = "Stromme syndrome".

## File map

| File                                                                                                                         | Responsibility                                                  | Task |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---- |
| `scripts/fetch_cytobands.py`, `tests/scripts/test_fetch_cytobands.py`                                                        | UCSC → `data/cytobands_hg38.json`                               | 1    |
| `data/cytobands_hg38.json`                                                                                                   | committed hg38 bands, chr1–22, X, Y                             | 1    |
| `lib/cytobands.ts`, `tests/cytobands_test.ts`                                                                                | typed table, `placeGene`, contract test                         | 1    |
| `lib/phenogram_encoding.json`, `tests/phenogram_encoding_test.ts`                                                            | families, traits, evidence, stains, layout constants; guardrail | 2    |
| `lib/constants.ts`                                                                                                           | export `NONE_FOUND`                                             | 2    |
| `lib/phenogram.ts`, `tests/phenogram_layout_test.ts`                                                                         | pure layout: chromosomes, blocks, collisions, legend            | 3    |
| `lib/tooltips.ts`, `tests/tooltips_test.ts`                                                                                  | `phenogramTooltip`, `phenotypeTooltip`                          | 4    |
| `islands/Phenogram.tsx`, `routes/phenogram.tsx`, `assets/app.css`                                                            | the island, its route, its chrome                               | 5    |
| `e2e/tests/phenogram.spec.ts`, `e2e/tests/theme.spec.ts`, `e2e/tests/timeline.spec.ts`, `e2e/tests/embeds.spec.ts` (deleted) | browser tests                                                   | 5    |
| `static/phenogram.html`, `static/images/phenogram.webp`, `deno.json`                                                         | retired artifact                                                | 5    |
| `components/EmbedPage.tsx`, `islands/EmbedFrame.tsx`, `lib/theme.ts`, `assets/app.css`                                       | embed scaffolding removal                                       | 6    |
| `scripts/phenogram_figure.py`, `tests/scripts/test_phenogram_figure.py`, `deno.json`                                         | print twin                                                      | 7    |
| `CLAUDE.md`, `README.md`, `docs/superpowers/specs/*.md`                                                                      | docs                                                            | 8    |

---

### Task 1: Cytoband table — fetch script, committed JSON, `lib/cytobands.ts`

**Files:**

- Create: `scripts/fetch_cytobands.py`
- Create: `tests/scripts/test_fetch_cytobands.py`
- Create: `data/cytobands_hg38.json` (generated, then `deno fmt`)
- Create: `lib/cytobands.ts`
- Create: `tests/cytobands_test.ts`
- Modify: `deno.json` (add the `cytobands` task)

**Interfaces:**

- Produces (Python): `CHROMOSOMES: list[str]`, `SOURCE: str`, `OUTPUT: Path`,
  `parse_cytobands(text: str) -> list[Chromosome]`,
  `build_table(text: str, source: str = SOURCE) -> CytobandTable`,
  `main(argv: list[str] | None = None) -> int`.
- Produces (TS, `lib/cytobands.ts`): `STAINS` (readonly tuple of the eight UCSC
  stain names), `interface Band { name; start; end; stain }`,
  `interface Chromosome { name; length; bands: Band[] }`,
  `interface CytobandTable { assembly; source; chromosomes: Chromosome[] }`,
  `const cytobands: CytobandTable`,
  `interface BandHit { chromosome; band; start; end; midpoint }`,
  `placeGene(location: string, table?: CytobandTable): BandHit | null`.

- [ ] **Step 1: Write the failing Python test**

`tests/scripts/test_fetch_cytobands.py`:

```python
"""Unit tests for scripts/fetch_cytobands.py."""

import gzip
import json
from pathlib import Path

import pytest

from scripts.fetch_cytobands import (
    CHROMOSOMES,
    OUTPUT,
    SOURCE,
    build_table,
    main,
    parse_cytobands,
)

CHR1 = [
    "chr1\t2300000\t5300000\tp36.32\tgpos25",
    "chr1\t0\t2300000\tp36.33\tgneg",
    "chr1\t123400000\t125100000\tp11.1\tacen",
    "chr1\t125100000\t143200000\tq11\tacen",
    "chr1\t143200000\t248956422\tq12\tgvar",
]
NOISE = [
    "chr1_KI270706v1_random\t0\t175055\t\tgneg",
    "chrUn_KI270302v1\t0\t2274\t\tgneg",
    "chrM\t0\t16569\t\tgneg",
    "",
]


def complete_rows() -> list[str]:
    """CHR1 in detail, one band for every other chromosome, plus noise."""
    others = [
        f"chr{name}\t0\t5000000\tq11\tgneg" for name in CHROMOSOMES if name != "1"
    ]
    return CHR1 + others + NOISE


class TestParse:
    def test_orders_bands_and_drops_other_contigs(self) -> None:
        chromosomes = parse_cytobands("\n".join(complete_rows()))
        assert [c["name"] for c in chromosomes] == CHROMOSOMES
        chr1 = chromosomes[0]
        assert chr1["length"] == 248956422
        assert [b["name"] for b in chr1["bands"]] == [
            "p36.33",
            "p36.32",
            "p11.1",
            "q11",
            "q12",
        ]
        assert chr1["bands"][1] == {
            "name": "p36.32",
            "start": 2300000,
            "end": 5300000,
            "stain": "gpos25",
        }
        assert all(len(c["bands"]) == 1 for c in chromosomes[1:])

    def test_a_missing_chromosome_is_left_out(self) -> None:
        assert [c["name"] for c in parse_cytobands("\n".join(CHR1))] == ["1"]


class TestBuildTable:
    def test_records_assembly_and_source(self) -> None:
        table = build_table("\n".join(complete_rows()), "file:///sample")
        assert table["assembly"] == "hg38"
        assert table["source"] == "file:///sample"
        assert len(table["chromosomes"]) == 24

    def test_refuses_an_incomplete_genome(self) -> None:
        with pytest.raises(ValueError, match="chr2"):
            build_table("\n".join(CHR1))


class TestMain:
    def test_writes_the_table_from_a_gzipped_source(self, tmp_path: Path) -> None:
        source = tmp_path / "cytoBandIdeo.txt.gz"
        source.write_bytes(gzip.compress("\n".join(complete_rows()).encode()))
        out = tmp_path / "cytobands.json"
        assert main(["--source", source.as_uri(), "--out", str(out)]) == 0
        table = json.loads(out.read_text())
        assert table["source"] == source.as_uri()
        assert [c["name"] for c in table["chromosomes"]] == CHROMOSOMES


def test_the_committed_table_is_the_generator_output_shape() -> None:
    table = json.loads(OUTPUT.read_text(encoding="utf-8"))
    assert table["assembly"] == "hg38"
    assert table["source"] == SOURCE
    assert [c["name"] for c in table["chromosomes"]] == CHROMOSOMES
    assert sum(len(c["bands"]) for c in table["chromosomes"]) == 862
    chr13 = next(c for c in table["chromosomes"] if c["name"] == "13")
    assert chr13["length"] == 114364328
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/scripts/test_fetch_cytobands.py -q` Expected: FAIL —
`ModuleNotFoundError: No module named 'scripts.fetch_cytobands'`

- [ ] **Step 3: Write the script**

`scripts/fetch_cytobands.py`:

```python
"""Fetch the UCSC hg38 cytoband table into data/cytobands_hg38.json.

lib/cytobands.ts draws the karyogram's chromosomes from this file and places
each gene on the band its `chromosomalLocation` names;
scripts/phenogram_figure.py reads the same file for print. It is committed like
every other data/*.json, so nothing fetches at build or run time -- rerun this
only to change the assembly or the source. `deno task cytobands` runs it and
then `deno fmt`s the output so the committed file is canonical.

Usage:
    uv run scripts/fetch_cytobands.py
    uv run scripts/fetch_cytobands.py --out /tmp/cytobands.json
"""

import argparse
import gzip
import json
import sys
import urllib.request
from pathlib import Path
from typing import TypedDict

SOURCE = (
    "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBandIdeo.txt.gz"
)
ASSEMBLY = "hg38"
CHROMOSOMES = [str(n) for n in range(1, 23)] + ["X", "Y"]
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "cytobands_hg38.json"


class Band(TypedDict):
    name: str
    start: int
    end: int
    stain: str


class Chromosome(TypedDict):
    name: str
    length: int
    bands: list[Band]


class CytobandTable(TypedDict):
    assembly: str
    source: str
    chromosomes: list[Chromosome]


def parse_cytobands(text: str) -> list[Chromosome]:
    """Rows of cytoBandIdeo.txt, one entry per chromosome in CHROMOSOMES order.

    Alternate contigs, unplaced scaffolds and chrM are dropped. A chromosome
    with no rows is left out; build_table refuses such a result.
    """
    by_name: dict[str, list[Band]] = {name: [] for name in CHROMOSOMES}
    for line in text.splitlines():
        if not line.strip():
            continue
        chrom, start, end, name, stain = line.split("\t")
        key = chrom.removeprefix("chr")
        if key not in by_name:
            continue
        by_name[key].append(
            {"name": name, "start": int(start), "end": int(end), "stain": stain}
        )
    chromosomes: list[Chromosome] = []
    for name in CHROMOSOMES:
        bands = sorted(by_name[name], key=lambda band: band["start"])
        if not bands:
            continue
        chromosomes.append(
            {"name": name, "length": bands[-1]["end"], "bands": bands}
        )
    return chromosomes


def build_table(text: str, source: str = SOURCE) -> CytobandTable:
    chromosomes = parse_cytobands(text)
    present = {chromosome["name"] for chromosome in chromosomes}
    missing = [name for name in CHROMOSOMES if name not in present]
    if missing:
        raise ValueError(f"no bands for chr{', chr'.join(missing)}")
    return {"assembly": ASSEMBLY, "source": source, "chromosomes": chromosomes}


def fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=60) as response:
        return gzip.decompress(response.read()).decode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, default=OUTPUT)
    parser.add_argument("--source", default=SOURCE)
    args = parser.parse_args(argv)
    table = build_table(fetch(args.source), args.source)
    args.out.write_text(json.dumps(table, indent=2) + "\n", encoding="utf-8")
    bands = sum(len(chromosome["bands"]) for chromosome in table["chromosomes"])
    print(f"Wrote {args.out}: {len(table['chromosomes'])} chromosomes, {bands} bands")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Add the task and generate the committed table**

In `deno.json` `tasks`, after `"geocode"`, add:

```json
"cytobands": "uv run scripts/fetch_cytobands.py && deno fmt data/cytobands_hg38.json",
```

Run: `deno task cytobands` Expected:
`Wrote .../data/cytobands_hg38.json: 24 chromosomes, 862 bands`, then
`Checked 1 file`. Confirm with `grep -c '"stain"' data/cytobands_hg38.json` →
`862`.

- [ ] **Step 5: Run the Python tests — all pass**

Run:
`uv run pytest tests/scripts/test_fetch_cytobands.py -q && uv run ruff check scripts/fetch_cytobands.py tests/scripts/test_fetch_cytobands.py && uv run ty check`
Expected: `6 passed`, ruff `All checks passed!`, ty clean.

- [ ] **Step 6: Write the failing Deno test**

`tests/cytobands_test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";

import { cytobands, placeGene, STAINS } from "../lib/cytobands.ts";
import { genes } from "../lib/data.ts";
import { CHROMOSOMES } from "../lib/sorting.ts";

/**
 * `data/cytobands_hg38.json` is the karyogram's geometry and the lookup that
 * places a gene from its `chromosomalLocation`. The last test is the
 * guardrail: a regenerated gene table whose band strings no longer resolve
 * fails here, not silently on the page.
 */

Deno.test("the table carries the 24 human chromosomes in CHROMOSOMES order", () => {
  assertEquals(cytobands.assembly, "hg38");
  assertEquals(cytobands.chromosomes.map((c) => c.name), [...CHROMOSOMES]);
  assertEquals(
    cytobands.chromosomes.reduce((n, c) => n + c.bands.length, 0),
    862,
  );
});

Deno.test("bands are sorted, contiguous, inside the chromosome, and use known stains", () => {
  for (const chromosome of cytobands.chromosomes) {
    let cursor = 0;
    for (const band of chromosome.bands) {
      assertEquals(
        band.start,
        cursor,
        `chr${chromosome.name} ${band.name} does not start where the previous band ends`,
      );
      assert(
        band.end > band.start,
        `chr${chromosome.name} ${band.name} is empty`,
      );
      assert(
        (STAINS as readonly string[]).includes(band.stain),
        `chr${chromosome.name} ${band.name}: unknown stain ${band.stain}`,
      );
      cursor = band.end;
    }
    assertEquals(cursor, chromosome.length, `chr${chromosome.name} length`);
    assertEquals(
      chromosome.bands.filter((b) => b.stain === "acen").length,
      2,
      `chr${chromosome.name} centromere`,
    );
  }
});

Deno.test("placeGene resolves an exact band to its midpoint and nothing else", () => {
  assertEquals(placeGene("7q31.1"), {
    chromosome: "7",
    band: "q31.1",
    start: 107800000,
    end: 115000000,
    midpoint: 111400000,
  });
  assertEquals(placeGene("13q34")?.chromosome, "13");
  assertEquals(placeGene("Xq28")?.chromosome, "X");
  assertEquals(placeGene(" 7q31.1 "), placeGene("7q31.1"));
  // Not a band name in the ideogram, so not a guess either.
  assertEquals(placeGene("1p3"), null);
  assertEquals(placeGene("23q11"), null);
  assertEquals(placeGene("(unknown)"), null);
  assertEquals(placeGene("7q31.1x"), null);
});

Deno.test("every committed gene's chromosomal location is an exact hg38 band", () => {
  const unresolved = genes
    .filter((gene) => placeGene(gene.chromosomalLocation) === null)
    .map((gene) => `${gene.gene} ${gene.chromosomalLocation}`);
  assertEquals(unresolved, []);
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `deno test -A tests/cytobands_test.ts` Expected: FAIL —
`Module not found "file:///.../lib/cytobands.ts"`

- [ ] **Step 8: Write `lib/cytobands.ts`**

```ts
/**
 * hg38 cytobands: the karyogram's geometry, and the band → coordinate lookup
 * that places a gene from its `chromosomalLocation` string.
 *
 * `data/cytobands_hg38.json` is written by `scripts/fetch_cytobands.py` from
 * UCSC `cytoBandIdeo.txt.gz` (`deno task cytobands`) and committed like every
 * other data file; nothing fetches at build or run time.
 */

import cytobandsJson from "../data/cytobands_hg38.json" with { type: "json" };

/** The UCSC `gieStain` values, in the order the encoding's `stains` map lists them. */
export const STAINS = [
  "gneg",
  "gpos25",
  "gpos50",
  "gpos75",
  "gpos100",
  "acen",
  "gvar",
  "stalk",
] as const;

export interface Band {
  name: string;
  start: number;
  end: number;
  stain: string;
}

export interface Chromosome {
  name: string;
  length: number;
  bands: Band[];
}

export interface CytobandTable {
  assembly: string;
  source: string;
  chromosomes: Chromosome[];
}

export const cytobands: CytobandTable = cytobandsJson;

export interface BandHit {
  chromosome: string;
  band: string;
  start: number;
  end: number;
  midpoint: number;
}

/** `7q31.1` → chromosome `7`, band `q31.1`. Anchored: `23q11` and `7q31.1x` fail. */
const LOCATION = /^(\d{1,2}|X|Y)([pq]\d+(?:\.\d+)?)$/;

/**
 * The band a location names, or null. Exact match only: a location naming a
 * parent band (`7q31`) or a chromosome the table lacks is unplaced rather
 * than guessed, so a bad string can never land silently on the wrong band.
 */
export function placeGene(
  location: string,
  table: CytobandTable = cytobands,
): BandHit | null {
  const match = LOCATION.exec(location.trim());
  if (!match) return null;
  const [, chromosome, bandName] = match;
  const band = table.chromosomes.find((c) => c.name === chromosome)?.bands
    .find((b) => b.name === bandName);
  if (!band) return null;
  return {
    chromosome,
    band: bandName,
    start: band.start,
    end: band.end,
    midpoint: (band.start + band.end) / 2,
  };
}
```

- [ ] **Step 9: Run the Deno tests and the full check**

Run:
`deno fmt lib/cytobands.ts tests/cytobands_test.ts && deno test -A tests/cytobands_test.ts && deno task check`
Expected: `4 passed`; check clean.

- [ ] **Step 10: Commit**

```bash
git add scripts/fetch_cytobands.py tests/scripts/test_fetch_cytobands.py data/cytobands_hg38.json lib/cytobands.ts tests/cytobands_test.ts deno.json
git commit -m "Add the hg38 cytoband table and the band lookup that places a gene" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The encoding file and its guardrail test

**Files:**

- Create: `lib/phenogram_encoding.json`
- Create: `tests/phenogram_encoding_test.ts`
- Modify: `lib/constants.ts:15` (export `NONE_FOUND`)

**Interfaces:**

- Produces: `lib/phenogram_encoding.json` with keys `families`, `traits`,
  `evidence`, `citation`, `stains`, `layout` (shape below); `NONE_FOUND`
  exported from `lib/constants.ts`.
- Consumes: `STAINS` from `lib/cytobands.ts` (Task 1).

- [ ] **Step 1: Export the sentinel**

In `lib/constants.ts`, change line 15 from `const NONE_FOUND = "(none found)";`
to:

```ts
export const NONE_FOUND = "(none found)";
```

- [ ] **Step 2: Write the encoding file**

`lib/phenogram_encoding.json` (the four `definition` strings are the STRIVE-2
texts from `static/phenogram.html:263, 272, 289, 299`, verbatim):

```json
{
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
  ],
  "traits": [
    {
      "key": "BG-PVS",
      "label": "BG-PVS",
      "family": "pvs",
      "name": "Basal ganglia perivascular spaces",
      "definition": "Fluid-filled space, which follows the typical course of a vessel penetrating the brain through grey or white matter; has signal intensity similar to CSF on all sequences; has a round, ovoid, or linear shape (depending on the slice direction) with a diameter commonly not exceeding 2 mm when imaged perpendicular to the course of the vessel.",
      "strive": true
    },
    {
      "key": "WM-PVS",
      "label": "WM-PVS",
      "family": "pvs",
      "name": "White matter perivascular spaces"
    },
    {
      "key": "HIP-PVS",
      "label": "HIP-PVS",
      "family": "pvs",
      "name": "Hippocampal perivascular spaces"
    },
    {
      "key": "PSMD",
      "label": "PSMD",
      "family": "diffusion",
      "name": "Peak width of skeletonized mean diffusivity"
    },
    {
      "key": "FA",
      "label": "FA",
      "family": "diffusion",
      "name": "Fractional anisotropy"
    },
    {
      "key": "MD",
      "label": "MD",
      "family": "diffusion",
      "name": "Mean diffusivity"
    },
    {
      "key": "NODDI",
      "label": "NODDI",
      "family": "diffusion",
      "name": "Neurite orientation dispersion and density imaging"
    },
    {
      "key": "extreme-cSVD",
      "label": "Extreme-cSVD",
      "family": "extreme",
      "name": "Extreme cerebral small vessel disease"
    },
    {
      "key": "WMH",
      "label": "WMH",
      "family": "wmh",
      "name": "White matter hyperintensities (of presumed vascular origin)",
      "definition": "Signal abnormality of variable size in the white matter that is hyperintense on T2-weighted images, such as fluid-attenuated inversion recovery (FLAIR), without cavitation (signal different from CSF). Lesions in the subcortical grey matter or brainstem are not included in this category unless explicitly stated. Where deep grey matter and brainstem hyperintensities are included as well, the collective name should be subcortical hyperintensities.",
      "strive": true
    },
    {
      "key": "SVS",
      "label": "SVS",
      "family": "stroke",
      "name": "Small vessel stroke"
    },
    {
      "key": "stroke",
      "label": "Stroke",
      "family": "stroke",
      "name": "Stroke"
    },
    {
      "key": "lacunar stroke",
      "label": "Lacunar stroke",
      "family": "stroke",
      "name": "Lacunar stroke"
    },
    {
      "key": "CMB",
      "label": "CMB",
      "family": "cmb",
      "name": "Cerebral microbleeds",
      "definition": "Small (usually 2–5 mm or sometimes 10 mm in size) areas of signal void with associated blooming artifact on T2* or other MRI sequences sensitive to susceptibility effects.",
      "strive": true
    },
    {
      "key": "lacunes",
      "label": "Lacunes",
      "family": "lacunes",
      "name": "Lacunes (of presumed vascular origin)",
      "definition": "Round or ovoid, subcortical, fluid filled (similar signal to CSF) cavity up to 15 mm in diameter that is likely to be end tissue damage from a recent small subcortical infarct, small subcortical haemorrhage, incidental diffusion-weighted imaging-positive lesion, or end-stage cavitation in a white matter hyperintensity.",
      "strive": true
    }
  ],
  "evidence": [
    { "key": "omics", "label": "Other omics", "shape": "triangle" },
    { "key": "monogenic", "label": "Monogenic disease", "shape": "square" },
    { "key": "mr", "label": "Mendelian randomization", "shape": "star" }
  ],
  "citation": {
    "label": "Duering, M. et al. Neuroimaging standards for research into small vessel disease—advances since 2013. The Lancet Neurology 22, 602–618 (2023).",
    "doi": "10.1016/S1474-4422(23)00131-X"
  },
  "stains": {
    "gneg": "#ffffff",
    "gpos25": "#d9d9d9",
    "gpos50": "#b3b3b3",
    "gpos75": "#8c8c8c",
    "gpos100": "#666666",
    "acen": "#9aa3c7",
    "gvar": "#e6e6e6",
    "stalk": "#e6e6e6"
  },
  "layout": {
    "viewBox": [1600, 920],
    "margin": 30,
    "rowSplitAfter": "10",
    "rowHeight": 400,
    "rowGap": 60,
    "chromosomeWidth": 14,
    "leaderGap": 10,
    "labelColumn": 128,
    "blockGap": 6,
    "symbolLine": 16,
    "pillLine": 14,
    "blockPadding": 3
  }
}
```

Then `deno fmt lib/phenogram_encoding.json` (it reflows the long objects; keep
the reflowed file).

- [ ] **Step 3: Write the failing guardrail test**

`tests/phenogram_encoding_test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";

import encoding from "../lib/phenogram_encoding.json" with { type: "json" };
import { GWAS_TRAIT_CHOICES, NONE_FOUND, SHOW_ALL } from "../lib/constants.ts";
import { STAINS } from "../lib/cytobands.ts";
import { genes } from "../lib/data.ts";

/**
 * `lib/phenogram_encoding.json` is read by two renderers — `lib/phenogram.ts`
 * for the island and `scripts/phenogram_figure.py` for print — so it is the
 * one place a GWAS trait gets its family, label and definition. These
 * assertions make the committed data, the filter choices and the encoding fail
 * together. The two palette gates that need no colour-blindness simulation are
 * re-checked here; the CVD result (worst adjacent ΔE 9.2) is recorded in the
 * design spec and was computed at design time.
 */

const HEX = /^#[0-9a-f]{6}$/;
const FAMILY_ORDER = [
  "pvs",
  "diffusion",
  "extreme",
  "wmh",
  "stroke",
  "cmb",
  "lacunes",
];

const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** sRGB hex → OKLab. */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) =>
    linear(parseInt(hex.slice(i, i + 2), 16) / 255)
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Euclidean distance in OKLab × 100, the unit the design spec records. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return 100 * Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

Deno.test("trait keys are exactly the GWAS filter values, grouped in family order", () => {
  const keys = encoding.traits.map((t) => t.key);
  const choices = GWAS_TRAIT_CHOICES.map((c) => c.value)
    .filter((v) => v !== SHOW_ALL && v !== NONE_FOUND);
  assertEquals([...keys].sort(), [...choices].sort());
  assertEquals(new Set(keys).size, keys.length, "trait keys repeat");

  const familyKeys = encoding.families.map((f) => f.key);
  assertEquals(familyKeys, FAMILY_ORDER);
  for (const trait of encoding.traits) {
    assert(familyKeys.includes(trait.family), `${trait.key}: unknown family`);
    assert(trait.label.length > 0 && trait.name.length > 0, trait.key);
  }
  // Grouped: the sequence of families never returns to an earlier one.
  const seen = encoding.traits.map((t) => familyKeys.indexOf(t.family));
  for (let i = 1; i < seen.length; i++) {
    assert(
      seen[i] >= seen[i - 1],
      `${encoding.traits[i].key} is out of family order`,
    );
  }
  for (const family of encoding.families) {
    assert(
      encoding.traits.some((t) => t.family === family.key),
      `${family.key} has no traits`,
    );
  }
});

Deno.test("every GWAS trait in the committed data has an entry", () => {
  const keys = new Set(encoding.traits.map((t) => t.key));
  const missing = [...new Set(genes.flatMap((g) => g.gwasTrait))]
    .filter((value) => value !== NONE_FOUND && !keys.has(value));
  assertEquals(missing, [], `traits without an encoding: ${missing}`);
});

Deno.test("family hues pass the lightness band and the adjacent normal-vision floor", () => {
  const hues = encoding.families.map((f) => f.hue);
  for (const family of encoding.families) {
    assert(HEX.test(family.hue), `${family.key}: bad hue`);
    assert(HEX.test(family.tint), `${family.key}: bad tint`);
    const [l] = oklab(family.hue);
    assert(
      l >= 0.43 && l <= 0.77,
      `${family.key}: hue lightness ${l.toFixed(3)}`,
    );
    const [tintL] = oklab(family.tint);
    assert(tintL >= 0.9, `${family.key}: tint too dark for ink`);
  }
  assertEquals(new Set(hues).size, hues.length, "two families share a hue");
  for (let i = 1; i < hues.length; i++) {
    const distance = deltaE(hues[i - 1], hues[i]);
    assert(
      distance >= 15,
      `${encoding.families[i - 1].key}/${encoding.families[i].key}: ΔE ${
        distance.toFixed(1)
      }`,
    );
  }
});

Deno.test("evidence glyphs, the citation and the stains are complete", () => {
  assertEquals(encoding.evidence.map((e) => e.key), [
    "omics",
    "monogenic",
    "mr",
  ]);
  for (const entry of encoding.evidence) {
    assert(["triangle", "square", "star"].includes(entry.shape), entry.key);
  }
  assert(encoding.citation.label.includes("Duering"));
  assertEquals(encoding.citation.doi, "10.1016/S1474-4422(23)00131-X");
  assertEquals(Object.keys(encoding.stains).sort(), [...STAINS].sort());
  for (const value of Object.values(encoding.stains)) assert(HEX.test(value));
  for (const trait of encoding.traits.filter((t) => "strive" in t)) {
    assert("definition" in trait, `${trait.key}: strive without a definition`);
  }
});

Deno.test("the layout constants fit ten columns and two rows on the canvas", () => {
  const L = encoding.layout;
  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  assert(
    2 * L.margin + 10 * pitch <= L.viewBox[0],
    "columns overflow the width",
  );
  assert(
    2 * L.margin + 2 * L.rowHeight + L.rowGap <= L.viewBox[1],
    "rows overflow the height",
  );
  for (
    const [name, value] of Object.entries(L).filter(([k]) =>
      k !== "viewBox" && k !== "rowSplitAfter"
    )
  ) {
    assert(typeof value === "number" && value > 0, `${name} must be positive`);
  }
  assertEquals(L.rowSplitAfter, "10");
});
```

- [ ] **Step 4: Run it — the file exists, so only structural failures remain**

Run:
`deno fmt tests/phenogram_encoding_test.ts && deno test -A tests/phenogram_encoding_test.ts`
Expected: `5 passed`. If the first test fails with a key mismatch, the
encoding's `key` values do not match `GWAS_TRAIT_CHOICES` — fix the JSON, not
the test.

- [ ] **Step 5: Full check and commit**

Run: `deno task check && deno task test` Expected: clean; all tests pass (the
encoding test is now in the suite).

```bash
git add lib/phenogram_encoding.json tests/phenogram_encoding_test.ts lib/constants.ts
git commit -m "Add the shared phenogram encoding and pin it to the gene data" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: The pure layout — `lib/phenogram.ts`

**Files:**

- Create: `lib/phenogram.ts`
- Create: `tests/phenogram_layout_test.ts`

**Interfaces:**

- Consumes: `placeGene`, `cytobands`, `CytobandTable`, `BandHit`
  (`lib/cytobands.ts`); `NONE_FOUND` (`lib/constants.ts`); `CHROMOSOMES`
  (`lib/sorting.ts`); `Gene` (`lib/types.ts`).
- Produces: `encoding: PhenogramEncoding`; types `FamilyEncoding`,
  `TraitEncoding`, `EvidenceEncoding`, `LayoutConstants`, `Point`, `Span`,
  `BandShape`, `ChromosomeShape`, `Pill`, `Glyph`, `GeneBlock`, `LegendFamily`,
  `PhenogramLayout`; `CHROMOSOME_LABEL_OFFSET = 18`;
  `blockHeight(pillCount, layout?)`, `pillsFor(gene, enc?)`,
  `glyphsFor(gene, enc?)`,
  `resolveCollisions(desired, heights, top, bottom, gap)`,
  `chromosomeShapes(names, table?, enc?)`,
  `computePhenogramLayout(rows, enc?, table?)`.

- [ ] **Step 1: Write the failing test**

`tests/phenogram_layout_test.ts`:

```ts
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { placeGene } from "../lib/cytobands.ts";
import { genes } from "../lib/data.ts";
import {
  blockHeight,
  computePhenogramLayout,
  encoding,
  resolveCollisions,
} from "../lib/phenogram.ts";

const layout = computePhenogramLayout(genes);
const L = encoding.layout;
const byGene = new Map(layout.blocks.map((b) => [b.symbol, b]));
const chromosome = (name: string) =>
  layout.chromosomes.find((c) => c.name === name)!;

/** Chromosomes carrying a gene in the committed table — the Python test pins the same list. */
const DRAWN = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "13",
  "14",
  "16",
  "17",
  "19",
  "20",
  "21",
  "22",
];

Deno.test("63 genes are placed, none unplaced, on 19 chromosomes including 13", () => {
  assertEquals(layout.blocks.length, 63);
  assertEquals(layout.unplaced, []);
  assertEquals(layout.chromosomes.map((c) => c.name), DRAWN);
  assertEquals(layout.rows.map((row) => row.map((c) => c.name)), [
    DRAWN.slice(0, 10),
    DRAWN.slice(10),
  ]);
  assertEquals(layout.canvas, { width: 1600, height: 920 });
  assertEquals(layout.blocks.map((b) => b.index), [...Array(63).keys()]);
});

Deno.test("chromosomes are drawn to scale, top-aligned in their row, one per column", () => {
  const one = chromosome("1");
  assertAlmostEquals(one.height, L.rowHeight, 1e-6);
  assertEquals(one.y, L.margin);
  const thirteen = chromosome("13");
  assertAlmostEquals(
    thirteen.height,
    114364328 / 248956422 * L.rowHeight,
    1e-6,
  );
  assertEquals(thirteen.y, L.margin + L.rowHeight + L.rowGap);
  assertEquals(thirteen.row, 1);

  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  for (const row of layout.rows) {
    row.forEach((c, i) =>
      assertEquals(c.x, L.margin + i * pitch, `chr${c.name} x`)
    );
  }
  for (const c of layout.chromosomes) {
    let cursor = c.y;
    for (const band of c.bands) {
      assertAlmostEquals(band.y, cursor, 1e-6, `chr${c.name} ${band.name}`);
      assertEquals(band.fill, encoding.stains[band.stain]);
      cursor += band.height;
    }
    assertAlmostEquals(cursor, c.y + c.height, 1e-6);
    assert(c.pArm.height > 0 && c.centromere.height > 0 && c.qArm.height > 0);
    assertAlmostEquals(c.pArm.y + c.pArm.height, c.centromere.y, 1e-6);
    assertAlmostEquals(c.centromere.y + c.centromere.height, c.qArm.y, 1e-6);
    assertEquals(c.labelPoint, {
      x: c.x + L.chromosomeWidth / 2,
      y: c.y + c.height + 18,
    });
  }
});

Deno.test("each marker sits at its band's midpoint inside its chromosome", () => {
  for (const block of layout.blocks) {
    const c = chromosome(block.chromosome);
    const hit = placeGene(block.gene.chromosomalLocation)!;
    assertEquals(block.band, hit.band);
    assertAlmostEquals(
      block.markerY,
      c.y + (hit.midpoint / c.length) * c.height,
      1e-6,
      block.symbol,
    );
    assert(block.markerY >= c.y && block.markerY <= c.y + c.height);
    assertEquals(block.x, c.x + L.chromosomeWidth + L.leaderGap);
    assertEquals(block.width, L.labelColumn);
    assert(
      block.leader.startsWith(`M ${(c.x + L.chromosomeWidth).toFixed(2)} `),
    );
  }
  assertEquals(byGene.get("ABO")!.chromosome, "9");
  assertEquals(byGene.get("APOE")!.chromosome, "19");
  assertEquals(byGene.get("C6orf195")!.chromosome, "6");
  assertEquals(byGene.get("COL4A1/2")!.chromosome, "13");
});

Deno.test("label blocks never overlap, stay in their row, and keep marker order", () => {
  for (const c of layout.chromosomes) {
    const blocks = layout.blocks.filter((b) => b.chromosome === c.name);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      assert(block.y >= c.y - 1e-6, `${block.symbol} is above its row`);
      assert(
        block.y + block.height <= c.y + L.rowHeight + 1e-6,
        `${block.symbol} is below its row`,
      );
      if (i === 0) continue;
      const previous = blocks[i - 1];
      assert(
        previous.markerY <= block.markerY,
        `${block.symbol} is out of order`,
      );
      assert(
        block.y >= previous.y + previous.height + L.blockGap - 1e-6,
        `${previous.symbol}/${block.symbol} overlap`,
      );
    }
  }
});

Deno.test("pills and glyphs derive from the four evidence columns", () => {
  const labels = (s: string) => byGene.get(s)!.pills.map((p) => p.label);
  const glyphs = (s: string) => byGene.get(s)!.glyphs.map((g) => g.key);
  assertEquals(labels("LAMB1"), []);
  assertEquals(glyphs("LAMB1"), []);
  assertEquals(labels("JAK1"), ["PSMD"]);
  assertEquals(glyphs("JAK1"), ["omics", "monogenic"]);
  assertEquals(labels("PCSK9"), []);
  assertEquals(glyphs("PCSK9"), ["omics", "monogenic", "mr"]);
  assertEquals(labels("TLR1"), []);
  assertEquals(glyphs("TLR1"), ["omics", "mr"]);
  assertEquals(labels("CENPF"), ["WM-PVS", "HIP-PVS", "PSMD"]);
  assertEquals(glyphs("CENPF"), ["omics", "monogenic"]);
  assertEquals(labels("COL4A1/2"), ["WMH", "SVS", "MD"]);

  const cenpf = byGene.get("CENPF")!;
  assertEquals(cenpf.height, blockHeight(3));
  assertEquals(blockHeight(0), 22);
  assertEquals(blockHeight(3), 64);
  assertEquals(cenpf.pills[0], {
    key: "WM-PVS",
    label: "WM-PVS",
    family: "pvs",
    fill: "#d8edff",
    stroke: "#2a78d6",
  });
  assertEquals(cenpf.pills[2].stroke, "#eb6834");
  assertEquals(cenpf.glyphs[0], {
    key: "omics",
    label: "Other omics",
    shape: "triangle",
  });
});

Deno.test("the legend lists the seven families with their fourteen traits", () => {
  assertEquals(layout.legend.families.map((f) => f.family.key), [
    "pvs",
    "diffusion",
    "extreme",
    "wmh",
    "stroke",
    "cmb",
    "lacunes",
  ]);
  assertEquals(
    layout.legend.families.reduce((n, f) => n + f.traits.length, 0),
    14,
  );
  assertEquals(layout.legend.evidence.map((e) => e.shape), [
    "triangle",
    "square",
    "star",
  ]);
});

Deno.test("a gene with an unknown band is reported, not drawn", () => {
  const bogus = { ...genes[0], gene: "FAKE1", chromosomalLocation: "1p3" };
  const partial = computePhenogramLayout([bogus, genes[0]]);
  assertEquals(partial.unplaced.map((g) => g.gene), ["FAKE1"]);
  assertEquals(partial.blocks.map((b) => b.symbol), [genes[0].gene]);
  assertEquals(computePhenogramLayout([]).chromosomes, []);
});

Deno.test("resolveCollisions keeps separated blocks where they are", () => {
  assertEquals(resolveCollisions([0, 50], [20, 20], 0, 400, 6), [0, 50]);
});

Deno.test("resolveCollisions pushes a following block down past the gap", () => {
  assertEquals(resolveCollisions([0, 10], [20, 20], 0, 400, 6), [0, 26]);
});

Deno.test("resolveCollisions pulls a stack up when it would run past the row", () => {
  assertEquals(resolveCollisions([380, 390], [20, 20], 0, 400, 6), [354, 380]);
});

Deno.test("resolveCollisions clamps a lone block to the row", () => {
  assertEquals(resolveCollisions([-10], [20], 0, 400, 6), [0]);
  assertEquals(resolveCollisions([395], [20], 0, 400, 6), [380]);
  assertEquals(resolveCollisions([], [], 0, 400, 6), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test -A tests/phenogram_layout_test.ts` Expected: FAIL —
`Module not found "file:///.../lib/phenogram.ts"`

- [ ] **Step 3: Write `lib/phenogram.ts`**

```ts
/**
 * Layout for the phenogram karyogram: chromosomes drawn to scale from the
 * hg38 cytobands, one marker per gene at the midpoint of its band, and a label
 * block beside the chromosome — the symbol with its evidence glyphs on the
 * first line, then one GWAS-phenotype pill per line. Pure functions over
 * `Gene` rows; no DOM, so the same code runs on the server, in the island and
 * under `deno test`.
 *
 * `scripts/phenogram_figure.py` implements this rule a second time for print.
 * Both read `phenogram_encoding.json`, the only place colours, labels,
 * definitions, band stains and the geometry constants live — keep the *rule*
 * here in step with the Python twin (same names, same order of operations).
 *
 * Coordinates are SVG user units in the encoding's `viewBox`; y grows down.
 */

import encodingJson from "./phenogram_encoding.json" with { type: "json" };
import {
  type BandHit,
  cytobands as defaultCytobands,
  type CytobandTable,
  placeGene,
} from "./cytobands.ts";
import { NONE_FOUND } from "./constants.ts";
import { CHROMOSOMES } from "./sorting.ts";
import type { Gene } from "./types.ts";

export interface FamilyEncoding {
  key: string;
  label: string;
  hue: string;
  tint: string;
}

export interface TraitEncoding {
  key: string;
  label: string;
  family: string;
  name: string;
  definition?: string;
  strive?: boolean;
}

export interface EvidenceEncoding {
  key: string;
  label: string;
  shape: string;
}

export interface LayoutConstants {
  viewBox: number[];
  margin: number;
  rowSplitAfter: string;
  rowHeight: number;
  rowGap: number;
  chromosomeWidth: number;
  leaderGap: number;
  labelColumn: number;
  blockGap: number;
  symbolLine: number;
  pillLine: number;
  blockPadding: number;
}

export interface PhenogramEncoding {
  families: FamilyEncoding[];
  traits: TraitEncoding[];
  evidence: EvidenceEncoding[];
  citation: { label: string; doi: string };
  stains: Record<string, string>;
  layout: LayoutConstants;
}

export const encoding: PhenogramEncoding = encodingJson;

/** Baseline offset of a chromosome's name under its q-arm. */
export const CHROMOSOME_LABEL_OFFSET = 18;

/** Pill colours for a trait the encoding does not know — unreachable on committed data (the encoding test). */
const FALLBACK_PILL = { fill: "#ffffff", stroke: "#888888" };
const FALLBACK_STAIN = "#cccccc";

export interface Point {
  x: number;
  y: number;
}

export interface Span {
  y: number;
  height: number;
}

export interface BandShape {
  name: string;
  y: number;
  height: number;
  stain: string;
  fill: string;
}

export interface ChromosomeShape {
  name: string;
  length: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  bands: BandShape[];
  pArm: Span;
  centromere: Span;
  qArm: Span;
  labelPoint: Point;
}

export interface Pill {
  key: string;
  label: string;
  family: string;
  fill: string;
  stroke: string;
}

export interface Glyph {
  key: string;
  label: string;
  shape: string;
}

export interface GeneBlock {
  index: number;
  gene: Gene;
  symbol: string;
  chromosome: string;
  band: string;
  markerY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pills: Pill[];
  glyphs: Glyph[];
  /** SVG path from the chromosome's right edge at the marker to the block's left-middle. */
  leader: string;
}

export interface LegendFamily {
  family: FamilyEncoding;
  traits: TraitEncoding[];
}

export interface PhenogramLayout {
  canvas: { width: number; height: number };
  rows: ChromosomeShape[][];
  chromosomes: ChromosomeShape[];
  blocks: GeneBlock[];
  unplaced: Gene[];
  legend: { families: LegendFamily[]; evidence: EvidenceEncoding[] };
}

const fixed = (n: number) => n.toFixed(2);

/** Height of a label block carrying `pillCount` pills. */
export function blockHeight(
  pillCount: number,
  layout: LayoutConstants = encoding.layout,
): number {
  return 2 * layout.blockPadding + layout.symbolLine +
    pillCount * layout.pillLine;
}

/** One pill per non-sentinel GWAS trait, in the table's order. */
export function pillsFor(
  gene: Gene,
  enc: PhenogramEncoding = encoding,
): Pill[] {
  const families = new Map(enc.families.map((f) => [f.key, f]));
  const traits = new Map(enc.traits.map((t) => [t.key, t]));
  return gene.gwasTrait
    .filter((value) => value !== NONE_FOUND)
    .map((value) => {
      const trait = traits.get(value);
      const family = trait ? families.get(trait.family) : undefined;
      return {
        key: value,
        label: trait?.label ?? value,
        family: trait?.family ?? "unknown",
        fill: family?.tint ?? FALLBACK_PILL.fill,
        stroke: family?.hue ?? FALLBACK_PILL.stroke,
      };
    });
}

/** Evidence glyphs in encoding order: other omics, monogenic disease, Mendelian randomization. */
export function glyphsFor(
  gene: Gene,
  enc: PhenogramEncoding = encoding,
): Glyph[] {
  const has = (values: readonly string[]) =>
    values.some((value) => value !== NONE_FOUND);
  const present: Record<string, boolean> = {
    omics: has(gene.evidenceFromOtherOmicsStudies),
    monogenic: has(gene.linkToMonogenicDisease),
    mr: gene.mendelianRandomization === "Yes",
  };
  return enc.evidence
    .filter((entry) => present[entry.key])
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      shape: entry.shape,
    }));
}

/**
 * Top edges for one chromosome's blocks. `desired` (sorted by marker) and
 * `heights` are parallel; the result keeps that order, separates neighbours
 * by `gap`, and stays inside `[top, bottom]` whenever the stack fits. A stack
 * taller than the row spills above `top` — the layout test pins that no
 * committed chromosome does. `scripts/phenogram_figure.py` carries the twin.
 */
export function resolveCollisions(
  desired: readonly number[],
  heights: readonly number[],
  top: number,
  bottom: number,
  gap: number,
): number[] {
  const y = desired.map((d, i) =>
    Math.min(Math.max(d, top), bottom - heights[i])
  );
  for (let i = 1; i < y.length; i++) {
    y[i] = Math.max(y[i], y[i - 1] + heights[i - 1] + gap);
  }
  for (let i = y.length - 1; i >= 0; i--) {
    const limit = i === y.length - 1
      ? bottom - heights[i]
      : y[i + 1] - gap - heights[i];
    y[i] = Math.min(y[i], limit);
  }
  return y;
}

/**
 * The chromosomes in `names`, in `CHROMOSOMES` order, scaled so the longest
 * chromosome in the table fills `rowHeight`, top-aligned in two rows split
 * after `rowSplitAfter`, one column each.
 */
export function chromosomeShapes(
  names: ReadonlySet<string>,
  table: CytobandTable = defaultCytobands,
  enc: PhenogramEncoding = encoding,
): ChromosomeShape[][] {
  const L = enc.layout;
  const longest = Math.max(...table.chromosomes.map((c) => c.length));
  const scale = L.rowHeight / longest;
  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  const splitIndex = CHROMOSOMES.indexOf(L.rowSplitAfter);
  const rows: ChromosomeShape[][] = [[], []];

  CHROMOSOMES.forEach((name, order) => {
    if (!names.has(name)) return;
    const chromosome = table.chromosomes.find((c) => c.name === name);
    if (!chromosome) return;
    const row = order <= splitIndex ? 0 : 1;
    const x = L.margin + rows[row].length * pitch;
    const y = L.margin + row * (L.rowHeight + L.rowGap);
    const height = chromosome.length * scale;
    const toY = (bp: number) => y + bp * scale;
    const acen = chromosome.bands.filter((b) => b.stain === "acen");
    const cenStart = acen.length ? acen[0].start : chromosome.length / 2;
    const cenEnd = acen.length ? acen[acen.length - 1].end : cenStart;
    rows[row].push({
      name,
      length: chromosome.length,
      row,
      x,
      y,
      width: L.chromosomeWidth,
      height,
      bands: chromosome.bands.map((band) => ({
        name: band.name,
        y: toY(band.start),
        height: (band.end - band.start) * scale,
        stain: band.stain,
        fill: enc.stains[band.stain] ?? FALLBACK_STAIN,
      })),
      pArm: { y, height: cenStart * scale },
      centromere: { y: toY(cenStart), height: (cenEnd - cenStart) * scale },
      qArm: { y: toY(cenEnd), height: (chromosome.length - cenEnd) * scale },
      labelPoint: {
        x: x + L.chromosomeWidth / 2,
        y: y + height + CHROMOSOME_LABEL_OFFSET,
      },
    });
  });
  return rows;
}

interface Placed {
  gene: Gene;
  hit: BandHit;
  markerY: number;
}

export function computePhenogramLayout(
  rows: readonly Gene[],
  enc: PhenogramEncoding = encoding,
  table: CytobandTable = defaultCytobands,
): PhenogramLayout {
  const L = enc.layout;
  const hits: Array<{ gene: Gene; hit: BandHit }> = [];
  const unplaced: Gene[] = [];
  for (const gene of rows) {
    const hit = placeGene(gene.chromosomalLocation, table);
    if (hit) hits.push({ gene, hit });
    else unplaced.push(gene);
  }

  const chromosomeRows = chromosomeShapes(
    new Set(hits.map((h) => h.hit.chromosome)),
    table,
    enc,
  );
  const chromosomes = chromosomeRows.flat();
  const blocks: GeneBlock[] = [];

  for (const chromosome of chromosomes) {
    const here: Placed[] = hits
      .filter((h) => h.hit.chromosome === chromosome.name)
      .map((h) => ({
        ...h,
        markerY: chromosome.y +
          (h.hit.midpoint / chromosome.length) * chromosome.height,
      }))
      .sort((a, b) =>
        a.markerY - b.markerY || a.gene.gene.localeCompare(b.gene.gene)
      );
    const pills = here.map((p) => pillsFor(p.gene, enc));
    const heights = pills.map((list) => blockHeight(list.length, L));
    const tops = resolveCollisions(
      here.map((p, i) => p.markerY - heights[i] / 2),
      heights,
      chromosome.y,
      chromosome.y + L.rowHeight,
      L.blockGap,
    );
    const x = chromosome.x + L.chromosomeWidth + L.leaderGap;
    const edge = chromosome.x + L.chromosomeWidth;
    here.forEach((p, i) => {
      const y = tops[i];
      const height = heights[i];
      blocks.push({
        index: blocks.length,
        gene: p.gene,
        symbol: p.gene.gene,
        chromosome: chromosome.name,
        band: p.hit.band,
        markerY: p.markerY,
        x,
        y,
        width: L.labelColumn,
        height,
        pills: pills[i],
        glyphs: glyphsFor(p.gene, enc),
        leader: `M ${fixed(edge)} ${fixed(p.markerY)} L ${fixed(x)} ${
          fixed(y + height / 2)
        }`,
      });
    });
  }

  return {
    canvas: { width: L.viewBox[0], height: L.viewBox[1] },
    rows: chromosomeRows,
    chromosomes,
    blocks,
    unplaced,
    legend: {
      families: enc.families.map((family) => ({
        family,
        traits: enc.traits.filter((t) => t.family === family.key),
      })),
      evidence: enc.evidence,
    },
  };
}
```

- [ ] **Step 4: Run the tests — all pass**

Run:
`deno fmt lib/phenogram.ts tests/phenogram_layout_test.ts && deno test -A tests/phenogram_layout_test.ts && deno task check`
Expected: `11 passed`; check clean. If "label blocks never overlap" reports a
chromosome whose stack leaves its row, the committed data changed since this
plan — widen `rowHeight` in the encoding rather than the test.

- [ ] **Step 5: Commit**

```bash
git add lib/phenogram.ts tests/phenogram_layout_test.ts
git commit -m "Add the pure phenogram karyogram layout" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Tooltip content for genes and phenotypes

**Files:**

- Modify: `lib/tooltips.ts` (new section after `proteinTooltip`, imports)
- Modify: `tests/tooltips_test.ts` (append)

**Interfaces:**

- Consumes: `encoding`, `TraitEncoding` (`lib/phenogram.ts`); `NONE_FOUND`,
  `NCBI_GENE_BASE_URL` (`lib/constants.ts`); `geneInfoByName`, `omimByNumber`
  (`lib/data.ts`); `Gene` (`lib/types.ts`).
- Produces: `phenogramTooltip(gene: Gene): TooltipContent` (never null) and
  `phenotypeTooltip(trait: TraitEncoding): TooltipContent`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tooltips_test.ts` (and add `phenogramTooltip`,
`phenotypeTooltip` to its `../lib/tooltips.ts` import, `genes` to the
`../lib/data.ts` import, and `import { encoding } from "../lib/phenogram.ts";`):

```ts
// -----------------------------------------------------------------------------
// phenogramTooltip / phenotypeTooltip
// -----------------------------------------------------------------------------

const gene = (symbol: string) => genes.find((g) => g.gene === symbol)!;

Deno.test("phenogramTooltip names the location, the evidence and the NCBI link", () => {
  assertEquals(phenogramTooltip(gene("JAK1")), {
    rows: [
      { label: "Location", value: "1p31.3" },
      { label: "GWAS phenotypes", value: "PSMD" },
      { label: "Other omics", value: "TWAS;brain frontal cortex" },
      {
        label: "Monogenic disease",
        value: "Autoinflammation, immune dysregulation, and eosinophilia",
      },
      { label: "Mendelian randomization", value: "No" },
    ],
    link: {
      href: "https://www.ncbi.nlm.nih.gov/gene/3716",
      label: "View on NCBI Gene",
    },
  });
});

Deno.test("phenogramTooltip says None found rather than the sentinel, and uses display labels", () => {
  const lamb1 = phenogramTooltip(gene("LAMB1"));
  assertEquals(lamb1.rows.map((r) => r.value), [
    "7q31.1",
    "None found",
    "None found",
    "None found",
    "No",
  ]);
  assertEquals(lamb1.link?.href, "https://www.ncbi.nlm.nih.gov/gene/3912");

  const cenpf = phenogramTooltip(gene("CENPF"));
  assertEquals(cenpf.rows[1].value, "WM-PVS; HIP-PVS; PSMD");
  assertEquals(cenpf.rows[3].value, "Stromme syndrome");
});

Deno.test("phenogramTooltip has no link for a gene without an NCBI record", () => {
  const unknown = { ...gene("LAMB1"), gene: "NOSUCHGENE" };
  assertEquals(phenogramTooltip(unknown).link, undefined);
});

Deno.test("phenotypeTooltip carries the long name, the STRIVE-2 definition and its DOI", () => {
  const wmh = encoding.traits.find((t) => t.key === "WMH")!;
  const content = phenotypeTooltip(wmh);
  assertEquals(content.rows[0], {
    label: "WMH",
    value: "White matter hyperintensities (of presumed vascular origin)",
  });
  assertEquals(content.rows[1].label, "STRIVE-2 definition");
  assertEquals(content.rows[1].value.startsWith("Signal abnormality"), true);
  assertEquals(content.link, {
    href: "https://doi.org/10.1016/S1474-4422(23)00131-X",
    label: "View STRIVE-2 (Lancet Neurol 2023)",
  });

  const psmd = encoding.traits.find((t) => t.key === "PSMD")!;
  assertEquals(phenotypeTooltip(psmd), {
    rows: [{
      label: "PSMD",
      value: "Peak width of skeletonized mean diffusivity",
    }],
    link: undefined,
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `deno test -A tests/tooltips_test.ts` Expected: FAIL —
`Module '"../lib/tooltips.ts"' has no exported member 'phenogramTooltip'`

- [ ] **Step 3: Implement**

In `lib/tooltips.ts`, extend the imports:

```ts
import {
  CELL_TYPE_NAMES,
  NCBI_GENE_BASE_URL,
  NONE_FOUND,
  OMICS_FULL_NAMES,
  PUBMED_BASE_URL,
} from "./constants.ts";
import { encoding, type TraitEncoding } from "./phenogram.ts";
import type { Gene, GeneInfo } from "./types.ts";
```

and add, after `proteinTooltip`:

```ts
// -----------------------------------------------------------------------------
// PHENOGRAM
// -----------------------------------------------------------------------------

const STRIVE_LINK = {
  href: `https://doi.org/${encoding.citation.doi}`,
  label: "View STRIVE-2 (Lancet Neurol 2023)",
};

/** "a; b" over the non-sentinel values, or "None found". */
function joined(
  values: readonly string[],
  render: (value: string) => string,
): string {
  const present = values.filter((value) => value !== NONE_FOUND);
  return present.length ? present.map(render).join("; ") : "None found";
}

/**
 * The karyogram's gene panel: where the gene sits, what the figure encodes
 * about it, in words, and the NCBI link the gene table offers. Never null — a
 * gene without a lookup record still has a location and its evidence rows.
 */
export function phenogramTooltip(gene: Gene): TooltipContent {
  const traitLabels = new Map(encoding.traits.map((t) => [t.key, t.label]));
  const rows: TooltipRow[] = [
    { label: "Location", value: gene.chromosomalLocation },
    {
      label: "GWAS phenotypes",
      value: joined(gene.gwasTrait, (v) => traitLabels.get(v) ?? v),
    },
    {
      label: "Other omics",
      value: joined(gene.evidenceFromOtherOmicsStudies, (v) => v),
    },
    {
      label: "Monogenic disease",
      value: joined(
        gene.linkToMonogenicDisease,
        (v) => optionalText(omimByNumber.get(v.trim())?.phenotype) ?? v,
      ),
    },
    { label: "Mendelian randomization", value: gene.mendelianRandomization },
  ];
  const uid = optionalText(geneInfoByName.get(gene.gene)?.uid);
  return {
    rows,
    link: uid
      ? {
        href: `${NCBI_GENE_BASE_URL}${encodeURIComponent(uid)}`,
        label: "View on NCBI Gene",
      }
      : undefined,
  };
}

/** A phenotype key entry: the long name, and the STRIVE-2 definition where one exists. */
export function phenotypeTooltip(trait: TraitEncoding): TooltipContent {
  const rows: TooltipRow[] = [{ label: trait.label, value: trait.name }];
  if (trait.definition) {
    rows.push({ label: "STRIVE-2 definition", value: trait.definition });
  }
  return { rows, link: trait.strive ? STRIVE_LINK : undefined };
}
```

- [ ] **Step 4: Run the tests — all pass**

Run:
`deno fmt lib/tooltips.ts tests/tooltips_test.ts && deno test -A tests/tooltips_test.ts && deno task check`
Expected: all tooltip tests pass (the four new ones included); check clean.

- [ ] **Step 5: Commit**

```bash
git add lib/tooltips.ts tests/tooltips_test.ts
git commit -m "Build tooltip content for phenogram genes and phenotypes" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The island, its route and chrome; retire the raster

**Files:**

- Create: `islands/Phenogram.tsx`
- Modify: `routes/phenogram.tsx` (rewrite)
- Modify: `assets/app.css` (new `/* === PHENOGRAM === */` section before
  `/* === REDUCED MOTION === */`)
- Delete: `static/phenogram.html`, `static/images/phenogram.webp`
- Modify: `deno.json` (`exclude` loses `"static/phenogram.html"`)
- Create: `e2e/tests/phenogram.spec.ts`
- Modify: `e2e/tests/theme.spec.ts` (delete the iframe loop),
  `e2e/tests/timeline.spec.ts` (gains the timeline tips test)
- Delete: `e2e/tests/embeds.spec.ts`

**Interfaces:**

- Consumes: `computePhenogramLayout`, `encoding`, `ChromosomeShape`, `GeneBlock`
  (`lib/phenogram.ts`); `phenogramTooltip`, `phenotypeTooltip`
  (`lib/tooltips.ts`); `Tooltip` (`components/Tooltip.tsx`, renders a
  `<button class="tooltip-box" popovertarget>` around its children and a sibling
  `<span popover class="tooltip-pop">`); `genes` (`lib/data.ts`).
- Produces: `islands/Phenogram.tsx` default export `Phenogram()`; DOM contract
  used by the e2e tests — `svg.phenogram-figure[viewBox="0 0 1600 920"]`,
  `g.phenogram-chromosome[data-chromosome]`,
  `g.phenogram-block[data-gene][data-chromosome]` containing `text[data-pill]` +
  `rect.pill-bg` pairs, `ul.phenogram-genes > li > button` (63, accessible name
  `"<symbol>, <chr><band>. GWAS phenotypes: …. Other
  evidence: …."`),
  `.phenogram-legend-family` (7), `.phenogram-legend-traits .phenogram-pill`
  (14, each inside a `Tooltip`).

- [ ] **Step 1: Write the island**

`islands/Phenogram.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { Tooltip } from "../components/Tooltip.tsx";
import { genes } from "../lib/data.ts";
import {
  type ChromosomeShape,
  computePhenogramLayout,
  encoding,
  type GeneBlock,
} from "../lib/phenogram.ts";
import { phenogramTooltip, phenotypeTooltip } from "../lib/tooltips.ts";

/** Computed once at module load, on the server and in the browser alike. */
const LAYOUT = computePhenogramLayout(genes);
const { width: WIDTH, height: HEIGHT } = LAYOUT.canvas;
const L = encoding.layout;

const SYMBOL_FONT_SIZE = 12;
const PILL_FONT_SIZE = 9.5;
const CHROMOSOME_FONT_SIZE = 13;
const GLYPH_SIZE = 9;
const GLYPH_GAP = 4;
const PILL_PADDING_X = 5;
const PILL_INSET = 2;
/**
 * Pre-hydration estimate of a text width, in em per character. Every pill
 * background and glyph position is refitted from `getBBox()` as soon as the
 * island mounts, and again once the web font has loaded — block positions
 * never depend on it.
 */
const PLACEHOLDER_EM = 0.6;

const percent = (value: number, of: number) => `${(value / of) * 100}%`;

/** The three evidence glyphs, drawn in a `size` × `size` box at (x, y). */
function glyphPath(shape: string, x: number, y: number, size: number): string {
  if (shape === "triangle") {
    return `M ${x} ${y + size} L ${x + size} ${y + size} L ${
      x + size / 2
    } ${y} Z`;
  }
  if (shape === "square") {
    return `M ${x} ${y} h ${size} v ${size} h ${-size} Z`;
  }
  const cx = x + size / 2;
  const cy = y + size / 2;
  const outer = size / 2;
  const inner = outer * 0.42;
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(
      `${(cx + r * Math.cos(angle)).toFixed(2)} ${
        (cy + r * Math.sin(angle)).toFixed(2)
      }`,
    );
  }
  return `M ${points.join(" L ")} Z`;
}

/** What a screen reader gets for a gene; the SVG itself is decoration. */
function accessibleName(block: GeneBlock): string {
  const traits = block.pills.length
    ? block.pills.map((p) => p.label).join(", ")
    : "none found";
  const evidence = block.glyphs.length
    ? block.glyphs.map((g) => g.label).join(", ")
    : "none";
  return `${block.symbol}, ${block.chromosome}${block.band}. ` +
    `GWAS phenotypes: ${traits}. Other evidence: ${evidence}.`;
}

/** Two rounded arms clipped over the band stripes, a narrower centromere, the name below. */
function Chromosome({ shape }: { shape: ChromosomeShape }) {
  const clipId = `phenogram-arms-${shape.name}`;
  const rx = shape.width / 2;
  const arms = [shape.pArm, shape.qArm];
  return (
    <g class="phenogram-chromosome" data-chromosome={shape.name}>
      <clipPath id={clipId}>
        {arms.map((arm, i) => (
          <rect
            key={i}
            x={shape.x}
            y={arm.y}
            width={shape.width}
            height={arm.height}
            rx={rx}
          />
        ))}
      </clipPath>
      <g clip-path={`url(#${clipId})`}>
        {shape.bands.map((band) => (
          <rect
            key={band.name}
            x={shape.x}
            y={band.y}
            width={shape.width}
            height={band.height}
            fill={band.fill}
          />
        ))}
      </g>
      {arms.map((arm, i) => (
        <rect
          key={`outline-${i}`}
          x={shape.x}
          y={arm.y}
          width={shape.width}
          height={arm.height}
          rx={rx}
          fill="none"
          stroke={encoding.stains.gpos100}
          stroke-width={1}
        />
      ))}
      <rect
        x={shape.x + shape.width * 0.2}
        y={shape.centromere.y}
        width={shape.width * 0.6}
        height={shape.centromere.height}
        fill={encoding.stains.acen}
      />
      <text
        class="label-ink"
        x={shape.labelPoint.x}
        y={shape.labelPoint.y}
        text-anchor="middle"
        font-size={CHROMOSOME_FONT_SIZE}
        font-weight={600}
      >
        {shape.name}
      </text>
    </g>
  );
}

interface BlockProps {
  block: GeneBlock;
  widths: ReadonlyMap<string, number>;
}

/** Marker tick, leader, the symbol followed by its glyphs, one pill per line. */
function Block({ block, widths }: BlockProps) {
  const symbolBaseline = block.y + L.blockPadding + L.symbolLine * 0.78;
  const glyphY = block.y + L.blockPadding + (L.symbolLine - GLYPH_SIZE) / 2;
  const chromosomeLeft = block.x - L.leaderGap - L.chromosomeWidth;
  return (
    <g
      class="phenogram-block"
      data-gene={block.symbol}
      data-chromosome={block.chromosome}
    >
      <line
        class="phenogram-marker"
        x1={chromosomeLeft}
        x2={block.x - L.leaderGap}
        y1={block.markerY}
        y2={block.markerY}
      />
      <path class="phenogram-leader" d={block.leader} />
      <text
        class="label-ink phenogram-symbol"
        data-symbol={`symbol-${block.index}`}
        x={block.x}
        y={symbolBaseline}
        font-size={SYMBOL_FONT_SIZE}
        font-weight={600}
      >
        {block.symbol}
      </text>
      {block.glyphs.map((glyph, i) => {
        const symbolWidth = widths.get(`symbol-${block.index}`) ??
          block.symbol.length * SYMBOL_FONT_SIZE * PLACEHOLDER_EM;
        const x = block.x + symbolWidth + 2 * GLYPH_GAP +
          i * (GLYPH_SIZE + GLYPH_GAP);
        return (
          <path
            key={glyph.key}
            class="phenogram-glyph"
            data-evidence={glyph.key}
            d={glyphPath(glyph.shape, x, glyphY, GLYPH_SIZE)}
          />
        );
      })}
      {block.pills.map((pill, i) => {
        const id = `pill-${block.index}-${i}`;
        const top = block.y + L.blockPadding + L.symbolLine + i * L.pillLine;
        const textWidth = widths.get(id) ??
          pill.label.length * PILL_FONT_SIZE * PLACEHOLDER_EM;
        const height = L.pillLine - PILL_INSET;
        return (
          <g key={id} class="phenogram-pill-mark" data-trait={pill.key}>
            <rect
              class="pill-bg"
              x={block.x}
              y={top + PILL_INSET / 2}
              width={textWidth + 2 * PILL_PADDING_X}
              height={height}
              rx={height / 2}
              fill={pill.fill}
              stroke={pill.stroke}
              stroke-width={1}
            />
            <text
              class="label-ink"
              data-pill={id}
              x={block.x + PILL_PADDING_X}
              y={top + L.pillLine / 2}
              dy="0.35em"
              font-size={PILL_FONT_SIZE}
            >
              {pill.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * The phenogram karyogram: putative causal genes on their hg38 chromosomes.
 *
 * Replaces the sandboxed iframe around a PhenoGram raster with pixel-colour
 * hit-testing. The layout is `lib/phenogram.ts`; this island renders it as a
 * decorative SVG and lays a list of real buttons over the label blocks, so
 * every gene has a focus target, an accessible name and the same popover
 * tooltip the tables use — hover, Enter, Tab-to-link and Escape all come from
 * `Tooltip` unchanged.
 */
export default function Phenogram() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [widths, setWidths] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );

  const measure = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const next = new Map<string, number>();
    for (
      const text of svg.querySelectorAll<SVGTextElement>(
        "text[data-pill], text[data-symbol]",
      )
    ) {
      let width = 0;
      try {
        width = text.getBBox().width;
      } catch {
        continue;
      }
      const key = text.dataset.pill ?? text.dataset.symbol ?? "";
      if (width > 0) next.set(key, width);
    }
    setWidths(next);
  };

  // Fit the pill backgrounds once on mount, and again when the web font lands.
  useLayoutEffect(measure, []);
  useEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { families, evidence } = LAYOUT.legend;
  const samplePill = families[0].family;

  return (
    <div class="phenogram-layout">
      <div class="phenogram-scroll">
        <div
          class="phenogram-canvas"
          style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        >
          <svg
            ref={svgRef}
            class="phenogram-figure"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            aria-hidden="true"
          >
            {LAYOUT.chromosomes.map((shape) => (
              <Chromosome key={shape.name} shape={shape} />
            ))}
            {LAYOUT.blocks.map((block) => (
              <Block key={block.index} block={block} widths={widths} />
            ))}
          </svg>
          <ul
            class="phenogram-genes"
            aria-label="Genes by chromosomal position"
          >
            {LAYOUT.blocks.map((block) => (
              <li
                key={block.index}
                style={{
                  left: percent(block.x, WIDTH),
                  top: percent(block.y, HEIGHT),
                  width: percent(block.width, WIDTH),
                  height: percent(block.height, HEIGHT),
                }}
              >
                <Tooltip content={phenogramTooltip(block.gene)}>
                  <span class="visually-hidden">{accessibleName(block)}</span>
                </Tooltip>
              </li>
            ))}
          </ul>
        </div>
        {LAYOUT.unplaced.length > 0 && (
          <p class="phenogram-unplaced" role="status">
            Not drawn (no hg38 band for their location): {LAYOUT.unplaced
              .map((g) =>
                `${g.gene} (${g.chromosomalLocation})`
              )
              .join(", ")}
          </p>
        )}
      </div>

      <div class="phenogram-legend">
        <section class="phenogram-legend-panel">
          <h2 class="phenogram-legend-title">Supporting evidence</h2>
          <ul class="phenogram-legend-list">
            <li class="phenogram-legend-item">
              <span
                class="phenogram-pill"
                style={{
                  background: samplePill.tint,
                  borderColor: samplePill.hue,
                }}
              >
                GWAS
              </span>
              one pill per associated phenotype
            </li>
            {evidence.map((entry) => (
              <li key={entry.key} class="phenogram-legend-item">
                <svg
                  class="phenogram-legend-glyph"
                  viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
                  aria-hidden="true"
                >
                  <path
                    d={glyphPath(entry.shape, 0, 0, GLYPH_SIZE)}
                    fill="currentColor"
                  />
                </svg>
                {entry.label}
              </li>
            ))}
          </ul>
        </section>
        <section class="phenogram-legend-panel">
          <h2 class="phenogram-legend-title">GWAS phenotypes</h2>
          <ul class="phenogram-legend-list">
            {families.map(({ family, traits }) => (
              <li key={family.key} class="phenogram-legend-family">
                <span class="phenogram-legend-family-name">
                  <span
                    class="phenogram-legend-swatch"
                    style={{ background: family.hue }}
                    aria-hidden="true"
                  />
                  {family.label}
                </span>
                <ul class="phenogram-legend-traits">
                  {traits.map((trait) => (
                    <li key={trait.key}>
                      <Tooltip content={phenotypeTooltip(trait)}>
                        <span
                          class="phenogram-pill"
                          style={{
                            background: family.tint,
                            borderColor: family.hue,
                          }}
                        >
                          {trait.label}
                        </span>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite the route**

`routes/phenogram.tsx` (replace the whole file):

```tsx
import { define } from "../utils.ts";
import Phenogram from "../islands/Phenogram.tsx";
import { TipBox } from "../components/TipBox.tsx";
import { Page } from "../components/Page.tsx";

/**
 * The karyogram, drawn in-app from data/table1.json and the hg38 cytobands.
 * It replaced a sandboxed iframe around a PhenoGram raster with pixel-colour
 * hit-testing; the print version of the same figure is
 * scripts/phenogram_figure.py.
 */
export default define.page(function PhenogramPage() {
  return (
    <Page
      title="Phenogram"
      description="Chromosomal positions of the putative causal genes, with their GWAS phenotypes and supporting evidence."
    >
      <div class="tip-row">
        <TipBox>
          Hover over or focus a gene to see its location, phenotypes and
          evidence; hover a phenotype in the key for its definition.
        </TipBox>
      </div>

      <Phenogram />
    </Page>
  );
});
```

- [ ] **Step 3: Add the stylesheet section**

In `assets/app.css`, in the light `:root` token block, immediately after the
`--svd-figure-ink: var(--svd-indigo-925);` declaration, add the plate token
(once — never in the dark blocks, which must stay identical):

```css
/* The plate the two figures are drawn on. Fixed, like --svd-figure-ink: the
   figures keep their colours in dark mode, so the ground under them does. */
--svd-figure-plate: var(--svd-white);
```

Then, immediately before `/* === REDUCED MOTION === */`:

```css
/* === PHENOGRAM === */

/*
 * The karyogram is drawn in-app by islands/Phenogram.tsx from lib/phenogram.ts.
 * Everything that encodes data — band stains, pill tints and borders — arrives
 * as SVG attributes and inline styles from lib/phenogram_encoding.json and is
 * deliberately left alone by the theme; these rules style the chrome and the
 * HTML button layer that gives every gene a real focus target.
 */
.phenogram-layout {
  display: flex;
  align-items: flex-start;
  gap: var(--svd-space-5);
}

.phenogram-scroll {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  padding: var(--svd-space-4);
  background: var(--svd-bg-card);
  border-radius: var(--svd-radius-md);
  box-shadow: var(--svd-shadow-sm);
}

/* The SVG fills this box and the gene buttons are placed on it in percentages
   of the viewBox, so both scale together. 1100px is the floor below which the
   plate scrolls sideways inside its container instead of overflowing the page.
   The plate is fixed light in both themes; only the card around it follows
   the theme. */
.phenogram-canvas {
  position: relative;
  width: 100%;
  min-width: 1100px;
  background: var(--svd-figure-plate);
  border-radius: var(--svd-radius-sm);
}

.phenogram-figure {
  display: block;
  width: 100%;
  height: 100%;
  font-family: var(--svd-font);
}

.phenogram-figure .label-ink {
  fill: var(--svd-figure-ink);
}

.phenogram-figure .phenogram-marker {
  stroke: var(--svd-figure-ink);
  stroke-width: 2;
}

.phenogram-figure .phenogram-leader {
  fill: none;
  stroke: var(--svd-figure-ink);
  stroke-width: 1;
}

.phenogram-figure .phenogram-glyph {
  fill: var(--svd-figure-ink);
}

.phenogram-genes {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.phenogram-genes li {
  position: absolute;
}

/* Tooltip.tsx renders a table-cell style trigger; over the figure it is a
   transparent hit area covering the label block, with hover and focus as its
   only visible states. */
.phenogram-genes .tooltip-box {
  position: absolute;
  inset: 0;
  padding: 0;
  border: 0;
  border-radius: var(--svd-radius-xs);
  background: transparent;
  box-shadow: none;
  cursor: pointer;
}

.phenogram-genes .tooltip-box:hover {
  background: color-mix(in oklab, var(--svd-color-primary) 8%, transparent);
  box-shadow: none;
}

.phenogram-genes .tooltip-box:focus-visible {
  outline: var(--svd-focus-width) solid var(--svd-focus-color);
  outline-offset: var(--svd-focus-offset);
}

.phenogram-unplaced {
  margin: var(--svd-space-3) 0 0;
  color: var(--svd-color-danger-text);
}

.phenogram-legend {
  flex: 0 0 18rem;
  display: flex;
  flex-direction: column;
  gap: var(--svd-space-4);
}

.phenogram-legend-panel {
  padding: var(--svd-space-4);
  background: var(--svd-bg-card);
  border-radius: var(--svd-radius-md);
  box-shadow: var(--svd-shadow-sm);
}

.phenogram-legend-title {
  margin: 0 0 var(--svd-space-3);
  font-size: var(--svd-text-md);
}

.phenogram-legend-list,
.phenogram-legend-traits {
  margin: 0;
  padding: 0;
  list-style: none;
}

.phenogram-legend-list {
  display: flex;
  flex-direction: column;
  gap: var(--svd-space-2);
  font-size: var(--svd-text-base);
}

.phenogram-legend-item {
  display: flex;
  align-items: center;
  gap: var(--svd-space-2);
}

.phenogram-legend-glyph {
  flex: none;
  width: 1rem;
  height: 1rem;
  color: var(--svd-ink);
}

.phenogram-legend-family {
  display: flex;
  flex-direction: column;
  gap: var(--svd-space-1);
}

.phenogram-legend-family-name {
  display: flex;
  align-items: center;
  gap: var(--svd-space-2);
  font-weight: var(--svd-weight-semibold);
}

.phenogram-legend-swatch {
  flex: none;
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
}

.phenogram-legend-traits {
  display: flex;
  flex-wrap: wrap;
  gap: var(--svd-space-1);
}

/* Pills carry data colours as inline styles; the ink is the fixed figure ink,
   so they read the same on both themes. */
.phenogram-pill {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border: 1px solid;
  border-radius: var(--svd-radius-sm);
  color: var(--svd-figure-ink);
  font-size: var(--svd-text-sm);
  line-height: 1.4;
}

.phenogram-legend .tooltip-box {
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  cursor: help;
}

@media (max-width: 1100px) {
  /* Stretch, or the scroll container sizes itself to the 1100px plate and the
     document overflows instead of the container scrolling. */
  .phenogram-layout {
    flex-direction: column;
    align-items: stretch;
  }

  .phenogram-legend {
    flex-basis: auto;
    width: 100%;
  }
}
```

- [ ] **Step 4: Retire the raster and its exclude entry**

```bash
git rm static/phenogram.html static/images/phenogram.webp
```

In `deno.json` `exclude`, delete the line `"static/phenogram.html",`.

- [ ] **Step 5: Check, unit tests, and look at it**

Run:
`deno fmt islands/Phenogram.tsx routes/phenogram.tsx assets/app.css && deno task check && deno task test`
Expected: clean; all Deno tests pass (the styles contract test in particular —
if it names a `--svd-` token, that token is not declared: use one from the list
at the top of this plan).

Run: `deno task dev`, open `http://localhost:8000/phenogram` (the port Vite
prints), and confirm: 19 chromosomes in two rows, chromosome 13 with COL4A1/2,
ABO on chromosome 9 next to LPAR1, pills with readable labels, no label block
overlapping another, hover on a block opens the gene tooltip, Tab reaches the
blocks in chromosome order, the legend pills open the phenotype tooltips, and
the dark-theme toggle leaves the plate light. Stop the server.

- [ ] **Step 6: Retire the iframe e2e tests**

In `e2e/tests/theme.spec.ts`, delete everything from the comment
`/** The phenogram frame cannot see app.css.` (line 117) to the end of the file
— the `for (const [route, frame] of …)` loop was the only entry.

Delete `e2e/tests/embeds.spec.ts` (`git rm e2e/tests/embeds.spec.ts`). Its one
surviving assertion, the timeline tips, moves to `e2e/tests/timeline.spec.ts` —
append:

```ts
/**
 * The tip row above a figure is the only place the page says what the figure
 * responds to. Both rows were dropped in the port from Shiny and nothing
 * noticed, which is what this pins.
 */
test("the timeline names its affordances and credits its source", async ({ page }) => {
  await page.goto("/timeline");
  const tips = page.locator(".tip-row .tip-box");
  await expect(tips).toHaveCount(2);
  await expect(tips.first()).toContainText("trial details panel");

  const citation = tips.nth(1);
  await expect(citation.locator("strong")).toHaveText("Visually-inspired by:");
  await expect(citation.getByRole("link", { name: /^DOI:/ })).toHaveAttribute(
    "href",
    "https://pubmed.ncbi.nlm.nih.gov/37251912/",
  );
});
```

- [ ] **Step 7: Write the phenogram e2e spec**

`e2e/tests/phenogram.spec.ts`:

```ts
import { expect, type Page, test } from "@playwright/test";

import { tooltip } from "../helpers.ts";

/**
 * The karyogram is drawn in-app by islands/Phenogram.tsx. Pill backgrounds are
 * fitted from getBBox() after the fonts settle, so anything that reads a box
 * polls rather than asserting once. The interactive layer is an HTML list of
 * buttons over the SVG, so the tooltip assertions are the same ones the tables
 * use.
 */

const FIGURE = "svg.phenogram-figure";

async function figureSettled(page: Page) {
  await page.goto("/phenogram");
  await expect(page.locator(FIGURE)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("draws 19 chromosomes, 63 gene blocks, 63 buttons and both legends", async ({ page }) => {
  await figureSettled(page);
  const figure = page.locator(FIGURE);
  await expect(figure).toHaveAttribute("viewBox", "0 0 1600 920");
  await expect(figure.locator("g.phenogram-chromosome")).toHaveCount(19);
  await expect(figure.locator('g.phenogram-chromosome[data-chromosome="13"]'))
    .toHaveCount(1);
  await expect(figure.locator("g.phenogram-block")).toHaveCount(63);
  await expect(page.locator(".phenogram-genes button")).toHaveCount(63);
  await expect(page.locator(".phenogram-legend-family")).toHaveCount(7);
  await expect(page.locator(".phenogram-legend-traits .phenogram-pill"))
    .toHaveCount(14);
  // The gene list is interactive on the figure; nothing hidden carries a link.
  await expect(page.locator(".visually-hidden a")).toHaveCount(0);
  await expect(page.locator(".phenogram-unplaced")).toHaveCount(0);
});

test("the raster's errors are gone: ABO on 9, C6orf195 on 6, COL4A1/2 on 13", async ({ page }) => {
  await figureSettled(page);
  for (
    const [symbol, chromosome] of [
      ["ABO", "9"],
      ["APOE", "19"],
      ["C6orf195", "6"],
      ["COL4A1/2", "13"],
    ]
  ) {
    await expect(
      page.locator(`${FIGURE} g.phenogram-block[data-gene="${symbol}"]`),
    ).toHaveAttribute("data-chromosome", chromosome);
  }
});

test("pill backgrounds fit their text and no two label blocks overlap", async ({ page }) => {
  await figureSettled(page);
  await expect.poll(() =>
    page.evaluate(() => {
      const misfit: string[] = [];
      const overlapping: string[] = [];
      const apart = (a: DOMRect, b: DOMRect) =>
        a.right < b.left || a.left > b.right || a.bottom < b.top ||
        a.top > b.bottom;

      for (
        const pill of document.querySelectorAll(
          "svg.phenogram-figure g.phenogram-pill-mark",
        )
      ) {
        const text = pill.querySelector<SVGTextElement>("text[data-pill]")!;
        const rect = pill.querySelector<SVGRectElement>("rect.pill-bg")!;
        const t = text.getBBox();
        const r = rect.getBBox();
        if (r.x > t.x || r.x + r.width < t.x + t.width) {
          misfit.push(text.dataset.pill ?? "?");
        }
      }

      const blocks = [
        ...document.querySelectorAll("svg.phenogram-figure g.phenogram-block"),
      ].map((g) => ({
        gene: g.getAttribute("data-gene") ?? "?",
        rect: g.querySelector("text.phenogram-symbol")!.getBoundingClientRect(),
        chromosome: g.getAttribute("data-chromosome"),
      }));
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          if (blocks[i].chromosome !== blocks[j].chromosome) continue;
          if (!apart(blocks[i].rect, blocks[j].rect)) {
            overlapping.push(`${blocks[i].gene}/${blocks[j].gene}`);
          }
        }
      }
      return { misfit, overlapping, blocks: blocks.length };
    })
  ).toEqual({ misfit: [], overlapping: [], blocks: 63 });
});

test("hovering a gene opens its tooltip and the keyboard reaches the NCBI link", async ({ page }) => {
  await figureSettled(page);
  const lamb1 = page.getByRole("button", { name: /^LAMB1, 7q31\.1\./ });
  await lamb1.hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page)).toContainText("Location");
  await expect(tooltip(page)).toContainText("7q31.1");
  await expect(tooltip(page)).toContainText("None found");
  await page.mouse.move(5, 5);
  await expect(tooltip(page)).toHaveCount(0);

  await lamb1.focus();
  await page.keyboard.press("Enter");
  await expect(tooltip(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tooltip(page).getByRole("link", { name: "View on NCBI Gene" }))
    .toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tooltip(page)).toHaveCount(0);
  await expect(lamb1).toBeFocused();
});

test("gene buttons follow chromosome order and name the evidence", async ({ page }) => {
  await figureSettled(page);
  const names = await page.locator(".phenogram-genes button").evaluateAll(
    (buttons) => buttons.map((b) => b.textContent?.trim() ?? ""),
  );
  expect(names[0]).toMatch(/^PCSK9, 1p32\.3\. GWAS phenotypes: none found\./);
  expect(names.find((n) => n.startsWith("CENPF,"))).toBe(
    "CENPF, 1q41. GWAS phenotypes: WM-PVS, HIP-PVS, PSMD. " +
      "Other evidence: Other omics, Monogenic disease.",
  );
  expect(names.at(-1)).toMatch(/^TIMP3, 22q12\.3\./);
});

test("the phenotype key explains WMH with its STRIVE-2 definition", async ({ page }) => {
  await figureSettled(page);
  const key = page.locator(".phenogram-legend-traits");
  await key.getByRole("button", { name: "WMH", exact: true }).hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page)).toContainText(
    "White matter hyperintensities (of presumed vascular origin)",
  );
  await expect(tooltip(page)).toContainText("hyperintense on T2-weighted");
  await expect(tooltip(page).getByRole("link", { name: /STRIVE-2/ }))
    .toHaveAttribute("href", "https://doi.org/10.1016/S1474-4422(23)00131-X");

  await page.mouse.move(5, 5);
  await expect(tooltip(page)).toHaveCount(0);
  await key.getByRole("button", { name: "PSMD", exact: true }).hover();
  await expect(tooltip(page)).toContainText("Peak width of skeletonized");
  await expect(tooltip(page).getByRole("link")).toHaveCount(0);
});

test("the figure's data colours do not follow the theme", async ({ page }) => {
  await figureSettled(page);
  const pill = page.locator(`${FIGURE} rect.pill-bg`).first();
  const band = page.locator(
    `${FIGURE} g.phenogram-chromosome[data-chromosome="1"] rect`,
  ).nth(2);
  const plate = page.locator(".phenogram-canvas");
  const before = {
    pill: await pill.getAttribute("fill"),
    band: await band.getAttribute("fill"),
    plate: await plate.evaluate((el) => getComputedStyle(el).backgroundColor),
    page: await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    ),
  };

  await page.getByRole("button", { name: /Switch to (dark|light) theme/ })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    /dark|light/,
  );
  await expect.poll(() =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  ).not.toBe(before.page);

  await expect(pill).toHaveAttribute("fill", before.pill ?? "");
  await expect(band).toHaveAttribute("fill", before.band ?? "");
  expect(await plate.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(before.plate);
});

test("the phenogram names its affordance", async ({ page }) => {
  await page.goto("/phenogram");
  const tips = page.locator(".tip-row .tip-box");
  await expect(tips).toHaveCount(1);
  await expect(tips.first()).toContainText("Hover over or focus a gene");
});
```

The first-button assertion relies on `PCSK9` (`1p32.3`) sitting above `JAK1`
(`1p31.3`) on chromosome 1 and `TIMP3` (`22q12.3`) being the last block; both
follow from the committed band strings.

- [ ] **Step 8: Run the browser suite**

Run: `deno task test:e2e` Expected: all specs pass — `phenogram.spec.ts` (8
tests), `timeline.spec.ts` (one more test), `theme.spec.ts` (two fewer),
`runtime.spec.ts` and `navigation.spec.ts` unchanged (`/phenogram` still renders
an h1 "Phenogram" and no horizontal overflow at 390 px). If "pill backgrounds
fit their text" reports misfits, `measure()` did not run after the font loaded —
check that `document.fonts.ready` resolves in the island (`useEffect`, not
`useLayoutEffect`).

- [ ] **Step 9: Commit**

```bash
git add islands/Phenogram.tsx routes/phenogram.tsx assets/app.css deno.json e2e/tests/phenogram.spec.ts e2e/tests/theme.spec.ts e2e/tests/timeline.spec.ts
git commit -m "Draw the phenogram in-app instead of embedding a raster" -m "Replaces the sandboxed iframe around a PhenoGram image with pixel-colour hit-testing. The karyogram is laid out from data/table1.json and the hg38 cytobands, every gene is a real button with the tables' popover tooltip, and the phenotype key carries the STRIVE-2 definitions. Fixes the raster's drift from the data: ABO was labelled APOE, C6orf195 and COL4A1/2 (and so chromosome 13) were missing." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Remove the embed scaffolding

**Files:**

- Delete: `components/EmbedPage.tsx`, `islands/EmbedFrame.tsx`
- Modify: `lib/theme.ts:6` (delete `THEME_MESSAGE`)
- Modify: `assets/app.css` (delete `/* === IFRAMES === */` with `.embed-frame`,
  and the orphan `.embed-frame-tall` under `/* === PAGE HEADINGS === */`)

**Interfaces:**

- Consumes: nothing new. After this task nothing in `components/`, `islands/`,
  `lib/` or `assets/` mentions `EmbedPage`, `EmbedFrame`, `THEME_MESSAGE`,
  `svd:theme` or `embed-frame`.

- [ ] **Step 1: Prove the scaffolding is unreferenced**

Run:
`grep -rn "EmbedPage\|EmbedFrame\|THEME_MESSAGE\|svd:theme\|embed-frame" --include=*.ts --include=*.tsx --include=*.css components islands lib routes assets e2e/tests`
Expected: hits only inside `components/EmbedPage.tsx`, `islands/EmbedFrame.tsx`,
`lib/theme.ts:6` and `assets/app.css` (`.embed-frame`, `.embed-frame-tall`). Any
other hit is a consumer this plan missed — stop and report it.

- [ ] **Step 2: Delete the files and the token**

```bash
git rm components/EmbedPage.tsx islands/EmbedFrame.tsx
```

In `lib/theme.ts`, delete the line `export const THEME_MESSAGE = "svd:theme";`.

- [ ] **Step 3: Delete the CSS**

In `assets/app.css`, delete the block

```css
/* === IFRAMES === */

.embed-frame {
  width: 100%;
  border: 0;
  border-radius: var(--svd-radius-md);
  background: var(--svd-bg-card);
  box-shadow: var(--svd-shadow-sm);
  display: block;
}
```

and, under `/* === PAGE HEADINGS === */`, the block

```css
.embed-frame-tall {
  height: min(80vh, 900px);
  min-height: 520px;
}
```

- [ ] **Step 4: Verify**

Run: `deno task check && deno task test && deno task test:e2e` Expected: all
clean. The styles contract test's "every declared token is used" stays green
because `--svd-radius-md`, `--svd-bg-card` and `--svd-shadow-sm` are used by the
timeline and phenogram rules.

Run:
`grep -rn "EmbedPage\|EmbedFrame\|THEME_MESSAGE\|svd:theme\|embed-frame" --include=*.ts --include=*.tsx --include=*.css components islands lib routes assets e2e/tests`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add -A components islands lib assets
git commit -m "Remove the iframe embed scaffolding" -m "Both figures are drawn in-app now, so the sandboxed frame, its page wrapper and the postMessage theme handoff have no consumer." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: The matplotlib print twin

**Files:**

- Create: `scripts/phenogram_figure.py`
- Create: `tests/scripts/test_phenogram_figure.py`
- Modify: `deno.json` (`figure` task runs both scripts)

**Interfaces:**

- Consumes: `data/table1.json`, `data/cytobands_hg38.json`,
  `lib/phenogram_encoding.json` (files only — no import from the TS side).
- Produces: module-level `load_genes`, `load_cytobands`, `load_encoding`,
  `place_gene(location, table) -> BandHit | None`,
  `block_height(pill_count, layout) -> float`,
  `pills_for(gene, encoding) -> tuple[Pill, ...]`,
  `glyphs_for(gene, encoding) -> tuple[Glyph, ...]`,
  `resolve_collisions(desired, heights, top, bottom, gap) -> list[float]`,
  `chromosome_shapes(names, table, encoding) -> list[list[ChromosomeShape]]`,
  `compute_layout(genes, encoding, table) -> Layout`, `configure_output()`
  (called by `draw`: `svg.fonttype = "none"`, PDF/PS fonts type 42),
  `configure_fonts(font)`, `draw(genes, encoding, table) -> Figure`,
  `main(argv) -> int`; function names mirror `lib/phenogram.ts` so the two read
  side by side.

- [ ] **Step 1: Write the failing test**

`tests/scripts/test_phenogram_figure.py`:

```python
"""Unit tests for scripts/phenogram_figure.py.

The numbers pinned here are the ones tests/phenogram_layout_test.ts pins for
lib/phenogram.ts: the island and the print figure implement one rule over one
encoding file and one cytoband table, and these two suites keep them in step.
"""

import re
from pathlib import Path

import pytest

from scripts.phenogram_figure import (
    DEFAULT_CYTOBANDS,
    DEFAULT_ENCODING,
    DEFAULT_GENES,
    block_height,
    compute_layout,
    draw,
    glyphs_for,
    load_cytobands,
    load_encoding,
    load_genes,
    main,
    pills_for,
    place_gene,
    resolve_collisions,
)

DRAWN = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    "11", "13", "14", "16", "17", "19", "20", "21", "22",
]


@pytest.fixture(scope="module")
def genes() -> list[dict]:
    return load_genes(DEFAULT_GENES)


@pytest.fixture(scope="module")
def cytobands() -> dict:
    return load_cytobands(DEFAULT_CYTOBANDS)


@pytest.fixture(scope="module")
def encoding() -> dict:
    return load_encoding(DEFAULT_ENCODING)


@pytest.fixture(scope="module")
def layout(genes, encoding, cytobands):
    return compute_layout(genes, encoding, cytobands)


def by_gene(layout, symbol: str):
    return next(block for block in layout.blocks if block.symbol == symbol)


class TestPlacement:
    def test_place_gene_is_exact(self, cytobands) -> None:
        hit = place_gene("7q31.1", cytobands)
        assert hit is not None
        assert (hit.chromosome, hit.band, hit.start, hit.end) == (
            "7",
            "q31.1",
            107800000,
            115000000,
        )
        assert hit.midpoint == 111400000
        assert place_gene("1p3", cytobands) is None
        assert place_gene("23q11", cytobands) is None
        assert place_gene("(unknown)", cytobands) is None

    def test_every_gene_is_placed_on_nineteen_chromosomes(self, layout) -> None:
        assert len(layout.blocks) == 63
        assert layout.unplaced == ()
        assert [c.name for c in layout.chromosomes] == DRAWN
        assert [[c.name for c in row] for row in layout.rows] == [
            DRAWN[:10],
            DRAWN[10:],
        ]
        assert layout.canvas == (1600, 920)

    def test_the_rasters_errors_are_gone(self, layout) -> None:
        assert by_gene(layout, "ABO").chromosome == "9"
        assert by_gene(layout, "APOE").chromosome == "19"
        assert by_gene(layout, "C6orf195").chromosome == "6"
        assert by_gene(layout, "COL4A1/2").chromosome == "13"

    def test_chromosomes_are_to_scale_and_bands_tile_them(
        self, layout, encoding
    ) -> None:
        one = next(c for c in layout.chromosomes if c.name == "1")
        assert one.height == pytest.approx(encoding["layout"]["rowHeight"])
        thirteen = next(c for c in layout.chromosomes if c.name == "13")
        assert thirteen.height == pytest.approx(114364328 / 248956422 * 400)
        for chromosome in layout.chromosomes:
            cursor = chromosome.y
            for band in chromosome.bands:
                assert band.y == pytest.approx(cursor)
                assert band.fill == encoding["stains"][band.stain]
                cursor += band.height
            assert cursor == pytest.approx(chromosome.y + chromosome.height)

    def test_blocks_stay_in_their_row_and_never_overlap(
        self, layout, encoding
    ) -> None:
        gap = encoding["layout"]["blockGap"]
        row_height = encoding["layout"]["rowHeight"]
        for chromosome in layout.chromosomes:
            blocks = [b for b in layout.blocks if b.chromosome == chromosome.name]
            for previous, block in zip(blocks, blocks[1:], strict=False):
                assert block.y >= previous.y + previous.height + gap - 1e-6
            for block in blocks:
                assert block.y >= chromosome.y - 1e-6
                assert block.y + block.height <= chromosome.y + row_height + 1e-6


class TestEncoding:
    def test_pills_and_glyphs_follow_the_evidence_columns(
        self, layout, genes, encoding
    ) -> None:
        cenpf = by_gene(layout, "CENPF")
        assert [p.label for p in cenpf.pills] == ["WM-PVS", "HIP-PVS", "PSMD"]
        assert [g.key for g in cenpf.glyphs] == ["omics", "monogenic"]
        assert cenpf.pills[0].fill == "#d8edff"
        assert cenpf.pills[0].stroke == "#2a78d6"
        assert cenpf.height == block_height(3, encoding["layout"]) == 64
        pcsk9 = next(g for g in genes if g["gene"] == "PCSK9")
        assert pills_for(pcsk9, encoding) == ()
        assert [g.key for g in glyphs_for(pcsk9, encoding)] == [
            "omics",
            "monogenic",
            "mr",
        ]
        lamb1 = next(g for g in genes if g["gene"] == "LAMB1")
        assert glyphs_for(lamb1, encoding) == ()


class TestResolveCollisions:
    """Same cases as tests/phenogram_layout_test.ts, same expected tops."""

    def test_leaves_separated_blocks_alone(self) -> None:
        assert resolve_collisions([0, 50], [20, 20], 0, 400, 6) == [0, 50]

    def test_pushes_a_following_block_down(self) -> None:
        assert resolve_collisions([0, 10], [20, 20], 0, 400, 6) == [0, 26]

    def test_pulls_a_stack_up_at_the_bottom(self) -> None:
        assert resolve_collisions([380, 390], [20, 20], 0, 400, 6) == [354, 380]

    def test_clamps_a_lone_block(self) -> None:
        assert resolve_collisions([-10], [20], 0, 400, 6) == [0]
        assert resolve_collisions([395], [20], 0, 400, 6) == [380]
        assert resolve_collisions([], [], 0, 400, 6) == []


class TestRender:
    def test_svg_carries_every_gene_and_both_legends(
        self, genes, encoding, cytobands, tmp_path: Path
    ) -> None:
        fig = draw(genes, encoding, cytobands)
        target = tmp_path / "phenogram.svg"
        fig.savefig(target, format="svg", bbox_inches="tight")
        svg = target.read_text(encoding="utf-8")
        assert svg.count('id="gene-') == 63
        assert "Supporting evidence" in svg
        assert "GWAS phenotypes" in svg
        assert "Perivascular spaces" in svg
        # Text stays text: real <text> elements, not glyph outlines. Comments
        # and gids carry the symbols regardless of svg.fonttype, so look for
        # the symbol as element content.
        assert svg.count("<text") >= 63
        assert re.search(r"<text[^>]*>(?:<tspan[^>]*>)?COL4A1/2<", svg)

    def test_main_writes_the_requested_formats(self, tmp_path: Path) -> None:
        code = main(["--out", str(tmp_path), "--format", "svg", "pdf", "--dpi", "72"])
        assert code == 0
        assert (tmp_path / "phenogram.svg").stat().st_size > 0
        assert (tmp_path / "phenogram.pdf").stat().st_size > 0
        assert not (tmp_path / "phenogram.png").exists()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/scripts/test_phenogram_figure.py -q` Expected: FAIL —
`ModuleNotFoundError: No module named 'scripts.phenogram_figure'`

- [ ] **Step 3: Write the script**

`scripts/phenogram_figure.py`:

```python
"""Draw the phenogram karyogram (genes on hg38 chromosomes) for print.

The dashboard draws the same figure in the browser (islands/Phenogram.tsx from
lib/phenogram.ts). Both renderers read lib/phenogram_encoding.json -- the one
place colours, labels, definitions, band stains and the geometry constants
live -- and data/cytobands_hg38.json, and both apply the same layout rule:
chromosomes that carry a gene, to scale, in two rows split after chromosome
10; one marker per gene at the midpoint of its band; a label block beside the
chromosome (symbol and evidence glyphs, then one pill per GWAS phenotype),
stacked without overlap by resolve_collisions. Coordinates are the SVG user
units of the encoding's viewBox, y down; the matplotlib axes are inverted to
match.

Usage:
    uv run --group figure scripts/phenogram_figure.py
    uv run --group figure scripts/phenogram_figure.py --out figures/ --format svg pdf
    uv run --group figure scripts/phenogram_figure.py --font /path/to/Arial.ttf --dpi 600
"""

import argparse
import json
import re
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GENES = _PROJECT_ROOT / "data" / "table1.json"
DEFAULT_CYTOBANDS = _PROJECT_ROOT / "data" / "cytobands_hg38.json"
DEFAULT_ENCODING = _PROJECT_ROOT / "lib" / "phenogram_encoding.json"
DEFAULT_OUT = _PROJECT_ROOT / "figures"
FORMATS = ("svg", "pdf", "png")

# The sentinel lib/constants.ts matches literally.
NONE_FOUND = "(none found)"
CHROMOSOMES = [str(n) for n in range(1, 23)] + ["X", "Y"]
CHROMOSOME_LABEL_OFFSET = 18.0
FALLBACK_PILL = ("#ffffff", "#888888")
FALLBACK_STAIN = "#cccccc"
LOCATION = re.compile(r"^(\d{1,2}|X|Y)([pq]\d+(?:\.\d+)?)$")

# One viewBox unit is 1/100 inch on the page: 12 units of text is 8.64 pt.
UNITS_PER_INCH = 100.0
PT_PER_UNIT = 72.0 / UNITS_PER_INCH
SYMBOL_FONT_UNITS = 12.0
PILL_FONT_UNITS = 9.5
CHROMOSOME_FONT_UNITS = 13.0
GLYPH_UNITS = 9.0
GLYPH_GAP = 4.0
PILL_PADDING_X = 5.0
LEGEND_FONT_PT = 7.5
INK = "#14172b"
MARKERS = {"triangle": "^", "square": "s", "star": "*"}


@dataclass(frozen=True)
class BandHit:
    chromosome: str
    band: str
    start: int
    end: int
    midpoint: float


@dataclass(frozen=True)
class Band:
    name: str
    y: float
    height: float
    stain: str
    fill: str


@dataclass(frozen=True)
class ChromosomeShape:
    name: str
    length: int
    row: int
    x: float
    y: float
    width: float
    height: float
    bands: tuple[Band, ...]
    p_arm: tuple[float, float]
    centromere: tuple[float, float]
    q_arm: tuple[float, float]
    label_point: tuple[float, float]


@dataclass(frozen=True)
class Pill:
    key: str
    label: str
    family: str
    fill: str
    stroke: str


@dataclass(frozen=True)
class Glyph:
    key: str
    label: str
    shape: str


@dataclass(frozen=True)
class GeneBlock:
    index: int
    gene: dict[str, Any]
    symbol: str
    chromosome: str
    band: str
    marker_y: float
    x: float
    y: float
    width: float
    height: float
    pills: tuple[Pill, ...]
    glyphs: tuple[Glyph, ...]


@dataclass(frozen=True)
class Layout:
    canvas: tuple[float, float]
    rows: tuple[tuple[ChromosomeShape, ...], ...]
    chromosomes: tuple[ChromosomeShape, ...]
    blocks: tuple[GeneBlock, ...]
    unplaced: tuple[dict[str, Any], ...]


def load_genes(path: Path = DEFAULT_GENES) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_cytobands(path: Path = DEFAULT_CYTOBANDS) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_encoding(path: Path = DEFAULT_ENCODING) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def place_gene(location: str, table: dict[str, Any]) -> BandHit | None:
    """The band a location names, or None. Exact match only, as lib/cytobands.ts."""
    match = LOCATION.match(location.strip())
    if not match:
        return None
    chromosome, band_name = match.groups()
    for chrom in table["chromosomes"]:
        if chrom["name"] != chromosome:
            continue
        for band in chrom["bands"]:
            if band["name"] == band_name:
                midpoint = (band["start"] + band["end"]) / 2
                return BandHit(chromosome, band_name, band["start"], band["end"], midpoint)
    return None


def block_height(pill_count: int, layout: dict[str, Any]) -> float:
    return (
        2 * layout["blockPadding"]
        + layout["symbolLine"]
        + pill_count * layout["pillLine"]
    )


def pills_for(gene: dict[str, Any], encoding: dict[str, Any]) -> tuple[Pill, ...]:
    """One pill per non-sentinel GWAS trait, in the table's order."""
    families = {f["key"]: f for f in encoding["families"]}
    traits = {t["key"]: t for t in encoding["traits"]}
    pills: list[Pill] = []
    for value in gene["gwasTrait"]:
        if value == NONE_FOUND:
            continue
        trait = traits.get(value)
        family = families.get(trait["family"]) if trait else None
        pills.append(
            Pill(
                key=value,
                label=trait["label"] if trait else value,
                family=trait["family"] if trait else "unknown",
                fill=family["tint"] if family else FALLBACK_PILL[0],
                stroke=family["hue"] if family else FALLBACK_PILL[1],
            )
        )
    return tuple(pills)


def glyphs_for(gene: dict[str, Any], encoding: dict[str, Any]) -> tuple[Glyph, ...]:
    """Evidence glyphs in encoding order: other omics, monogenic, Mendelian randomization."""

    def has(values: list[str]) -> bool:
        return any(value != NONE_FOUND for value in values)

    present = {
        "omics": has(gene["evidenceFromOtherOmicsStudies"]),
        "monogenic": has(gene["linkToMonogenicDisease"]),
        "mr": gene["mendelianRandomization"] == "Yes",
    }
    return tuple(
        Glyph(entry["key"], entry["label"], entry["shape"])
        for entry in encoding["evidence"]
        if present.get(entry["key"], False)
    )


def resolve_collisions(
    desired: Sequence[float],
    heights: Sequence[float],
    top: float,
    bottom: float,
    gap: float,
) -> list[float]:
    """Top edges for one chromosome's blocks; the twin of lib/phenogram.ts."""
    y = [min(max(d, top), bottom - h) for d, h in zip(desired, heights, strict=True)]
    for i in range(1, len(y)):
        y[i] = max(y[i], y[i - 1] + heights[i - 1] + gap)
    for i in range(len(y) - 1, -1, -1):
        if i == len(y) - 1:
            limit = bottom - heights[i]
        else:
            limit = y[i + 1] - gap - heights[i]
        y[i] = min(y[i], limit)
    return y


def chromosome_shapes(
    names: Iterable[str], table: dict[str, Any], encoding: dict[str, Any]
) -> list[list[ChromosomeShape]]:
    """Chromosomes in CHROMOSOMES order, scaled to the longest, in two rows."""
    wanted = set(names)
    layout = encoding["layout"]
    longest = max(c["length"] for c in table["chromosomes"])
    scale = layout["rowHeight"] / longest
    pitch = layout["chromosomeWidth"] + layout["leaderGap"] + layout["labelColumn"]
    split_index = CHROMOSOMES.index(layout["rowSplitAfter"])
    by_name = {c["name"]: c for c in table["chromosomes"]}
    rows: list[list[ChromosomeShape]] = [[], []]
    for order, name in enumerate(CHROMOSOMES):
        if name not in wanted or name not in by_name:
            continue
        chromosome = by_name[name]
        row = 0 if order <= split_index else 1
        x = layout["margin"] + len(rows[row]) * pitch
        y = layout["margin"] + row * (layout["rowHeight"] + layout["rowGap"])
        height = chromosome["length"] * scale
        acen = [b for b in chromosome["bands"] if b["stain"] == "acen"]
        cen_start = acen[0]["start"] if acen else chromosome["length"] / 2
        cen_end = acen[-1]["end"] if acen else cen_start
        bands = tuple(
            Band(
                name=b["name"],
                y=y + b["start"] * scale,
                height=(b["end"] - b["start"]) * scale,
                stain=b["stain"],
                fill=encoding["stains"].get(b["stain"], FALLBACK_STAIN),
            )
            for b in chromosome["bands"]
        )
        rows[row].append(
            ChromosomeShape(
                name=name,
                length=chromosome["length"],
                row=row,
                x=x,
                y=y,
                width=layout["chromosomeWidth"],
                height=height,
                bands=bands,
                p_arm=(y, cen_start * scale),
                centromere=(y + cen_start * scale, (cen_end - cen_start) * scale),
                q_arm=(y + cen_end * scale, (chromosome["length"] - cen_end) * scale),
                label_point=(
                    x + layout["chromosomeWidth"] / 2,
                    y + height + CHROMOSOME_LABEL_OFFSET,
                ),
            )
        )
    return rows


def compute_layout(
    genes: Sequence[dict[str, Any]], encoding: dict[str, Any], table: dict[str, Any]
) -> Layout:
    layout = encoding["layout"]
    hits: list[tuple[dict[str, Any], BandHit]] = []
    unplaced: list[dict[str, Any]] = []
    for gene in genes:
        hit = place_gene(gene["chromosomalLocation"], table)
        if hit is None:
            unplaced.append(gene)
        else:
            hits.append((gene, hit))

    rows = chromosome_shapes({hit.chromosome for _, hit in hits}, table, encoding)
    chromosomes = [shape for row in rows for shape in row]
    blocks: list[GeneBlock] = []
    for shape in chromosomes:
        here = [
            (gene, hit, shape.y + hit.midpoint / shape.length * shape.height)
            for gene, hit in hits
            if hit.chromosome == shape.name
        ]
        # Same order as lib/phenogram.ts: by marker, then symbol (localeCompare
        # there, case-folded here; identical on the committed symbols).
        here.sort(key=lambda item: (item[2], item[0]["gene"].casefold()))
        pills = [pills_for(gene, encoding) for gene, _, _ in here]
        heights = [block_height(len(p), layout) for p in pills]
        desired = [
            marker_y - height / 2
            for (_, _, marker_y), height in zip(here, heights, strict=True)
        ]
        tops = resolve_collisions(
            desired,
            heights,
            shape.y,
            shape.y + layout["rowHeight"],
            layout["blockGap"],
        )
        x = shape.x + layout["chromosomeWidth"] + layout["leaderGap"]
        for (gene, hit, marker_y), pill_list, height, top in zip(
            here, pills, heights, tops, strict=True
        ):
            blocks.append(
                GeneBlock(
                    index=len(blocks),
                    gene=gene,
                    symbol=gene["gene"],
                    chromosome=shape.name,
                    band=hit.band,
                    marker_y=marker_y,
                    x=x,
                    y=top,
                    width=layout["labelColumn"],
                    height=height,
                    pills=pill_list,
                    glyphs=glyphs_for(gene, encoding),
                )
            )

    return Layout(
        canvas=(layout["viewBox"][0], layout["viewBox"][1]),
        rows=tuple(tuple(row) for row in rows),
        chromosomes=tuple(chromosomes),
        blocks=tuple(blocks),
        unplaced=tuple(unplaced),
    )


def configure_output() -> None:
    """Text stays text in the SVG; the PDF/PS embed the face as TrueType."""
    from matplotlib import rcParams

    rcParams["svg.fonttype"] = "none"
    rcParams["pdf.fonttype"] = 42
    rcParams["ps.fonttype"] = 42


def configure_fonts(font: Path | None) -> None:
    """Register an optional print face; the default is matplotlib's sans-serif."""
    from matplotlib import font_manager, rcParams

    if font is not None:
        font_manager.fontManager.addfont(str(font))
        properties = font_manager.FontProperties(fname=str(font))
        rcParams["font.family"] = properties.get_name()


def _rounded(x: float, y: float, width: float, height: float, **style: Any) -> Any:
    from matplotlib.patches import FancyBboxPatch

    return FancyBboxPatch(
        (x, y),
        width,
        height,
        boxstyle=f"round,pad=0,rounding_size={width / 2}",
        mutation_aspect=1,
        **style,
    )


def _draw_chromosome(ax: Any, shape: ChromosomeShape, encoding: dict[str, Any]) -> None:
    from matplotlib.patches import Rectangle

    outline = encoding["stains"]["gpos100"]
    for arm_y, arm_height in (shape.p_arm, shape.q_arm):
        if arm_height <= 0:
            continue
        clip = _rounded(shape.x, arm_y, shape.width, arm_height, facecolor="white")
        clip.set_edgecolor("none")
        ax.add_patch(clip)
        for band in shape.bands:
            if band.y + band.height <= arm_y or band.y >= arm_y + arm_height:
                continue
            rect = Rectangle(
                (shape.x, band.y),
                shape.width,
                band.height,
                facecolor=band.fill,
                edgecolor="none",
            )
            ax.add_patch(rect)
            rect.set_clip_path(clip)
        ax.add_patch(
            _rounded(
                shape.x,
                arm_y,
                shape.width,
                arm_height,
                facecolor="none",
                edgecolor=outline,
                linewidth=0.6,
            )
        )
    cen_y, cen_height = shape.centromere
    ax.add_patch(
        Rectangle(
            (shape.x + shape.width * 0.2, cen_y),
            shape.width * 0.6,
            cen_height,
            facecolor=encoding["stains"]["acen"],
            edgecolor="none",
        )
    )
    ax.text(
        shape.label_point[0],
        shape.label_point[1],
        shape.name,
        ha="center",
        va="baseline",
        fontsize=CHROMOSOME_FONT_UNITS * PT_PER_UNIT,
        fontweight="bold",
        color=INK,
    )


def _draw_block(ax: Any, block: GeneBlock, layout: dict[str, Any]) -> None:
    left = block.x - layout["leaderGap"] - layout["chromosomeWidth"]
    edge = block.x - layout["leaderGap"]
    ax.plot([left, edge], [block.marker_y, block.marker_y], color=INK, linewidth=1.2)
    ax.plot(
        [edge, block.x],
        [block.marker_y, block.y + block.height / 2],
        color=INK,
        linewidth=0.6,
    )
    pad = layout["blockPadding"]
    symbol_line = layout["symbolLine"]
    text = ax.text(
        block.x,
        block.y + pad + symbol_line * 0.78,
        block.symbol,
        ha="left",
        va="baseline",
        fontsize=SYMBOL_FONT_UNITS * PT_PER_UNIT,
        fontweight="bold",
        color=INK,
    )
    text.set_gid(f"gene-{block.symbol}")
    glyph_y = block.y + pad + symbol_line / 2
    # Glyphs follow the symbol at its rendered width, as the island measures it.
    extent = text.get_window_extent()
    inverse = ax.transData.inverted()
    symbol_width = (
        inverse.transform((extent.x1, 0))[0] - inverse.transform((extent.x0, 0))[0]
    )
    for i, glyph in enumerate(block.glyphs):
        x = block.x + symbol_width + 2 * GLYPH_GAP + i * (GLYPH_UNITS + GLYPH_GAP)
        ax.plot(
            [x + GLYPH_UNITS / 2],
            [glyph_y],
            marker=MARKERS.get(glyph.shape, "o"),
            markersize=GLYPH_UNITS * PT_PER_UNIT * 1.1,
            color=INK,
            linestyle="none",
        )
    for i, pill in enumerate(block.pills):
        top = block.y + pad + symbol_line + i * layout["pillLine"]
        ax.text(
            block.x + PILL_PADDING_X,
            top + layout["pillLine"] / 2,
            pill.label,
            ha="left",
            va="center",
            fontsize=PILL_FONT_UNITS * PT_PER_UNIT,
            color=INK,
            bbox={
                "boxstyle": "round,pad=0.3",
                "facecolor": pill.fill,
                "edgecolor": pill.stroke,
                "linewidth": 0.5,
            },
        )


def _add_legends(fig: Any, encoding: dict[str, Any]) -> None:
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch

    evidence = [
        Line2D(
            [],
            [],
            marker=MARKERS.get(entry["shape"], "o"),
            linestyle="none",
            color=INK,
            markersize=6,
            label=entry["label"],
        )
        for entry in encoding["evidence"]
    ]
    families = []
    for family in encoding["families"]:
        traits = [t["label"] for t in encoding["traits"] if t["family"] == family["key"]]
        families.append(
            Patch(
                facecolor=family["tint"],
                edgecolor=family["hue"],
                label=f"{family['label']}: {', '.join(traits)}",
            )
        )
    fig.legend(
        handles=evidence,
        title="Supporting evidence",
        loc="lower left",
        bbox_to_anchor=(0.0, 1.0),
        fontsize=LEGEND_FONT_PT,
        title_fontsize=LEGEND_FONT_PT,
        frameon=False,
    )
    fig.legend(
        handles=families,
        title="GWAS phenotypes",
        loc="lower left",
        bbox_to_anchor=(0.22, 1.0),
        ncols=2,
        fontsize=LEGEND_FONT_PT,
        title_fontsize=LEGEND_FONT_PT,
        frameon=False,
    )


def draw(
    genes: Sequence[dict[str, Any]], encoding: dict[str, Any], table: dict[str, Any]
) -> Any:
    """The figure, ready for `savefig(..., bbox_inches="tight")`."""
    import matplotlib

    matplotlib.use("Agg")
    configure_output()
    from matplotlib import pyplot as plt

    layout = compute_layout(genes, encoding, table)
    width, height = layout.canvas
    fig = plt.figure(figsize=(width / UNITS_PER_INCH, height / UNITS_PER_INCH))
    ax = fig.add_axes((0.0, 0.0, 1.0, 1.0))
    ax.set_xlim(0, width)
    ax.set_ylim(height, 0)
    ax.set_aspect("equal")
    ax.axis("off")
    for shape in layout.chromosomes:
        _draw_chromosome(ax, shape, encoding)
    for block in layout.blocks:
        _draw_block(ax, block, encoding["layout"])
    _add_legends(fig, encoding)
    return fig


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--genes", type=Path, default=DEFAULT_GENES)
    parser.add_argument("--cytobands", type=Path, default=DEFAULT_CYTOBANDS)
    parser.add_argument("--encoding", type=Path, default=DEFAULT_ENCODING)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--format", nargs="+", choices=FORMATS, default=list(FORMATS))
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument(
        "--font",
        type=Path,
        default=None,
        help="a .ttf/.otf to render with (journals usually want Arial/Helvetica)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    configure_fonts(args.font)
    fig = draw(load_genes(args.genes), load_encoding(args.encoding), load_cytobands(args.cytobands))
    args.out.mkdir(parents=True, exist_ok=True)
    for fmt in args.format:
        target = args.out / f"phenogram.{fmt}"
        fig.savefig(target, format=fmt, dpi=args.dpi, bbox_inches="tight")
        print(f"Wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests, ruff and ty**

Run:
`uv run ruff format scripts/phenogram_figure.py tests/scripts/test_phenogram_figure.py && uv run ruff check scripts/phenogram_figure.py tests/scripts/test_phenogram_figure.py && uv run ty check && uv run pytest tests/scripts/test_phenogram_figure.py -q`
Expected: `12 passed`. If `test_svg_carries_every_gene_and_both_legends` finds
fewer than 63 `gene-` ids, a symbol contains a character matplotlib drops from
gids — none of the committed symbols does (`/` in `COL4A1/2` is kept).

- [ ] **Step 5: Make `deno task figure` draw both figures**

In `deno.json`, change the `figure` task to:

```json
"figure": "uv run --group figure scripts/timeline_figure.py && uv run --group figure scripts/phenogram_figure.py",
```

Run: `deno task figure` Expected: `figures/timeline.{svg,pdf,png}` and
`figures/phenogram.{svg,pdf,png}` are written (gitignored). Open
`figures/phenogram.svg` and compare with `/phenogram` in `deno task dev`: same
19 chromosomes in the same rows, the same blocks per chromosome in the same
order, pills with the same labels and colours, both legends.

- [ ] **Step 6: Commit**

```bash
git add scripts/phenogram_figure.py tests/scripts/test_phenogram_figure.py deno.json
git commit -m "Add the matplotlib print renderer for the phenogram" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation

**Files:**

- Modify: `CLAUDE.md`, `README.md`,
  `docs/superpowers/specs/2026-08-29-pipeline-teardown.md`,
  `docs/superpowers/specs/2026-08-29-timeline-radar-design.md`,
  `docs/superpowers/specs/2026-08-29-phenogram-design.md`

**Interfaces:** none — prose only. Every claim below must match what Tasks 1–7
built; if a name differs, fix the prose, not the code.

- [ ] **Step 1: `CLAUDE.md`**

1. Delete the paragraph beginning
   `The standalone`static/phenogram.html`is
   excluded from fmt/lint/check`.
2. Replace the `deno task figure` paragraph with:

   ```markdown
   `deno task figure` draws both figures for print — the trials timeline with
   `scripts/timeline_figure.py` (pyCirclize) and the phenogram with
   `scripts/phenogram_figure.py` (matplotlib). It needs `uv sync --group figure`
   first and writes `figures/{timeline,phenogram}.{svg,pdf,png}`, which are not
   committed. `deno task cytobands` regenerates `data/cytobands_hg38.json` from
   UCSC; that file _is_ committed, like every other `data/*.json`.
   ```

3. In "Routes and islands", change
   `data tables, the map, and embeds use the
   full width` to
   `data tables, the map and the two figures use the full
   width`; replace the
   `islands/EmbedFrame.tsx` bullet with:

   ```markdown
   - `islands/Phenogram.tsx` — the karyogram: chromosomes from the hg38 cytobands,
     one label block per gene, drawn as SVG from `lib/phenogram.ts` under an HTML
     layer of gene buttons. See "Phenogram" below.
   ```

   and replace the paragraph beginning
   `` `routes/phenogram.tsx` renders
   `components/EmbedPage.tsx` `` with:

   ```markdown
   Both figures are drawn in-app from the committed JSON. Nothing is embedded in an
   iframe any more; the last one, the phenogram, was a PhenoGram raster with
   pixel-colour hit-testing that had drifted from the data (ABO labelled APOE,
   C6orf195 and COL4A1/2 missing).
   ```

4. After the `### Timeline` section, add:

   ```markdown
   ### Phenogram

   `islands/Phenogram.tsx` draws the karyogram from `data/table1.json` and
   `data/cytobands_hg38.json` (UCSC hg38, 862 bands, written by
   `scripts/fetch_cytobands.py`). A gene is placed at the midpoint of the band its
   `chromosomalLocation` names — exact match only, in `lib/cytobands.ts`;
   `tests/cytobands_test.ts` fails if any committed location stops resolving, and
   the island lists such genes instead of guessing.

   Two renderers, one contract, as for the timeline:

   - `lib/phenogram_encoding.json` holds the seven phenotype families and their
     hues and tints, the fourteen traits (keyed by the raw data value, with display
     label, long name and the STRIVE-2 definition where one exists), the evidence
     glyphs, the band-stain greys and the geometry constants.
     `tests/phenogram_encoding_test.ts` fails when the data carries a GWAS trait
     the file does not, when the trait keys drift from `GWAS_TRAIT_CHOICES`, or
     when a family hue leaves the lightness band or sits within OKLab ΔE 15 of its
     legend neighbour. Add the entry; do not widen the test.
   - `lib/phenogram.ts` (island) and `scripts/phenogram_figure.py` (print)
     implement the same rule: chromosomes that carry a gene, to scale, in two rows
     split after chromosome 10; a label block per gene — symbol and evidence glyphs
     on the first line, then one pill per GWAS trait — stacked by
     `resolveCollisions` (sweep down to enforce the gap, sweep back up at the row's
     bottom). `tests/phenogram_layout_test.ts` and
     `tests/scripts/test_phenogram_figure.py` pin the same numbers.

   Trait identity is text, not colour: each trait is a pill with its label on the
   family tint, because no seven-hue palette is pairwise distinguishable under
   colour-blindness simulation and the printed figure has no tooltip. The hues are
   the dataviz reference palette minus yellow, in the one legend order (of 720)
   that clears both adjacent gates; see the design spec.

   The SVG is `aria-hidden` decoration. Over it, `ul.phenogram-genes` holds one
   absolutely positioned `<li>` per block, in percent of the viewBox, each wrapping
   `components/Tooltip.tsx` around a visually-hidden name — so hover, Enter,
   Tab-to-link and Escape are the tables' behaviour with no new tooltip code, and
   screen readers get the 63 genes in chromosome order. Pill backgrounds and the
   glyph positions after each symbol are the only measured geometry (`getBBox()` on
   mount and on `document.fonts.ready`); block positions never depend on text
   metrics.
   ```

5. Replace the paragraph beginning
   `The embedded phenogram page cannot see`app.css`` with:

   ```markdown
   Both figures keep their data colours out of the theme: wedge, marker, band, pill
   and label-box colours are SVG attributes or inline styles from the two encoding
   files, never CSS, so the dark blocks cannot reach them. The fixed ink they need
   is `--svd-figure-ink`, and the phenogram's plate is `--svd-figure-plate`; both
   are declared once and never overridden by the dark blocks.
   ```

- [ ] **Step 2: `README.md`**

1. In the directory listing, change the `static/` line to
   `static/         fonts and images`.
2. In the print-figures section (the paragraph beginning
   `` `scripts/timeline_figure.py` draws the trials timeline radar ``), add
   after it:

   ```markdown
   `scripts/phenogram_figure.py` draws the phenogram karyogram the same way, from
   `data/table1.json`, `data/cytobands_hg38.json` and
   `lib/phenogram_encoding.json`, on plain matplotlib. `deno task figure` runs both
   scripts.
   ```

   and change the `deno task figure   # figures/timeline.{svg,pdf,png}` line to
   `deno task figure   # figures/{timeline,phenogram}.{svg,pdf,png}`.
3. Replace the paragraph beginning `The phenogram (a 362 KB WebP raster` with:

   ```markdown
   Both figures — the phenogram and the trials timeline — are drawn in-app from the
   committed JSON. The phenogram used to be a PhenoGram raster with pixel-colour
   hit-testing inside a sandboxed iframe; it had drifted from the data (ABO
   labelled APOE, C6orf195 and COL4A1/2 missing).
   ```

- [ ] **Step 3: Design documents**

1. `docs/superpowers/specs/2026-08-29-pipeline-teardown.md`: replace the line
   ``- `static/phenogram.html` duplicates the GWAS trait vocabulary with no test.``
   with
   ``- `static/phenogram.html` duplicated the GWAS trait vocabulary with no test — retired 2026-08-29; the phenogram now reads `lib/phenogram_encoding.json`, pinned by `tests/phenogram_encoding_test.ts`.``
2. `docs/superpowers/specs/2026-08-29-timeline-radar-design.md`: after the
   bullet that says `components/EmbedPage.tsx` / `islands/EmbedFrame.tsx` "stay
   for the phenogram", add the sentence
   `Superseded: the phenogram spec of the same day removes them.`
3. `docs/superpowers/specs/2026-08-29-phenogram-design.md`, refinements the plan
   and its execution made (the `lib/phenogram.ts` bullet was already amended for
   the glyph placement in commit b041394 — leave it): in the
   `islands/Phenogram.tsx` bullet, replace the parenthesis that reads
   `reuse --svd-figure-ink and the .timeline-figure / .timeline-scroll plate
   rules, generalized into a shared .figure-plate / .figure-scroll pair rather
   than copied`
   and the sentence `Inside the plate: the HTML legend, then a` with:

   ```markdown
   reuse `--svd-figure-ink`; `.phenogram-scroll` / `.phenogram-canvas` mirror the
   timeline's `.timeline-scroll` / `.timeline-figure` rather than generalizing
   them, since the timeline's styling was still moving on its own branch, and the
   canvas is painted with the fixed `--svd-figure-plate` token). Beside the plate,
   as the timeline's legend sits, the HTML legend; inside the card a
   ```

   (the rest of that bullet stays as it is).

- [ ] **Step 4: Format, check and commit**

Run:
`deno fmt CLAUDE.md README.md docs/superpowers/specs/2026-08-29-pipeline-teardown.md docs/superpowers/specs/2026-08-29-timeline-radar-design.md docs/superpowers/specs/2026-08-29-phenogram-design.md && deno task check`
Expected: clean.

Run:
`grep -rn "phenogram.html\|phenogram.webp\|EmbedPage\|EmbedFrame\|THEME_MESSAGE" CLAUDE.md README.md`
Expected: no output.

```bash
git add CLAUDE.md README.md docs/superpowers/specs
git commit -m "Document the in-app phenogram and retire the embed notes" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (after Task 8)

Run, from the worktree root:

- `deno task check && deno task test` — every Deno test passes, including
  `cytobands_test`, `phenogram_encoding_test`, `phenogram_layout_test`, the four
  new tooltip tests and the unchanged `styles_contract_test`.
- `uv run ruff check . && uv run ty check && uv run pytest -q` — the two new
  Python suites pass alongside the existing 841 tests.
- `deno task test:e2e` — `phenogram.spec.ts` (8), `timeline.spec.ts` (+1),
  `theme.spec.ts` (−2), `runtime.spec.ts`, `navigation.spec.ts` all green.
- `deno task figure` — writes both print figures; `figures/phenogram.svg` shows
  the same rows, blocks and legend as `/phenogram`.
- `git grep -n "phenogram.html\|phenogram.webp\|EmbedFrame\|EmbedPage\|THEME_MESSAGE"`
  — only the design specs and this plan mention them.

## Plan self-review

- **Spec coverage.** Cytoband table + placement rule → Task 1. Encoding file,
  families/tints, guardrail gates → Task 2. Layout rule, collisions, legend
  data, `unplaced` → Task 3. `phenogramTooltip`/`phenotypeTooltip` → Task 4.
  Island (SVG + button layer + legend + tips), route, CSS on tokens, raster
  retired, e2e replacement, theme spec → Task 5. Embed scaffolding deletion
  (`EmbedPage`, `EmbedFrame`, `THEME_MESSAGE`, `.embed-frame*`) → Task 6. Print
  twin, `figure` task, `figure` group → Task 7. Docs and the teardown hazard
  line → Task 8. Deferred by the spec and not planned: bp-precision placement
  from NCBI `genomicinfo`.
- **Refinements over the spec**, recorded in Task 8 Step 3: one pill per line
  (no width-dependent wrapping, so neither renderer estimates glyph widths — the
  timeline's lesson, for layout) with glyphs following the symbol at its
  measured width (a right-aligned first draft put them beside the neighbouring
  chromosome); the legend sits beside the plate as the timeline's does. Column
  width 128 and row height 400 were checked against the committed data: the
  densest stacks are chromosome 1 (8 blocks, ≈358 units with gaps) and
  chromosome 2 (7 blocks); chromosome 17's five blocks fit its 400-unit row
  although the chromosome itself is 134 units tall.
- **Type consistency.** `BandHit`, `placeGene`, `STAINS` (Task 1) are consumed
  by Tasks 2–3 under those names; `encoding`, `GeneBlock`, `ChromosomeShape`,
  `computePhenogramLayout`, `blockHeight` (Task 3) by Tasks 4–5;
  `phenogramTooltip`, `phenotypeTooltip` (Task 4) by Task 5; the DOM contract
  listed in Task 5's Interfaces is what `phenogram.spec.ts` selects. The Python
  names mirror the TS names one-for-one (`place_gene`, `block_height`,
  `pills_for`, `glyphs_for`, `resolve_collisions`, `chromosome_shapes`,
  `compute_layout`).
