# Repository Guidelines

## Project Structure & Module Organization

Deno 2/Fresh 2/Preact powers the dashboard; Python 3.14 powers its pipeline.
Page routes live in `routes/`, browser state in `islands/`, reusable UI in
`components/`, and shared types, filtering, layouts, and data access in `lib/`.
`assets/app.css` holds global CSS; `static/` holds served assets.

`pipeline/` ingests records into PostgreSQL, owns Alembic migrations, and
exports the committed `data/*.json` inputs. `scripts/` contains generators.
`disease/` is the disease seam — the manifests, prompt and reference files that
name the disease this deployment serves; see the root `CLAUDE.md`, "The disease
seam". Tests live in `tests/` (Deno and pytest) and `e2e/` (Playwright). Treat
`_fresh/`, `figures/`, and `logs/` as generated output.

## Build, Test, and Development Commands

- `deno install` resolves dependencies; `deno task dev` serves port 5173.
- `deno task check` runs formatting, linting, and TypeScript checks;
  `deno task test` runs Deno unit tests.
- `deno task build && deno task start` builds and serves production.
- `deno task e2e:install` installs Playwright once; `deno task test:e2e` builds
  and tests the app in Chromium.
- `uv sync --locked --group dev --group figure` installs Python tooling. Check
  pipeline changes with `uv run ruff check .`, `uv run ty check`, and
  `uv run pytest`; use `uv run pytest tests/scripts` for generator changes.
- `deno task data` and `deno task geocode` regenerate committed data, require
  services, and should produce reviewed diffs.
- Containers run under Apple's macOS-native `container`, not Docker. Local
  PostgreSQL runs on `dhi.io/postgres:18.6`, a Docker Hardened Image
  (`container registry login dhi.io` first). Mount data at
  `/var/lib/postgresql/18/data`, not the official image's
  `/var/lib/postgresql/18/docker`, and migrate with
  `cd pipeline && uv run alembic upgrade head`.

## Coding Style & Naming Conventions

Follow `deno fmt`: two-space indentation, double quotes, and trailing commas.
Use `PascalCase` for Preact components, `camelCase` for functions,
`UPPER_SNAKE_CASE` for constants, and lowercase route files. Keep browser state
in islands and type shared boundaries. Python uses snake_case, Ruff's 88-column
limit, and `ty`. Add schema changes as Alembic revisions.

## Testing Guidelines

Name Deno tests `*_test.ts`, pytest files `test_*.py`, and browser tests
`*.spec.ts`. Prefer behavior-focused names and user-visible assertions.
Unit-test pure logic and data contracts; use E2E tests for browser interactions
and accessibility. Coverage floors are enforced and CI fails under them: 85 %
lines, 95 % branches and 90 % functions in `deno.json`, 100 % under `lib/` in
`deno task test:coverage`, and 99.5 % line-and-branch for `pipeline` through
`fail_under` in `pyproject.toml`. Live tests need credentials. Docling is a core
dependency, so its converter tests run everywhere, CI included.

## Commit & Pull Request Guidelines

Use concise, capitalized imperative subjects, such as
`Add a Batch API extraction path`. Keep commits focused. Pull requests should
explain behavior, list checks run, link issues, and include screenshots for UI
work. Call out migrations, configuration changes, regenerated JSON, and
follow-ups.

## Security & Configuration

Copy `.env.example` to `.env`; never commit credentials, PDFs, or run logs. The
web app consumes bundled JSON and must not query PostgreSQL at runtime. Review
generated data for sensitive content before committing it. Prefer the hardened
`dhi.io/postgres:18.6` over Docker Hub's `postgres:18.6`, which carries fixable
critical and high CVEs and runs as root; Alpine is not a substitute for that
mounted server, having measured worse on both counts and collating text through
musl. The throwaway pytest container is the exception and runs
`dhi.io/postgres:18-alpine3.23`: it mounts no volume, so neither concern reaches
it.
