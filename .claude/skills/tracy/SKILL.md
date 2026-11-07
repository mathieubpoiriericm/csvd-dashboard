---
name: tracy
description: 'Use when profiling the pipeline with Tracy, adding Tracy instrumentation to pipeline code, reading or comparing .tracy captures or tracy-csvexport output, building or updating the third_party/tracy submodule, or when Tracy misbehaves (capture "disconnected during the initial connection handshake", "incompatible protocol version", "Fatal Python error: take_gil", a wheel or tool that will not build).'
---

# Tracy

Tracy does two jobs here, both built from the `third_party/tracy` git submodule.
That submodule is **always pinned to Tracy's newest release** (never master, and
never an older tag):

1. **A client inside the Python pipeline.** `pipeline/profiling.py` records
   zones, plots and messages, but only when the run goes through
   `deno task tracy:run`; every other run, and every test, does nothing.
2. **The analysis backend of `deno task perf`.** It converts Chromium traces
   with `tracy-import-chrome` and ranks them with `tracy-csvexport -e` (the
   `perf` skill). Tracy cannot instrument Preact itself.

The client and the tools must be the same version, because the protocol and the
trace format change between releases. `reference.md` in this directory is the
condensed manual: options, the markup API, every tool's flags, the MCP server,
the GUI and the limits. The full text for the pinned version is
`third_party/tracy/manual/tracy.tex`.

## Where things are

| Path                                     | What                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `third_party/tracy`                      | the submodule; `git submodule status` names its tag                  |
| `scripts/tracy.sh` / `deno task tracy:*` | `build`, `update`, `run CMD…`                                        |
| `scripts/tracy_python_fixups.cmake`      | workarounds for the wheel's build bugs, one block each, each dated   |
| `.tracy/bin`, `.tracy/wheels`            | tools and client wheel (gitignored); `.tracy/VERSION` is the build   |
| `logs/tracy/<timestamp>.tracy` (+`.log`) | captures from `tracy:run`, beside each capture's own log             |
| `pipeline/profiling.py`                  | the only module that talks to Tracy                                  |
| `.claude/rules/pipeline/profiling.md`    | where zones may go under asyncio; read it before instrumenting       |

`TRACY_DIR` points the scripts and the perf harness at another build's
`bin/`. A worktree sets it to the main checkout's `.tracy/bin` instead of
building again.

## Profiling a run

`deno task tracy:run <cmd…>` runs the command through `uv run` with the client
wheel layered on. It attaches `tracy-capture` once the client is listening,
and prints the capture's path and the commands to read it. Do not start
`tracy-capture` by hand first: on macOS it "connects" to a port nobody is
listening on and quits (see the troubleshooting table). What each command
records:

| Command                                            | Records                                                                                  | Cost                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------- |
| `python -m pipeline.main --pubmed --test-mode`     | the `pubmed` and `discover papers` zones only; test mode stops before extraction         | free                    |
| `python -m pipeline.main --pmids FILE`             | extraction of the listed papers, with `parse PDF` zones on worker threads                | pays for those papers   |
| `python -m pipeline.main --pubmed`                 | the stage zones, the `papers in flight` and `papers done` plots, one message per paper   | a real run              |
| `python -m pipeline.export.main`                   | eleven step zones plus `publish`, but **it rewrites `data/*.json`**                      | free                    |

To profile the export without touching `data/`, run it into a scratch
directory:

```sh
deno task tracy:run python -c 'import asyncio; from pathlib import Path
from dotenv import load_dotenv; load_dotenv()
from pipeline.database import Database; from pipeline.export.main import run_export
async def go():
    try: await run_export(Path("/tmp/export-out"))
    finally: await Database.close()
asyncio.run(go())'
```

To attach late to a client that is already running, wait for its port first:
`until nc -z -G 1 127.0.0.1 8086; do sleep 0.1; done; .tracy/bin/tracy-capture -o x.tracy`.
Without `TRACY_ON_DEMAND`, the client keeps everything since start-up until a
capture connects.

## Reading a capture

```sh
.tracy/bin/tracy-csvexport -e T.tracy | sort -t, -k4,4nr   # zones by self time, slowest first
.tracy/bin/tracy-csvexport -u T.tracy                      # one row per zone: start, duration
.tracy/bin/tracy-csvexport -m T.tracy                      # messages (per-paper times)
.tracy/bin/tracy-profiler T.tracy                          # GUI: Statistics, Find zone (Ctrl+F), Compare
```

- The output is **unsorted**, in nanoseconds. Its columns are `name, src_file,
  src_line, total_ns, total_perc, counts, mean_ns, min_ns, max_ns, std_ns`.
- Without `-e` the times are inclusive, so the `pubmed` zone contains every
  stage. `-e` gives self time.
- `total_perc` is a share of the **whole capture**, which runs from the moment
  `tracy_client` loads to the moment it exits, not of the zoned work.
- `counts` 1 is one sample. Capture two or three times before acting on a close
  call.
- The times are wall-clock on the calling thread, so they include waiting on
  PostgreSQL, the network or the rate limiter.
- A stage name may contain a comma: pass `-s ';'` before splitting.
- `src_file` should name the code that opened the zone. `pipeline/profiling.py`
  there means call-site attribution broke.
- Newer tools still open older captures, through a compatibility layer that is
  eventually dropped; `tracy-update old.tracy new.tracy` upgrades one for good.
  An older tool refuses a newer capture.

## Updating Tracy, always to the newest release

1. `git -C third_party/tracy fetch --tags`, then read the new tag's `NEWS`.
   Diff `CMakeLists.txt`, `cmake/`, `python/` and `csvexport/` against the
   current tag.
2. `deno task tracy:update`. It checks out the highest `vX.Y.Z`, builds the
   tools and the wheel, and smoke-tests the wheel through
   `pipeline/profiling.py`. A build failure names its log in `.tracy/`.
3. Retire workarounds. For each block in `scripts/tracy_python_fixups.cmake`,
   comment it out, run `deno task tracy:build`, and keep the block only if its
   signature returns:

   | Block | Signature                                                                  |
   | ----- | -------------------------------------------------------------------------- |
   | 1     | `Missing variable is: CMAKE_C_COMPILE_OBJECT` in `.tracy/build-wheel.log`  |
   | 2     | `install FILES given no DESTINATION` in `.tracy/build-wheel.log`           |
   | 3     | `Fatal Python error: take_gil` in `.tracy/smoke.log`                       |

   Re-date what stays ("v0.15.0, still v0.16.0"). If the smoke test fails on
   the client API itself (`_ScopedZone`, `plot_config` …), change
   `pipeline/profiling.py` and the fake in `tests/pipeline/test_profiling.py`
   together.
4. Prove both channels:
   - profile the export into a scratch directory (above) and check that
     `src_file` points at `pipeline/export/main.py`;
   - run `deno task perf` and check that its `report.md` has numeric "Aggregate
     Tracy zones". A renamed csvexport column turns them `null`.
5. Run the gates: `uv run pytest`, `uv run ruff check .`, `uv run ty check`,
   `deno task check` and `deno task test:perf`. CI never checks out the
   submodule, so it cannot vouch for an update.
6. Refresh `reference.md` from
   `git -C third_party/tracy diff OLD NEW -- manual/tracy.tex`.
7. Commit through a PR. `git submodule status third_party/tracy` must show no
   leading `+` and the new tag once the gitlink is staged.

Any checkout that pulls the bump then runs
`git submodule update third_party/tracy && deno task tracy:build`. `build` warns
when the checkout and the recorded commit differ.

## Troubleshooting

| Symptom                                                          | Cause and fix                                                                                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| capture exits 3: "disconnected during the initial connection handshake" | Nothing was listening yet. On macOS a refused non-blocking `connect()` comes back `EISCONN`, and Tracy takes that for success. Start the client first: `tracy:run` does.                              |
| "uses incompatible protocol version"                             | The client and tools come from different releases. `deno task tracy:build`, then re-run.                                                                                                             |
| `Fatal Python error: take_gil` on import                         | The wheel links `libpython`; fixup block 3 is missing or no longer applies.                                                                                                                         |
| "no capture taken; did the command import pipeline.profiling?"  | The command never loaded `tracy_client`, so nothing listened.                                                                                                                                       |
| the last zone before exit is missing                             | macOS cuts the client off at exit; `profiling.py`'s 0.25 s `atexit` grace covers it. A script that bypasses `profiling.py` needs its own pause.                                                      |
| zones nest wrongly, or the session ends with an instrumentation failure | Zones from concurrent coroutines interleaved on one thread. Follow `.claude/rules/pipeline/profiling.md`.                                                                                            |
| `deno task perf` fails preflight                                 | No tools in `.tracy/bin` (or `TRACY_DIR`): `deno task tracy:build`.                                                                                                                                  |
