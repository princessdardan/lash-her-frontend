// Only the parent-owned disposable TLS/SCRAM cluster. Real route/SDK/database,
// synthetic workload token and intercepted public gateway response; no provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Client } from "pg";
import { readMigrationCatalog } from "../frontend-schema.mjs";
import { changeFrontendAdmission } from "../frontend-admission.mjs";

let phase = "configuration";
async function main() {
  assert.equal(process.env.FRONTEND_BOOTSTRAP_PROBE_OWNED_TEST, "true");
  const port = Number(process.env.OWNED_RECONCILIATION_PORT), password = process.env.OWNED_RECONCILIATION_PASSWORD;
  const major = Number(process.env.OWNED_RECONCILIATION_MAJOR);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536 && [16, 18].includes(major));
  assert.match(password ?? "", /^owned-[a-f0-9-]{36}$/u);
  const target = { environment: "staging", host: "127.0.0.1", port, database: "frontend_admission_owned", user: "frontend_admission_protocol", serverMajor: major, targetSha256: "a".repeat(64) };
  const { VERCEL_PROJECT_BINDINGS } = await import("../../../src/lib/env/application-environment.mjs");
  const { BOOTSTRAP_DISABLED_FEATURES } = await import("../../../src/lib/writer-admission/bootstrap-probe.ts");
  const secret = "d".repeat(64), challenge = "e".repeat(64);
  const url = `postgresql://${target.user}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`;
  const workload = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.synthetic`;
  Object.assign(process.env, Object.fromEntries(BOOTSTRAP_DISABLED_FEATURES.map(name => [name, "false"])), {
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url,
    FRONTEND_WRITER_ADMISSION_MODE: "enforce", FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify(target),
    FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64), VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    VERCEL_OIDC_TOKEN: workload, LASH_RELEASE_PROBE_SECRET: secret, LASH_RELEASE_PROBE_EXPIRES_AT: String(Date.now() + 60_000),
    API_GATEWAY_STAGING_ORIGIN: "https://gateway.example.invalid",
  });
  delete process.env.VERCEL_OIDC_TOKEN_FILE;
  const operator = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin", password,
    ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
  await operator.connect();
  let server, calls = 0;
  const nativeFetch = globalThis.fetch, checks = [];
  let epoch = (await operator.query("SELECT epoch::text FROM frontend_admission.control")).rows[0].epoch;
  const change = async (newWork, recovery) => { epoch = (await changeFrontendAdmission(operator, target, epoch, { newWork, recovery })).epoch; };
  try {
    await change(false, false);
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), selected = new URL(request.url);
      if (server && selected.origin === `http://127.0.0.1:${server.address().port}`) return nativeFetch(input, init);
      assert.equal(selected.origin, "https://gateway.example.invalid");
      assert.equal(selected.pathname, "/course/v1/courses"); assert.equal(request.method, "GET");
      assert.equal(request.headers.get("x-lash-workload-token"), workload);
      calls++; return Response.json({ courses: [] });
    };
    const { GET, HEAD } = await import("../../../src/app/api/internal/release-probe/route.ts");
    server = createServer(async (incoming, outgoing) => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value);
        const result = incoming.method === "HEAD" ? HEAD() : await GET(new Request(`http://127.0.0.1${incoming.url}`, { headers }));
        outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
      } catch { outgoing.writeHead(500); outgoing.end(); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const request = async (headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/internal/release-probe`, {
      headers: { authorization: `Bearer ${secret}`, "x-lash-release-challenge": challenge, "x-lash-release-mode": "admission-bootstrap", ...headers },
    });
    phase = "actual-protected-route";
    const before = (await operator.query("SELECT count(*)::int AS count FROM frontend_admission.operations")).rows[0].count;
    const expectedHash = createHash("sha256").update(JSON.stringify(await readMigrationCatalog(operator))).digest("hex");
    phase = "initial-http-status";
    const response = await request(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    phase = "initial-probe-binding";
    const data = await response.json();
    assert.equal(data.challenge, challenge); assert.deepEqual(data.checks, ["gateway-course-catalog", "frontend-admission-bootstrap"]);
    assert.equal(data.schemaCatalogSha256, expectedHash);
    assert.deepEqual(data.admission, { environment: "staging", targetSha256: target.targetSha256, producerSha256: "b".repeat(64), sourceCommit: "c".repeat(40), epoch, newWork: false, recovery: false });
    assert.deepEqual(data.featureControls, Object.fromEntries(BOOTSTRAP_DISABLED_FEATURES.map(name => [name, false])));
    assert.equal("appliedLineageSha256" in data, false);
    for (const privateValue of [password, secret, workload, "frontend_admission_protocol"]) assert.equal(JSON.stringify(data).includes(privateValue), false);
    assert.equal((await operator.query("SELECT count(*)::int AS count FROM frontend_admission.operations")).rows[0].count, before);
    checks.push("actual-http-export-sdk-current-policy-runtime-tls-and-schema-hash-without-journal-access-or-ledger-writes");
    phase = "auth-and-mode-refusal";
    const callsBefore = calls;
    assert.equal((await request({ authorization: "Bearer wrong" })).status, 401);
    assert.equal((await request({ "x-lash-release-mode": "unknown" })).status, 400);
    assert.equal((await request({ "x-lash-release-challenge": "invalid" })).status, 400);
    assert.equal(calls, callsBefore);
    checks.push("invalid-authentication-mode-and-challenge-refuse-before-sdk-or-database");
    phase = "feature-control-refusal";
    for (const name of BOOTSTRAP_DISABLED_FEATURES) {
      process.env[name] = "true";
      assert.equal((await request()).status, 503);
      process.env[name] = "false";
    }
    checks.push("each-new-feature-control-must-be-explicitly-disabled");
    phase = "open-ledger-and-source-refusal";
    await change(true, false); assert.equal((await request()).status, 503); await change(false, false);
    await change(false, true); assert.equal((await request()).status, 503); await change(false, false);
    process.env.VERCEL_GIT_COMMIT_SHA = "f".repeat(40); assert.equal((await request()).status, 503); process.env.VERCEL_GIT_COMMIT_SHA = "c".repeat(40);
    checks.push("open-admission-recovery-or-unregistered-source-refuse");
    phase = "read-only-postconditions";
    assert.equal(createHash("sha256").update(JSON.stringify(await readMigrationCatalog(operator))).digest("hex"), expectedHash);
    assert.equal((await operator.query("SELECT count(*)::int AS count FROM frontend_admission.operations")).rows[0].count, before);
    console.log(JSON.stringify({ status: "FRONTEND_BOOTSTRAP_PROBE_OWNED_PASS", postgresMajor: major, checks, actualRouteExport: true, loopbackHttp: true, verifiedPostgresTls: true, realBusinessDatabase: true, syntheticWorkloadIdentity: true, gatewayIntercepted: true, providerTouched: false, migrationAuthorized: false, historicalWritersFenced: false }));
  } finally {
    globalThis.fetch = nativeFetch;
    if (server) await new Promise(resolve => server.close(resolve));
    await operator.end();
  }
}
main().catch(() => { console.error(JSON.stringify({ status: "FRONTEND_BOOTSTRAP_PROBE_OWNED_FAILED", phase, providerTouched: false })); process.exitCode = 1; });
