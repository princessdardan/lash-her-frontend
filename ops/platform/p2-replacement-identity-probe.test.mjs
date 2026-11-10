import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareReplacementIdentityProbe, requireReplacementIdentityHostReceipt } from "./p2-replacement-identity-probe.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { p2NativeHash as hash } from "./p2-lifecycle-native.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "p2-replacement-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const priorEvidence = {};
  const pins = { originalReleasePlanSha256: "1".repeat(64) };
  for (const [name, id] of [["originalReleaseReceipt", 1], ["frontendDeploymentRecord", 2]]) {
    const raw = Buffer.from(JSON.stringify({ owned: id }) + "\n");
    priorEvidence[name] = join(directory, name.toLowerCase() + ".json");
    await writeFile(priorEvidence[name], raw, { mode: 0o600 });
    pins[name + "Sha256"] = hash(raw);
  }
  const sourceProgram = Buffer.from("// owned probe\n");
  const sourceFiles = [
    { path: "ops/platform/p2-identity-negative-probe.mjs", data: sourceProgram.toString("base64"), sha256: hash(sourceProgram) },
    { path: "ops/platform/host/p2_identity_replacement_provenance.py", sha256: "9".repeat(64) },
    { path: "ops/platform/evidence/owned.json", sha256: "8".repeat(64) },
  ];
  const hostRoot = "/var/lib/lash-her/releases/staging";
  const ids = names => Object.fromEntries(names.map((name, index) => [name,
    `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`]));
  const containers = Object.entries({ gateway: "gateway", "course-api": "course-runtime", "community-api": "community-runtime" })
    .map(([service, image], index) => ({ service, containerId: (index + 1).toString().repeat(64),
      image: `ghcr.io/princessdardan/lash-her-platform-${image}@sha256:${"a".repeat(64)}` }));
  const settings = { version: 2, qualificationTargetProfile: profile,
    results: directory, knownHosts: join(directory, "known-hosts"), sshKey: join(directory, "id"), priorEvidence,
    host: { bundle: hostRoot + "/bundle", configuration: hostRoot + "/runtime/configuration", results: hostRoot + "/results" },
    reviewed: { version: 2, qualificationTargetProfile: profile, environment: "staging", probeId: "identity-s06", releaseId: "owned-release",
      hostMachineId: "b".repeat(32), candidateSha256: "c".repeat(64), configurationSha256: "d".repeat(64),
      sources: { frontend: "1".repeat(40), course: "2".repeat(40), community: "3".repeat(40) },
      containers, subjects: ids(["learnerA", "learnerB", "admin"]),
      resources: ids(["courseA", "courseB", "sharedCourse", "lesson", "completedAttempt"]), previousProfiles: [], priorEvidence: pins,
      targetSha256: "a".repeat(64), apiJobSha256: { course: "c".repeat(64), community: "d".repeat(64) },
      runtimeInventorySha256: "e".repeat(64), gatewayProcessSha256: "f".repeat(64), successorRuntime: null,
      replacementRelease: { qualificationTargetProfile: profile, reviewedPlanSha256: pins.originalReleasePlanSha256 } } };
  return { settings, sourceFiles, sourceProgram };
}

test("replacement identity plan binds source, raw evidence and exact host without a private packet", async t => {
  const { settings, sourceFiles, sourceProgram } = await fixture(t);
  const prepared = prepareReplacementIdentityProbe(settings, sourceFiles);
  const { plan, packet, original } = prepared;
  assert.equal(packet.operation, "plan-replacement");
  assert.equal(packet.priorEvidence, null);
  assert.equal(packet.reviewed.programSha256, hash(Buffer.concat([sourceProgram, Buffer.from("\nawait runPrivateProbeFromStdin();\n")])));
  assert.equal(Object.keys(packet.reviewed.operatorSourceFiles).length, 2);
  assert.equal(plan.reviewedScopeSha256, hash(packet.reviewed));
  assert.equal(plan.confirmation, `staging/identity-s06/identity-probe/${plan.bindingSha256}`);
  assert.equal(hash(Buffer.from(original.originalReleaseReceipt, "base64")), settings.reviewed.priorEvidence.originalReleaseReceiptSha256);
  assert.ok(!JSON.stringify(plan).includes(settings.sshKey));
  const changedMount = structuredClone(settings);
  changedMount.host.configuration += "-changed";
  assert.notEqual(prepareReplacementIdentityProbe(changedMount, sourceFiles).plan.confirmation, plan.confirmation);
  for (const invalid of [
    { ...settings, host: { ...settings.host, configuration: "/var/lib/lash-her/releases/production/configuration" } },
    { ...settings, reviewed: { ...settings.reviewed, arbitraryCommand: "owned-private" } },
    { ...settings, priorEvidence: { ...settings.priorEvidence, originalReleaseReceipt: settings.priorEvidence.frontendDeploymentRecord } },
  ]) assert.throws(() => prepareReplacementIdentityProbe(invalid, sourceFiles), /REQUIRES_REVIEW/u);
});

test("replacement identity terminal must preserve the exact binding and limited claims", async t => {
  const { settings, sourceFiles } = await fixture(t);
  const { packet: { reviewed } } = prepareReplacementIdentityProbe(settings, sourceFiles);
  const { subjects, resources, containers, previousProfiles, operatorSourceFiles, ...base } = reviewed;
  const common = { ...base, readOnly: true, frontendSqlVerified: false, oidcVerified: false, releaseAccepted: false };
  const plan = { ...common, status: "P2_IDENTITY_NEGATIVE_PROBE_PLAN", prerequisites: ["owned"],
    credentialsRead: false, networkCalled: false };
  assert.equal(requireReplacementIdentityHostReceipt(plan, reviewed, false), plan);
  const checks = Array.from({ length: 60 }, (_, index) => ({ name: `owned-${index}`, status: "passed" }));
  const httpChecks = checks.map((row, index) => ({ ...row, name: "course-http." +
    (index === 0 ? "current.learner-a-baseline" : index === 59 ? "final-valid-baseline" : row.name),
    httpStatus: index === 0 || index === 59 ? 200 : 401 }));
  const verifiers = [
    ["course", ["dist/auth/first-party.js", "dist/auth/jwt-profile.js", "dist/config/env.js"]],
    ["community", ["dist/auth/community-user-auth.js", "dist/config/runtime.js", "dist/config/env.js"]],
  ].map(([api, modules]) => ({ scope: `actual-${api}-image-verifier-only`, bindingSha256: hash(reviewed), checks,
    runtimeConfigurationBindingVerified: true, moduleSha256: Object.fromEntries(modules.map(name => [name, "a".repeat(64)])) }));
  const pass = { ...common, status: "P2_STAGING_IDENTITY_NEGATIVE_PROBES_PASS", containers, previousProfiles,
    reviewedScopeSha256: hash(reviewed), verifiers, httpChecks, keyRemovalVerified: false,
    crossAccountIsolationVerified: true, completedAttemptIsolationVerified: true, newFixturesCreated: false,
    leaseProfile: "fresh-host-flock-readonly-identity-no-sql", priorEvidenceBytesBound: true };
  assert.equal(requireReplacementIdentityHostReceipt(pass, reviewed, true), pass);
  for (const mutation of [{ releaseAccepted: true }, { keyRemovalVerified: true }, { priorEvidenceBytesBound: false },
    { reviewedScopeSha256: "f".repeat(64) }, { runtimeInventorySha256: "f".repeat(64) }, { verifiers: [] },
    { unexpected: "owned-private" }]) {
    assert.throws(() => requireReplacementIdentityHostReceipt({ ...pass, ...mutation }, reviewed, true), /REQUIRES_REVIEW/u);
  }
});
