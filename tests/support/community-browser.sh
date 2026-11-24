#!/bin/sh
set -eu
umask 077

: "${COMMUNITY_E2E_COURSE_ROOT:?Set the path to the pinned Course checkout}"
: "${COMMUNITY_E2E_COMMUNITY_ROOT:?Set the path to the pinned Community checkout}"
root=$(cd "$(dirname "$0")/../.." && pwd)
export COMMUNITY_E2E_COURSE_ROOT=$(cd "$COMMUNITY_E2E_COURSE_ROOT" && pwd)
export COMMUNITY_E2E_COMMUNITY_ROOT=$(cd "$COMMUNITY_E2E_COMMUNITY_ROOT" && pwd)
for project in "$root" "$COMMUNITY_E2E_COURSE_ROOT" "$COMMUNITY_E2E_COMMUNITY_ROOT"; do
  if [ ! -d "$project/node_modules" ]; then
    printf 'Install locked dependencies in %s before running the fixture.\n' "$project" >&2
    exit 1
  fi
done
for dotenv in "$root/.env" "$root/.env.local" "$root/.env.development" "$root/.env.development.local"; do
  if [ -e "$dotenv" ]; then
    printf 'Use a disposable frontend checkout without %s.\n' "$dotenv" >&2
    exit 1
  fi
done
node -e 'if (process.versions.node.split(".")[0] !== "24") throw new Error("Use Node 24.")'

fixture=$(mktemp -d /tmp/lash-p506-browser.XXXXXX)
printf 'Community browser logs are in %s\n' "$fixture"
export COMMUNITY_E2E_FIXTURE_DIRECTORY="$fixture"
export COMMUNITY_E2E=1 COMMUNITY_MEDIA_E2E=1 COMMUNITY_E2E_INVALID_RESPONSE=1
export LASH_LOCAL_NEXT_LAUNCHER="$root/scripts/run-local-next.mjs"
export VERCEL_OIDC_TOKEN=$(node -e '
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  process.stdout.write(`${encode({ alg: "HS256" })}.${encode({ exp })}.fixture`);
')
api_pid= gateway_pid= next_pid=
cleanup() {
  for pid in $next_pid $gateway_pid $api_pid; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in $next_pid $gateway_pid $api_pid; do wait "$pid" 2>/dev/null || true; done
  if pg_ctl -D "$fixture/db" status >/dev/null 2>&1; then
    pg_ctl -D "$fixture/db" -m fast -w stop >/dev/null
  fi
  rm -rf "$fixture/db" "$fixture/tls-key.pem" "$fixture/database-password"
  rm -f "$fixture/admission.json" "$fixture/admission.json.next"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')
password=$(openssl rand -hex 24)
printf '%s\n' "$password" > "$fixture/database-password"
initdb -D "$fixture/db" --username=p506_fixture --auth-local=trust --auth-host=scram-sha-256 \
  --pwfile="$fixture/database-password" --no-locale --encoding=UTF8 >"$fixture/initdb.log"
rm "$fixture/database-password"
pg_ctl -D "$fixture/db" -o "-h 127.0.0.1 -p $port -k $fixture" -l "$fixture/postgres.log" -w start
for role in frontend course community; do
  env PGPASSWORD="$password" createdb -h 127.0.0.1 -p "$port" -U p506_fixture "lash_community_${role}_test"
done
base="postgresql://p506_fixture:$password@127.0.0.1:$port"
export COMMUNITY_E2E_FRONTEND_DATABASE_URL="$base/lash_community_frontend_test?sslmode=disable"
export COMMUNITY_E2E_COURSE_DATABASE_URL="$base/lash_community_course_test?sslmode=disable"
export COMMUNITY_E2E_COMMUNITY_DATABASE_URL="$base/lash_community_community_test?sslmode=disable"

migrate() {
  (
    cd "$1"
    shift
    env -i PATH="$PATH" USER="$(id -un)" "$@" npm run db:migrate
  )
}
if ! migrate "$root" CI=true PRIVATE_DB_MIGRATION_TARGET=local PRIVATE_DB_MIGRATION_HOST=127.0.0.1 \
  DATABASE_URL="$COMMUNITY_E2E_FRONTEND_DATABASE_URL" >"$fixture/frontend-migrate.log" 2>&1 ||
  ! migrate "$COMMUNITY_E2E_COURSE_ROOT" NODE_ENV=test DATABASE_TARGET=test DOTENV_CONFIG_PATH=/dev/null \
  TEST_DATABASE_URL="$COMMUNITY_E2E_COURSE_DATABASE_URL" >"$fixture/course-migrate.log" 2>&1 ||
  ! migrate "$COMMUNITY_E2E_COMMUNITY_ROOT" NODE_ENV=test DATABASE_TARGET=test DOTENV_CONFIG_PATH=/dev/null \
  TEST_DATABASE_URL="$COMMUNITY_E2E_COMMUNITY_DATABASE_URL" >"$fixture/community-migrate.log" 2>&1; then
  tail -15 "$fixture/"*-migrate.log
  exit 1
fi
cd "$root"
psql -X "$COMMUNITY_E2E_COURSE_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f tests/fixtures/public-course-catalog.sql
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$fixture/tls-key.pem" \
  -out "$fixture/tls-cert.pem" -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 >"$fixture/tls.log" 2>&1
sh tests/support/community-apis.sh >"$fixture/apis.log" 2>&1 &
api_pid=$!
node tests/support/community-gateway-fixture.mjs >"$fixture/gateway.log" 2>&1 &
gateway_pid=$!
sh tests/support/community-frontend.sh >"$fixture/frontend.log" 2>&1 &
next_pid=$!

wait_http() {
  for attempt in $(seq 1 60); do
    if curl --silent --fail --output /dev/null --max-time 3 "$1"; then return; fi
    kill -0 "$2" 2>/dev/null || break
    sleep 1
  done
  return 1
}
if ! wait_http http://127.0.0.1:4107/health "$api_pid" ||
   ! wait_http http://127.0.0.1:4108/health "$api_pid" ||
   ! wait_http http://127.0.0.1:4110/fixture/objects "$api_pid" ||
   ! wait_http http://127.0.0.1:3120/favicon.ico "$next_pid" ||
   ! kill -0 "$gateway_pid"; then
  tail -35 "$fixture/apis.log" "$fixture/gateway.log" "$fixture/frontend.log"
  exit 1
fi
if ! node node_modules/@playwright/test/cli.js test -c tests/community.playwright.config.ts --global-timeout=480000 "$@" >"$fixture/browser.log" 2>&1; then
  tail -90 "$fixture/browser.log"
  exit 1
fi
cat "$fixture/browser.log"
