#!/bin/sh
set -eu

: "${COMMUNITY_E2E_COURSE_ROOT:?Set the path to the pinned Course checkout}"
: "${COMMUNITY_E2E_COMMUNITY_ROOT:?Set the path to the pinned Community checkout}"
: "${COMMUNITY_E2E_COURSE_DATABASE_URL:?Set the disposable Course database URL}"
: "${COMMUNITY_E2E_COMMUNITY_DATABASE_URL:?Set the disposable Community database URL}"
node --input-type=module - <<'JS'
import assert from "node:assert/strict";
assert.equal(process.env.COMMUNITY_E2E, "1");
for (const service of ["course", "community"]) {
  const url = new URL(process.env[`COMMUNITY_E2E_${service.toUpperCase()}_DATABASE_URL`]);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, `/lash_community_${service}_test`);
  assert.equal(url.search, "?sslmode=disable");
}
JS

support=$(cd "$(dirname "$0")" && pwd)
reader=synthetic-community-course-authority-and-reader-credential
course_pid= community_pid= relay_pid= media_pid=
cleanup() {
  for pid in $course_pid $community_pid $relay_pid $media_pid; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait
}
trap cleanup EXIT
trap 'exit 1' INT TERM

(
  cd "$COMMUNITY_E2E_COURSE_ROOT"
  exec env -i PATH="$PATH" NODE_ENV=test HTTP_BIND_ADDRESS=127.0.0.1 PORT=4107 \
    DATABASE_TARGET=test DOTENV_CONFIG_PATH=/dev/null TEST_DATABASE_URL="$COMMUNITY_E2E_COURSE_DATABASE_URL" \
    COURSE_LEARNER_JWT_CURRENT_SECRET=synthetic-academy-learner-and-fastify-fixture-shared-key \
    COURSE_ADMIN_JWT_CURRENT_SECRET=synthetic-community-course-support-signer-for-revocation-fixture \
    COURSE_COMMUNITY_READ_JWT_CURRENT_SECRET="$reader" COURSE_COMMUNITY_READ_ALLOWED_IPS=127.0.0.1 \
    node --import tsx src/server.ts
) &
course_pid=$!

if [ "${COMMUNITY_MEDIA_E2E:-}" = 1 ]; then
  env -i PATH="$PATH" COMMUNITY_MEDIA_E2E=1 node "$support/community-media-s3.mjs" &
  media_pid=$!
  set -- COMMUNITY_MEDIA_BUCKET=community-media-fixture COMMUNITY_MEDIA_REGION=us-east-1 \
    COMMUNITY_MEDIA_TEST_ENDPOINT=http://127.0.0.1:4110 AWS_EC2_METADATA_DISABLED=true \
    AWS_ACCESS_KEY_ID=community-media-test AWS_SECRET_ACCESS_KEY=synthetic-private-media-object-storage-key
else
  set --
fi

(
  cd "$COMMUNITY_E2E_COMMUNITY_ROOT"
  exec env -i "$@" PATH="$PATH" NODE_ENV=test HTTP_BIND_ADDRESS=127.0.0.1 PORT=4108 \
    DATABASE_TARGET=test DOTENV_CONFIG_PATH=/dev/null TEST_DATABASE_URL="$COMMUNITY_E2E_COMMUNITY_DATABASE_URL" \
    COMMUNITY_MEMBER_JWT_CURRENT_SECRET=synthetic-community-member-signer-and-api-session-fixture \
    COMMUNITY_ADMIN_JWT_CURRENT_SECRET=synthetic-community-moderator-signer-and-api-session-fixture \
    COMMUNITY_READER_JWT_CURRENT_SECRET="$reader" COURSE_API_BASE_URL=http://127.0.0.1:4109 \
    COURSE_PUBLISHER_JWT_CURRENT_SECRET=synthetic-community-course-enrollment-publisher-fixture-key \
    COURSE_PUBLISHER_ALLOWED_IPS=127.0.0.1 \
    node --import tsx src/server.ts
) &
community_pid=$!

env -i PATH="$PATH" node "$support/community-authority-fixture.mjs" &
relay_pid=$!
wait "$course_pid" "$community_pid" "$relay_pid"
