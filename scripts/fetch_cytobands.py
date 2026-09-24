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

SOURCE = "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBandIdeo.txt.gz"
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
        chromosomes.append({"name": name, "length": bands[-1]["end"], "bands": bands})
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
