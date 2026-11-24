import assert from "node:assert/strict";
import test from "node:test";
import { resolveCustomerAuthConfiguration } from "@/lib/customer-auth/policy";
import { VERCEL_PROJECT_BINDINGS } from "./application-environment.mjs";
import { matchesP506OriginHeaders, permitsP506CandidateRequest, resolveP506CandidateOrigin } from "./p506-candidate-origin";

const host = "lash-her-frontend-staging-abcdef123-dardan-demiris-projects.vercel.app";
const origin = `https://${host}`;
const commit = "a".repeat(40);
const migrationReceiptSha256 = "b".repeat(64);
const database = "postgresql://lash_her_p506_frontend_runtime:fixture@p506-frontend-db.lashher.com:5432/lash_her_p506_frontend?sslmode=verify-full&channel_binding=require";
const env = {
  VERCEL: "1", VERCEL_URL: host, VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
  VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
  APP_ENV: "staging", APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
  API_GATEWAY_STAGING_ORIGIN: "https://api-p506.lashher.com",
  P506_POSTGRES_RELAY_URL: "wss://api-p506.lashher.com/internal/p5-06/postgres",
  P506_POSTGRES_RELAY_DEPLOYMENT_PROOF: "c".repeat(64),
  FRONTEND_WRITER_ADMISSION_MODE: "enforce",
  DATABASE_URL: database, FRONTEND_WRITER_ADMISSION_DATABASE_URL: database,
  VERCEL_GIT_COMMIT_SHA: commit, STAGING_P5_06_BUILD_PINS: JSON.stringify({ commit, migrationReceiptSha256 }),
  STAGING_P5_06_MIGRATION_RECEIPT_SHA256: migrationReceiptSha256,
};

test("resolves only the generated origin of the qualified P5-06 deployment", () => {
  assert.equal(resolveP506CandidateOrigin({}), undefined);
  assert.equal(resolveP506CandidateOrigin({ AUTH_URL: "https://staging.lashher.com" }), undefined);
  assert.equal(resolveP506CandidateOrigin(env), origin);
  assert.equal(resolveP506CandidateOrigin({
    ...env, AUTH_URL: "", NEXTAUTH_URL: "", CUSTOMER_AUTH_URL: "", AUTH_REDIRECT_PROXY_URL: "",
    P407_CHECKOUT_SCOPE_JSON: "", P407_POSTGRES_RELAY_URL: "", P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: "",
  }), origin);
  assert.equal(resolveP506CandidateOrigin({ ...env, AUTH_URL: origin, CUSTOMER_AUTH_URL: origin + "/" }), origin);
  const overrides = [
    { VERCEL_URL: "staging.lashher.com" },
    { VERCEL_URL: host + ":443" },
    { VERCEL_URL: host + ".other.example" },
    { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
    { VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
    { APP_VERCEL_TEAM_ID: "team_other" },
    { VERCEL_GIT_COMMIT_SHA: "d".repeat(40) },
    { STAGING_P5_06_MIGRATION_RECEIPT_SHA256: "d".repeat(64) },
    { P506_POSTGRES_RELAY_DEPLOYMENT_PROOF: undefined },
    { P407_CHECKOUT_SCOPE_JSON: "{}" },
    { DATABASE_URL: database.replace("channel_binding=require", "channel_binding=prefer") },
    { FRONTEND_WRITER_ADMISSION_DATABASE_URL: database.replace("/lash_her_p506_frontend", "/unrelated") },
    { API_GATEWAY_STAGING_ORIGIN: "https://api-staging.lashher.com" },
    { FRONTEND_WRITER_ADMISSION_MODE: "off" },
    { AUTH_URL: "https://staging.lashher.com" },
    { NEXTAUTH_URL: "https://elsewhere.example.com" },
    { CUSTOMER_AUTH_URL: "https://elsewhere.example.com" },
    { AUTH_REDIRECT_PROXY_URL: "https://elsewhere.example.com" },
  ];
  for (const override of overrides) {
    assert.throws(() => resolveP506CandidateOrigin({ ...env, ...override }), /candidate origin refused/u);
  }
});

test("rejects other URLs and inconsistent Auth.js forwarded headers before handling candidate requests", () => {
  const validHeaders = { host, "x-forwarded-host": host, "x-forwarded-proto": "https" };
  const url = origin + "/api/auth/callback/google";
  assert(matchesP506OriginHeaders(new Headers(validHeaders), origin));
  assert(permitsP506CandidateRequest(new Request(url, { headers: validHeaders }), env));
  assert(!permitsP506CandidateRequest(new Request("https://staging.lashher.com/api/auth/session", { headers: validHeaders }), env));
  for (const override of [
    { host: "staging.lashher.com" },
    { "x-forwarded-host": "staging.lashher.com" },
    { "x-forwarded-host": `${host}, staging.lashher.com` },
    { "x-forwarded-proto": "http" },
  ]) {
    const request = new Request(url, { headers: { ...validHeaders, ...override } });
    assert(!permitsP506CandidateRequest(request, env));
  }
  assert(!permitsP506CandidateRequest(new Request(url, { headers: validHeaders }), { ...env, VERCEL_URL: undefined }));
});

test("customer auth uses the qualified origin when inherited auth URLs are cleared", () => {
  const customerEnv = {
    ...env, AUTH_URL: "", NEXTAUTH_URL: "", CUSTOMER_AUTH_URL: "",
    CUSTOMER_AUTH_ENABLED: "true", INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true",
    CUSTOMER_AUTH_SECRET: "d".repeat(32), CUSTOMER_AUTH_GOOGLE_ID: "candidate-customer",
    CUSTOMER_AUTH_GOOGLE_SECRET: "customer-google-fixture", CUSTOMER_AUTH_RESEND_KEY: "customer-resend-fixture",
    CUSTOMER_AUTH_EMAIL_FROM: "Candidate <candidate@example.invalid>",
    AUTH_SECRET: "e".repeat(32), AUTH_GOOGLE_ID: "candidate-admin", AUTH_GOOGLE_SECRET: "admin-google-fixture",
  };
  assert.equal(resolveCustomerAuthConfiguration(customerEnv)?.origin, origin);
  assert.throws(() => resolveCustomerAuthConfiguration({ ...customerEnv, CUSTOMER_AUTH_SECRET: customerEnv.AUTH_SECRET }), /CUSTOMER_AUTH_CONFIGURATION/u);
  assert.throws(() => resolveCustomerAuthConfiguration({ ...customerEnv, AUTH_URL: "https://staging.lashher.com" }), /candidate origin refused/u);
});
