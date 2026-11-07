import assert from "node:assert/strict";
import test from "node:test";
import { P2_LIFECYCLE_PERSISTENCE_SQL, p2LifecyclePersistenceTargetSha256, prepareP2LifecyclePersistencePlan, qualifyPersistenceStage, validatePersistenceWitnessInput } from "./p2-lifecycle-persistence-probe.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";

const sha = digit => digit.repeat(64), commit = digit => digit.repeat(40), uuid = digit => `00000000-0000-4000-8000-${digit.padStart(12, "0")}`;
const target = (_digit, role) => { const value = { host: `${role}.staging.example.com`, port: 5432, database: `${role}_staging`, runtimeRole: `${role}_runtime`, runtimeRoleOid: "1001", serverMajor: 16 };
  return { targetSha256: p2LifecyclePersistenceTargetSha256(role, value), ...value }; };
const settings = () => ({ version: 1, environment: "staging", releaseId: "p2-owned", hostMachineId: "1".repeat(32), candidateSha256: sha("1"), configurationSha256: sha("2"),
  sources: { frontend: commit("1"), course: commit("2"), community: commit("3") }, targets: { frontend: target("3", "frontend"), course: target("4", "course"), community: target("5", "community") },
  containerImages: { course: `ghcr.io/princessdardan/lash-her-platform-course-runtime@sha256:${sha("6")}`,
    community: `ghcr.io/princessdardan/lash-her-platform-community-runtime@sha256:${sha("7")}` }, operatorSourceSha256: sha("8"), frontendDeploymentSha256: sha("9"), originalReleaseSha256: sha("a"),
  expectedMigrations: { frontend: 83, course: 22, community: 11 } });
const profiledSettings = () => {
  const value = settings(); value.version = 2; value.qualificationTargetProfile = current;
  for (const [service, selected] of Object.entries(value.targets)) {
    selected.qualificationTargetProfile = current;
    selected.targetSha256 = p2LifecyclePersistenceTargetSha256(service, selected, current);
  }
  return value;
};
const privateInput = stage => ({ version: 1, environment: "staging", stage, userId: uuid("1"), originalEmail: "owned@example.invalid", exportCommand: { commandId: uuid("2"), accountVersion: 1 },
  attemptIds: [uuid("3")], grantIds: [uuid("4")], streamIds: [uuid("5")], inboxEventIds: [uuid("6")], ...(stage === "verify-delete" ? { deleteCommand: { commandId: uuid("7"), accountVersion: 2 } } : {}) });
function baselineWitness(profile) {
  const command = { commandId: uuid("2"), accountVersion: 1, action: "export", issuedAt: "2026-11-06T00:00:00.000Z", canonicalSha256: sha("b") };
  const counts = {
    frontend: { accountRows: 1, commandRows: 1, deliveryRows: 2, exportRows: 1, sessionRows: 1, providerLinkRows: 1, verificationTokenRows: 1, preferenceRows: 1 },
    course: { accountRows: 1, commandRows: 1, exportRows: 0, progressRows: 1, attemptRows: 1, grantRows: 1 },
    community: { accountRows: 1, commandRows: 1, exportRows: 0, projectionRows: 1, inboxRows: 1 },
  };
  return { version: 1, profile, environment: "staging", candidateSha256: sha("1"), configurationSha256: sha("2"),
    sources: { frontend: commit("1"), course: commit("2"), community: commit("3") }, targetSha256: { frontend: sha("3"), course: sha("4"), community: sha("5") },
    userId: uuid("1"), command, frontend: { status: "active", accountVersion: 1, latestCommandId: command.commandId, commandCount: 1, laterCommandCount: 0,
      pendingOrDeliveringCount: 0, deliveries: ["course", "community"].map((receiver, index) => ({ receiver, status: "acknowledged", attempts: 1,
        leaseId: null, leaseUntil: null, acknowledgedAt: `2026-11-06T00:00:0${index + 1}.000Z` })) },
    receivers: Object.fromEntries(["course", "community"].map((service, index) => [service, { status: "active", accountVersion: 1,
      latestCommandId: command.commandId, commandCount: 1, knownCommand: { id: command.commandId, version: 1, action: "export",
        canonicalDigest: command.canonicalSha256, acceptedAt: `2026-11-06T00:00:0${index + 1}.000Z` } }])),
    domainSnapshots: Object.fromEntries(Object.entries(counts).map(([service, serviceCounts]) => [service, { profileId: profile,
      rowCount: Object.values(serviceCounts).reduce((total, count) => total + count, 0), counts: serviceCounts, digest: sha(service === "frontend" ? "6" : service === "course" ? "7" : "8") }])), readOnly: true };
}
const retainedExportTimes = {
  frontend: { readyAt: "2026-11-06T00:00:00.000Z", expiresAt: "2026-11-07T00:00:00.000Z" },
  course: { readyAt: "2026-11-06T00:01:00.000Z", expiresAt: "2026-11-07T00:01:00.000Z" },
  community: { readyAt: "2026-11-06T00:02:00.000Z", expiresAt: "2026-11-07T00:02:00.000Z" },
};
function scrubbedObservations() {
  return { frontend: { now: retainedExportTimes.frontend.expiresAt, exports: [{ command_id: uuid("2"), status: "expired",
    ready_at: retainedExportTimes.frontend.readyAt, expires_at: retainedExportTimes.frontend.expiresAt,
    data_present: false, frontend_data_present: false }], originalEmailMatchesAccount: true, sessions: 1, links: 1, proofs: 1, preferences: 1 },
  course: { now: retainedExportTimes.course.expiresAt, exports: [], accountAttempts: [{ id: uuid("3") }], user: [{ email_present: true }], progress: [{}],
    attempts: [{ id: uuid("3"), user_id: uuid("1"), enrollment_id: uuid("8"), request_id: uuid("9"), request_hash: sha("9"), answer_count: 1, deidentified_at: null }],
    grants: [{ id: uuid("4"), user_id: uuid("1") }] },
  community: { now: retainedExportTimes.community.expiresAt, exports: [], projections: [{ stream_id: uuid("5"), user_id: uuid("1") }], inbox: [{ event_id: uuid("6"), user_id: uuid("1") }] } };
}

test("offline plan closes exact candidate targets and migrations without credentials", () => {
  const plan = prepareP2LifecyclePersistencePlan(settings());
  assert.equal(plan.credentialsRead, false); assert.equal(plan.networkCalled, false); assert.equal(plan.mutationsAuthorized, false);
  for (const mutate of [value => { value.expectedMigrations.course = 21; }, value => { value.targets.frontend.runtimeRoleOid = "0"; }, value => { value.extra = true; }]) {
    const value = settings(); mutate(value); assert.throws(() => prepareP2LifecyclePersistencePlan(value), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  }
});

test("profiled offline plan requires a separately selected current profile at the plan and every target", () => {
  const plan = prepareP2LifecyclePersistencePlan(profiledSettings(), current);
  assert.equal(plan.version, 2); assert.deepEqual(plan.qualificationTargetProfile, current);
  for (const selected of Object.values(plan.targets)) assert.deepEqual(selected.qualificationTargetProfile, current);
  assert.equal(plan.operation, "p2-lifecycle-persistence-readonly");
  for (const mutate of [value => { delete value.targets.course.qualificationTargetProfile; },
    value => { value.version = 1; }, value => { delete value.qualificationTargetProfile; }]) {
    const value = profiledSettings(); mutate(value);
    assert.throws(() => prepareP2LifecyclePersistencePlan(value, current));
  }
  assert.throws(() => prepareP2LifecyclePersistencePlan(profiledSettings()));
  const legacy = prepareP2LifecyclePersistencePlan(settings());
  assert.equal(legacy.version, 1); assert.equal(Object.hasOwn(legacy, "qualificationTargetProfile"), false);
});

test("private witness requires exact owned records and original email", () => {
  assert.equal(validatePersistenceWitnessInput(privateInput("capture-export-ready"), "capture-export-ready").userId, uuid("1"));
  for (const mutate of [value => { value.originalEmail = "WRONG@example.invalid"; }, value => { value.attemptIds = []; }, value => { value.deleteCommand.accountVersion = 1; }]) {
    const value = privateInput("verify-delete"); mutate(value); assert.throws(() => validatePersistenceWitnessInput(value, "verify-delete"), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  }
});

test("physical scrub requires every database server clock to reach its retained expiry", () => {
  const input = privateInput("capture-delete-baseline"), prior = baselineWitness("export-ready-v1"), currentWitness = baselineWitness("delete-baseline-v1");
  const priorEvidence = { version: 1, stage: "capture-export-ready", export: retainedExportTimes };
  assert.equal(qualifyPersistenceStage(input, scrubbedObservations(), currentWitness, prior, priorEvidence).status, "P2_LIFECYCLE_EXPORT_SCRUBBED_DELETE_BASELINE_CAPTURED");
  for (const service of ["frontend", "course", "community"]) {
    const observations = scrubbedObservations(); observations[service].now = new Date(Date.parse(retainedExportTimes[service].expiresAt) - 1).toISOString();
    assert.throws(() => qualifyPersistenceStage(input, observations, currentWitness, prior, priorEvidence), error => error?.check === "export-scrubbed", service);
  }
  for (const service of ["course", "community"]) {
    const observations = scrubbedObservations(); observations[service].exports = [{ command_id: uuid("2"), status: "expired",
      ready_at: retainedExportTimes[service].readyAt, expires_at: retainedExportTimes[service].expiresAt, data_present: false }];
    assert.throws(() => qualifyPersistenceStage(input, observations, currentWitness, prior, priorEvidence), error => error?.check === "export-scrubbed", service);
  }
});

test("every domain query is a fixed parameterized SELECT and contains no answer/export payload projection", () => {
  for (const [service, queries] of Object.entries(P2_LIFECYCLE_PERSISTENCE_SQL)) for (const [name, sql] of Object.entries(queries)) {
    assert.match(sql, /^SELECT\b/u, `${service}.${name}`); assert.doesNotMatch(sql, /;|\b(insert|update|delete|alter|create|drop|truncate|copy)\b/iu);
    if (name.startsWith("attempts")) assert.doesNotMatch(sql, /\banswers\s*(?:,|from)/iu);
    if (name === "exports") assert.doesNotMatch(sql, /\bdata\s*(?:,|from)/iu);
  }
});
