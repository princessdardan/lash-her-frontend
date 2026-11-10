import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { courseHttpCheckPlan, probeCourseHttps, validatePrivateInput, createPrivateTlsReader, probeActualVerifier } from "./p2-identity-negative-probe.mjs";
import { identityProbeFixture, hashFixture } from "./p2-identity-negative-probe.fixture.mjs";

const host = fileURLToPath(new URL("./host/", import.meta.url));
function validateHostReceipt(receipt, mode, fixture, check = null) {
  const code = "import sys,json; sys.path.insert(0,sys.argv[1]); import p2_identity_negative_probe as p; v=json.load(sys.stdin); " +
    "p._validate_receipt(v['receipt'],v['binding'],v['mode'],v['check'],v['previous'],v['serviceKeyCount']); print('HOST_PROTOCOL_VERIFIED')";
  const result = spawnSync("python3", ["-I", "-B", "-c", code, host], { encoding: "utf8", timeout: 10_000,
    input: JSON.stringify({ receipt, binding: fixture.bindingSha256, mode, check, previous: fixture.previousProfiles, serviceKeyCount: fixture.serviceKeys.length }) });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "HOST_PROTOCOL_VERIFIED");
}

test("private probe rejects unknown fields, production, malformed subjects/resources and missing current keys", () => {
  const changes = [value => { value.environment = "production"; }, value => { value.origin = "https://foreign.example.invalid"; },
    value => { value.subjects.learnerA = "not-a-uuid"; }, value => { value.resources.courseB = value.resources.courseA; },
    value => { delete value.keys["community-member"].current; }, value => { value.keys["course-admin"].current = value.keys["course-learner"].current; },
    value => { value.serviceKeys.push(value.keys["course-learner"].current); }, value => { value.previousProfiles = []; }];
  for (const change of changes) { const value = identityProbeFixture(); change(value); assert.throws(() => validatePrivateInput(value), /P2_IDENTITY_NEGATIVE_PROBE_REFUSED/u); }
});

test("fixed HTTP plan starts and ends with real positive baselines and includes completed-attempt isolation", () => {
  const plan = courseHttpCheckPlan(identityProbeFixture("course-http-plan"));
  assert.equal(plan.networkCalled, false); assert.ok(plan.checks.length >= 60);
  assert.deepEqual(plan.checks[0], { name: "course-http.current.learner-a-baseline", expectedStatus: 200 });
  assert.deepEqual(plan.checks.at(-1), { name: "course-http.final-valid-baseline", expectedStatus: 200 });
  assert.ok(plan.checks.some(row => row.name === "course-http.completed-attempt-a-baseline" && row.expectedStatus === 200));
  assert.ok(plan.checks.some(row => row.name === "course-http.completed-attempt-isolated-from-b" && row.expectedStatus === 200));
  const text = JSON.stringify(plan); assert.equal(text.includes("Bearer "), false);
  for (const value of Object.values(identityProbeFixture().keys).flatMap(row => Object.values(row))) assert.equal(text.includes(value), false);
});

test("actual Node HTTP plans match the independent host protocol for current-only and overlapping keys", () => {
  for (const overlap of [true, false]) {
    const fixture = identityProbeFixture("course-http-plan");
    if (!overlap) { fixture.previousProfiles = []; for (const keys of Object.values(fixture.keys)) delete keys.previous; }
    validateHostReceipt(courseHttpCheckPlan(fixture), "course-http-plan", fixture);
  }
});

test("deployed HTTP selection is a fixed source check, not an arbitrary path or proxy", async () => {
  const value = identityProbeFixture(); value.httpCheck = "arbitrary.check";
  const gateway = Buffer.from(JSON.stringify({ appEnv: "staging", courseOrigin: "https://course-tls:8443", upstreamCaFile: "/tls/ca.pem" }));
  value.gatewayConfigurationSha256 = hashFixture(gateway); value.gatewayCaSha256 = hashFixture("owned-ca");
  let calls = 0;
  await assert.rejects(probeCourseHttps(value, { readGateway: () => gateway, readCa: () => "owned-ca", read: async () => { calls++; return {}; } }));
  assert.equal(calls, 0);
});

test("fixed TLS client rejects all unreviewed paths before issuing a request", async () => {
  let calls = 0;
  const read = createPrivateTlsReader("owned-ca", () => { calls++; throw new Error("must not reach request"); });
  for (const path of ["https://foreign.example.invalid", "/v1/internal/entitlements/grants", "/v1/student/progress", "/v1/admin/courses", "/v1/student/courses/id?other=true"])
    await assert.rejects(read(path, null));
  assert.equal(calls, 0);
});

test("actual verifier observation rejects foreign runtime targets and mismatched private configuration before importing modules", async () => {
  const value = identityProbeFixture("community-verifier");
  value.runtimeEnvironment = { DATABASE_TARGET: "staging", STAGING_DATABASE_URL: "owned-private-url" };
  let imports = 0;
  for (const environment of [{ DATABASE_TARGET: "prod" }, { DATABASE_TARGET: "staging", NODE_ENV: "production", STAGING_DATABASE_URL: "foreign-private-url" }]) {
    await assert.rejects(probeActualVerifier(value, { environment, loadVerifier: async () => { imports++; return {}; } }));
  }
  assert.equal(imports, 0);
});

test("private CLI payload failures print only bounded JSON and never raw error, token or input bytes", () => {
  const source = readFileSync(new URL("./p2-identity-negative-probe.mjs", import.meta.url), "utf8") + "\nawait runPrivateProbeFromStdin();\n";
  for (const input of ["not-json-private-marker", JSON.stringify({ secret: "private-marker" }), "x".repeat(270_000)]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { input, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 10_000 });
    assert.equal(result.status, 1); assert.equal(result.stderr, "");
    const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, "P2_IDENTITY_NEGATIVE_PROBE_FAILED");
    assert.equal(result.stdout.includes("private-marker"), false); assert.equal(receipt.releaseAccepted, false);
  }
});

const actual = Boolean(process.env.P2_IDENTITY_COURSE_RUNTIME_DIR && process.env.P2_IDENTITY_COMMUNITY_RUNTIME_DIR);
for (const mode of ["verifiers", "verifiers-current-only", "https", "https-current-only", "single-check", "all-401", "all-404", "redirect", "oversized", "untrusted-ca", "missing-attempt", "leak-attempt"]) {
  test(`owned actual API module/TLS fixture: ${mode}`, { skip: actual ? false : "explicit qualified Course/Community runtime directories required; no deployed evidence inferred" }, () => {
    const directory = mkdtempSync(join(tmpdir(), "owned-p2-negative-child-"));
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./harness/owned-p2-identity-negative-fixture.mjs", import.meta.url)), mode], {
        cwd: directory, env: { PATH: process.env.PATH, DOTENV_CONFIG_QUIET: "true", P2_IDENTITY_COURSE_RUNTIME_DIR: process.env.P2_IDENTITY_COURSE_RUNTIME_DIR,
          P2_IDENTITY_COMMUNITY_RUNTIME_DIR: process.env.P2_IDENTITY_COMMUNITY_RUNTIME_DIR }, encoding: "utf8", timeout: 30_000,
      });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
      const value = JSON.parse(result.stdout);
      assert.equal(value.status, mode.startsWith("verifiers") ? "OWNED_P2_IDENTITY_MODULES_PASS" : "OWNED_P2_IDENTITY_TLS_PASS");
      assert.equal(result.stdout.includes("Bearer "), false); assert.equal(result.stdout.includes("private-owned-answer"), false);
      if (mode === "https") assert.equal(value.receipt.completeHttpSuite, true);
      const fixture = identityProbeFixture();
      if (mode.endsWith("-current-only")) { fixture.previousProfiles = []; for (const keys of Object.values(fixture.keys)) delete keys.previous; }
      if (mode.startsWith("verifiers")) for (const [index, service] of ["course", "community"].entries())
        validateHostReceipt(value.receipts[index], service + "-verifier", fixture);
      if (mode === "single-check") validateHostReceipt(value.receipt, "course-http", fixture,
        courseHttpCheckPlan({ ...fixture, mode: "course-http-plan" }).checks[0]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
