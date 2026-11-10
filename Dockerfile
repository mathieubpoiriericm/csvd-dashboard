# The dashboard as Fly.io runs it: the Fresh build, served by Deno.
#
# The tag is an exact patch of the 2.9 LTS line. Deno 2.9 receives monthly
# bug-fix and security releases until October 2027 and nothing after, so
# bumping this tag each month is the whole of this image's security
# maintenance. Keep it equal to the Deno that runs locally and in CI.
FROM denoland/deno:2.9.8

WORKDIR /app
RUN chown deno:deno /app
USER deno

# Dependencies first, so a change to the source alone reuses this layer.
# --frozen fails the build when deno.lock disagrees with deno.json instead of
# resolving afresh; nodeModulesDir is "manual", so this is also what populates
# node_modules for Vite.
COPY --chown=deno:deno deno.json deno.lock ./
RUN deno install --frozen

# .dockerignore is an allowlist, so this copies the app and nothing else.
COPY --chown=deno:deno . .
RUN deno task build

# The image starts as root and serves as `deno`. Fly mounts the session
# volume (fly.toml's [mounts]) with its root owned by root, so the entrypoint
# creates ADAPT_SESSIONS_DIR there and gives it to `deno`, and only then
# drops to `deno` with setpriv (util-linux, in the base image) to run the CMD.
# Nothing runs as root after that exec. The script is copied again as root's,
# over the copy above, so the user it drops to cannot edit it in place. It
# replaces the base image's entrypoint, /tini running the base's own
# docker-entrypoint.sh, so the server is the container's first process.
USER root
COPY --chmod=755 scripts/docker-entrypoint.sh scripts/docker-entrypoint.sh
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]

EXPOSE 8000

# The whole tree stays: the server bundle still imports `fresh` through the
# deno.json import map, so _fresh/ alone does not start.
#
# 0.0.0.0, where `deno task start` binds 127.0.0.1: Fly's proxy reaches the
# machine over its private network. The loopback flag there exists for the URL
# `deno serve` prints to a browser on the same machine (.claude/rules/login.md);
# here the session cookie's Secure flag follows the public host name, and Fly
# terminates TLS in front of it.
#
# --cached-only: every module was cached by the two RUN steps above, so one
# that was not fails the start instead of being fetched in production.
#
# _fresh/server.js, never _fresh/compiled-entry.js (the deploy skill says why).
# The two login secrets come from `fly secrets`, never from the image.
CMD ["deno", "serve", "-A", "--cached-only", "--host", "0.0.0.0", "--port", "8000", "_fresh/server.js"]
