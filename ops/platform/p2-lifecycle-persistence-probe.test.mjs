import assert from "node:assert/strict";
import test from "node:test";
import { P2_LIFECYCLE_PERSISTENCE_SQL, p2LifecyclePersistenceTargetSha256, prepareP2LifecyclePersistencePlan, validatePersistenceWitnessInput } from "./p2-lifecycle-persistence-probe.mjs";
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

test("every domain query is a fixed parameterized SELECT and contains no answer/export payload projection", () => {
  for (const [service, queries] of Object.entries(P2_LIFECYCLE_PERSISTENCE_SQL)) for (const [name, sql] of Object.entries(queries)) {
    assert.match(sql, /^SELECT\b/u, `${service}.${name}`); assert.doesNotMatch(sql, /;|\b(insert|update|delete|alter|create|drop|truncate|copy)\b/iu);
    if (name.startsWith("attempts")) assert.doesNotMatch(sql, /\banswers\s*(?:,|from)/iu);
    if (name === "exports") assert.doesNotMatch(sql, /\bdata\s*(?:,|from)/iu);
  }
});
