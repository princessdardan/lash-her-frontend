import assert from "node:assert/strict";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { resolveCustomerAuthConfiguration } from "@/lib/customer-auth/policy";
import { resolveP407CheckoutScope, selectCourseRecoveryOrder } from "./p407-checkout-scope";

const now = Date.parse("2026-11-23T19:00:00.000Z");
const config = {
  sourceCommit: "a".repeat(40),
  customerId: "03dddf83-63a0-4747-a392-059ed93cfdb0",
  courseId: "d167029b-56ce-48b1-811c-ccf470440607",
  orderId: "6911c2a4-9f70-4b54-afe1-093556e816dc",
  expiresAt: new Date(now + 60_000).toISOString(),
};
const env = {
  P407_CHECKOUT_SCOPE_JSON: JSON.stringify(config),
  P407_POSTGRES_RELAY_URL: "wss://api-p407.lashher.com/internal/p4-07/postgres",
  P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: "1".repeat(64),
  FRONTEND_WRITER_ADMISSION_MODE: "enforce",
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
  APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
  APP_ENV: "staging",
  VERCEL_URL: "lash-her-frontend-staging-58cqxrmzm-dardan-demiris-projects.vercel.app",
  VERCEL_GIT_COMMIT_SHA: config.sourceCommit,
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_LOCATION_ID: "LCW972G6NQNSE",
};

test("binds the exact protected staging source, generated origin and synthetic order", () => {
  assert.deepEqual(resolveP407CheckoutScope(env, now), {
    origin: `https://${env.VERCEL_URL}`,
    customerId: config.customerId,
    courseId: config.courseId,
    orderId: config.orderId,
  });
  assert.equal(resolveP407CheckoutScope({ APP_ENV: "local" }, now), undefined);
});

test("refuses partial, expired, cross-project and non-Sandbox bindings", () => {
  for (const override of [
    { P407_CHECKOUT_SCOPE_JSON: undefined },
    { P407_CHECKOUT_SCOPE_JSON: JSON.stringify({ ...config, wildcard: true }) },
    { P407_CHECKOUT_SCOPE_JSON: JSON.stringify({ ...config, orderId: "*" }) },
    { P407_CHECKOUT_SCOPE_JSON: JSON.stringify({ ...config, expiresAt: new Date(now).toISOString() }) },
    { VERCEL_URL: "lash-her-frontend-staging.vercel.app" },
    { VERCEL_URL: `${env.VERCEL_URL}.example.com` },
    { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) },
    { VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
    { FRONTEND_WRITER_ADMISSION_MODE: "off" },
    { P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: "0".repeat(64) },
    { SQUARE_LOCATION_ID: "OTHER_LOCATION" },
    { SQUARE_ENVIRONMENT: "production" },
  ]) {
    assert.throws(() => resolveP407CheckoutScope({ ...env, ...override }, now));
  }
});

test("customer auth uses the deployment origin and continues to reject a global origin conflict", () => {
  const candidate = {
    ...env,
    P407_CHECKOUT_SCOPE_JSON: JSON.stringify({
      ...config,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    CUSTOMER_AUTH_ENABLED: "true",
    INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true",
    CUSTOMER_AUTH_URL: "https://shared.example.com",
    CUSTOMER_AUTH_SECRET: "x".repeat(32),
    CUSTOMER_AUTH_GOOGLE_ID: "example-id",
    CUSTOMER_AUTH_GOOGLE_SECRET: "example-google",
    CUSTOMER_AUTH_RESEND_KEY: "example-key",
    CUSTOMER_AUTH_EMAIL_FROM: "account@example.com",
  };
  assert.equal(resolveCustomerAuthConfiguration(candidate)?.origin, `https://${env.VERCEL_URL}`);
  assert.throws(() => resolveCustomerAuthConfiguration({
    ...candidate,
    AUTH_URL: candidate.CUSTOMER_AUTH_URL,
  }), /CUSTOMER_AUTH_CONFIGURATION/);
});

test("candidate recovery selects a single exact order, ordinary recovery keeps its existing shape", () => {
  const scope = resolveP407CheckoutScope(env, now)!;
  const url = (suffix: string) => new URL(`/api/internal/course-purchases/recover${suffix}`, scope.origin);
  assert.deepEqual(selectCourseRecoveryOrder(url(""), undefined), {});
  assert.equal(selectCourseRecoveryOrder(url(`?orderId=${scope.orderId}`), undefined), null);
  assert.deepEqual(selectCourseRecoveryOrder(url(`?orderId=${scope.orderId}`), scope), { orderId: scope.orderId });
  assert.deepEqual(selectCourseRecoveryOrder(url(`?orderId=${scope.orderId}&paymentId=fixture_A-1`), scope),
    { orderId: scope.orderId, paymentId: "fixture_A-1" });
  for (const suffix of [
    "",
    `?orderId=${scope.courseId}`,
    `?orderId=${scope.orderId}&orderId=${scope.orderId}`,
    `?orderId=${scope.orderId}&limit=4`,
    `?orderId=${scope.orderId}&paymentId=`,
    `?orderId=${scope.orderId}&paymentId=one&paymentId=two`,
    `?orderId=${scope.orderId}&paymentId=one%2Ftwo`,
    `?%6frderId=${scope.orderId}`,
  ]) {
    assert.equal(selectCourseRecoveryOrder(url(suffix), scope), null);
  }
  assert.equal(selectCourseRecoveryOrder(new URL(`https://shared.example.com/?orderId=${scope.orderId}`), scope), null);
});
