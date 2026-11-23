import assert from "node:assert/strict";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { readP407CourseCheckoutScope } from "./p407-course";

const scope = {
  sourceCommit: "b".repeat(40),
  orderId: "11111111-1111-4111-8111-111111111111",
  customerId: "22222222-2222-4222-8222-222222222222",
  courseId: "33333333-3333-4333-8333-333333333333",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const environment = {
  APP_ENV: "staging",
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  VERCEL_GIT_COMMIT_SHA: scope.sourceCommit,
  VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
  APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
  FRONTEND_WRITER_ADMISSION_MODE: "enforce",
  P407_POSTGRES_RELAY_URL: "wss://api-p407.lashher.com/internal/p4-07/postgres",
  P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: "c".repeat(64),
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_LOCATION_ID: "LCW972G6NQNSE",
  P407_CHECKOUT_SCOPE_JSON: JSON.stringify(scope),
};

test("P4-07 scope binds an exact checkout order to the protected staging workload", () => {
  assert.deepEqual(readP407CourseCheckoutScope(environment), scope);
  assert.equal(readP407CourseCheckoutScope({ APP_ENV: "local" }), null);
  for (const change of [
    { VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
    { VERCEL_GIT_COMMIT_SHA: "a".repeat(40) },
    { FRONTEND_WRITER_ADMISSION_MODE: "off" },
    { P407_POSTGRES_RELAY_URL: "wss://elsewhere.invalid" },
    { P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: undefined },
    { P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: "0".repeat(64) },
    { SQUARE_ENVIRONMENT: "production" },
    { SQUARE_LOCATION_ID: "unrelated-location" },
    { P407_CHECKOUT_SCOPE_JSON: undefined },
    { P407_CHECKOUT_SCOPE_JSON: JSON.stringify({ ...scope, expiresAt: "2020-01-01T00:00:00.000Z" }) },
    { P407_CHECKOUT_SCOPE_JSON: JSON.stringify({ ...scope, orderId: "00000000-0000-0000-0000-000000000000" }) },
    { P407_CHECKOUT_SCOPE_JSON: JSON.stringify({ ...scope, unrestricted: true }) },
  ]) assert.throws(() => readP407CourseCheckoutScope({ ...environment, ...change }), /scope refused/);
});
