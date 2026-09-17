# Pipeline tests

These suites are covered by the pipeline notes, imported here so they load when
working under `tests/pipeline/`.

Two inputs of `test_extraction_golden.py` are gitignored because they are
publisher text: the seven full-text fixtures under `fixtures/papers/` and the
cassettes under `cassettes/test_extraction_golden/`, which embed them.
`uv run python -m scripts.fetch_paper_fixtures` writes the fixtures from Europe
PMC and checks them against the tracked `fixtures/papers/manifest.json`; the
cassettes are recorded locally per that module's docstring. Without them the
golden suite skips -- `pytest_collection_modifyitems` in `conftest.py` turns the
`paper_fixtures` and `golden_cassettes` markers into skips that name what to run
-- so CI never runs it, and a green CI says nothing about extraction recall.

@../../pipeline/CLAUDE.md
