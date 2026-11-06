#!/usr/bin/env bash
# Tracy, built from the third_party/tracy submodule (manual §2.1: the client
# comes from a git submodule so an update is a checkout away).
#
#   bash scripts/tracy.sh build         tools -> .tracy/bin, client wheel -> .tracy/wheels
#   bash scripts/tracy.sh update        move the submodule to the newest vX.Y.Z tag, then build
#   bash scripts/tracy.sh run CMD...    run CMD under `uv run` with the profiling client,
#                                       capturing to logs/tracy/<timestamp>.tracy
#
# The deno tasks tracy:build, tracy:update and tracy:run call these. Needs cmake
# and ninja on PATH (brew install cmake ninja). TRACY_DIR overrides where the
# tools live (default .tracy/bin), and the wheel is read from $TRACY_DIR/../wheels,
# so a worktree points TRACY_DIR at the main checkout's build. The tracy skill
# (.claude/skills/tracy/SKILL.md) explains the workflow.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/third_party/tracy"
OUT="$ROOT/.tracy"
BIN="${TRACY_DIR:-$OUT/bin}"
BIN="${BIN%/}"
WHEELS="$BIN/../wheels"
TOOLS=(capture csvexport import update profiler)
export CPM_SOURCE_CACHE="${CPM_SOURCE_CACHE:-$HOME/.cache/cpm}"

die() {
    echo "tracy.sh: $*" >&2
    exit 1
}

require() {
    local missing=()
    for tool in "$@"; do
        command -v "$tool" > /dev/null || missing+=("$tool")
    done
    if ((${#missing[@]})); then
        die "missing ${missing[*]} on PATH; install with: brew install ${missing[*]}"
    fi
}

ensure_submodule() {
    if [[ ! -f "$SRC/CMakeLists.txt" ]]; then
        git -C "$ROOT" submodule update --init third_party/tracy
    fi
}

checked_out_version() {
    git -C "$SRC" describe --tags --exact-match 2> /dev/null ||
        git -C "$SRC" rev-parse --short HEAD
}

# After pulling a Tracy bump, the submodule still holds the old release until
# `git submodule update`; building then would quietly rebuild the old version.
warn_if_unrecorded() {
    if [[ "$(git -C "$ROOT" submodule status third_party/tracy)" == +* ]]; then
        echo "tracy.sh: warning: third_party/tracy is at $(checked_out_version), not the" \
            "commit the repository records. Run \`git submodule update third_party/tracy\`" \
            "for the recorded release, or commit the move if it is yours." >&2
    fi
}

# Proves the wheel through the very calls pipeline/profiling.py makes,
# including the private _ScopedZone signature its tests can only fake, and
# the libpython link that otherwise surfaces as "Fatal Python error: take_gil"
# halfway into a profiled run.
smoke_test() {
    local wheel="$1"
    (cd "$ROOT" && uv run --refresh-package tracy-client --with "$wheel" python -c '
from pipeline import profiling
assert profiling.enabled(), "the wheel was built without TRACY_ENABLE"
with profiling.zone("smoke") as zone:
    zone.text("tracy.sh build")
with profiling.stages() as stage:
    stage("smoke stage")
profiling.adjust("smoke", 1)
profiling.message("smoke")
') > "$OUT/smoke.log" 2>&1 ||
        die "the client wheel fails pipeline/profiling.py; see $OUT/smoke.log and scripts/tracy_python_fixups.cmake"
}

build() {
    require cmake ninja uv
    ensure_submodule
    local version wheel=""
    version="$(checked_out_version)"
    mkdir -p "$OUT/bin" "$OUT/wheels"

    for tool in "${TOOLS[@]}"; do
        echo "==> tracy-$tool ($version)"
        {
            cmake -G Ninja -S "$SRC/$tool" -B "$OUT/build/$tool" -DCMAKE_BUILD_TYPE=Release &&
                cmake --build "$OUT/build/$tool" --parallel
        } > "$OUT/build-$tool.log" 2>&1 || die "tracy-$tool build failed; see $OUT/build-$tool.log"
        for exe in "$OUT/build/$tool"/tracy-*; do
            if [[ -f "$exe" && -x "$exe" ]]; then
                ln -sf "$exe" "$OUT/bin/"
            fi
        done
    done

    # The client: Tracy's own Python package compiles public/TracyClient.cpp.
    # TRACY_ENABLE defaults to OFF, so this wheel is the "separate build
    # configuration" of §2.1; nothing else in the repository installs it. The
    # client listens on localhost only and never announces itself on the LAN
    # (§2.1.7, §2.1.8). The fixups file works around the wheel's build bugs;
    # each block there names the release it was found on.
    echo "==> tracy_client wheel ($version)"
    rm -f "$OUT"/wheels/tracy_client-*.whl
    uv build --wheel --python "$(< "$ROOT/.python-version")" "$SRC/python" \
        -o "$OUT/wheels" \
        -C cmake.define.TRACY_ENABLE=ON \
        -C cmake.define.TRACY_ONLY_LOCALHOST=ON \
        -C cmake.define.TRACY_NO_BROADCAST=ON \
        -C "cmake.define.CMAKE_PROJECT_Tracy_INCLUDE=$ROOT/scripts/tracy_python_fixups.cmake" \
        > "$OUT/build-wheel.log" 2>&1 ||
        die "wheel build failed; see $OUT/build-wheel.log"
    for candidate in "$OUT"/wheels/tracy_client-*.whl; do
        wheel="$candidate"
    done
    echo "==> smoke test through pipeline/profiling.py"
    smoke_test "$wheel"

    echo "$version" > "$OUT/VERSION"
    echo "Tracy $version: tools in .tracy/bin, client wheel in .tracy/wheels"
}

update() {
    require git
    ensure_submodule
    git -C "$SRC" fetch --tags --quiet origin
    local latest current
    latest="$(git -C "$SRC" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
    current="$(checked_out_version)"
    [[ -n "$latest" ]] || die "no vX.Y.Z tag found in $SRC"

    if [[ "$latest" == "$current" && -f "$OUT/VERSION" && "$(< "$OUT/VERSION")" == "$latest" ]]; then
        echo "Tracy is already at the latest release, $latest."
        return
    fi
    if [[ "$latest" != "$current" ]]; then
        echo "==> Tracy $current -> $latest"
        git -C "$SRC" checkout --quiet "$latest"
    fi
    build
    if [[ "$latest" != "$current" ]]; then
        cat << EOF

Next:
  1. Check scripts/tracy_python_fixups.cmake: delete any workaround $latest no longer needs.
  2. Run deno task perf, and deno task tracy:run on a pipeline command, to prove both channels.
  3. git add third_party/tracy && git commit -m "Update Tracy to $latest"
EOF
    fi
}

run() {
    [[ "${1:-}" == "--" ]] && shift
    (($#)) || die "usage: tracy.sh run CMD... (for example: python -m pipeline.export.main)"
    require uv nc
    local capture="$BIN/tracy-capture" wheel=""
    [[ -x "$capture" ]] || die "$capture is missing; run deno task tracy:build"
    for candidate in "$WHEELS"/tracy_client-*.whl; do
        [[ -f "$candidate" ]] && wheel="$candidate"
    done
    [[ -n "$wheel" ]] || die "no client wheel in $WHEELS; run deno task tracy:build"

    local port="${TRACY_PORT:-8086}" trace
    mkdir -p "$ROOT/logs/tracy"
    trace="$ROOT/logs/tracy/$(date +%Y%m%d-%H%M%S).tracy"
    export TRACY_PORT="$port"

    # The capture must attach *after* the client is listening. On macOS,
    # tracy-capture treats a refused connection as an established one (a
    # second non-blocking connect() fails with EISCONN, and Tracy does not read
    # SO_ERROR), so started first it "connects" to nothing and quits with
    # "disconnected during the initial connection handshake". The waiter polls
    # the client's port and only then hands over to tracy-capture. Being a
    # background job, it ignores the terminal's Ctrl-C, which goes to the
    # client in the foreground; the capture then saves when the client ends.
    (
        until nc -z -G 1 127.0.0.1 "$port" 2> /dev/null; do sleep 0.1; done
        exec "$capture" -o "$trace" -p "$port" > "${trace%.tracy}.log" 2>&1 < /dev/null
    ) &
    local waiter=$! status=0

    # A trap (not an ignore) so Ctrl-C still reaches the client, which resets
    # handled signals to their defaults, while this script carries on to wait
    # for the capture instead of exiting with the client.
    trap ':' INT
    uv run --refresh-package tracy-client --with "$wheel" "$@" || status=$?
    trap - INT

    # Once it has exec'd, the waiter *is* tracy-capture: it saves and exits when
    # the client disconnects, however long a large trace takes to write. A waiter
    # still polling means the client never listened (nothing imported
    # tracy_client), so there is nothing to capture.
    if [[ "$(ps -o comm= -p "$waiter" 2> /dev/null)" == *tracy-capture* ]]; then
        wait "$waiter" || true
    else
        kill "$waiter" 2> /dev/null || true
        wait "$waiter" 2> /dev/null || true
        echo "tracy.sh: no capture taken; did the command import pipeline.profiling?" >&2
    fi
    if [[ -f "$trace" ]]; then
        local bin="${BIN#"$ROOT"/}" rel="${trace#"$ROOT"/}"
        echo "Trace: $rel (capture log: ${rel%.tracy}.log)"
        echo "  $bin/tracy-csvexport -e $rel | sort -t, -k4,4nr   # zones by self time, slowest first"
        echo "  $bin/tracy-profiler $rel"
    fi
    return "$status"
}

case "${1:-}" in
    build)
        warn_if_unrecorded
        build
        ;;
    update) update ;;
    run)
        shift
        run "$@"
        ;;
    *) die "usage: tracy.sh build | update | run CMD..." ;;
esac
