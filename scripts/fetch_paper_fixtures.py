"""Fetch the full-text paper fixtures for tests/pipeline/test_extraction_golden.py.

The golden extraction suite scores the model against ten gold-standard papers.
Seven of them are full articles from Europe PMC, and publisher text is not ours
to redistribute, so those seven are gitignored and this script writes them; the
three abstract-only fixtures are short enough to stay tracked. `manifest.json`
beside the fixtures names the seven PMIDs with the SHA-256 of the text the
committed cassettes were recorded against. Europe PMC re-renders articles, and
a paper whose text has moved makes every cassette a recording of a request the
pipeline no longer sends -- so a mismatch fails the run and says so, and
`--update-manifest` is passed only after the cassettes have been re-recorded
(the recipe is in the module docstring of test_extraction_golden.py).

The text is what the pipeline itself would send: `fetch_europepmc_fulltext`,
through the current `parse_jats`. `pdf_retrieval.get_fulltext` is deliberately
not used -- it falls back to an abstract when full text is unavailable, and an
abstract written under a full-text PMID would score as an extraction failure.

Run as a module, not as a path: it imports `pipeline`, which resolves from the
repository root.

Usage:
    uv run python -m scripts.fetch_paper_fixtures
    uv run python -m scripts.fetch_paper_fixtures --pmid 37069360
    uv run python -m scripts.fetch_paper_fixtures --update-manifest
"""

import argparse
import asyncio
import hashlib
import json
import sys
from collections.abc import Awaitable, Callable, Iterable
from datetime import date
from pathlib import Path

from pipeline.europepmc import close_http_client, fetch_europepmc_fulltext

_REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = _REPO_ROOT / "tests" / "pipeline" / "csvd" / "fixtures" / "papers"
MANIFEST = FIXTURES_DIR / "manifest.json"


# {pmid: {"sha256": <hex digest of the fixture text>, "fetched": <ISO date>}}
Manifest = dict[str, dict[str, str]]


def load_manifest(path: Path) -> Manifest:
    return json.loads(path.read_text(encoding="utf-8"))


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def fetch_papers(
    pmids: Iterable[str],
    fetch: Callable[[str], Awaitable[str | None]] | None = None,
) -> dict[str, str]:
    """Full text for every PMID, or LookupError naming the first without one."""
    fetch = fetch or fetch_europepmc_fulltext
    texts: dict[str, str] = {}
    try:
        for pmid in pmids:
            text = await fetch(pmid)
            if text is None:
                raise LookupError(f"Europe PMC has no full text for PMID {pmid}")
            texts[pmid] = text
    finally:
        await close_http_client()
    return texts


def write_fixtures(texts: dict[str, str], out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for pmid, text in texts.items():
        path = out_dir / f"{pmid}.txt"
        path.write_text(text, encoding="utf-8")
        written.append(path)
    return written


def drifted(manifest: Manifest, texts: dict[str, str]) -> list[str]:
    """PMIDs whose fetched text no longer hashes to what the manifest records."""
    return [
        pmid for pmid, text in texts.items() if manifest[pmid]["sha256"] != digest(text)
    ]


def updated_manifest(manifest: Manifest, texts: dict[str, str], today: str) -> Manifest:
    """A copy with the fetched papers re-stamped; the others are left alone."""
    updated = {pmid: dict(entry) for pmid, entry in manifest.items()}
    for pmid, text in texts.items():
        updated[pmid] = {"sha256": digest(text), "fetched": today}
    return updated


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, default=FIXTURES_DIR)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument(
        "--pmid",
        action="append",
        default=[],
        help="fetch only this PMID (repeatable); must be listed in the manifest",
    )
    parser.add_argument(
        "--update-manifest",
        action="store_true",
        help="record the fetched hashes instead of failing on a mismatch",
    )
    args = parser.parse_args(argv)

    manifest = load_manifest(args.manifest)
    unknown = [pmid for pmid in args.pmid if pmid not in manifest]
    if unknown:
        parser.error(f"not in {args.manifest}: {', '.join(unknown)}")
    pmids = args.pmid or list(manifest)

    try:
        texts = asyncio.run(fetch_papers(pmids))
    except LookupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for path in write_fixtures(texts, args.out):
        print(f"Wrote {path}")

    moved = drifted(manifest, texts)
    if args.update_manifest:
        stamped = updated_manifest(manifest, texts, today=date.today().isoformat())
        args.manifest.write_text(json.dumps(stamped, indent=2) + "\n", encoding="utf-8")
        print(f"Updated {args.manifest}: {len(texts)} papers re-stamped")
        return 0
    if moved:
        print(
            "error: Europe PMC's text has moved for PMID "
            f"{', '.join(moved)} since the cassettes were recorded, so the "
            "golden suite would replay answers to a request the pipeline no "
            "longer sends. Fix: re-record the cassettes (see the docstring of "
            "tests/pipeline/test_extraction_golden.py), then rerun this "
            "script with --update-manifest.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
