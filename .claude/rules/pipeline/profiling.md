---
paths:
  - "pipeline/profiling.py"
  - "pipeline/main.py"
  - "pipeline/pdf_parse.py"
  - "pipeline/export/main.py"
  - "tests/pipeline/test_profiling.py"
  - "scripts/tracy.sh"
---

# Profiling with Tracy

`pipeline/profiling.py` is the only module that talks to Tracy. Every function
in it is a no-op unless the run went through `deno task tracy:run`, which layers
Tracy's `tracy_client` wheel onto the environment. The `tracy` skill
(`.claude/skills/tracy/SKILL.md`) has the build, capture and analysis workflow.

**A zone held across an `await` must have no sibling that also holds one.**
Tracy keeps one zone stack per thread, and zones must close in reverse order of
opening. Coroutines interleaving on the event loop thread break that the moment
two of them hold zones across their awaits. The Python client has no fibers and
no sections to escape it, and an out-of-order end corrupts the trace. Where each
kind of instrumentation goes:

| Code                                                                    | Use                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Sequential stages (`run_pipeline`'s steps, one mode after another)      | `profiling.zone(...)`, even across awaits             |
| Synchronous code that never awaits, on any thread                       | `profiling.zone(...)`                                 |
| A worker thread (`asyncio.to_thread`), such as `parse_pdf_bytes`        | `profiling.zone(...)` inside the function it runs     |
| Steps in a row, each awaiting in turn (`run_export`)                    | `profiling.stages()`, one call per step               |
| Anything per paper, per gene or per request inside concurrent work      | `profiling.adjust(...)` (a level) or `message(...)`   |

So a per-paper zone around `await process_paper(...)` is the mistake. Per-paper
time is carried in the one `message` written per finished paper ("PMID …: 3 genes
(pmc) in 41.2 s"), which `tracy-csvexport -m` lists. Concurrency is the
`papers in flight` plot, kept by `adjust(…, ±1)` around the semaphore's body.

`zone()` and `stages()` attribute each zone to their caller's line by building
the binding's `_ScopedZone` directly. `tracy_client.ScopedZone` would attribute
every zone to `profiling.py` instead. Names passed to `start()` and `zone()`
are generic: the no-disease-literal scanners cover this module like any other.
