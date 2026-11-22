import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { createP407PostgresStream, readP407PostgresRelay } from "./p407-postgres-relay";

const endpoint = "wss://api-p407.lashher.com/internal/p4-07/postgres";
const host = "p4-07-db.lashher.com";
const database = "postgresql://lash_her_p407_frontend_runtime:fixture-password@" + host +
  "/lash_her_p407_frontend?sslmode=verify-full";
const proof = "a".repeat(64);
const staging = {
  APP_ENV: "staging",
  APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
  VERCEL: "1",
  VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  P407_POSTGRES_RELAY_URL: endpoint,
  P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: proof,
};

test("the relay is opt-in and has no direct fallback for its isolated database", () => {
  assert.equal(readP407PostgresRelay("postgresql://shared.example.test/db", {}), undefined);
  assert.throws(() => readP407PostgresRelay(database, {}), /configuration refused/u);
  const relay = readP407PostgresRelay(database, staging);
  assert.equal(typeof relay?.stream, "function");
});

test("the relay refuses incomplete, preview, production and alternate endpoint settings", () => {
  for (const override of [
    { P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: undefined },
    { P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: "0".repeat(64) },
    { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
    { APP_ENV: "production", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
    { P407_POSTGRES_RELAY_URL: endpoint + "?destination=other" },
  ]) {
    assert.throws(() => readP407PostgresRelay(database, { ...staging, ...override }), /configuration refused/u);
  }
});

test("the relay refuses a different database identity or weakened PostgreSQL TLS", () => {
  for (const candidate of [
    database.replace(host, "shared.example.test"),
    database.replace(host, host + ":6432"),
    database.replace("frontend_runtime", "frontend_migration"),
    database.replace("/lash_her_p407_frontend", "/lash_her_p407_course"),
    database.replace("verify-full", "require"),
    database + "&sslmode=verify-full",
    database + "&host=shared.example.test",
  ]) {
    assert.throws(() => readP407PostgresRelay(candidate, staging), /configuration refused/u);
  }
});

test("a mismatched socket authority is rejected before obtaining workload proof", async () => {
  let tokenReads = 0;
  const stream = createP407PostgresStream({ endpoint, proof, host, port: 5432 }, async () => {
    tokenReads++;
    return "unused";
  });
  const failed = once(stream, "error");
  stream.connect(5432, "shared.example.test");
  const [error] = await failed;
  assert.match(error.message, /relay unavailable/u);
  assert.equal(tokenReads, 0);
});

test("a request-context credential failure closes the stream with a sanitized error", async () => {
  const stream = createP407PostgresStream({ endpoint, proof, host, port: 5432 }, async () => {
    throw new Error("private token detail");
  });
  const failed = once(stream, "error");
  stream.connect(5432, host);
  const [error] = await failed;
  assert.equal(error.message, "P4-07 PostgreSQL relay unavailable");
});
