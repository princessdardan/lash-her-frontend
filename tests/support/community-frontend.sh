#!/bin/sh
set -eu

: "${COMMUNITY_E2E_FRONTEND_DATABASE_URL:?Set the disposable frontend database URL}"
: "${COMMUNITY_E2E_FIXTURE_DIRECTORY:?Set the temporary fixture directory}"
: "${LASH_LOCAL_NEXT_LAUNCHER:?Set the absolute path to scripts/run-local-next.mjs}"
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
node --input-type=module - <<'JS'
import assert from "node:assert/strict";
assert.equal(process.env.COMMUNITY_E2E, "1");
const url = new URL(process.env.COMMUNITY_E2E_FRONTEND_DATABASE_URL);
assert.equal(url.protocol, "postgresql:");
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/lash_community_frontend_test");
assert.equal(url.search, "?sslmode=disable");
assert.equal(process.env.VERCEL_OIDC_TOKEN?.split(".").at(-1), "fixture");
assert.match(process.env.COMMUNITY_E2E_FIXTURE_DIRECTORY, /^\/(?:private\/)?tmp\/lash-p506-browser\.[A-Za-z0-9]+$/u);
JS
bindings=$(node --input-type=module -e '
  import { SANITY_PROJECT_BINDINGS as sanity, VERCEL_PROJECT_BINDINGS as vercel } from "./src/lib/env/application-environment.mjs";
  process.stdout.write([sanity.stagingProjectId, vercel.teamId, vercel.stagingProjectId].join(" "));
')
IFS=' ' read -r sanity_project vercel_team vercel_project <<EOF
$bindings
EOF
exec env -i PATH="$PATH" USER="$(id -un)" NODE_ENV=development APP_ENV=staging \
  VERCEL=1 VERCEL_ENV=production VERCEL_TARGET_ENV=production \
  APP_VERCEL_TEAM_ID="$vercel_team" VERCEL_PROJECT_ID="$vercel_project" \
  VERCEL_OIDC_TOKEN="$VERCEL_OIDC_TOKEN" NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SANITY_PROJECT_ID="$sanity_project" NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
  DATABASE_URL="$COMMUNITY_E2E_FRONTEND_DATABASE_URL" \
  COURSE_LEARNER_JWT_CURRENT_SECRET=synthetic-academy-learner-and-fastify-fixture-shared-key \
  COMMUNITY_MEMBER_JWT_CURRENT_SECRET=synthetic-community-member-signer-and-api-session-fixture \
  COMMUNITY_ADMIN_JWT_CURRENT_SECRET=synthetic-community-moderator-signer-and-api-session-fixture \
  CUSTOMER_AUTH_URL=http://127.0.0.1:3120 CUSTOMER_AUTH_ENABLED=true \
  CUSTOMER_AUTH_SECRET=synthetic-community-local-customer-session-binding \
  CUSTOMER_AUTH_GOOGLE_ID=synthetic-community-customer-google-id \
  CUSTOMER_AUTH_GOOGLE_SECRET=synthetic-community-customer-google-secret \
  CUSTOMER_AUTH_RESEND_KEY=synthetic-community-customer-resend-key \
  CUSTOMER_AUTH_EMAIL_FROM=fixture@community-fixture.invalid \
  AUTH_URL=http://127.0.0.1:3120 AUTH_TRUST_HOST=true \
  AUTH_SECRET=synthetic-community-authjs-local-moderator-session-fixture \
  INTEGRATION_CUSTOMER_ACCESS_ENABLED=true INTEGRATION_LEGACY_PROGRESS_IMPORT_ENABLED=false \
  INTEGRATION_COURSE_READS_ENABLED=true INTEGRATION_LEARNING_ROUTES_ENABLED=true FRONTEND_WRITER_ADMISSION_MODE=off \
  INTEGRATION_COMMUNITY_READS_ENABLED=true INTEGRATION_COMMUNITY_WRITES_ENABLED=true \
  INTEGRATION_COMMUNITY_MEDIA_ENABLED=true HIGHLEVEL_TRACKING_ENABLED=false \
  COMMUNITY_E2E=1 COMMUNITY_E2E_INVALID_RESPONSE=1 \
  API_GATEWAY_STAGING_ORIGIN=https://127.0.0.1:4113 \
  NODE_OPTIONS="--require=$root/tests/support/community-fetch-fixture.cjs" \
  NODE_EXTRA_CA_CERTS="$COMMUNITY_E2E_FIXTURE_DIRECTORY/tls-cert.pem" \
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$root/tests/support/public-course-font-fixture.cjs" \
  node "$LASH_LOCAL_NEXT_LAUNCHER" --app-dir "$root" dev --hostname 127.0.0.1 --port 3120
