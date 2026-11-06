import assert from "node:assert/strict";
import test from "node:test";
import { P2_LIFECYCLE_PERSISTENCE_SQL, p2LifecyclePersistenceTargetSha256, prepareP2LifecyclePersistencePlan, validatePersistenceWitnessInput } from "./p2-lifecycle-persistence-probe.mjs";

const sha = digit => digit.repeat(64), commit = digit => digit.repeat(40), uuid = digit => `00000000-0000-4000-8000-${digit.padStart(12, "0")}`;
const target = (_digit, role) => { const value = { host: `${role}.staging.example.com`, port: 5432, database: `${role}_staging`, runtimeRole: `${role}_runtime`, runtimeRoleOid: "1001", serverMajor: 16 };
  return { targetSha256: p2LifecyclePersistenceTargetSha256(role, value), ...value }; };
const settings = () => ({ version: 1, environment: "staging", releaseId: "p2-owned", hostMachineId: "1".repeat(32), candidateSha256: sha("1"), configurationSha256: sha("2"),
  sources: { frontend: commit("1"), course: commit("2"), community: commit("3") }, targets: { frontend: target("3", "frontend"), course: target("4", "course"), community: target("5", "community") },
  containerImages: { course: `ghcr.io/princessdardan/lash-her-platform-course-runtime@sha256:${sha("6")}`,
    community: `ghcr.io/princessdardan/lash-her-platform-community-runtime@sha256:${sha("7")}` }, operatorSourceSha256: sha("8"), frontendDeploymentSha256: sha("9"), originalReleaseSha256: sha("a"),
  expectedMigrations: { frontend: 83, course: 22, community: 11 } });
const privateInput = stage => ({ version: 1, environment: "staging", stage, userId: uuid("1"), originalEmail: "owned@example.invalid", exportCommand: { commandId: uuid("2"), accountVersion: 1 },
  attemptIds: [uuid("3")], grantIds: [uuid("4")], streamIds: [uuid("5")], inboxEventIds: [uuid("6")], ...(stage === "verify-delete" ? { deleteCommand: { commandId: uuid("7"), accountVersion: 2 } } : {}) });

test("offline plan closes exact candidate targets and migrations without credentials", () => {
  const plan = prepareP2LifecyclePersistencePlan(settings());
  assert.equal(plan.credentialsRead, false); assert.equal(plan.networkCalled, false); assert.equal(plan.mutationsAuthorized, false);
  for (const mutate of [value => { value.expectedMigrations.course = 21; }, value => { value.targets.frontend.runtimeRoleOid = "0"; }, value => { value.extra = true; }]) {
    const value = settings(); mutate(value); assert.throws(() => prepareP2LifecyclePersistencePlan(value), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  }
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
