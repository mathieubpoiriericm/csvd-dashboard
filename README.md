# cSVD Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Maintained](https://img.shields.io/badge/Maintained-yes-green.svg)](mailto:mathieu.poirier@icm-institute.org)
[![Deno](https://img.shields.io/badge/Deno-2.9-blue.svg)](https://deno.com/)
[![Fresh](https://img.shields.io/badge/Fresh-2.3-yellow.svg)](https://fresh.deno.dev/)
[![Python](https://img.shields.io/badge/Python-3.14+-yellow.svg)](https://www.python.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18.6-purple.svg)](https://www.postgresql.org/)

[![Unit tests](https://img.shields.io/badge/Unit_tests-466_passing-green.svg)](#testing)
[![Pipeline tests](https://img.shields.io/badge/Pipeline_tests-2180_passing-green.svg)](#testing)
[![End-to-end tests](https://img.shields.io/badge/End--to--end-163_passing-green.svg)](#testing)

Interactive dashboard of putative causal genes and clinical trial drugs for
cerebral small vessel disease (cSVD), developed at the Paris Brain Institute
(ICM).

---

## Table of Contents

- [Overview](#overview)
- [Technology Stack](#technology-stack)
- [Features](#features)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Development](#development)
- [Deployment](#deployment)
- [Environment Variables](#environment-variables)
- [Data](#data)
- [Pipeline](#pipeline)
- [Print Figures](#print-figures)
- [Data Sources](#data-sources)
- [Testing](#testing)
- [Notes on the Port](#notes-on-the-port)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)
- [Acknowledgments](#acknowledgments)

---

## Overview

The dashboard provides up-to-date and standardized information on:

- Putative cerebral SVD causal genes, with the omics evidence behind each one
- Drugs tested in planned or ongoing cerebral SVD clinical trials

It is a port of the original R Shiny application to Deno + Fresh. Data
preparation was ported too: a Python pipeline searches PubMed, extracts genes
with an LLM, syncs external annotations into PostgreSQL, and exports JSON. The
web application is TypeScript.

**One pipeline, one language, meeting the web app at a JSON file boundary.**

```text
PubMed / Europe PMC / CT.gov ──> pipeline/ ──> PostgreSQL ──> pipeline/export/ ──> data/*.json ──> islands
```

Nothing queries a database at request time, and nothing fetches JSON at runtime.
The modules under `lib/data/` use `import … with { type: "json" }`, so each file
is bundled into whatever imports it. **Import the narrow module, not the
barrel** — `lib/data.ts` re-exports all of them, and an island that reaches for
it pulls the whole ~350 KB dataset into its client bundle instead of the one
table it renders. In production, Vite places the generated records and their
`lib/data/` normalization layer in one `protected-data-<hash>.js` client chunk;
server middleware authenticates that chunk before static serving and marks it
`private, no-store`. Editing `data/*.json` therefore requires a rebuild or HMR
cycle to show up.

`compression()` is the outermost middleware in `main.ts`, which is what lets it
reach both the static bundles `staticFiles()` would otherwise serve verbatim and
the protected chunk `protectDataAssets()` rewrites. Every route dropped from
760–1000 KB to 204–255 KB.

---

## Technology Stack

<!-- markdownlint-disable MD013 MD033 -->
<p align="center">
<a href="https://deno.com/"><img src="https://img.shields.io/badge/-Deno-000000?logo=deno&logoColor=white" alt="Deno" /></a>
<a href="https://fresh.deno.dev/"><img src="https://img.shields.io/badge/-Fresh-FFDB1E?logo=deno&logoColor=black" alt="Fresh" /></a>
<a href="https://preactjs.com/"><img src="https://img.shields.io/badge/-Preact-673AB8?logo=preact&logoColor=white" alt="Preact" /></a>
<a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/-TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
<a href="https://vite.dev/"><img src="https://img.shields.io/badge/-Vite-646CFF?logo=vite&logoColor=white" alt="Vite" /></a>
<a href="https://tanstack.com/table"><img src="https://img.shields.io/badge/-TanStack%20Table-FF4154?logo=reactquery&logoColor=white" alt="TanStack Table" /></a>
<a href="https://leafletjs.com/"><img src="https://img.shields.io/badge/-Leaflet-199900?logo=leaflet&logoColor=white" alt="Leaflet" /></a>
<a href="https://floating-ui.com/"><img src="https://img.shields.io/badge/-Floating%20UI-333333?logoColor=white" alt="Floating UI" /></a>
<a href="https://www.python.org/"><img src="https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white" alt="Python" /></a>
<a href="https://docs.astral.sh/uv/"><img src="https://img.shields.io/badge/-uv-DE5FE9?logo=uv&logoColor=white" alt="uv" /></a>
<a href="https://www.anthropic.com/claude"><img src="https://img.shields.io/badge/-Claude-191919?logo=anthropic&logoColor=white" alt="Claude" /></a>
<a href="https://github.com/docling-project/docling"><img src="https://img.shields.io/badge/-Docling-333333?logoColor=white" alt="Docling" /></a>
<a href="https://github.com/pydantic/pydantic"><img src="https://img.shields.io/badge/-Pydantic-E92063?logo=pydantic&logoColor=white" alt="Pydantic" /></a>
<a href="https://github.com/unionai-oss/pandera"><img src="https://img.shields.io/badge/-Pandera-333333?logoColor=white" alt="Pandera" /></a>
<a href="https://github.com/pandas-dev/pandas"><img src="https://img.shields.io/badge/-pandas-150458?logo=pandas&logoColor=white" alt="pandas" /></a>
<a href="https://github.com/encode/httpx"><img src="https://img.shields.io/badge/-httpx-333333?logoColor=white" alt="httpx" /></a>
<a href="https://biopython.org/"><img src="https://img.shields.io/badge/-Biopython-333333?logoColor=white" alt="Biopython" /></a>
<a href="https://github.com/MagicStack/asyncpg"><img src="https://img.shields.io/badge/-asyncpg-333333?logoColor=white" alt="asyncpg" /></a>
<a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/-PostgreSQL-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL" /></a>
<a href="https://alembic.sqlalchemy.org/"><img src="https://img.shields.io/badge/-Alembic-333333?logoColor=white" alt="Alembic" /></a>
<a href="https://docs.docker.com/dhi/"><img src="https://img.shields.io/badge/-Docker%20Hardened-2496ED?logo=docker&logoColor=white" alt="Docker Hardened Image" /></a>
<a href="https://playwright.dev/"><img src="https://img.shields.io/badge/-Playwright-2EAD33?logo=playwright&logoColor=white" alt="Playwright" /></a>
<a href="https://github.com/pytest-dev/pytest"><img src="https://img.shields.io/badge/-pytest-0A9EDC?logo=pytest&logoColor=white" alt="pytest" /></a>
<a href="https://github.com/astral-sh/ruff"><img src="https://img.shields.io/badge/-Ruff-D7FF64?logo=ruff&logoColor=black" alt="Ruff" /></a>
<a href="https://github.com/astral-sh/ty"><img src="https://img.shields.io/badge/-ty-261230?logo=astral&logoColor=white" alt="ty" /></a>
</p>
<!-- markdownlint-enable MD013 MD033 -->

| Layer             | Technology                                                                                                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | [Deno 2.9](https://deno.com/)                                                                                                                                                                                                                                                    |
| Web framework     | [Fresh 2.3](https://fresh.deno.dev/) ([Preact 10](https://preactjs.com/) islands) + [Vite 7.3](https://vite.dev/)                                                                                                                                                                |
| Tables            | [TanStack Table 9](https://tanstack.com/table) (`@tanstack/preact-table`)                                                                                                                                                                                                        |
| Map               | [Leaflet 1.9.4](https://leafletjs.com/) + [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster)                                                                                                                                                              |
| Tooltips          | Native `[popover]` panels positioned by [Floating UI](https://floating-ui.com/)                                                                                                                                                                                                  |
| Figures (in app)  | Hand-drawn SVG from `lib/timeline.ts` and `lib/phenogram.ts`                                                                                                                                                                                                                     |
| Styling           | One stylesheet (`assets/app.css`), OKLCH tokens, no framework; Barlow Condensed over Barlow self-hosted; [Heroicons v2](https://heroicons.com/) inlined                                                                                                                          |
| Data pipeline     | [Python 3.14](https://www.python.org/) ([uv](https://docs.astral.sh/uv/)), [httpx](https://github.com/encode/httpx), [asyncpg](https://github.com/MagicStack/asyncpg), [Biopython](https://biopython.org/), [lxml](https://lxml.de/), [Rich](https://github.com/Textualize/rich) |
| Validation        | [Pydantic v2](https://github.com/pydantic/pydantic), [Pandera](https://github.com/unionai-oss/pandera), [pandas](https://pandas.pydata.org/)                                                                                                                                     |
| LLM extraction    | [Anthropic Claude Opus 5](https://platform.claude.com/docs/en/about-claude/models/overview), pinned in `pipeline/config.py`                                                                                                                                                      |
| PDF fallback      | [Docling](https://github.com/docling-project/docling) + RapidOCR on ONNX Runtime                                                                                                                                                                                                 |
| Database          | [PostgreSQL 18.6](https://www.postgresql.org/) ([Docker Hardened Image](https://docs.docker.com/dhi/)), [Alembic](https://alembic.sqlalchemy.org/) migrations                                                                                                                    |
| Print figures     | [pyCirclize](https://github.com/moshi4/pyCirclize) (timeline), [matplotlib](https://matplotlib.org/) (phenogram)                                                                                                                                                                 |
| Testing           | `deno test`, [pytest](https://github.com/pytest-dev/pytest), [Playwright](https://playwright.dev/)                                                                                                                                                                               |
| Lint & type-check | `deno fmt` / `deno lint` / `deno check`, [Ruff](https://github.com/astral-sh/ruff), [ty](https://github.com/astral-sh/ty), [basedpyright](https://github.com/DetachHead/basedpyright)                                                                                            |

Vite is pinned to 7.x because `@fresh/plugin-vite` requires `vite@^7.1.4`.

---

## Features

Six tabs, one server-rendered route each, listed in `TABS` (`lib/constants.ts`).
Interactivity lives in seven Preact islands.

### About (`/`)

- Summary value boxes: genes, drugs, trials, publications
- **Pipeline run report** (`islands/PipelineRun.tsx`) — six timed steps with
  status badges, the funnel from papers fetched to genes accepted, the external
  services the run called, and a drawer holding everything it wrote
- **Reference-data refreshes** (`components/PipelineSyncs.tsx`) — one entry per
  sync mode, read from `data/pipeline_syncs.json`; a refresh is a separate event
  from a run, so it is a separate table and a separate file
- Data-source attribution with licences, and how to cite

### Genes (`/genes`)

Table 1 — 79 curated genes under a grouped two-row header (Putative Causal
Genes, Evidence From Omics Studies, Expression Context, References).

Filters:

- Mendelian randomization performed (Yes / No)
- GWAS traits — the 16 canonical cSVD phenotypes declared in
  `disease/vocabulary.json`: WMH, PVWMH, DWMH, SVS, BG-PVS, WM-PVS, HIP-PVS,
  PSMD, MD, FA, NODDI, extreme-cSVD, lacunes, lacunar stroke, stroke, CMB
- Evidence from other omics studies (EWAS, TWAS, PWAS, Proteomics, WES/WGS,
  MENTR)

Every gene carries linked reference data in its tooltips — NCBI Gene (gene ID,
protein, aliases), UniProt (accession), OMIM (phenotype, inheritance,
gene/locus), PubMed citations, and the machine-fetched ClinVar / Orphanet / Open
Targets disease annotations.

### Phenogram (`/phenogram`)

Karyogram drawn in-app from `data/table1.json` and `data/cytobands_hg38.json`
(UCSC hg38, 24 chromosomes, 862 bands). The 21 chromosomes that carry a gene are
drawn, to scale, in two rows split after chromosome 10. Each gene sits at the
midpoint of the band its `chromosomalLocation` names, with a label block
carrying its symbol, evidence glyphs and one pill per GWAS trait. Trait identity
is text on a family tint, never colour alone.

### Clinical Trials (`/trials`)

Table 2 — 111 curated rows: 70 drugs across 89 registered trials, merged by drug
so one drug reads as one block. `--clinical-trials` writes ClinicalTrials.gov
discoveries into the same database table with every curator column NULL; the
export's curation gate keeps them out of this file until somebody has read them.

Filters:

- Genetic evidence (Yes / No)
- Trial registry (ClinicalTrials.gov, ISRCTN, ANZCTR, ChiCTR)
- Clinical trial phase (I, II, III, IV, or not stated)
- SVD population (CAA, Cognitive Impairment, Stroke, SVD)
- Sponsor type (Academic, Industry)

### Trials Radar (`/timeline`)

The trials radar: four population sectors × five phase rings × one marker per
trial, 111 of them, drawn as SVG from `lib/timeline.ts`. The 51 mechanisms of
action are grouped into 14 families and coloured one hue per family with
lightness steps inside it, because that many pairwise-distinct hues cannot clear
a colour-vision check — identity rides the drug label and the legend, and the
colour says the family first.

Record confidence is two derived channels — nothing is stored, and no curator
marks anything:

- **The evidence ring says whether anybody assessed the drug's genetics.** Solid
  found evidence, dashed looked and found none, no ring means nobody looked.
- **A hollow centre means the record is too thin to read at face value**, on 18
  of the 111 rows: an uncharacterised mechanism (15), no stated target enrolment
  or a stated zero (3), no stated completion date (1).

Neither ever claims a value is wrong. The figure emits no machine verdict.

Two panels divide the record: a pointer-only tooltip identifies a trial at a
glance (five fields, glyphs for names); a keyboard-accessible drawer is the
whole record (all eleven fields). Labels are laid out from measured text — every
one is fitted with `getBBox()`, then separated from the markers and from each
other until nothing collides; the 55 that end up further from their marker than
their own height get a leader line back to it.

### Trials Map (`/map`)

Leaflet map of the 378 geocoded facility sites across the 84 NCT-registered
trials — 173 shown by default, the rest revealed by the study-status filter — on
an OpenStreetMap raster basemap with marker clustering and spiderfication.
Coordinates come from ClinicalTrials.gov's `geoPoint` (city-level), and
co-located sites are fanned out so each stays clickable. A visually-hidden
`LocationList` is the text alternative, because Leaflet's circle markers cannot
take focus.

### Across every view

- Light / dark theme, following `prefers-color-scheme` until the toggle is used
- Tooltips as native `[popover]` panels — keyboard reachable, Escape closes and
  returns focus
- Both data tables have sticky headers and a sticky identity column, and print
  their `Active Filters:` readout above the table
- The filter sidebar (`components/FilterPanel.tsx`) collapses to a rail rather
  than unmounting, so the toggle keeps focus and the pointer, and hiding the
  controls hides no information
- Both figures sit on a white plate in either theme, so data colours never move

---

## Project Structure

<!-- markdownlint-disable MD033 -->
<details>
<summary><strong>Click to expand project structure</strong></summary>

```text
csvd-dashboard/
├── routes/                     one server-rendered page per tab
│   ├── _app.tsx                document shell, font preloads
│   ├── _middleware.ts          the login gate; fails closed
│   ├── index.tsx               About
│   ├── genes.tsx               Genes (Table 1)
│   ├── phenogram.tsx           Phenogram
│   ├── trials.tsx              Clinical Trials (Table 2)
│   ├── timeline.tsx            Trials Radar
│   ├── map.tsx                 Trials Map
│   └── login.tsx, logout.tsx   the passphrase form and its counterpart
├── server/                     middleware, outermost first
│   ├── compression.ts          gzip ahead of staticFiles(), ETag suffixed
│   ├── frame_protection.ts     framing policy
│   ├── protected_data_assets.ts  authenticates the generated-data chunk
│   └── login_post_limiter.ts   rate limit on POST /login
├── islands/                    the interactive views
│   ├── GenesView.tsx           Table 1, grouped two-row header
│   ├── TrialsView.tsx          Table 2, row-merged by drug
│   ├── TrialsMap.tsx           Leaflet map, clustered markers
│   ├── TrialsTimeline.tsx      the trials radar
│   ├── Phenogram.tsx           the karyogram
│   ├── PipelineRun.tsx         the About page's run report
│   └── ThemeToggle.tsx         the theme switch
├── components/                 presentational pieces shared by the islands
│   ├── TableShell.tsx          controls, header, body, pagination, SHELL_FEATURES
│   ├── CheckboxFilter.tsx      filter groups that can never match nothing
│   ├── Tooltip.tsx             the [popover] panel
│   ├── FilterPanel.tsx         the sidebar-and-table layout, and its rail
│   ├── DensityReadout.tsx      the "Active Filters:" line above each table
│   ├── PipelineSyncs.tsx       the About page's reference-data refreshes
│   ├── Icon.tsx                Heroicons v2 outline, plus `dna` and `molecule`
│   └── …                       Page, ValueBox, MapPopup, TipBox, …
├── lib/                        types, constants, data loading, filtering
│   ├── data/                   per-file readers and normalizers
│   ├── filters.ts              the only place row selection happens
│   ├── auth.ts                 pure; takes the session secret as an argument
│   ├── sorting.ts              the registered sortFns, `chromosome` among them
│   ├── timeline.ts             radar layout (island half)
│   ├── phenogram.ts            karyogram layout (island half)
│   ├── vocabulary.json         single source of truth for GWAS traits
│   ├── timeline_encoding.json  radar appearance contract
│   ├── phenogram_encoding.json karyogram appearance contract
│   └── pipeline_encoding.json  run-widget labels, glyphs and tints
├── data/                       generated JSON (committed)
├── assets/app.css              design tokens and all styling
├── static/                     self-hosted fonts and images
├── tests/                      *_test.ts for the web app
│   ├── pipeline/               pytest suite for pipeline/ (+ fetched fixtures)
│   └── scripts/                pytest suite for scripts/
├── e2e/                        Playwright suite (npm-managed, self-contained)
│   └── perf/                   the throttled responsiveness harness
├── docs/superpowers/           design specs and findings, including the
│                               responsiveness measurements
├── pipeline/                   Python: ingest, extraction, sync, export
│   ├── alembic/versions/       the only definition of the schema
│   ├── export/                 PostgreSQL → data/*.json
│   ├── main.py                 the CLI
│   ├── prompts.py              the frozen extraction prompt
│   └── steps.py                the one step vocabulary
├── scripts/                    Python: print figures, cytoband fetch,
│                               backfills, and the report-only reconcilers
├── deno.json                   tasks, import map, coverage floors
└── pyproject.toml              pipeline dependencies, pytest, ruff, coverage
```

</details>
<!-- markdownlint-enable MD033 -->

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/mathieubpoiriericm/csvd-dashboard.git
cd csvd-dashboard

# 2. Resolve dependencies (nodeModulesDir is "manual" — never implicit)
deno install

# 3. Choose a passphrase and a session secret (the app is gated)
cp .env.example .env
# then set DASHBOARD_PASSPHRASE and DASHBOARD_SESSION_SECRET in .env

# 4. Run the app
deno task dev    # http://localhost:5173
```

No database is needed to run the dashboard. The data is committed JSON, bundled
at build time. The dashboard sits behind a shared passphrase: every page except
`/login` redirects there until it has been entered once per browser, and with
either variable unset the app answers 503 on every page rather than opening.
Protected HTML and the generated data chunk are never stored in shared or
browser caches; login CSS, fonts, icons and bootstrap code remain public.

---

## Installation

### Prerequisites

| Tool          | Needed for                      | Version |
| ------------- | ------------------------------- | ------- |
| Deno          | the web app (always)            | 2.9+    |
| Node.js + npm | the Playwright end-to-end suite | 26+     |
| uv            | the Python pipeline and figures | 0.12+   |
| PostgreSQL    | regenerating `data/` only       | 18.6    |
| `container`   | running that PostgreSQL locally | 1.3+    |

### Web application

```bash
deno install
```

`nodeModulesDir` is `"manual"`, so dependencies are never resolved implicitly —
run this before anything type-checks.

### Python pipeline

`pipeline/` is a [uv](https://docs.astral.sh/uv/) project, entirely separate
from the Deno app. The two meet only at the committed JSON files.

```bash
uv sync --group dev              # resolves and fetches Python 3.14 if needed
uv sync --group dev --group figure   # plus the print-figure renderers
```

`docling` is a **core** dependency, not an optional extra: a fallback path CI
cannot import is a fallback path nobody has proven. It pulls torch and roughly
70 transitive ML/CV packages, so `[tool.uv.sources]` routes torch to the PyTorch
CPU index on Linux, keeping CI off the ~2.5 GB of CUDA wheels PyPI's default
torch would bring. macOS is unaffected — its arm64 wheels are already CPU/MPS
only.

Docling fetches its layout, TableFormer and RapidOCR weights from Hugging Face
on first use. Prefetch them into `~/.cache/docling/models`:

```bash
deno task models
```

### End-to-end suite

Playwright is a Node tool, so it lives in `e2e/` with its own `package.json` and
its own `node_modules`, kept away from the Deno-managed `node_modules` at the
root. Running `npm install` against a root `package.json` would prune that
symlink farm.

```bash
deno task e2e:install   # npm ci + download the Chromium build
```

### Database

Only needed to regenerate `data/`. Containers run under **Apple's macOS-native
[`container`](https://github.com/apple/container)**, not Docker. The image is
**`dhi.io/postgres:18.6`** — a
[Docker Hardened Image](https://docs.docker.com/dhi/) pulled from `dhi.io` after
`container registry login dhi.io`, not Docker Hub's `postgres:18.6`.

```bash
container image pull dhi.io/postgres:18.6
container run --detach --name csvd-pg \
  --env POSTGRES_USER=csvd_user --env POSTGRES_PASSWORD=… \
  --env POSTGRES_DB=csvd_dashboard \
  --volume csvd-pgdata:/var/lib/postgresql/18/data \
  dhi.io/postgres:18.6
cd pipeline && uv run alembic upgrade head
```

Four things about it are load-bearing:

- **Nothing is published onto the host.** `container` puts each container on its
  own address on the `default` network, so the server answers on 5432 there and
  `container list` prints the address to point `DB_HOST` at. There is no
  `container port` subcommand; `container inspect <name>` reports the address
  under `status.networks` in CIDR form.
- **`PGDATA` is `/var/lib/postgresql/18/data`**, not the official image's
  `/var/lib/postgresql/18/docker`. A volume left at the old path leaves the
  container initializing an empty database beside it, which reads as a wiped
  schema rather than as a misplaced mount. It also runs as non-root (uid 70), so
  a _bind_ mount needs `chown 70:70`; the named volume above needs nothing.
- **Alpine is not the lighter alternative.** `postgres:18.6-alpine` measured
  _worse_ on the severities that matter — 3 critical and 27 high against
  `postgres:18.6`'s 2 and 23 — because the CVEs are in openssl and the vendored
  Go stdlib, not in the base OS the Alpine variant trims. The hardened image
  reports 0 critical, 0 high and 0 medium. Those numbers came from
  `docker scout quickview <image>`; re-measure rather than assuming, with
  whatever scanner is at hand — `container` ships none.
- **It is Debian and glibc**, collating `en_US.UTF-8` through the libc provider
  as the official image does. That is what makes it a drop-in for an existing
  data directory, and it is why the tag is pinned here: a musl image would
  silently reorder every text index in an existing `PGDATA`.

Tests never touch that database. `tests/pipeline/conftest.py` clears the `DB_*`
variables outright, and a test needing real SQL brings up its own throwaway
container on its own address. That container runs
**`dhi.io/postgres:18-alpine3.23`** — the musl image, deliberately, because it
mounts no volume and initdb's a fresh cluster every session, so it has no data
directory to collate compatibly with. Both images serve PostgreSQL 18.6.

---

## Development

### Tasks

Tasks live in `deno.json`.

| Task                      | What it does                                    |
| ------------------------- | ----------------------------------------------- |
| `deno task dev`           | Vite dev server with HMR on `:5173`             |
| `deno task build`         | production build into `_fresh/`                 |
| `deno task start`         | serve the production build, loading `.env`      |
| `deno task check`         | `deno fmt --check` + `deno lint` + `deno check` |
| `deno task test`          | unit tests                                      |
| `deno task test:coverage` | unit tests plus enforced coverage floors        |
| `deno task e2e:install`   | `npm ci` + download the Chromium build          |
| `deno task test:e2e`      | build, serve, and drive the app                 |
| `deno task test:e2e:ui`   | the same suite in Playwright's UI mode          |
| `deno task perf`          | throttled responsiveness measurement            |
| `deno task data`          | regenerate everything in `data/` except the map |
| `deno task geocode`       | regenerate `data/geocoded_trials.json`          |
| `deno task cytobands`     | regenerate `data/cytobands_hg38.json` from UCSC |
| `deno task figure`        | draw both print figures into `figures/`         |
| `deno task models`        | prefetch the Docling model weights              |
| `deno task update`        | run Fresh's own updater against the checkout    |

Pipeline checks are run through uv:

```bash
uv run pytest          # tests/pipeline (testpaths in pyproject.toml)
uv run pytest tests/scripts   # explicitly — testpaths does not reach it
uv run ruff check .    # lint
uv run ty check        # type-check
```

`testpaths` collects only `tests/pipeline`, so after touching `scripts/` run
`tests/scripts` by name. CI names that path in a step of its own for the same
reason. Do not run `ruff format`.

A single end-to-end spec:

```bash
cd e2e && npx playwright test tests/genes-filters.spec.ts
```

### Responsiveness

`deno task perf` builds, brings up the gated production server and measures
every route's cold load, sixteen interactions and a layout sweep over five
viewports. It runs under **4x CPU throttling** — unthrottled on an Apple-silicon
laptop every surface measures as instant, which is the measurement failing to
discriminate rather than a result — and reports the median of three repetitions.

Two channels are recorded per scenario, so a failure in one never leaves a
surface unmeasured: in-page `PerformanceObserver` metrics (long tasks, INP,
layout shift, TTFB/FCP/LCP, transferred bytes), and a Chromium CDP trace
converted by `tracy-import-chrome` and ranked by self time. Tracy cannot
instrument Preact — the capture is an ordinary DevTools trace and Tracy is only
the analysis backend, so a missing binary degrades the run rather than failing
it. **Read INP, not blocking time, for the interaction scenarios**: the
`longtask` API only reports tasks over 50 ms. The numbers live in
[`docs/superpowers/specs/2026-09-03-responsiveness-findings.md`](docs/superpowers/specs/2026-09-03-responsiveness-findings.md).

### Continuous integration

`.github/workflows/ci.yml` runs three jobs on every push to `main` and every
pull request:

| Job      | Steps                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `check`  | `deno install`, `deno task check`, `deno task test:coverage`                                         |
| `python` | `uv sync --locked`, Ruff, ty, pytest with branch coverage, then `tests/scripts` in a step of its own |
| `e2e`    | Playwright against the production build, report uploaded                                             |

`uv sync --locked` fails the build if `uv.lock` has drifted from
`pyproject.toml` rather than silently re-resolving.

---

## Deployment

The dashboard is hosted on [Deno Deploy](https://console.deno.com) at
**<https://csvd-dashboard.mathieubpoiriericm.deno.net>**.

Pushing to `main` builds and deploys it; every other branch gets its own preview
URL. CI runs in parallel and does **not** gate the deploy — a red push still
ships, and the remedy is timeline locking in the console rather than a workflow.
Because `data/*.json` is committed and bundled at build time, regenerating data
and pushing it to `main` republishes the site.

### Build configuration

Set through the Deno Deploy console, via the native GitHub integration:

| Field             | Value                             |
| ----------------- | --------------------------------- |
| Framework preset  | `Fresh`                           |
| App directory     | **empty** (deploys from the root) |
| Install command   | `deno install`                    |
| Build command     | `deno task build`                 |
| Runtime config    | Native Fresh integration          |
| Deployment target | Free Regions                      |
| Build timeout     | 5 min (the free-tier ceiling)     |
| Build memory      | 3 GiB                             |
| Runtime memory    | 768 MiB                           |

**Enter the install and build commands explicitly.** The Fresh preset renders
both as greyed placeholders in empty fields, which look identical to values that
have been set. `deno install` is not optional — `nodeModulesDir` is `"manual"`,
so Deno will not populate `node_modules` implicitly and Vite resolves through
it. `.github/workflows/ci.yml` carries the same note for the same reason.

**App directory must be empty, not `/`.** A `/` there produces
`Module not found file:///_fresh/server.js` at the Warm up stage — the error
names the module rather than the field, which makes it the least legible
first-build failure available.

**There is no entrypoint field.** Runtime config is "Native Fresh integration"
and Deploy resolves `_fresh/server.js` itself; the build page reports which
entrypoint it used. Do not hand-configure `_fresh/compiled-entry.js` should the
field ever return: the plugin emits it alongside `server.js`, but it calls
`Deno.serve({ port: Deno.env.get("PORT") })`, passing a string where a number is
required.

A full build runs in about 30 seconds (install ~2 s, `vite build` ~22 s), so the
free tier's 5-minute cap is not a constraint. Deno's version is not pinnable —
the builder runs the same version as the runtime — which is the one upgrade risk
that cannot be controlled from this repo.

### Secrets

`DASHBOARD_PASSPHRASE` and `DASHBOARD_SESSION_SECRET` are set in the console
under `Settings → Environment Variables`, both of type **Secret**. Generate the
session secret with `openssl rand -base64 32`; the passphrase is shared out of
band and never committed. A context of `All` covers production and the preview
URLs together — scope a second `DASHBOARD_PASSPHRASE` to `Preview` to gate
branch deployments behind a different one.

Do not upload the whole `.env`: the web app reads two of its twelve variables,
and the rest are the pipeline's database password and API keys, which have no
use on Deploy.

**A missing secret is a 503 on every route, not a build failure.** The build
cannot see the runtime context, so it goes green and the gate fails closed at
request time. A wholly-503 site after a deploy means a context is missing a
variable. Rotating `DASHBOARD_SESSION_SECRET` logs everyone out at once and is
the only revocation there is; rotating the passphrase leaves existing 30-day
sessions valid.

---

## Environment Variables

**The Fresh web app reads `data/*.json` and needs only the first two.** The rest
are used by the Python pipeline. The first two are also the only two set on Deno
Deploy (see [Deployment](#deployment)); the rest have no use there. Copy
`.env.example` to `.env` and fill in real values; `.env` is never committed, and
`deno task dev` loads it itself.

| Variable                                                               | Purpose                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `DASHBOARD_PASSPHRASE`                                                 | what collaborators type on `/login`                                    |
| `DASHBOARD_SESSION_SECRET`                                             | signs the 30-day session cookie; rotate to log everyone out            |
| `DB_HOST` … `DB_PASSWORD`                                              | PostgreSQL connection (`pipeline/database.py`)                         |
| `ANTHROPIC_API_KEY`                                                    | LLM gene extraction                                                    |
| `ANTHROPIC_WORKSPACE_ID`                                               | only for an identity-linked key                                        |
| `ENTREZ_EMAIL`, `NCBI_API_KEY`                                         | NCBI E-utilities (email required by policy)                            |
| `UNPAYWALL_EMAIL`                                                      | open-access PDF lookup                                                 |
| `PIPELINE_LLM_EFFORT`                                                  | cost lever; defaults to `high`                                         |
| `PIPELINE_CONFIDENCE_*`                                                | the two confidence floors (update / insert)                            |
| `PIPELINE_REQUIRE_VERIFIED_QUOTES`                                     | reject a gene whose quote is not verbatim in the paper; off by default |
| `PIPELINE_MAX_PAPER_TEXT_CHARS`                                        | truncation cap on retrieved full text                                  |
| `PIPELINE_PDF_*`                                                       | Docling device, threads, OCR, page and time caps                       |
| `PIPELINE_CLINVAR_*`, `PIPELINE_ORPHADATA_*`, `PIPELINE_OPENTARGETS_*` | annotation-source rate limits and caps                                 |
| `PIPELINE_LOG_DIR`                                                     | where run logs go; defaults to `<root>/logs`                           |

**The extraction model is not an environment variable.** It is pinned in
`pipeline/config.py` as `EXTRACTION_MODEL`, because extraction output is
compared across runs, against recorded cassettes and against a gold standard — a
per-machine override would make two runs of the same code incomparable with
nothing saying so. Every knob and its measured rationale is documented inline in
`.env.example`.

---

## Data

The app reads static JSON from `data/`, imported at build time.

The source files are not served directly. The browser build groups generated
JSON and `lib/data/` into a single authenticated, non-cacheable client chunk;
the build fails if one of those modules lands in a public chunk. Other assets
stay public so the signed-out login page can render normally.

| File                    | Rows         | Source                              |
| ----------------------- | ------------ | ----------------------------------- |
| `table1.json`           | 79           | `genes` table (+ three join tables) |
| `table2.json`           | 111          | `clinical_trials` table (curated)   |
| `gene_info.json`        | 79           | `ncbi_gene_info` cache              |
| `gene_info_table2.json` | 26           | `ncbi_gene_info` cache              |
| `protein_info.json`     | 79           | `uniprot_info` cache                |
| `refs.json`             | 111          | `pubmed_citations` cache            |
| `omim_info.json`        | 49           | `disease/omim_info.csv`             |
| `gene_annotations.json` | 171          | `gene_annotations` table (pivoted)  |
| `pipeline_status.json`  | 1 or `null`  | `pipeline_runs` table               |
| `pipeline_run.json`     | 1 or `null`  | `pipeline_runs.run_report`          |
| `pipeline_syncs.json`   | one per mode | `sync_runs` table                   |
| `geocoded_trials.json`  | 378 sites    | ClinicalTrials.gov                  |
| `cytobands_hg38.json`   | 862 bands    | UCSC Genome Browser                 |

Four of these behave differently from the rest:

- **`gene_annotations.json` is the one machine-fetched file**, and the only one
  whose rows are a pivot rather than a table dump — one row per
  `(gene, disease)` rather than one per cross-reference, because the raw table
  is ~4700 rows and this file is bundled like every other. Only ClinVar's
  attested diseases and Orphanet's enrichment of them are published; Open
  Targets' ranked associations and GO terms stay in PostgreSQL. It is also the
  one file **skipped rather than emptied** when its table has no rows.
- **`pipeline_run.json` and `pipeline_status.json` are both committed as `null`
  until a run records them.** Exactly one of the two renders on the About page;
  the four-number card is the fallback for the null report.
- **`pipeline_syncs.json` is committed as `[]`** until a reference-data refresh
  is recorded, one entry per sync mode. It is a separate file because a refresh
  is a separate event from a run — and a separate table, so no query feeding the
  run widget or the About page's date badge can see one. It is what publishes
  the upstreams only the syncs touch: ClinVar, Orphadata, Open Targets, UniProt
  and ClinicalTrials.gov.
- **`cytobands_hg38.json` is not the export's output** but
  `scripts/fetch_cytobands.py`'s, and `deno fmt --check .` is what gates its
  formatting rather than the byte-exact writer test.

**`table2.json` publishes only curated trial rows.** `--clinical-trials` writes
ClinicalTrials.gov discoveries into the same table with every curator column
NULL; `_read_curated_trials` skips any row with no `target_population` and logs
the count, so a discovery no one has read cannot reach the dashboard as
`(unknown)` mechanism, population and evidence — values no filter choice offers
and the radar draws nowhere.

### Regenerating

Requires PostgreSQL reachable and `.env` populated.

```bash
deno task data      # pipeline/export/main.py    → everything except the map
deno task geocode   # pipeline/export/geocode.py → data/geocoded_trials.json
deno task cytobands # scripts/fetch_cytobands.py → data/cytobands_hg38.json
```

`filter.ids` fetches every trial's locations in one request, so
`deno task geocode` needs no cache and no rate limit. Facility coordinates come
from ClinicalTrials.gov's `geoPoint`, computed as
`GeoPoint(City, State,
Country)` — city-level, not facility-level.
`jitter_duplicate_coordinates()` fans out co-located sites. No geocoding service
is involved.

### The JSON contract

`pipeline/export/writer.py`'s `to_camel()` derives JSON keys from display column
names (`"Registry ID"` → `registryId`). Three layers stay in sync:

| Concern               | Lives in                                 |
| --------------------- | ---------------------------------------- |
| Wire keys             | `pipeline/export/writer.py` (`to_camel`) |
| TypeScript shapes     | `lib/types.ts`                           |
| Human-readable labels | `islands/*View.tsx` column definitions   |

Two invariants the TypeScript side depends on:

1. **List-columns are always arrays.** Four `Gene` fields and two
   `GeneAnnotation` fields are always arrays.
2. **Sentinel strings are load-bearing.** Absent values become `"(none found)"`,
   `"(unknown)"`, `"(none)"` and are matched literally by the filter choices in
   `lib/constants.ts`, so those `value`s must stay byte-identical to what
   `pipeline/export/tables.py` emits.

**JSON output is byte-exact, and every exported file is gated on it.**
`tests/pipeline/export/test_writer.py` parses each `data/*.json`, re-encodes it
through the writer and compares the bytes; a companion test fails if a file
appears in `data/` with no case. This is what catches a formatting divergence
before it turns the first regeneration into an unreviewable whole-file diff.
Every export query therefore needs an `ORDER BY` — without one PostgreSQL
returns rows in whatever physical order it likes.

---

## Pipeline

`pipeline/` populates PostgreSQL and exports it to `data/*.json`.

```text
PubMed search (SVD_QUERY)
      │
      ▼
Retrieve full text     Europe PMC JATS XML, Docling PDF fallback (~15%)
      │
      ▼
Extract genes          Claude Opus 5, structured output
      │
      ▼
Validate               NCBI Gene lookup, then the two confidence floors
      │
      ▼
Merge  ────────────>   PostgreSQL   <────  ClinVar / Orphadata / Open Targets
                            │              NCBI Gene / UniProt / citations
                            │              ClinicalTrials.gov
                            ▼
                       pipeline/export/  ──>  data/*.json  ──>  Fresh islands
```

### Running it

```bash
uv run python -m pipeline.main [flags]
```

| Flag                   | Effect                                                         |
| ---------------------- | -------------------------------------------------------------- |
| `--pubmed`             | PubMed gene extraction (also the default with no selector)     |
| `--days-back N`        | lookback window for new papers (default 7)                     |
| `--batch`              | submit every paper in one Batch API request at half price      |
| `--clinical-trials`    | the ClinicalTrials.gov discovery pipeline                      |
| `--sync-external-data` | NCBI Gene, UniProt and PubMed citations for every gene         |
| `--sync-annotations`   | ClinVar, Orphadata and Open Targets annotations                |
| `--export`             | regenerate `data/*.json` when the selected pipelines finish    |
| `--local-pdfs PATH`    | extract from a local PDF or directory (no PubMed, no database) |
| `--pmids FILE`         | process specific PMIDs from a text file (no database)          |
| `--skip-validation`    | skip NCBI validation (only with `--local-pdfs` or `--pmids`)   |
| `--dry-run`            | run without writing to the database                            |
| `--test-mode`          | run search and retrieval only, no LLM and no merge             |

`--batch` results usually arrive within an hour. Use it for a full corpus run;
the default streaming path stays better for single papers and `--local-pdfs`.

A long `--days-back` run is **resumable**: every paper is checkpointed to
`logs/pipeline_checkpoint.jsonl` as it finishes, so a crash costs the papers in
flight and nothing else. `--batch` is the exception — every paper is in flight
until the batch's results arrive, and the batch id is held only in the run log,
so a crash inside the poll loses the whole submission and re-running pays again.
`uv run python -m scripts.backfill_pubmed` walks the window in committed chunks
instead, for when the database should be updated as it goes.

`--export` does `deno task data`'s work at the end of a live run, so the
figures, the About page's date and the run widget track the database without a
second command. It **stops at the working tree** — nothing is committed, because
the curated `genes` table is a scientific judgement and the e2e fixtures pin
exact row counts. It is refused with `--local-pdfs` / `--pmids`, skipped after
`--dry-run` or `--test-mode`, and runs even when a pipeline **failed**, because
not exporting is what would keep that recorded failure invisible.

A run is recorded as six timed steps — Search PubMed, Filter new papers,
Retrieve & extract, Validate, Merge to database, Finalize — declared once in
`pipeline/steps.py` and read by the About page's widget through
`lib/pipeline_encoding.json`.

### Retrieval

`SVD_QUERY` in `pipeline/pubmed_search.py` is a hand-maintained constant, and
its recall is measured rather than assumed.
`tests/pipeline/test_query_recall.py` intersects it with a `[uid]` disjunction
over the 111 PMIDs the dashboard cites, so recall is exact rather than sampled
and never meets PubMed's 9,999-record `esearch` cap — it bounds a result set
that can never exceed the gold set.

It retrieves **106 of 111**. The third branch, `MESH_TERMS AND GENETIC_TERMS`,
reaches papers that never write the disease name out in the title or abstract
and recovers 32 of the 111 on its own; its genetics gate is what keeps
`"White Matter"[MeSH]` from quadrupling ingestion. The two Title/Abstract
branches both `AND` on `"cerebral small vessel disease"[Title/Abstract]`, which
is therefore the ceiling on them: the ten `GENETIC_TERMS` and seven
`MARKER_TERMS` are precision filters and **contribute no recall at all**, and a
test pins that so widening either list in the belief that it helps fails loudly.

The five misses are the same five at gold sets of 29, 32 and 111 papers, which
is the strongest evidence the suite has produced that they are properties of
those papers rather than of the query. They are pinned with a reason each in
`_MISSED`.

### PDF fallback

`docling` extracts structured tables from the PDF path — the ~15% of papers
Europe PMC's JATS XML doesn't cover. OCR runs through RapidOCR on ONNX Runtime,
and is a fallback rather than a mode: Docling's default `OcrMode` drops every
layout cluster that already holds programmatic text. Measured over six corpus
papers on an M1 Pro, OCR takes the PDF path from 59.7 s to 106.9 s for
**byte-identical** output — while the same paper rasterised recovers 97.5% of
text that would otherwise be lost entirely. The cost is real, the risk is not.
`PIPELINE_PDF_OCR=false` disables it; the other `PIPELINE_PDF_*` knobs and their
measurements are documented in `.env.example`.

### Annotations

`--sync-annotations` fetches disease, ontology and identity annotations for the
79 curated genes from ClinVar, Orphadata and Open Targets, and verifies Table
2's curator-entered mechanisms against Open Targets' ChEMBL records.

**The curated `genes` table is never written by any of it**, and there is no
foreign key to it either, so an annotation run cannot lock or cascade into it.
The acceptance criterion is that `max(updated_at)` on `genes` is unchanged
across a full run.

### Schema

Alembic is the only definition of the schema — there is no ORM model file and no
checked-in DDL beside it.

```bash
uv run alembic -c pipeline/alembic.ini upgrade head
```

Twelve migrations define `genes`, its three join tables (`gene_references`,
`gene_gwas_traits`, `gene_monogenic_links`), `clinical_trials`,
`ncbi_gene_info`, `uniprot_info`, `pubmed_citations`, `pubmed_refs`,
`gene_annotations`, `gene_annotation_status`, `trial_drug_annotations`,
`pipeline_runs` and `sync_runs`.

The three gene list columns moved out of delimited TEXT into join tables in
migration 005 because `references` had already been destroyed once by a
spreadsheet round-trip that read the whole PMID list as one number. One value
per row makes that impossible rather than merely detectable.

---

## Print Figures

Both figures are drawn twice from the same committed JSON and the same encoding
files — once for the browser, once for print — and the layout rule is pinned on
both sides so a change has to be made twice or fails.

```bash
uv sync --group figure
deno task figure   # figures/{timeline,phenogram}.{svg,pdf,png}

# or with a specific font and resolution
uv run --group figure scripts/timeline_figure.py --font /path/to/Arial.ttf --dpi 600
```

| Figure    | Island                       | Print script                  | Library    |
| --------- | ---------------------------- | ----------------------------- | ---------- |
| Timeline  | `islands/TrialsTimeline.tsx` | `scripts/timeline_figure.py`  | pyCirclize |
| Phenogram | `islands/Phenogram.tsx`      | `scripts/phenogram_figure.py` | matplotlib |

Outputs are regenerated, not committed. The SVG keeps text as text
(`svg.fonttype = none`), so it stays editable; the PDF embeds the font.

---

## Data Sources

| Source                                                                          | Provides                                                           | Licence             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------- |
| [PubMed / NCBI E-utilities](https://www.ncbi.nlm.nih.gov/pmc/tools/developers/) | Paper search and citation metadata                                 | NCBI, public domain |
| [Europe PMC](https://europepmc.org/)                                            | Full-text JATS XML                                                 | per-article         |
| [Unpaywall](https://unpaywall.org/)                                             | Open-access PDF locations for the fallback path                    | CC0                 |
| [NCBI Gene](https://www.ncbi.nlm.nih.gov/gene)                                  | Gene identity, aliases, validation                                 | NCBI, public domain |
| [UniProt](https://www.uniprot.org/)                                             | Protein data and accessions                                        | CC BY 4.0           |
| [OMIM](https://www.omim.org/)                                                   | Phenotype, inheritance, gene/locus (curated CSV)                   | OMIM terms          |
| [ClinVar](https://www.ncbi.nlm.nih.gov/clinvar/)                                | Monogenic disease associations and clinical significance           | NCBI, public domain |
| [Orphanet / Orphadata](https://www.orphadata.com/)                              | Disease cross-references with mapping relation, HPO frequencies    | CC BY 4.0           |
| [Open Targets Platform](https://platform.opentargets.org/)                      | Identity anchors, ranked associations, GO terms, ChEMBL mechanisms | CC0 1.0             |
| [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api)            | Trial metadata and facility `geoPoint` coordinates                 | NLM terms           |
| [UCSC Genome Browser](https://genome.ucsc.edu/)                                 | hg38 cytoband ideogram                                             | UCSC terms          |

Trial registries carried in Table 2: ClinicalTrials.gov, ISRCTN, ANZCTR, ChiCTR.
Only ClinicalTrials.gov trials appear on the map — the others have no comparable
location API.

Attribution here is a licence obligation, not a courtesy: Orphadata is CC BY 4.0
and asserts that in every payload, and the pipeline logs an error if the
asserted licence ever changes.

---

## Testing

| Suite                | Tests | Runner      | Scope                                                                     |
| -------------------- | ----- | ----------- | ------------------------------------------------------------------------- |
| `tests/*_test.ts(x)` | 466   | `deno test` | Web app: filters, data contract, layout maths, SSR routes                 |
| `tests/pipeline/`    | 2180  | pytest      | The Python pipeline and its export                                        |
| `tests/scripts/`     | 55    | pytest      | The print figures, cytoband fetch, backfills, reconcilers                 |
| `e2e/tests/`         | 163   | Playwright  | 15 specs plus the sign-in setup, against the production build in Chromium |

The golden extraction suite (`tests/pipeline/test_extraction_golden.py`) is the
one part of `tests/pipeline/` that CI never runs. Its inputs are publisher text
and are not committed: `deno task fixtures` fetches the seven full-text paper
fixtures from Europe PMC, and the VCR cassettes that replay the model's answers
are recorded locally with an `ANTHROPIC_API_KEY` (the recipe is in the module's
docstring). Without them its 34 tests skip with a reason naming the command, so
a green CI says nothing about extraction recall.

```bash
deno task test              # web app
deno task test:coverage     # plus the enforced floors
uv run pytest               # tests/pipeline (pyproject testpaths)
uv run pytest tests/scripts # explicitly — testpaths does not reach it
deno task test:e2e          # builds, serves and drives the app
```

`deno task test:e2e` builds and serves the app itself — no `deno task dev`
needed, and no database, since the data is bundled at build time. It also logs
in itself: the server is started with the suite's own passphrase, a `setup`
project signs in once, and every other spec starts from the saved session.

### Coverage

`deno task test:coverage` enforces **100% line, branch and function coverage for
the shared `lib/` logic**, and gates the complete server-rendered unit graph at
85% lines, 95% branches, 90% functions. Browser-only effects — Leaflet, popover
positioning, font measurement, focus management, hydrated event handlers — are
covered by the Playwright suite rather than simulated under Deno.

The pipeline gate is **99.5% line and branch coverage** (`fail_under` in
`pyproject.toml`), measured over both `pipeline/` and Alembic's non-package
migration scripts.

Several suites are deliberately pinned to the _real committed rows_ —
`tests/filters_test.ts` asserts exact row counts, `e2e/` asserts 79 genes, 111
trial rows, 21 chromosomes and 378 map sites. Regenerating `data/` can
legitimately turn them red; check whether the data changed before "fixing" the
filter. The trial populations alone are pinned in five more places that all move
together: the two timeline layout suites, the trials-filter and timeline e2e
specs, and the "CADASIL" search counts.

### What the test suite does not cover

Two gaps worth knowing before you trust a green run.

- **Extraction quality is measured, but not by raw F1.**
  `tests/pipeline/test_extraction_golden.py` replays locally recorded cassettes
  (see [Testing](#testing); CI skips it) and asserts recall over the gold genes
  each paper's _retrieved text actually names_:

  | Subset                      | Recall          |
  | --------------------------- | --------------- |
  | genes named in the prompt   | 19/20 = **95%** |
  | genes the prompt never says | 23/26 = **88%** |
  | pooled                      | 42/46 = **91%** |

  **Quote the 88%** — the clean subset is the one that measures extraction
  rather than recall of the prompt. 13 of the 36 gold genes are named verbatim
  in the rendered v7 prompt — the `<example>` blocks that name them live in the
  disease half, `disease/prompt.md`, not the template in `pipeline/prompts.py` —
  six of them with their expected trait and confidence, and
  `test_the_prompt_names_part_of_its_own_answer_key` pins that count so a prompt
  edit naming another gold gene fails instead of quietly inflating the figure.

  These figures are from the 2026-09-11 re-record, against fixtures refetched
  through the current Europe PMC parser. The recording before it measured two
  points lower (81% clean, 87% pooled) and the one before that the same as now:
  one paper gains or loses two genes the prompt never names from one recording
  to the next, with the model, prompt version and effort unchanged — the
  nondeterminism the suite is built around rather than a regression to chase.

  Raw set-F1 measures about 0.40, for reasons that are mostly not extraction:
  23% of gold gene-paper pairs name a gene that is not in the retrieved text at
  all, and the gold standard is a curated table whose rows are the genes the
  curators judged causal, not every gene a paper implicates. Still unmeasured:
  the Docling PDF path (no gold PMID takes it), negative cases (no gold row
  reports zero genes), and anything downstream of `extract_from_paper`, which
  runs before the confidence gate and NCBI validation.

- **Retrieval precision is not measured.** Recall is exact (106/111), but the
  argument for the MeSH branch is a volume argument — 43% more papers for six
  more gold ones — not a relevance one. Nothing here says what fraction of those
  ~263 extra papers a year is signal, and settling it needs relevance judgments
  over a sample.

---

## Notes on the Port

Behaviour matches the Shiny app except where it was demonstrably wrong.

- **Filter matching normalizes case and surrounding whitespace on both sides.**
  The R version compared raw strings, so the "Proteomics" choice never matched
  (the data says "proteomics"), and traits stored with a trailing space —
  `"PSMD "`, `"WMH "` — were missed by their own filter. Both failed closed,
  hiding rows.
- **The OMIM CSV is UTF-8, like every other file here.** It was Mac Roman until
  the seven stray `0xCA` bytes it carried — U+00A0 non-breaking spaces pasted in
  from omim.org — were folded into ordinary spaces at the source, leaving it
  pure ASCII. `read_omim_csv` decodes UTF-8, so a Mac Roman re-paste now raises
  instead of being admitted silently; it still folds a correctly-encoded U+00A0,
  because web copy-paste is where this data comes from.
- **Nothing is embedded in an iframe any more.** Both figures are drawn in-app
  from the committed JSON. The last iframe, the phenogram, was a PhenoGram
  raster with pixel-colour hit-testing that had drifted from the data — ABO
  labelled APOE, C6orf195 and COL4A1/2 missing.
- **The trait vocabulary has one home.** `disease/vocabulary.json` defines all
  16 traits — label, family, long name, STRIVE-2 definition, ontology xref (or
  an explicit `null` with the reason), synonyms and the 9 deliberately untracked
  prompt terms. Restating it is what let `PVWMH` — the second most extracted
  trait — have no filter choice and no phenogram entry.
- **The extraction prompt is reconciled, not generated.**
  `pipeline/prompts.py`'s canonical-abbreviation sentence stays a frozen
  literal, because it is recorded in cassettes and treated as part of the
  method; `tests/pipeline/test_prompt_vocabulary.py` fails in both directions
  instead.
- **Tooltips are native `[popover]` panels.** This replaced Tippy 6.3.7, whose
  repo is archived and whose Popper v2 engine is frozen.

---

## Contributing

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Guidelines

- Run `deno task check` and `deno task test` before pushing; the pipeline half
  is `uv run ruff check .`, `uv run ty check` and `uv run pytest`
- Add tests for new functionality — and when a change touches an encoding file,
  add the entry rather than widening the test
- Keep commits focused and atomic

### Reporting issues

Found a bug or have a suggestion? Please
[open an issue](https://github.com/mathieubpoiriericm/csvd-dashboard/issues)
with:

- A clear description of the problem or enhancement
- Steps to reproduce (for bugs)
- Expected vs actual behaviour

---

## License

MIT — see [LICENSE](LICENSE). That licence covers the software. The committed
`data/*.json` is derived from the sources in the [Data Sources](#data-sources)
table and carries their terms, not MIT's — OMIM's in particular, whose data is
not freely redistributable.

---

## Contact

**Maintenance**: <mathieu.poirier@icm-institute.org>

---

## Acknowledgments

Developed at the Paris Brain Institute (ICM).
