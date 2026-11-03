import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedRuntimeTls, runImage, runtimeConnection } from "./host/staging_work_image.mjs";

function fixture(service = "course", mode = "preflight") {
  const target = { host: "ep-owned-fixture.c-14.us-east-1.aws.neon.tech", port: 5432, database: "neondb",
    user: `lash_her_${service}_staging_runtime`, serverMajor: 18 };
  const input = { version: 1, service, mode, target };
  const environment = { NODE_ENV: "production", DATABASE_TARGET: "staging",
    STAGING_DATABASE_URL: `postgresql://${target.user}:owned-private-fixture@${target.host}/neondb?sslmode=verify-full` };
  return { input, environment };
}

test("image adapter derives only exact staging runtime identity and explicit authenticated TLS", () => {
  for (const service of ["course", "community"]) {
    const { input, environment } = fixture(service);
    const config = runtimeConnection(input, environment);
    assert.equal(config.user, input.target.user); assert.equal(config.password, "owned-private-fixture");
    assert.deepEqual(config.ssl, { rejectUnauthorized: true, servername: input.target.host });
    assert.equal(config.max, 1); assert.match(config.options, /default_transaction_read_only=on/u);
  }
});

test("only repository retention mode permits a writable session", () => {
  for (const mode of ["preflight", "outbox", "retain", "fingerprint"]) {
    const { input, environment } = fixture("course", mode);
    assert.equal(runtimeConnection(input, environment).options.includes("default_transaction_read_only=on"), mode !== "retain");
  }
  const { input, environment } = fixture("community", "inbox");
  assert.match(runtimeConnection(input, environment).options, /default_transaction_read_only=on/u);
  input.mode = "retain";
  assert.throws(() => runtimeConnection(input, environment), /SELECTED_MODE/u);
});

test("production selectors, ambient PG configuration and disabled TLS refuse before imports or connections", async () => {
  for (const changes of [{ DATABASE_TARGET: "production" }, { NODE_ENV: "test" }, { PGHOST: "other.invalid" },
    { PGSSLMODE: "disable" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }]) {
    const { input, environment } = fixture();
    await assert.rejects(runImage(input, { ...environment, ...changes }), /SELECTED_RUNTIME_ENVIRONMENT/u);
  }
});

test("migration or owner identity, other host or parameters cannot replace runtime binding", () => {
  for (const change of [url => { url.username = "neondb_owner"; }, url => { url.username = "lash_her_course_staging_migration"; },
    url => { url.hostname = "other.invalid"; }, url => { url.search = "?sslmode=disable"; },
    url => { url.searchParams.set("options", "anything"); }, url => { url.pathname = "/other"; }]) {
    const { input, environment } = fixture(); const url = new URL(environment.STAGING_DATABASE_URL); change(url);
    environment.STAGING_DATABASE_URL = url.toString();
    assert.throws(() => runtimeConnection(input, environment), /RUNTIME_DATABASE_BINDING/u);
  }
  const { input, environment } = fixture(); input.target.extra = "must-not-be-exported";
  assert.throws(() => runtimeConnection(input, environment), /EXACT_RUNTIME_TARGET/u);
});

test("a socket-shaped object cannot stand in for an authenticated Node TLS connection", () => {
  for (const stream of [undefined, {}, { encrypted: true, authorized: true, destroyed: false, getPeerCertificate: () => ({}) }]) {
    assert.equal(authenticatedRuntimeTls({ connection: { stream } }, "owned.invalid"), false);
  }
});
