import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { validateP2ReceiverDenialInput, observeCourseSuspensionDenial, observeCommunitySuspensionDenial } from "./p2-lifecycle-receiver-denial.mjs";
import { createP2LifecycleWorkerPrivateResolvers, readP2LifecycleWorkerCronSecret, readP2LifecycleWorkerRuntimeUrl, readP2DirectWorkerSourceArtifact } from "./p2-lifecycle-worker-evidence.mjs";

function input() { return { version: 1, mode: "course-http", environment: "staging", bindingSha256: "a".repeat(64), subject: randomUUID(), courseId: randomUUID(),
  currentKey: "OWNED-SYNTHETIC-CURRENT-KEY-NEVER-LIVE".repeat(2), gatewayCaSha256: "b".repeat(64), runtimeEnvironment: null, target: null }; }
test("private denial profile cannot select a URL, SQL, token, command or Community HTTP feature", () => {
  validateP2ReceiverDenialInput(input());
  for (const change of [row => { row.url = "https://foreign.invalid"; }, row => { row.sql = "SELECT 1"; }, row => { row.token = "arbitrary"; },
    row => { row.mode = "community-http"; }, row => { row.environment = "production"; }]) {
    const value = input(); change(value); assert.throws(() => validateP2ReceiverDenialInput(value));
  }
});
test("source private resolvers read only approved runtime inputs and foreign handles refuse", async () => {
  const original = process.env.FRONTEND_STAGING_CRON_SECRET; let reads = 0;
  const handle = createP2LifecycleWorkerPrivateResolvers(async () => { reads++; return { frontendRuntimeDatabaseUrl: "OWNED-PRIVATE-RUNTIME-URL" }; });
  assert.equal(reads, 0); assert.throws(() => readP2LifecycleWorkerCronSecret({}));
  process.env.FRONTEND_STAGING_CRON_SECRET = "OWNED-SYNTHETIC-CRON-SECRET";
  try {
    assert.equal(readP2LifecycleWorkerCronSecret(handle), "OWNED-SYNTHETIC-CRON-SECRET");
    assert.equal(await readP2LifecycleWorkerRuntimeUrl(handle), "OWNED-PRIVATE-RUNTIME-URL"); assert.equal(reads, 1);
    assert.equal(JSON.stringify(handle).includes(process.env.FRONTEND_STAGING_CRON_SECRET), false);
    assert.throws(() => readP2DirectWorkerSourceArtifact({}, { recordSha256: "a".repeat(64) }));
  } finally { if (original === undefined) delete process.env.FRONTEND_STAGING_CRON_SECRET; else process.env.FRONTEND_STAGING_CRON_SECRET = original; }
});
test("Course403 must be the exact account restriction, never generic403/401/429/503", async () => {
  const { createHash } = await import("node:crypto"), ca = Buffer.from("OWNED-UNIT-CA");
  const selected = { ...input(), gatewayCaSha256: createHash("sha256").update(ca).digest("hex") };
  for (const [status, code, message, passes] of [[403, "FORBIDDEN", "Account access is unavailable", true], [403, "FORBIDDEN", "Other refusal", false],
    [401, "UNAUTHORIZED", "Unauthorized", false], [429, "RATE_LIMITED", "Rate limited", false], [503, "UNAVAILABLE", "Unavailable", false]]) {
    const request = (options, receive) => {
      assert.equal(options.hostname, "course-tls"); assert.equal(options.port, 8443); assert.equal(options.method, "GET"); assert.equal(options.rejectUnauthorized, true);
      const outgoing = new EventEmitter(); outgoing.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = status; response.headers = { "cache-control": "private, no-store", "x-request-id": "owned-request" };
        receive(response); response.emit("data", Buffer.from(JSON.stringify({ error: { code, message } }))); response.emit("end");
      }); return outgoing;
    };
    if (passes) { const result = await observeCourseSuspensionDenial(selected, { ca, request }); assert.equal(result.evidenceClass, "actual-protected-course-http"); assert.equal(result.httpStatus, 403); }
    else await assert.rejects(observeCourseSuspensionDenial(selected, { ca, request }));
  }
});
test("Community requires actualproduction runtime configuration before any private module load", async () => {
  const selected = { ...input(), mode: "community-private-guard", gatewayCaSha256: null, runtimeEnvironment: { DATABASE_TARGET: "staging" },
    target: { host: "localhost", port: 5432, database: "owned", runtimeRole: "owned_runtime", runtimeRoleOid: "123", serverMajor: 16 } };
  let loaded = false;
  await assert.rejects(observeCommunitySuspensionDenial(selected, { environment: { NODE_ENV: "test", DATABASE_TARGET: "staging" }, load: async () => { loaded = true; } }));
  assert.equal(loaded, false);
});
