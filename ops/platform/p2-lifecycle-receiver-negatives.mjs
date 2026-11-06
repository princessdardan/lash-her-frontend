import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { prepareP2LifecyclePersistencePlan } from "./p2-lifecycle-persistence-probe.mjs";
import { validateP2LifecycleStateWitness, p2LifecycleStateWitnessSha256 } from "./p2-lifecycle-state-witness.mjs";
import { assertReceiverNegativeBaseline, deriveReceiverNegativeCommand } from "./p2-lifecycle-receiver-post.mjs";

const fields = ["version", "environment", "releaseId", "hostMachineId", "candidateSha256", "configurationSha256", "sources", "targets", "containerImages",
  "operatorSourceSha256", "frontendDeploymentSha256", "originalReleaseSha256", "expectedMigrations"];
const closed = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_RECEIVER_PLAN_REFUSED"); };
const services = ["community-api", "course-api", "community-tls", "course-tls", "course-snapshot", "community-worker", "course-media", "course-export-cleanup", "course-publisher", "gateway"];
const persistenceFiles = ["ops/platform/p2-lifecycle-state-witness.mjs", "ops/platform/p2-lifecycle-persistence-probe.mjs",
  "ops/platform/host/p2_lifecycle_persistence_scope.py", "ops/platform/host/p2_lifecycle_persistence_probe.py"];
export const P2_LIFECYCLE_RECEIVER_CASES = Object.freeze(["exact-replay", "changed-replay", "stale-restore"]);
export function prepareP2LifecycleReceiverPlan(reviewed) {
  demand(closed(reviewed, ["version", "environment", "profile", "actionId", "persistence", "programSha256", "operatorSourceFiles", "privateDirectory"])
    && reviewed.version === 1 && reviewed.environment === "staging" && reviewed.profile === "suspended-head-negatives-v1"
    && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(reviewed.actionId) && digest(reviewed.programSha256));
  demand(closed(reviewed.persistence, ["version", "environment", "probeId", "plan", "containers", "operatorSourceFiles", "programSha256", "privateDirectory"])
    && reviewed.persistence.version === 1 && reviewed.persistence.environment === "staging" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(reviewed.persistence.probeId)
    && reviewed.persistence.operatorSourceFiles && persistenceFiles.every(name => Object.hasOwn(reviewed.persistence.operatorSourceFiles, name))
    && digest(reviewed.persistence.programSha256));
  const sourcePlan = reviewed.persistence.plan;
  demand(sourcePlan && typeof sourcePlan === "object");
  const plan = prepareP2LifecyclePersistencePlan(Object.fromEntries(fields.map(name => [name, sourcePlan[name]])));
  demand(isDeepStrictEqual(sourcePlan, plan) && reviewed.persistence.environment === "staging"
    && Array.isArray(reviewed.persistence.containers) && reviewed.persistence.containers.length === 10
    && new Set(reviewed.persistence.containers.map(row => row.containerId)).size === 10
    && isDeepStrictEqual(reviewed.persistence.containers.map(row => row.service).sort(), [...services].sort())
    && reviewed.persistence.containers.every(row => closed(row, ["service", "containerId", "image", "health"]) && digest(row.containerId)
      && /^ghcr\.io\/princessdardan\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/u.test(row.image)
      && row.health === (row.service.endsWith("-tls") ? "none" : "healthy")));
  demand(reviewed.operatorSourceFiles && Object.keys(reviewed.operatorSourceFiles).length > 0 && Object.keys(reviewed.operatorSourceFiles).length <= 496
    && Object.entries(reviewed.operatorSourceFiles).every(([name, hash]) => /^ops\/[A-Za-z0-9_./-]+$/u.test(name) && !name.split("/").includes("..") && digest(hash)));
  const sourceSha256 = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(reviewed.operatorSourceFiles).sort()
    .map(name => [name, reviewed.operatorSourceFiles[name]])))).digest("hex");
  demand(isDeepStrictEqual(reviewed.persistence.operatorSourceFiles, reviewed.operatorSourceFiles) && sourceSha256 === plan.operatorSourceSha256);
  demand(typeof reviewed.privateDirectory === "string" && /^\/var\/lib\/lash-her\/releases\/staging\/[a-zA-Z0-9_/-]+$/u.test(reviewed.privateDirectory)
    && !reviewed.privateDirectory.split("/").includes(".."));
  return Object.freeze({ version: 1, status: "P2_LIFECYCLE_RECEIVER_NEGATIVE_PLAN", environment: "staging", profile: reviewed.profile,
    actionId: reviewed.actionId, candidateSha256: plan.candidateSha256, configurationSha256: plan.configurationSha256,
    operatorSourceCommit: plan.sources.frontend, operatorSourceEligibility: "same-as-immutable-frontend-candidate",
    sourceSha256: createHash("sha256").update(JSON.stringify(plan.sources)).digest("hex"), programSha256: reviewed.programSha256,
    cases: ["course", "community"].flatMap(service => P2_LIFECYCLE_RECEIVER_CASES.map(caseName => ({ service, case: caseName,
      expectedHttpStatus: caseName === "exact-replay" ? 200 : 409 }))),
    openCases: ["course", "community"].map(service => ({ service, case: "future-gap", status: "OPEN", reason: "current-quiescence-not-positively-proved" })),
    domainStatePreserving: true, globallyReadOnly: false, quotaWritesExcluded: true, credentialsRead: false, networkCalled: false,
    fixtureCreationAuthorized: false, admissionChangesAuthorized: false, oidcVerified: false, releaseAccepted: false });
}

export function verifyReceiverNegativeReadback(before, after, service, caseName, freshCommandId = null) {
  assertReceiverNegativeBaseline(before); validateP2LifecycleStateWitness(after);
  deriveReceiverNegativeCommand(before, caseName, freshCommandId);
  demand(["course", "community"].includes(service) && isDeepStrictEqual(before, after));
  return { beforeWitnessSha256: p2LifecycleStateWitnessSha256(before), afterWitnessSha256: p2LifecycleStateWitnessSha256(after),
    accountAndDomainStateUnchanged: true, quotaWritesExcluded: true };
}

export function validateReceiverNegativeOutcome(value, reviewed) {
  const plan = prepareP2LifecycleReceiverPlan(reviewed);
  demand(closed(value, ["version", "status", "environment", "profile", "actionId", "candidateSha256", "configurationSha256", "programSha256",
    "cases", "openCases", "domainStatePreserving", "globallyReadOnly", "quotaWritesExcluded", "oidcVerified", "frontendSqlVerified", "releaseAccepted"])
    && value.version === 1 && value.status === "P2_STAGING_LIFECYCLE_RECEIVER_NEGATIVES_PARTIAL"
    && value.environment === "staging" && value.profile === plan.profile && value.actionId === plan.actionId
    && value.candidateSha256 === plan.candidateSha256 && value.configurationSha256 === plan.configurationSha256
    && value.programSha256 === plan.programSha256 && isDeepStrictEqual(value.openCases, plan.openCases)
    && value.domainStatePreserving === true && value.globallyReadOnly === false && value.quotaWritesExcluded === true
    && value.oidcVerified === false && value.frontendSqlVerified === false && value.releaseAccepted === false
    && Array.isArray(value.cases) && value.cases.length === plan.cases.length);
  for (let index = 0; index < plan.cases.length; index++) {
    const actual = value.cases[index], expected = plan.cases[index];
    demand(closed(actual, ["service", "case", "httpStatus", "status", "beforeWitnessSha256", "afterWitnessSha256", "privateRecordSha256",
      "accountAndDomainStateUnchanged", "quotaWritesExcluded"]) && actual.service === expected.service && actual.case === expected.case
      && actual.httpStatus === expected.expectedHttpStatus && actual.status === "passed"
      && [actual.beforeWitnessSha256, actual.afterWitnessSha256, actual.privateRecordSha256].every(digest)
      && actual.beforeWitnessSha256 === actual.afterWitnessSha256 && actual.accountAndDomainStateUnchanged === true && actual.quotaWritesExcluded === true);
  }
  return value;
}
