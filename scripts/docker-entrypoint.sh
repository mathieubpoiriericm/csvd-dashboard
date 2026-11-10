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
# SMOKE_EXPECT_SESSIONS=1).
#
# With ADAPT_SESSIONS_DIR unset (CI's unconfigured container, a plain local
# `docker run`) it only drops privileges.

set -eu

dir="${ADAPT_SESSIONS_DIR:-}"
if [ -n "$dir" ]; then
  if ! { mkdir -p "$dir" && chown deno:deno "$dir"; } 2>/dev/null; then
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
