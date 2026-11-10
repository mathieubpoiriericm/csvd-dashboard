#!/bin/sh
# The image's entrypoint: starts as root, serves as `deno`.
#
# A Fly volume, like a fresh Docker named volume, mounts with its root owned
# by root, and the server runs as `deno`, so the sessions directory has to be
# created and handed over by root before the server starts. Only that
# directory changes hands, not the rest of the mount.
#
# When that fails (a read-only mount, say) the server still starts: the guide
# then serves without server-side sessions, which server/adapt_sessions.ts
# logs, rather than the whole site not serving. A deploy that expects sessions
# fails its smoke test instead (scripts/smoke_deploy.sh,
# SMOKE_EXPECT_SESSIONS=1), when the repository holds the SMOKE_PASSPHRASE
# secret that test signs in with; without it the deploy only notes that
# sessions were not checked.
#
# Only on a mount, though. With the variable set and no volume there (a fork
# that drops [mounts] but keeps ADAPT_SESSIONS_DIR, a `docker run -e` without
# `-v`), root creating the directory would put it on the container's own
# filesystem: sessions would report as on and be lost at every deploy or
# restart. So the directory is prepared only when its nearest existing
# ancestor (itself, if it exists) sits on another device than `/`. Otherwise
# it is left alone, the server, as `deno`, cannot create it under root-owned
# `/`, and the guide serves without sessions and says so.
#
# With ADAPT_SESSIONS_DIR unset (CI's unconfigured container, a plain local
# `docker run`) it only drops privileges.

set -eu

dir="${ADAPT_SESSIONS_DIR:-}"
if [ -n "$dir" ]; then
  # dirname ends at `/` or `.`, which both exist, so this stops.
  probe=$dir
  while [ ! -e "$probe" ]; do
    probe=$(dirname -- "$probe")
  done
  # -L: a symlink is judged by where it leads, which is where the files go.
  probe_dev=$(stat -L -c %d -- "$probe" 2>/dev/null || true)
  root_dev=$(stat -L -c %d / 2>/dev/null || true)
  if [ -z "$probe_dev" ] || [ "$probe_dev" = "$root_dev" ]; then
    echo "docker-entrypoint: nothing is mounted at $dir (it would be on the container's own filesystem); leaving it uncreated, so sessions are off" >&2
  # -h: a symlink planted at that path by `deno` (if a fork puts it under a
  # directory deno owns) must not have root chown whatever it points to.
  elif ! { mkdir -p "$dir" && chown -h deno:deno "$dir"; } 2>/dev/null; then
    echo "docker-entrypoint: cannot create $dir or give it to deno; serving without sessions" >&2
  fi
fi

# The environment is root's otherwise: HOME follows the user, as it did
# while the image itself ran as `deno`.
HOME=$(getent passwd deno | cut -d: -f6)
export HOME

# The base image's init, kept: this script is the container's first process
# and becomes tini, which forwards signals to the server and reaps zombies,
# as it did under the base image's own entrypoint. Without it (another base
# image), the server becomes the first process itself.
if [ -x /tini ]; then
  exec /tini -- setpriv --reuid=deno --regid=deno --init-groups "$@"
fi
exec setpriv --reuid=deno --regid=deno --init-groups "$@"
