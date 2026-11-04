#!/usr/bin/env bash
# Provisions the self-hosted CI runners on a dedicated Ubuntu Server machine:
# a native PostgreSQL for the database tests, with a database per runner,
# Chromium's system packages, and RUNNERS instances of GitHub's runner, each
# a systemd service with its own E2E_PORT and CSVD_TEST_DB_URL.
#
# Run it as root on that machine. sudo asks for a password there, so copy the
# script over and run it with a terminal attached; piped into ssh, it leaves
# sudo no terminal to ask on. Registering a runner needs a registration token
# fetched where `gh` is signed in (it lasts an hour and registers every
# instance); a re-run that registers nothing needs none:
#
#   token=$(gh api -X POST \
#     repos/mathieubpoiriericm/csvd-dashboard-private/actions/runners/registration-token \
#     --jq .token)
#   scp .claude/skills/ci-runner/provision.sh minipc:
#   ssh -t minipc "sudo RUNNER_TOKEN=$token bash ~/provision.sh"
#
# Re-running it is safe: an instance that is already configured is left alone,
# so raising RUNNERS adds the missing ones. It restarts every runner service at
# the end, so run it while no CI job is running. Never point REPO_URL at the
# public repository -- a fork's pull request would run its code on this
# machine.
#
# RETIRE_DOCKER=1 also removes Docker, which the runners used for postgres
# service containers before the native server: the package and what came with
# it, its images, the runner user's docker group (which made every CI job
# root-equivalent), and the weekly prune timer.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/mathieubpoiriericm/csvd-dashboard-private}
RUNNERS=${RUNNERS:-12}
LABEL=${LABEL:-csvd-ci}
# e2e/package.json's @playwright/test. Re-run this script with the new one
# after an upgrade: the workflow skips --with-deps on a self-hosted runner.
PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION:-1.64.1}
RUNNER_USER=runner
RUNNER_HOME=/home/$RUNNER_USER
PG_ROLE=csvd_ci
PG_PASSWORD_FILE=/etc/csvd-ci/postgres-password

if [[ $EUID -ne 0 ]]; then
  echo "run as root (sudo)" >&2
  exit 1
fi

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
# nodejs/npm only run the one-off install-deps below; jobs get their Node
# from actions/setup-node. unzip and xz-utils are what the setup actions
# extract their downloads with.
apt-get install -y postgresql-18 openssl git curl jq unzip xz-utils \
  ca-certificates nodejs npm unattended-upgrades

echo "== the runner user (no sudo, no docker)"
id "$RUNNER_USER" &>/dev/null || useradd --create-home --shell /bin/bash "$RUNNER_USER"

echo "== PostgreSQL for the database tests"
# Every database on this server is a throwaway the fixture creates, migrates
# and drops, so durability buys nothing: a crash at worst means re-running
# this script. Loopback only.
cat >/etc/postgresql/18/main/conf.d/csvd-ci.conf <<'EOF'
listen_addresses = 'localhost'
fsync = off
synchronous_commit = off
full_page_writes = off
max_connections = 200
EOF
systemctl enable postgresql
systemctl restart postgresql
if [[ ! -s $PG_PASSWORD_FILE ]]; then
  install -d -m 700 "$(dirname "$PG_PASSWORD_FILE")"
  openssl rand -hex 24 >"$PG_PASSWORD_FILE"
  chmod 600 "$PG_PASSWORD_FILE"
fi
pg_password=$(cat "$PG_PASSWORD_FILE")
# CREATEDB because each pytest-xdist worker creates and drops a database of
# its own (tests/xdist_databases.py); nothing in the migrations needs more.
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PG_ROLE') THEN
    CREATE ROLE $PG_ROLE;
  END IF;
END \$\$;
ALTER ROLE $PG_ROLE WITH LOGIN CREATEDB NOSUPERUSER PASSWORD '$pg_password';
SQL

echo "== Chromium's system packages, for Playwright $PLAYWRIGHT_VERSION"
npx -y "playwright@$PLAYWRIGHT_VERSION" install-deps chromium

echo "== GitHub's runner"
release=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)
version=$(jq -r .tag_name <<<"$release" | sed 's/^v//')
sha=$(jq -r .body <<<"$release" |
  sed -n 's/.*<!-- BEGIN SHA linux-x64 -->\([0-9a-f]\{64\}\)<!-- END SHA linux-x64 -->.*/\1/p')
if [[ -z $sha ]]; then
  echo "no linux-x64 checksum in the v$version release notes; not installing" >&2
  exit 1
fi
tarball=$RUNNER_HOME/actions-runner-linux-x64-$version.tar.gz

for i in $(seq 1 "$RUNNERS"); do
  dir=$RUNNER_HOME/runner-$i
  if [[ -f $dir/.runner ]]; then
    echo "== runner-$i is already configured"
  else
    echo "== runner-$i"
    : "${RUNNER_TOKEN:?set RUNNER_TOKEN to a registration token; see the header}"
    if [[ ! -f $tarball ]]; then
      curl -fsSLo "$tarball" \
        "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz"
    fi
    echo "$sha  $tarball" | sha256sum -c -
    mkdir -p "$dir"
    tar -xzf "$tarball" -C "$dir"
    chown -R "$RUNNER_USER:" "$dir"
    sudo -u "$RUNNER_USER" bash -c "cd '$dir' && ./config.sh --unattended \
      --url '$REPO_URL' --token '$RUNNER_TOKEN' \
      --name 'ryzen-$i' --labels '$LABEL' --work _work --replace"
    (cd "$dir" && ./svc.sh install "$RUNNER_USER")
  fi
  # A database of the runner's own, so two jobs never share one: the
  # pytest-xdist workers of a job on this runner create csvd_ci_r<i>_gw<n>
  # beside it. Several jobs share this host, so each instance also serves the
  # e2e build on its own port; playwright.config.ts reads E2E_PORT. config.sh's
  # env.sh keeps an existing .env and appends to it, so these go in after it.
  db=${PG_ROLE}_r$i
  if [[ -z $(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'") ]]; then
    sudo -u postgres createdb --owner "$PG_ROLE" "$db"
  fi
  touch "$dir/.env"
  sed -i '/^E2E_PORT=/d; /^CSVD_TEST_DB_URL=/d' "$dir/.env"
  {
    echo "E2E_PORT=$((8100 + i))"
    echo "CSVD_TEST_DB_URL=postgresql://$PG_ROLE:$pg_password@127.0.0.1:5432/$db"
  } >>"$dir/.env"
  chown "$RUNNER_USER:" "$dir/.env"
  chmod 600 "$dir/.env"
done

if [[ ${RETIRE_DOCKER:-0} == 1 ]]; then
  echo "== retiring Docker"
  systemctl disable --now ci-docker-prune.timer 2>/dev/null || true
  rm -f /etc/systemd/system/ci-docker-prune.service /etc/systemd/system/ci-docker-prune.timer
  systemctl daemon-reload
  gpasswd -d "$RUNNER_USER" docker 2>/dev/null || true
  if dpkg -s docker.io &>/dev/null; then
    apt-get purge -y --autoremove docker.io
  fi
  rm -rf /var/lib/docker /var/lib/containerd
fi

echo "== restarting the runners, so each reads its .env and groups afresh"
systemctl daemon-reload
for i in $(seq 1 "$RUNNERS"); do
  (cd "$RUNNER_HOME/runner-$i" && ./svc.sh stop >/dev/null 2>&1 || true; ./svc.sh start)
done

echo "== done"
systemctl list-units --no-pager 'actions.runner.*'
sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname LIKE '${PG_ROLE}_r%' ORDER BY 1" | tr '\n' ' '
echo
