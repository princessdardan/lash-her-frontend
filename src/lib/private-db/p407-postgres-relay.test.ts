import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { createP407PostgresStream, readP407PostgresRelay } from "./p407-postgres-relay";
import { resolveWriterAdmissionConfiguration } from "@/lib/writer-admission/config";
import { readPostgresRelay } from "./postgres-relay";

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

const p506Endpoint = "wss://api-p506.lashher.com/internal/p5-06/postgres";
const p506Host = "p506-frontend-db.lashher.com";
const p506Name = "lash_her_p506_frontend";
const p506User = "lash_her_p506_frontend_runtime";
const p506Database = `postgresql://${p506User}:fixture-password@${p506Host}:5432/${p506Name}?sslmode=verify-full&channel_binding=require`;
const p506Environment = {
  APP_ENV: staging.APP_ENV,
  APP_VERCEL_TEAM_ID: staging.APP_VERCEL_TEAM_ID,
  VERCEL: staging.VERCEL,
  VERCEL_PROJECT_ID: staging.VERCEL_PROJECT_ID,
  VERCEL_ENV: staging.VERCEL_ENV,
  VERCEL_TARGET_ENV: staging.VERCEL_TARGET_ENV,
  P506_POSTGRES_RELAY_URL: p506Endpoint,
  P506_POSTGRES_RELAY_DEPLOYMENT_PROOF: "b".repeat(64),
};

test("selects the isolated P5-06 stream and retains P4-07 and direct connections", () => {
  assert.equal(readPostgresRelay("postgresql://shared.example.test/db", {}), undefined);
  assert.equal(readPostgresRelay(database, staging)?.qualification, "P4-07");
  const p506 = readPostgresRelay(p506Database, p506Environment);
  assert.equal(p506?.qualification, "P5-06");
  assert.equal(typeof p506?.stream, "function");
  for (const candidate of [
    p506Database,
    p506Database.replace(p506Host, p506Host + "."),
    p506Database.replace(p506Host, "alias.example.test"),
    `postgresql://shared.example.test/db?host=${p506Host}`,
  ]) {
    assert.throws(() => readPostgresRelay(candidate, {}), /P5-06 PostgreSQL relay configuration refused/u);
  }
});

test("P5-06 refuses mixed relay settings and pins the reviewed Vercel project, target and team", () => {
  for (const override of [
    { P407_POSTGRES_RELAY_URL: endpoint },
    { P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: proof },
    { P407_CHECKOUT_SCOPE_JSON: "{}" },
    { P506_POSTGRES_RELAY_URL: p506Endpoint + "?destination=other" },
    { P506_POSTGRES_RELAY_DEPLOYMENT_PROOF: undefined },
    { P506_POSTGRES_RELAY_DEPLOYMENT_PROOF: "0".repeat(64) },
    { VERCEL: undefined },
    { APP_VERCEL_TEAM_ID: "team_other" },
    { VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
    { VERCEL_TARGET_ENV: "preview" },
    { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
  ]) {
    assert.throws(() => readPostgresRelay(p506Database, { ...p506Environment, ...override }),
      /P5-06 PostgreSQL relay configuration refused/u);
  }
});

test("P5-06 refuses alternate database identities and insecure or ambiguous driver options", () => {
  for (const candidate of [
    database,
    p506Database.replace(p506Host, "shared.example.test"),
    p506Database.replace(":5432", ":6432"),
    p506Database.replace(p506User, "lash_her_p506_frontend_migration"),
    p506Database.replace("/" + p506Name, "/lash_her_p506_course"),
    p506Database.replace("verify-full", "require"),
    p506Database.replace("channel_binding=require", "channel_binding=prefer"),
    p506Database + "&sslmode=verify-full",
    p506Database + "&channel_binding=require",
    p506Database + "&host=shared.example.test",
  ]) {
    assert.throws(() => readPostgresRelay(candidate, p506Environment), /P5-06 PostgreSQL relay configuration refused/u);
  }
});

test("writer admission pins both P5-06 database URLs and keeps TLS and channel binding enabled", () => {
  const environment = {
    ...p506Environment,
    DATABASE_URL: p506Database,
    FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_DATABASE_URL: p506Database,
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({
      environment: "staging",
      host: p506Host,
      port: 5432,
      database: p506Name,
      user: p506User,
      serverMajor: 18,
      targetSha256: "c".repeat(64),
    }),
    FRONTEND_WRITER_PRODUCER_SHA256: "d".repeat(64),
    VERCEL_GIT_COMMIT_SHA: "e".repeat(40),
  };
  const configuration = resolveWriterAdmissionConfiguration(environment);
  assert.equal(typeof configuration?.connection.stream, "function");
  assert.equal(configuration?.retryAdmissionLock, true);
  assert.deepEqual(configuration?.connection.ssl, { rejectUnauthorized: true });
  assert.equal(configuration?.connection.enableChannelBinding, true);

  for (const override of [
    { FRONTEND_WRITER_ADMISSION_MODE: "off" },
    { P506_POSTGRES_RELAY_URL: undefined, P506_POSTGRES_RELAY_DEPLOYMENT_PROOF: undefined },
    { DATABASE_URL: p506Database.replace(p506Host, "shared.example.test") },
    { DATABASE_URL: p506Database.replace("channel_binding=require", "channel_binding=prefer") },
    { FRONTEND_WRITER_ADMISSION_DATABASE_URL: p506Database.replace("verify-full", "require") },
  ]) {
    assert.throws(() => resolveWriterAdmissionConfiguration({ ...environment, ...override }),
      /Writer admission configuration/u);
  }
});
