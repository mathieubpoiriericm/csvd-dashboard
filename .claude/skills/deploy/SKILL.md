---
name: deploy
description: Use when deploying the dashboard to Fly.io, setting up a fork's Fly app, or diagnosing a broken deploy - the one-machine rule the login limiter depends on, the Fly-Client-IP header, the allowlist .dockerignore, the CI deploy job and its FLY_API_TOKEN, why Fly's health check cannot see a missing login secret, the session volume and its root-owned mount, the adapt guide's saved sessions (ADAPT_SESSIONS_DIR, listing or clearing them by hand, ADAPT_SESSIONS_MACHINE before a second machine), what the deploy smoke test checks, the Fly-Client-IP spoof probe and its result, and retiring the old Deno Deploy project.
---

# Hosting on Fly.io

The app runs at `https://csvd-dashboard.fly.dev`, on Fly.io, as one always-on
machine built from the root `Dockerfile` and configured by `fly.toml`. On a push
to `main`, CI's `container` job builds that image, smoke-tests it and pushes it
to `registry.fly.io/<app>:<commit>`; the `deploy` job in
`.github/workflows/ci.yml` releases exactly that image
(`flyctl deploy --image`), but only once every other job has passed, then runs
`scripts/smoke_deploy.sh` against `https://<app>.fly.dev`. Fly builds nothing in
CI any more, so what goes live is the image the smoke test passed, and Fly's
remote build (18-38 s on the deploys before, mostly waiting for a builder) is
off the time from push to live. On the first such push (run 41751654752, 4
November 2026) `container`'s push took 19 s, inside the time the tests take;
`deploy`'s release took 29 s against the remote build's 45; and the commit was
live 1m42s after the push, against 1m55s the deploy before. The app's deploy
token (`fly tokens create deploy`) is enough for `flyctl auth docker` and the
push, which Fly does not document. `README.md`'s "Deployment" section carries
the summary table. It moved there on 2 November 2026 from Deno Deploy, which
shuts down about six months after Deno's 9 October 2026 announcement; "Retiring
Deno Deploy" below has what is left.

Nine things are non-obvious enough to state here:

- **Exactly one machine.** `server/login_post_limiter.ts` counts failed sign-ins
  in the server process: a second machine doubles the guess budget, and a
  stopped one forgets it. `fly.toml` turns auto-stop off and keeps one running;
  CI deploys with `--ha=false`, because a first `fly deploy` otherwise creates
  two machines. `fly status` should list one. If it lists two,
  `fly scale count 1`. The app ran eight machines for part of 10 November 2026
  and was scaled back the same day.
- **One volume, on that machine, holding the adapt guide's saved sessions.**
  `fly.toml`'s `[mounts]` puts the 1 GB `persistent_session_storage` volume at
  `/session_storage`, and its `ADAPT_SESSIONS_DIR` names
  `/session_storage/adapt-sessions`, where `server/adapt_sessions.ts` keeps one
  JSON file per session. A volume attaches to one machine and is not shared, so
  a second machine needs a volume of that name in its region first and would not
  see this one's files ("More than one machine" below). With the variable unset,
  or the directory unwritable, the server logs `Adapt sessions are off:` and the
  reason, and the guide serves without Save session rather than not at all.
- **The image starts as root, and serves as `deno`.** A fresh volume mounts with
  its root owned by root, and the server runs as `deno`, so it could not create
  the sessions directory. The `ENTRYPOINT`, `scripts/docker-entrypoint.sh`
  installed root-owned at `/usr/local/bin/docker-entrypoint.sh`, creates
  `ADAPT_SESSIONS_DIR`, gives that directory alone to `deno`, sets `HOME` to
  `deno`'s, and execs `/tini -- setpriv --reuid=deno --regid=deno
  --init-groups` with the `CMD`. It prepares the directory only when its
  nearest existing ancestor sits on another device than `/` (`stat -c %d`):
  with the variable set and no volume mounted, root would otherwise create it
  on the machine's own filesystem, where sessions would report as on and vanish
  at every deploy or restart. Instead it prints
  `docker-entrypoint: nothing is mounted at …`, leaves the directory uncreated,
  and the server, unable to create it as `deno` under root-owned `/`, serves
  with sessions off. If the directory cannot be made on the volume it prints
  one line to stderr and serves anyway. Tini stays the first process, as it was
  under the base image's own entrypoint, and is then the only thing running as
  root. The script lives outside `/app` because `deno` owns `/app` and could
  otherwise rewrite what root runs at the next start, and the `deno`-owned copy
  `COPY . .` brings into `/app/scripts` is deleted. CI's `container` job checks
  that the first process is tini, that every `deno` process has a non-zero uid,
  and that the entrypoint is `root 755`; and, on a third container given the
  variable but no volume, that the directory does not exist, that the
  entrypoint said so, and that a signed-in `/adapt` reports sessions off.
- **The deploy's smoke test saves and resumes a real session, when it can sign
  in.** `scripts/smoke_deploy.sh` with `SMOKE_EXPECT_SESSIONS=1` opens `/adapt`
  and wants `data-sessions="on"`, then creates a session from
  `scripts/smoke_session.json` (an empty export) and resumes it with the code
  the create returned, which it never prints, even under `bash -x`. The `deploy`
  job sets that flag when `fly.toml` has both `[mounts]` and
  `ADAPT_SESSIONS_DIR` **and** the repository holds the live passphrase as the
  secret `SMOKE_PASSPHRASE`, because `/adapt` sits behind the login. No such
  secret exists today, so a production deploy prints a notice that the session
  check was skipped; adding it makes every deploy sign in to production. Each
  checked deploy leaves one empty session on the volume for its 14 days and
  spends one of the session limiter's counted requests. CI's `container` job
  always runs the check, against a Docker named volume.
- **`LOGIN_CLIENT_IP_HEADER = "Fly-Client-IP"` in `fly.toml` is load-bearing.**
  Every request reaches the machine from Fly's proxy, so without it the limiter
  keys every visitor on the proxy's address, and five wrong guesses from anyone
  lock everyone out for a minute. The limiter refuses `X-Forwarded-For` and
  `Forwarded` as the header, because a client can append to both. Fly's docs do
  not say whether the proxy overwrites a client-sent `Fly-Client-IP`, so the
  probe below was run against the live app on 2 November 2026: it does, and a
  visitor cannot pick their own bucket. Were that ever to change, the global
  limit, which keys on nothing a client sends, would still cap guessing at 64 a
  minute.
- **Fly's health check is liveness only, and cannot see a missing login
  secret.** Fly's checks pass on a 2xx and follow no redirect, and `/login` is
  the one page that answers 200 without a session. The gate exempts it before
  reading the secrets, so it renders even with both unset. A missing secret is a
  503 on every _gated_ route, which is what the smoke test's logged-out `GET /`
  looks for: it wants a 303 to `/login`, and a 503 fails the CI job naming both
  variables.
- **`.dockerignore` is an allowlist.** It names the files the build reads and
  excludes everything else, so `.env`, `.venv` and the publisher PDFs under
  `data/test_data/` cannot reach the build context. A new top-level file the
  build imports must be added there, and the CI `container` job fails until it
  is.
- **The image runs
  `deno serve -A --cached-only --host 0.0.0.0 --port 8000
  _fresh/server.js`.**
  `0.0.0.0`, unlike `deno task start`'s `127.0.0.1` (`.claude/rules/login.md`),
  because Fly's proxy reaches the machine over its private network.
  `--cached-only`, because the two `RUN` steps cached every module, so a missing
  one fails the start rather than being fetched in production. The whole tree
  stays in the image, because the server bundle still imports `fresh` through
  the `deno.json` import map. Never `_fresh/compiled-entry.js`: the plugin emits
  it beside `server.js`, but it calls
  `Deno.serve({ port: Deno.env.get("PORT") })` and so passes a string where a
  number is required.
- **The Deno tag is pinned to an exact 2.9.x patch, and bumped by hand.** The
  2.9 LTS line receives monthly bug-fix and security releases until October 2027
  and nothing after, so that monthly bump, together with the local Deno, is the
  image's security maintenance. After October 2027 the app has to be off Deno.

Because `data/*.json` is committed and bundled at build time, regenerating data
and pushing it to `main` republishes the site — `tests/filters_test.ts`'s caveat
about regeneration now has a production consequence as well as a test one.

## Setting up an app (once per app, by a person)

These touch an account and its secrets, so the researcher runs them:

1. `brew install flyctl`, then `fly auth login`. In Claude Code, type
   `! fly auth login` so the browser login lands in the session.
2. If this is a fork, edit `fly.toml` first: `app` becomes the host name
   `<app>.fly.dev` and must be unique across Fly, and `primary_region` should be
   the region nearest the readers (`fly platform regions`).
3. `fly launch --no-deploy --copy-config` registers the app from `fly.toml`
   without building anything.
4. `fly volumes create persistent_session_storage --region <region> --size 1`,
   in the `primary_region`, before the first deploy. Fly's documentation leans
   towards a first deploy creating a missing volume itself, but its
   configuration reference also says a volume of the `[mounts]` name "must exist
   in _some_ region for the application to deploy"
   (https://docs.fly.io/reference/configuration, read 10 November 2026), and
   creating it first is harmless either way. A fork that will not offer saved
   sessions removes `[mounts]` and `ADAPT_SESSIONS_DIR` from `fly.toml` instead
   and skips this step.
5. `fly secrets set DASHBOARD_PASSPHRASE='…' DASHBOARD_SESSION_SECRET='…'`, in
   the same single quotes `.env` uses. The passphrase keeps apostrophes out for
   that reason. `openssl rand -base64 32` makes the session secret. Never import
   the whole `.env`: the rest is the pipeline's database password and API keys.
6. `fly tokens create deploy`, stored as the repository secret `FLY_API_TOKEN`
   in GitHub. Store it in **one** repository only: this project pushes to two
   remotes, and CI's `container` job pushes the image and its `deploy` job
   releases it wherever the secret exists; where it does not, `container` pushes
   nothing and `deploy` skips with a notice.
7. Push to `main`, or run `fly deploy --remote-only --ha=false` once by hand.
   Then `scripts/smoke_deploy.sh https://<app>.fly.dev` should print seven
   `ok` lines with `SMOKE_PASSPHRASE` set, ten with `SMOKE_EXPECT_SESSIONS=1`
   as well, or five and a skip without the passphrase. To have every deploy
   check sessions, store the passphrase as the repository secret
   `SMOKE_PASSPHRASE` too.

## The adapt guide's sessions on the volume

Each session is `/session_storage/adapt-sessions/<sha256>.json`, named by the
SHA-256 of its normalised resume code (20 characters, upper case, no hyphens),
so the directory cannot be read back into codes and nothing logs one. The file
holds a version, the revision, `savedAt` and the answers as "Export answers"
writes them, with the NCBI email and API key blanked by the server whatever the
browser sent. A file's mtime is its `savedAt`; a sweep at start and then at most
hourly, on the next session request, deletes a session 14 days after its last
save, and a temporary file a write left behind after an hour. Two bounds keep
the 1 GB volume from filling (`server/adapt_sessions.ts`): at 500 session files
(`SESSION_CAP`), or when the session files would hold more than 750,000,000
bytes together (`SESSION_BYTES_BUDGET`), a create or a revival answers "full";
a save to an existing session is refused as "full" only when it would grow the
total past the budget. The three session routes read at most 4,000,000 bytes of
body (`SESSION_BODY_LIMIT` in `server/adapt_session_api.ts`; two logos at their
1 MB cap make an export of about 2.7 MB) and answer 413 above it; the 8 MB
`IMPORT_BYTE_LIMIT` bounds only a file imported in the browser. A write or read
that fails logs one line, `Adapt session <operation> failed for <first 12 hex
characters of the file's hash>: <error>`, never the code. By hand, as root:

```sh
# list, count, total size, clear all
fly ssh console -C "ls -l /session_storage/adapt-sessions"
fly ssh console -C "sh -c 'ls /session_storage/adapt-sessions | wc -l'"
fly ssh console -C "du -sh /session_storage/adapt-sessions"
fly ssh console -C "sh -c 'rm /session_storage/adapt-sessions/*.json'"
```

Clearing removes every session at once and cannot be undone; a researcher whose
session is gone resumes from their own Export answers. One session is removed by
its file name, which only its code gives: there is no index from a person or a
date to a file beyond the mtime. The code opens the session, so it goes in on a
silent prompt, never on a command line, where it would reach the shell's history
and the process list. On your own machine:

```sh
read -rs code   # paste the code, then Enter; nothing is echoed
printf %s "$code" | tr -d '[:space:]-' | tr a-z A-Z | tr OIL 011 | sha256sum
unset code
```

The pipeline is `normaliseCode()` (`lib/adapt/session_code.ts`) in `tr`: it
drops whitespace and hyphens, upper-cases, and reads O as 0 and I or L as 1, so
it gives the hash the server names the file by for any spelling the guide
accepts. Then
`fly ssh console -C "rm /session_storage/adapt-sessions/<hash>.json"`.

## More than one machine

Production is one machine, and `ADAPT_SESSIONS_MACHINE` is unset: every machine
is then its own holder. A second machine has a volume of its own and cannot see
the first one's files, so before adding one, set the variable to the id of the
machine that keeps the sessions (`fly status` prints it), in `fly.toml`'s
`[env]` or with `fly secrets set`. `server/adapt_session_holder.ts` reads it at
start, and a value that is not 6 to 32 hexadecimal characters stops the server.
Each machine compares it with the `FLY_MACHINE_ID` Fly sets; the others open no
store and leave their volume alone.

The page then writes the id into `data-sessions-machine`, and the guide sends
every session request with `fly-force-instance-id: <id>`, which Fly's proxy
routes to that machine with "No fallback if Machine is ultimately unavailable".
A request that reaches another machine without the header, from a page served
before the designation, is answered with a 503 carrying
`fly-replay: instance=<id>`, which the proxy consumes and replays to the holder.
"Requests larger than 1MB cannot be replayed"
(https://docs.fly.io/networking/dynamic-request-routing, read 10 November
2026), so a save carrying logos depends on the header, and without it the
browser sees the 503 as "The session could not be reached". The replay path is
untested against live Fly. Remember too that the login limiter counts per
process ("Exactly one machine" above), which a second machine changes as well.

## Diagnosis

| Symptom                                                          | Cause and fix                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every gated page answers 503, `/login` renders                   | a login secret is unset: `fly secrets list`, then `fly secrets set` the missing one (this restarts the machine)                                                                                                                                                                                          |
| everyone gets "Too many sign-in attempts" at once                | `LOGIN_CLIENT_IP_HEADER` is missing from `fly.toml`'s `[env]`, or `fly status` lists more than one machine                                                                                                                                                                                               |
| the CI `deploy` job printed "FLY_API_TOKEN is not set"           | this repository holds no token, which is expected on the second remote and on a fork that hosts elsewhere                                                                                                                                                                                                |
| the `container` job's push step fails, so nothing deploys        | `flyctl auth docker` or `docker push` to `registry.fly.io` was refused: check the token (`fly tokens create deploy`) and the app name in `fly.toml`; the live site keeps the previous release                                                                                                            |
| `deploy` fails with the image not found                          | this commit's image is not in the registry: the token was added after the run's `container` job had skipped the push and only `deploy` was re-run, or an old run's `deploy` was re-run after the image left Fly's registry. Re-run the whole workflow                                                    |
| the CI `container` job fails at `deno task build`                | a file the build imports is missing from `.dockerignore`'s allowlist                                                                                                                                                                                                                                     |
| the machine starts and exits at once (`fly logs`)                | `--cached-only` met a module the build did not cache; reproduce with `container build` and `container run` (README, "Deployment")                                                                                                                                                                        |
| Save session is missing on the live site                         | sessions are off: `fly logs` shows `Adapt sessions are off:` with the reason, and `docker-entrypoint: cannot create` if the entrypoint could not make the directory. Either `ADAPT_SESSIONS_DIR` is unset in `fly.toml`'s `[env]`, or the variable is set but no volume is mounted (`docker-entrypoint: nothing is mounted at`; check `[mounts]` and `fly volumes list`), or the directory it names cannot be written, which the log line names |
| every save answers "The server cannot take another session right now" | the volume's sessions reached a bound: 500 files or 750,000,000 bytes (503 `full`). Count and size them (the `ls` and `du` lines above); the sweep frees nothing younger than 14 days, so delete by hand the largest or oldest files you can spare, or every one (it cannot be undone). `fly logs` lines `Adapt session write failed` instead mean the disk itself refused (full or read-only) |
| a resume says no session answers to that code right after a save | more than one machine and no `ADAPT_SESSIONS_MACHINE`: the save and the resume reached different volumes. `fly status`; scale to one, or set the variable ("More than one machine")                                                                                                                      |

**Probing whether `Fly-Client-IP` can be spoofed**, once, from a machine whose
address may be locked out for a minute:

1. POST five wrong passphrases to `/login` with `Sec-Fetch-Site: same-origin` to
   exhaust your own bucket.
2. POST a sixth with a made-up `Fly-Client-IP` header, and a seventh without
   one.
3. Confirm the header is configured on the running machine:
   `fly machine status <id> -d` lists `LOGIN_CLIENT_IP_HEADER` under `env`.
   Without it every request shares the proxy's bucket, which would also answer
   429 and pass for the safe result.

With the header configured, a 429 on the sixth means the proxy overwrote the
header, which is the safe answer. A 401 means it passed the client's value
through, and the per-client limit can be dodged, though not the global one.

**Result, 2 November 2026:** five 401s, then 429 with the made-up header and 429
without it, with `LOGIN_CLIENT_IP_HEADER = Fly-Client-IP` in machine
`853d9df4213e38`'s env. Fly's proxy overwrites a client-sent `Fly-Client-IP`.
Run the probe again if the app moves host or the proxy changes behaviour.

## Retiring Deno Deploy

The site moved from `https://csvd-dashboard.mathieubpoiriericm.deno.net` to
`https://csvd-dashboard.fly.dev` on 2 November 2026, and `hosting.url`,
`disease/README.md`, `README.md` and the root `CLAUDE.md` name the new address.

Since 4 November 2026 the old address serves a "has moved" page instead of the
dashboard, and so does the legacy Shiny app's,
`https://icm-dashboard.shinyapps.io/published_dashboard_preview/`. Both come
from the private `csvd-dashboard-moved` repository, whose README has the deploy
steps. The page links to the same path on the new host and tells a reader how
to get the passphrase, since a session cookie belongs to its host and everyone
signs in once more there. The Deno Deploy app is linked to that repository now,
so a push here no longer builds there, and its two login secrets are deleted.

Nothing is left to do. The Deno Deploy project goes when Deno Deploy shuts down,
in about April 2027 (no date published), or earlier if the researcher deletes it
in the Deno Deploy console, which cannot be undone.
