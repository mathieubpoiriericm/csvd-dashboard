# Tracy reference (v0.15.0)

A condensed manual for the release `third_party/tracy` is pinned to. The
authoritative text for whatever is checked out is
`third_party/tracy/manual/tracy.tex` (grep it; section numbers below are the
manual's). `.tracy/VERSION` names the build in `.tracy/`.

## Model

- The profiled program is the **client**; the profiler or capture tool is the
  **server**, and the server connects to the client. Data travels over TCP
  **8086**; presence broadcasts use UDP 8086 (§2.1.7, §2.1.13).
- **Client and server must be the same version**: the protocol and the trace
  format change between releases (§2.3). `tracy-capture` reports "uses
  incompatible protocol version" when they differ.
- Without `TRACY_ON_DEMAND` the client records from program start and **buffers
  every event in memory until a server connects** (the memory is never released,
  only reused). Only one server ever gets that data (§2.1.6).
- With `TRACY_ON_DEMAND`, data flows only while connected, each connection is a
  separate capture, and a zone counts only if both its ends fall inside it. It
  costs a little per event.
- Captures live in RAM until saved. Instrument moderately and keep captures short
  (§4.7).

## Build options (CMake `-D…=ON`, or the same-named macros) — §2.1.3, table 2

A Tracy define is tested for **presence**, never value: `TRACY_ENABLE=0` still
enables. Define them for the whole project, not in some files. Mismatched sets
between libraries trigger a `GetProfiler_CFG_…` link error; decode its suffix
with `public/client/TracyMangle.hpp` (§2.1.9).

| Group       | Options                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic       | `TRACY_ENABLE` (default **OFF**), `TRACY_ON_DEMAND`, `TRACY_NO_EXIT`, `TRACY_STATIC`, `TRACY_LTO`                                                    |
| Network     | `TRACY_NO_BROADCAST`, `TRACY_ONLY_LOCALHOST`, `TRACY_ONLY_IPV4`, `TRACY_PORT` / `TRACY_DATA_PORT` / `TRACY_BROADCAST_PORT`, `TRACY_CLIENT_ADDRESS`    |
| Collection  | `TRACY_NO_SYSTEM_TRACING`, `TRACY_NO_CONTEXT_SWITCH`, `TRACY_NO_SAMPLING`, `TRACY_NO_WAIT_STACKS`, `TRACY_NO_VSYNC_CAPTURE`, `TRACY_NO_CODE_TRANSFER` |
|             | `TRACY_NO_FRAME_IMAGE`, `TRACY_NO_CRASH_HANDLER`, `TRACY_NO_VERIFY`, `TRACY_FIBERS`, `TRACY_IGNORE_MEMORY_FAULTS`                                    |
| Call stacks | `TRACY_CALLSTACK=<depth>`, `TRACY_NO_CALLSTACK`, `TRACY_NO_CALLSTACK_INLINES`, `TRACY_LIBUNWIND_BACKTRACE`, `TRACY_DEBUGINFOD`                       |
|             | `TRACY_SYMBOL_OFFLINE_RESOLVE`, `TRACY_DEMANGLE`                                                                                                     |
| Timers      | `TRACY_TIMER_FALLBACK`, `TRACY_DISALLOW_HW_TIMER` (needs the fallback; for VMs)                                                                      |
| Special     | `TRACY_MANUAL_LIFETIME` (`StartupProfiler`/`ShutdownProfiler`), `TRACY_PLATFORM_HEADER`, `TRACY_PATCHABLE_NOPSLEDS`                                  |
| Diagnostics | `TRACY_VERBOSE` (stderr), `TRACY_NO_INTERNAL_MESSAGE`, `TRACY_ASSERT(cond)`                                                                          |

Also: `TRACY_SAMPLING_HZ`, `TRACY_SAMPLING_PROFILER_MANUAL_START`,
`TRACY_CRASH_SIGNAL` (Linux, default `SIGPWR`), `TRACY_ALLOW_SHADOW_WARNING`,
`TRACY_NO_SAMPLE_RETIREMENT` / `_BRANCH` / `_CACHE`, `TRACY_IMPORTS` (Windows
DLLs).

**Runtime environment variables:** `TRACY_NO_EXIT=1` (wait for a server before
exiting; not on macOS), `TRACY_PORT`, `TRACY_ONLY_LOCALHOST=1`,
`TRACY_ONLY_IPV4=1`, `TRACY_NO_SYSTEM_TRACING=1`,
`TRACY_SYMBOL_OFFLINE_RESOLVE=1`, `TRACY_DPI_SCALE` (GUI),
`TRACY_NO_DBGHELP_INIT_LOAD=1` (Windows), `TRACY_ROCPROF_COUNTERS`.

Profile **release** builds with `-march=native` and debug symbols
(`-g -fno-omit-frame-pointer -rdynamic`; `dsymutil` on macOS). On Unix, link
`pthread` and `dl` (§2.1, §3.12.1).

## Markup (C++, `public/tracy/Tracy.hpp`) — §3

- **Strings** (§3.1): a pointer-only macro needs a literal that lives for the
  whole program. A `(text, size)` macro copies, at a small cost. 64 KB maximum
  per string. Frame, plot and pool names need **unique pointers**: declare
  `const char* const sl_X = "X";` once and reuse the variable.
- **Colours** (§3.2): `0xRRGGBB`; `0` means "unset", so black is `0x000001`.
- **Frames** (§3.3): `FrameMark` after each frame, `FrameMarkNamed(name)` for a
  second set, `FrameMarkStart/End(name)` for discontinuous frames (never mix the
  kinds in one set), `FrameImage(rgba, w, h, offset, flip)` (sides divisible by
  4; ≤256 KB compressed, e.g. 320×180).
- **Zones** (§3.4): `ZoneScoped`, `ZoneScopedN(name)`, `ZoneScopedC(color)`,
  `ZoneScopedNC`. Then `ZoneText(t, n)`, `ZoneTextF`, `ZoneName`, `ZoneNameF`
  (per-call names are not used for grouping), `ZoneValue(u64)`,
  `ZoneColor(u32)`, `ZoneIsActive`. Two zones in one scope need
  `ZoneNamed[N][C](var, …, active)` and the `…V(var, …)` setters. `active` may
  be a runtime flag; a compile-time constant generates no branch.
  `ZoneTransient[N]` copies the source location for unloadable code.
- **The zone stack** (§3.4.2): only the innermost zone may be modified, and
  zones end in reverse order. Exiting the program inside a zone hangs it (§3.4.6).
- **Sections** (§3.5): `id = TracySectionEnter(fmt, …)` /
  `TracySectionLeave(id)`; they may overlap freely. Categories come from
  `TracySectionEnterCategory(cat, fmt, …)` and are named with
  `TracySectionSetup`.
- **Locks** (§3.6): `TracyLockable(std::mutex, m)`, `TracyLockableN`,
  `LockableBase(type)` for `lock_guard`, `LockMark(m)`, `TracySharedLockable`.
  Use `std::condition_variable_any`. Deadlocks among instrumented locks are
  detected (§5.19).
- **Plots** (§3.7): `TracyPlot(name, value)`,
  `TracyPlotConfig(name, Number|Memory|Percentage, step, fill, color)`.
- **Messages** (§3.8): `TracyMessage(t, n)`, `TracyMessageL(lit)`, the `C`
  variants with colour, `TracyLogString(severity, color, depth, n, t)` for Trace,
  Debug, Info, Warning, Error and Fatal. `TracyAppInfo(t, n)` fills the trace's
  info window.
- **Memory** (§3.9): `TracyAlloc(p, n)` / `TracyFree(p)` in `new`/`delete`
  under a mutex. Every free needs a matching alloc, or the session ends.
  `TracyAllocN` / `TracyFreeN` for named pools, `TracyMemoryDiscard(name)` for
  arena resets.
- **GPU** (§3.10): OpenGL, Vulkan, D3D11, D3D12, Metal, OpenCL, CUDA, WebGPU and
  ROCm contexts and zones, with periodic `…Collect`. GPU and CPU clocks drift
  unless the context is calibrated.
- **Fibers** (§3.11, `TRACY_FIBERS`): `TracyFiberEnter(name)` /
  `TracyFiberLeave` around the scheduler's switches; zones then follow the fiber.
- **Call stacks** (§3.12): the `S` macros (`ZoneScopedS(depth)` and so on), at
  most 62 frames, costing about 1 µs on x64. `TRACY_CALLSTACK` applies a depth
  to every macro.
- **Trace parameters** (§3.19): `TracyParameterRegister(cb, data)` and
  `TracyParameterSetup(idx, name, Int|Bool|Trigger, val)`, which the GUI only
  can change. Source callback: §3.20. Connection test: `TracyIsConnected`
  (§3.21).

## C API (`public/tracy/TracyC.h`) — §3.14

`TracyCZone[N][C](ctx, active)` / `TracyCZoneEnd(ctx)`. A context is ended
**exactly once**, on the thread that began it; copy it by value, never take
its address. Also `TracyCZoneText/Name/Value`, `TracyCFrameMark…`,
`TracyCPlot[F|I]`, `TracyCMessage…`, `TracyCAppInfo`, `TracyCAlloc/Free`,
`TracyCLock…`, `TracyCSection…`, `TracyCFiberEnter/Leave` and
`TracyCIsConnected`.

For writing bindings: `___tracy_startup_profiler` and
`___tracy_shutdown_profiler`;
`___tracy_alloc_srcloc[_name](line, file, fileSz, func, funcSz[, name, nameSz])`
returns a `uint64_t` consumed by **one** `___tracy_emit_zone_begin_alloc[_callstack]`;
`___tracy_get_time()`. Bindings must disable themselves when `TRACY_ENABLE` is
absent. No lock, GPU or Lua markup in C.

## Python client (`tracy_client`) — §3.15

Built from `third_party/tracy/python` (pybind11 over a **shared**
`libTracyClient`). Here `scripts/tracy.sh build` builds it with `TRACY_ENABLE`,
`TRACY_ONLY_LOCALHOST` and `TRACY_NO_BROADCAST`, plus
`scripts/tracy_python_fixups.cmake`. The API:

`is_enabled()`, `program_name(s)`, `app_info(s)`, `thread_name(s)`,
`message(s[, color])`, `plot_config(name, PlotFormatType.Number|Memory|Percentage, step, fill, color) -> id`,
`plot(id, value)`, `frame_mark()`, `frame_mark_start(name) -> id`,
`frame_mark_end(id)`, `frame_image(bytes, w, h)`,
`alloc(ptr|obj, size, name=, id=, depth=)`, `free(...)`, and
`ScopedZone(name, color, depth, active)` (`with`, or `enter()`/`exit()`, plus
`.text()`, `.name()`, `.color()`), with the decorators `ScopedZoneDecorator` and
`ScopedFrameDecorator`.

There are **no fibers, sections, lock markup or connection query** in Python.
`ScopedZone` takes its source location from its immediate caller (wrap it and
every zone points at the wrapper). Wheel CMake options: `BUFFER_SIZE` and
`NAME_LENGTH` (128 each) for the name buffer, and `EXTERNAL_PYBIND11`.

## Command-line tools — §4, §7, §8 (in `.tracy/bin`)

| Tool                    | Use                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracy-capture`         | `-o out.tracy` (required), `-a addr` (default 127.0.0.1), `-p port`, `-f` overwrite, `-s secs` stop after, `-m pct` memory cap. Ctrl-C disconnects and saves.               |
| `tracy-capture-daemon`  | Captures every broadcasting client: `-o dir`, `-p`, `-m`, `--filter-name`, `--filter-port`. Files are named `<program>_<ip>_<port>.tracy`.                                    |
| `tracy-monitor`         | **Linux only**: samples an unmodified process. `tracy-monitor ./prog args`, `-p PID`, `-n name`, `--hz`, `--port`, `-o file`, `-f`.                                           |
| `tracy-merge`           | `-o out.tracy in1 in2 …`. Keeps only zones, messages and plots, and does not align clocks across sessions.                                                                   |
| `tracy-update`          | `in out` upgrades an old trace. `-4`, `-h`, `-e` LZ4; `-z N` zstd (best for archives); `-j N` streams; `-d` frame-image dictionary; `-c` rescan source files.                |
|                         | `-s flags` strips data: `l` locks, `m` messages, `p` plots, `M` memory, `i` images, `c` context switches, `s` samples, `C` symbol code, `S` source cache.                     |
|                         | `-r` resolves offline symbols, with `-p` path substitutions, `-a` an addr2line tool and `-A` its arguments.                                                                  |
| `tracy-csvexport`       | See the CSV section below.                                                                                                                                                  |
| `tracy-import-chrome`   | `in.json[.zst] out.tracy`, for Chrome trace-event JSON; a `loc: "file.c:42"` key on begin events gives source locations. Each PID+TID pair becomes a pseudo-thread.           |
| `tracy-import-fuchsia`  | `in.fxt[.zst] out.tracy`.                                                                                                                                                   |
| `tracy-profiler`        | The GUI: `tracy-profiler file.tracy`, `-a addr` to connect, `-p port`. The web build loads `https://tracy.nereid.pl/?t=<https URL with CORS>`.                                |

### `tracy-csvexport` (§7)

Default columns: `name, src_file, src_line, total_ns, total_perc, counts,
mean_ns, min_ns, max_ns, std_ns`, all zones, **inclusive** time. Flags:

- `-e` gives self time (exclusive of children), the honest ranking;
- `-f name` filters, made case-sensitive by `-c`;
- `-s sep` sets the separator (names may contain commas);
- `-u` lists one row per zone instance with timestamp and duration, and `-p`
  adds plot data to it;
- `-m` exports messages only;
- `-g` exports GPU zones;
- `-t [pct]` gives a truncated mean (90 by default);
- `-F` gives frame-set statistics instead. Its columns are `frame_set,
  continuous, frames, counts, total_ns, span_perc, min/max/mean/median/std_ns,
  cv_perc, p75/p90/p99/p99_9_ns`, and `-S` adds per-section rows.

## MCP server (`third_party/tracy/extra/mcp/tracy_mcp.py`) — §3.16

It lets an agent load `.tracy` files and query them. It needs `mcp` and the
`TracyServerBindings` module, imported **top-level**
(`import TracyServerBindings`). The client wheel built here ships that module as
`tracy_client/TracyServerBindings*.so`, so `PYTHONPATH` must point at the
installed `tracy_client/` directory itself. This has not been run in this
repository yet. It runs as one process on Streamable HTTP
(`TRACY_MCP_PORT`, default 47380; `TRACY_CAPTURES_DIR` enables
`list_captures`). Its tools are `list_captures`, `list_instances`,
`load_capture`, `connect_instance`, `live_connect`, `discover_instances`,
`save_trace`, `eval` (Python against a Worker as `ctx`) and `task`.

The Worker's methods return nanoseconds:

- capture details: `get_capture_name`, `get_host_info`, `get_resolution`,
  `get_first_time` / `get_last_time`;
- zone statistics: `get_all_zone_stats` (min, max, total, avg, count, sum_sq),
  `get_root_zone_stats`, `get_thread_zone_stats`, `get_zone_durations(name)`,
  `get_zone_source_location`;
- frames: `get_frame_times[_named]`, `get_frame_boundaries`;
- messages and plots: `get_messages`, `get_plots`, `get_plot_samples`,
  `get_plot_window_stats`;
- the rest: `get_memory_events`, `get_locks`, `get_symbol_stats`,
  `get_callstack_frames`, and the GPU variants.

Opening a file in the GUI does not load it into the MCP server.

## The GUI — §5

- **Statistics** (§5.6): zones ranked by total, count or mean, with timing
  modes *with children*, *self only* and *non-reentrant*; Sampling mode when
  samples exist.
- **Find zone** (Ctrl+F, §5.7): a duration histogram (log axes, cumulate,
  self or running time), mean, median, mode, σ and P75 to P99.9, grouped by
  thread, user text, name, call stack or parent. Drag over the histogram to
  isolate outliers.
- **Compare** (§5.8): two traces overlaid. Set trace descriptions first, use
  *Normalize values* when zone counts differ, and diff sources there too.
- **Flame graph** (§5.9), **Memory** (§5.10), **Messages** (§5.5): filters are
  comma-separated terms, `-term` excludes, and severity and source can be
  filtered.
- **Info** (§5.13): the trace description, host, crash report and
  source-path substitutions (regex).
- Time ranges: Ctrl-drag on the timeline limits Find, Statistics, Flame and
  Memory (§5.3). Annotations live in a sidecar under `~/.config/tracy`.
- Navigation: W/A/S/D, the wheel zooms, a right-drag pans, a middle-click zooms
  to an item. Ctrl+Alt+R reconnects.
- **Tracy Assist** (§6) is a local-LLM-only chat (llama.cpp or LM Studio) over
  the manual, source and samples; it can be switched off in the global settings.

## Limits and platform facts — §2.1.14, §2.6, §2.1.10

- 65,534 unique source locations, half native and half dynamic (Lua, Python,
  allocated); a recursive zone may appear at most 255 times on one stack; a
  session lasts at most 1.6 days; 2^32 frees; 2^24 unique call stacks; 65,535
  threads per lock.
- **macOS**: no `TRACY_NO_EXIT`; profiling is cut off when the process exits, so
  the last events are lost; no call-stack sampling, context switches, wait
  stacks, hardware counters, CPU topology, vsync or crash handler; no OpenGL GPU
  zones; higher per-event overhead. Release binaries need
  `xattr -d com.apple.quarantine tracy-profiler.app`.
- **Linux** has everything (sampling needs no root; kernel stacks and context
  switches do); `ulimit -n` may need raising for perf events. In Docker it needs
  `--privileged --pid=host` and a mounted debugfs. Avoid VMs: their timers drift.
- Measurement hygiene (§2.2): close other applications, disable turbo and power
  saving where possible, mind SMT siblings, and run without a debugger.
- Configuration: `$XDG_CONFIG_HOME/tracy` (`~/.config/tracy`); cache:
  `~/.cache/tracy`. Per-trace settings go in `sidecar/<program>/<date>.json`, or
  next to the trace when the sidecar is made public.
