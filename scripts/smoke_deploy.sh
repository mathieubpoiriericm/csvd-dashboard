#!/usr/bin/env bash
# Check a running dashboard from outside, the way a visitor reaches it. This is
# what a deploy has to pass before anyone looks at it. Needs bash and curl.
#
#   scripts/smoke_deploy.sh <base-url>
#
# With SMOKE_PASSPHRASE set it also signs in and opens a gated page. Without
# it, only what a logged-out visitor sees is checked, so it can run against
# production without the secret. With SMOKE_EXPECT_SESSIONS=1 as well, it
# saves and resumes an adaptation-guide session, which needs the passphrase.
# It stops at the first failure, non-zero.
#
# CI's container job runs it against the image with throwaway secrets, and its
# deploy job runs it against the live site after every deploy.

set -euo pipefail

base="${1:?usage: scripts/smoke_deploy.sh <base-url>}"
base="${base%/}"

fail() {
  echo "FAIL $*" >&2
  exit 1
}

ok() {
  echo "ok   $*"
}

# The status code alone; 000 when nothing answered.
status_of() {
  curl -sS -o /dev/null -w '%{http_code}' "$@" || true
}

# 1. The server is up: /login renders without a session.
code=$(status_of "$base/login")
[ "$code" = 200 ] || fail "GET /login answered $code, want 200"
ok "GET /login renders"

# 2. The login secrets are set: a logged-out visitor is sent to /login. With
# either secret unset the gate answers 503 here while /login above still
# renders, because the gate exempts /login before it reads them. That is why
# this, and not /login or Fly's health check, is the configuration check.
read -r code location < <(
  curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "$base/" ||
    echo "000"
)
[ "$code" != 503 ] ||
  fail "GET / answered 503: DASHBOARD_PASSPHRASE or DASHBOARD_SESSION_SECRET is unset"
[ "$code" = 303 ] && [[ "${location:-}" == */login\?next=%2F ]] ||
  fail "GET / answered $code ${location:-with no Location}, want 303 to /login?next=%2F"
ok "GET / sends a logged-out visitor to /login"

# 3. The protected data chunks are refused without a session. The middleware
# matches the file name's shape, not the file, so no build hash is needed;
# step 6 checks the names the build actually emits, when it can sign in.
code=$(status_of "$base/assets/protected-data-smoke.js")
[ "$code" = 401 ] ||
  fail "a logged-out GET of a protected-data chunk answered $code, want 401"
ok "protected data refused without a session"

# Vite's build manifest maps every source file to its chunk. staticFiles()
# does not serve it today; this keeps it that way.
code=$(status_of "$base/.vite/manifest.json")
[ "$code" != 200 ] || fail "GET /.vite/manifest.json answered 200, want it unserved"
ok "the build manifest is not served"

# 4. Responses leave compressed (server/compression.ts), not at full size.
encoding=$(
  curl -sS -o /dev/null -D - -H 'Accept-Encoding: gzip, br' "$base/login" |
    tr -d '\r' |
    awk 'tolower($1) == "content-encoding:" { print tolower($2) }'
)
[[ "$encoding" == gzip || "$encoding" == br ]] ||
  fail "GET /login was not compressed (Content-Encoding: ${encoding:-none})"
ok "GET /login compressed ($encoding)"

# 5. Signing in works end to end, when there is a passphrase to sign in with.
if [ -z "${SMOKE_PASSPHRASE:-}" ]; then
  [ "${SMOKE_EXPECT_SESSIONS:-}" != 1 ] ||
    fail "SMOKE_EXPECT_SESSIONS=1 needs SMOKE_PASSPHRASE: the session routes sit behind the login"
  echo "skip sign-in: SMOKE_PASSPHRASE is unset"
  exit 0
fi

# Sec-Fetch-Site is what a browser sends with the form, and what csrf() in
# main.ts accepts. The passphrase goes in on stdin, never on a command line.
response=$(
  printf '%s' "$SMOKE_PASSPHRASE" |
    curl -sS -o /dev/null -D - -H 'Sec-Fetch-Site: same-origin' \
      --data-urlencode 'passphrase@-' --data-urlencode 'next=/' \
      "$base/login" |
    tr -d '\r'
)
code=$(printf '%s\n' "$response" | awk 'NR == 1 { print $2 }')
[ "$code" = 303 ] ||
  fail "POST /login answered ${code:-nothing}, want 303 (401 is a refused passphrase)"

# The session cookie is replayed by hand rather than through a cookie jar: it
# is Secure on every host but localhost, so curl would withhold it from a
# plain-HTTP address such as a local container's. It is never printed, and it
# reaches curl on stdin too.
cookie=$(
  printf '%s\n' "$response" |
    awk 'tolower($1) == "set-cookie:" && /HttpOnly/ {
      sub(/^[^:]*: */, ""); sub(/;.*/, ""); print; exit
    }'
)
[ -n "$cookie" ] || fail "POST /login set no session cookie"
code=$(printf 'Cookie: %s\n' "$cookie" | status_of -H @- "$base/")
[ "$code" = 200 ] || fail "GET / with the new session answered $code, want 200"
ok "signing in opens the dashboard"

# 6. Every protected chunk a data page loads is refused without a session and
# never cached. Step 3 proves the gate matches the name's shape; this proves
# the names the build emits have that shape, by following /genes to the island
# chunks it boots and the protected chunks those import.
code=$(printf 'Cookie: %s\n' "$cookie" | status_of -H @- "$base/.vite/manifest.json")
[ "$code" != 200 ] ||
  fail "GET /.vite/manifest.json with a session answered 200, want it unserved"
page=$(printf 'Cookie: %s\n' "$cookie" | curl -sS -H @- "$base/genes")
islands=$(
  printf '%s' "$page" |
    grep -oE '/assets/fresh-island__[A-Za-z0-9_-]+\.js' | sort -u || true
)
[ -n "$islands" ] || fail "GET /genes named no island chunk"
chunks=$(
  for island in $islands; do
    curl -sS "$base$island" | grep -oE 'protected-data-[A-Za-z0-9_-]+\.js' || true
  done | sort -u
)
[ -n "$chunks" ] || fail "the /genes islands import no protected-data chunk"
for chunk in $chunks; do
  read -r code cache < <(
    printf 'Cookie: %s\n' "$cookie" |
      curl -sS -o /dev/null -H @- -w '%{http_code} %header{cache-control}\n' \
        "$base/assets/$chunk" || echo "000"
  )
  [ "$code" = 200 ] && [ "${cache:-}" = "private, no-store" ] ||
    fail "GET $chunk with a session answered $code ${cache:-}, want 200 private, no-store"
  code=$(status_of "$base/assets/$chunk")
  [ "$code" = 401 ] ||
    fail "a logged-out GET of $chunk answered $code, want 401"
done
ok "$(wc -w <<<"$chunks" | tr -d ' ') protected chunks /genes loads: 401 logged out, private and no-store signed in"

# 7. The adaptation guide saves and resumes a session on the server, when the
# host is meant to keep them (SMOKE_EXPECT_SESSIONS=1): ADAPT_SESSIONS_DIR is
# set and the directory it names can be written, which the page reports.
if [ "${SMOKE_EXPECT_SESSIONS:-}" != 1 ]; then
  exit 0
fi

# The resume code a save returns opens that session for 14 days, so from here
# on nothing is traced, even under `bash -x`: xtrace would print the code with
# every assignment and printf that holds it. It stays in a variable, reaches
# curl through a pipe or a file descriptor, never on a command line, and no
# message below includes it or a response body that carries it.
#
# Each run leaves one empty session behind for its 14 days, and spends one of
# the per-client requests server/adapt_session_limiter.ts counts.
{ set +x; } 2>/dev/null

page=$(printf 'Cookie: %s\n' "$cookie" | curl -sS -H @- "$base/adapt")
if [[ "$page" != *'data-sessions="on"'* ]]; then
  [[ "$page" != *'data-sessions="off"'* ]] ||
    fail "GET /adapt says sessions are off: ADAPT_SESSIONS_DIR is unset or cannot be written (the server log says which)"
  fail "GET /adapt carries no data-sessions attribute"
fi
# With more than one machine the page names the one that holds the sessions,
# and the guide sends every session request there; so does this.
machine=$(
  printf '%s' "$page" |
    grep -oE 'data-sessions-machine="[0-9A-Fa-f]+"' | head -n 1 |
    cut -d '"' -f 2 || true
)
ok "GET /adapt has sessions on${machine:+ (held by machine $machine)}"

# The headers every session request carries: the session cookie, and what
# csrf() in main.ts accepts.
session_headers() {
  printf 'Cookie: %s\n' "$cookie"
  printf 'Content-Type: application/json\n'
  printf 'Sec-Fetch-Site: same-origin\n'
  if [ -n "$machine" ]; then
    printf 'fly-force-instance-id: %s\n' "$machine"
  fi
}

# The request body is a fixed, public file, so it can be named on the command
# line; tests/adapt/smoke_session_test.ts keeps it an export the server
# accepts. The response holds the code and is never printed.
body_file="$(dirname "$0")/smoke_session.json"
response=$(
  session_headers |
    curl -sS -H @- --data-binary "@$body_file" -w '\n%{http_code}' \
      "$base/adapt/session/create" || true
)
code=${response##*$'\n'}
[ "$code" = 201 ] ||
  fail "POST /adapt/session/create answered $code, want 201"
resume_code=$(
  printf '%s' "${response%$'\n'*}" |
    sed -n 's/.*"code":"\([0-9A-Z]\{20\}\)".*/\1/p'
)
response=
[ -n "$resume_code" ] ||
  fail "POST /adapt/session/create answered 201 without a resume code"
ok "a session saves"

# The resume body holds the code, so it reaches curl on a file descriptor
# rather than as an argument.
code=$(
  session_headers |
    status_of -H @- --data-binary @/dev/fd/3 \
      "$base/adapt/session/resume" 3< <(printf '{"code":"%s"}' "$resume_code")
)
resume_code=
[ "$code" = 200 ] ||
  fail "POST /adapt/session/resume answered $code, want 200"
ok "the saved session resumes"
