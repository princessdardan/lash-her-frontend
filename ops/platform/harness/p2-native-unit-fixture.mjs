// Protocol-model unit fixture only; actual TLS/SQL qualification is separate.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, chmodSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareP2LifecycleNativePlan, qualifyP2LifecycleNative, P2_NATIVE_FEATURE_NAMES, P2_LIFECYCLE_NATIVE_PROJECT } from "../p2-lifecycle-native.mjs";
import { frontendAdmissionTargetSha256 } from "../frontend-admission-bootstrap.mjs";

// Synthetic P2 receipts bind the last reviewed P2 source, even as the
// candidate moves forward. The native planner still enforces its live policy.
export const P2_OWNED_FRONTEND_REVISION = "174ae9fe407956ba009e94356a39cc8e5032a904";

export function nativeSourceCommit() {
  return readSourceCommit(P2_OWNED_FRONTEND_REVISION);
}

export function ownedCheckoutCommit() {
  return readSourceCommit("HEAD");
}

function readSourceCommit(revision) {
  const source = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
  return execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", `safe.directory=${source}`, "rev-parse", "--verify", `${revision}^{commit}`],
    { cwd: source, encoding: "utf8", timeout: 10_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}
export function nativeDocuments(target = {}) {
  const sourceCommit = nativeSourceCommit();
  const candidate = { version: 2, environment: "staging", releaseId: "owned-native", contractPhase: "p2", phase2ContractManifestSha256: `sha256:${"d".repeat(64)}`,
    integration: { state: "passed" }, sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
    workload: { projectId: P2_LIFECYCLE_NATIVE_PROJECT, environment: "production" } };
  const selectedTarget = { host: "127.0.0.1", port: 35432, database: "frontend_admission_owned", user: "frontend_test_admin", serverMajor: 16, ...target };
  const settings = { version: 1, actionId: candidate.releaseId, deploymentId: "dpl_ownedNative", deploymentUrl: "https://owned-native.vercel.app", configurationRecordSha256: "e".repeat(64),
    epoch: "1", target: selectedTarget, targetSha256: frontendAdmissionTargetSha256("staging", selectedTarget), owner: { name: "admission_owner", oid: "101" },
    producer: { producerSha256: "b".repeat(64), role: { name: "frontend_runtime", oid: "102" } }, featureControls: Object.fromEntries(P2_NATIVE_FEATURE_NAMES.map(key => [key, key !== "INTEGRATION_CHECKOUT_ENABLED"])),
    windowSeconds: 60, drainSeconds: 2, commandWitnesses: [{ commandId: randomUUID(), accountVersion: "1", action: "suspend" }], finalDisposition: "disabled-and-admission-closed" };
  return { candidate, settings };
}
export function nativeObservation(plan, operation, changes = {}) {
  const event = { version: 1, status: "P2_LIFECYCLE_CRON_ADMITTED", environment: "staging", projectId: plan.projectId, operationId: operation.id,
    producerSha256: plan.producer.producerSha256, sourceCommit: plan.sourceCommit, epoch: operation.epoch, kind: "recovery", targetSha256: plan.targetSha256 };
  return { version: 1, kind: "vercel-native-request-details", reviewerGithubUserId: "8996309", projectId: plan.projectId, deploymentId: plan.deploymentId,
    path: plan.schedule.path, method: "GET", providerRequestTypeFilter: "cron", providerRequestId: `owned-${operation.id}`, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    httpStatus: 200, logScope: "this-provider-request-details", admittedLogLine: JSON.stringify(event), ...changes };
}
export function nativeModel(documents = nativeDocuments()) {
  const plan = prepareP2LifecycleNativePlan(documents.candidate, documents.settings);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "p2-native-model-"))); chmodSync(directory, 0o700);
  const state = { epoch: "1", newWork: true, recovery: true, operations: [], observations: [], deliveries: ['community','course'].map(receiver => ({ command_id: plan.commandWitnesses[0].commandId,
    receiver, status: "pending", attempts: 0, acknowledged_at: null, lease_until: null })), enabled: false, toggles: [], queries: 0, orderViolations: [] };
  const boundary = () => ({ projectId: plan.projectId, deploymentId: plan.deploymentId, sourceCommit: plan.sourceCommit, deploymentUrl: plan.deploymentUrl,
    configurationRecordSha256: plan.configurationRecordSha256, schedule: plan.schedule, featureControls: plan.featureControls, writerAdmissionBinding: plan.writerAdmissionBinding, nativeEnabled: state.enabled });
  const client = { connection: { stream: { encrypted: true, authorized: true } }, connectionParameters: { host: plan.target.host, port: plan.target.port },
    async query(sql, values) {
      state.queries++;
      if (sql.includes("pg_backend_pid() AS pid")) return { rows: [{ pid: 123, username: plan.target.user, session_username: plan.target.user, database: plan.target.database, major: 16 }] };
      if (sql.includes("AS held")) return { rows: [{ held: true }] };
      if (sql.includes("schema_owner_oid")) return { rows: [{ username: plan.owner.name, role_oid: plan.owner.oid, schema_owner_oid: plan.owner.oid }] };
      if (sql.includes("FROM frontend_admission.control")) return { rows: [{ environment: "staging", target_sha256: plan.targetSha256, epoch: state.epoch, new_work: state.newWork, recovery: state.recovery }] };
      if (sql.startsWith("UPDATE frontend_admission.control")) { state.epoch = String(BigInt(state.epoch) + 1n); [state.newWork,state.recovery] = values; return { rows: [{ epoch: state.epoch, new_work: state.newWork, recovery: state.recovery }] }; }
      if (sql.includes("FROM frontend_admission.producers")) return { rows: [{ producer_sha256: plan.producer.producerSha256, source_sha: plan.sourceCommit, role_oid: plan.producer.role.oid, enabled: true }] };
      if (sql.includes("count(*) FILTER")) return { rows: [{ active: state.operations.filter(row => row.state === 'active').length, uncertain: state.operations.filter(row => row.state === 'uncertain').length }] };
      if (sql.includes("FROM frontend_admission.operations WHERE epoch")) return { rows: structuredClone(state.operations.filter(row => BigInt(row.epoch) >= BigInt(values[0]))) };
      if (sql.includes("SELECT 1 FROM frontend_admission.operations")) return { rows: state.operations.filter(row => row.state !== 'completed').map(() => ({ present: 1 })) };
      if (sql.includes("SELECT command_id::text,account_version")) return { rows: plan.commandWitnesses.map(row => ({ command_id: row.commandId, account_version: row.accountVersion, action: row.action })) };
      if (sql.includes("SELECT command_id::text,receiver")) return { rows: structuredClone(state.deliveries) };
      if (sql.includes("SELECT later.command_id")) return { rows: state.orderViolations };
      if (['BEGIN','COMMIT','ROLLBACK','SET LOCAL ROLE'].some(prefix => sql.startsWith(prefix))) return { rows: [] };
      throw Error("OWNED_MODEL_UNKNOWN_QUERY");
    } };
  let elapsed = 0, ticked = false;
  const tick = () => {
    if (ticked || !state.enabled) return; ticked = true;
    const operation = { id: randomUUID(), producer_sha256: plan.producer.producerSha256, source_sha: plan.sourceCommit, role_oid: plan.producer.role.oid,
      epoch: state.epoch, kind: "recovery", state: "completed", started_at: new Date(), completed_at: new Date(), reconciliation_sha256:null };
    state.operations.push(operation); state.observations.push(nativeObservation(plan, operation));
    for (const row of state.deliveries) Object.assign(row, { status: "acknowledged", attempts: 1, acknowledged_at: new Date() });
  };
  const input = { plan, client, directory, confirmation: "staging/owned-native", verifyEnvironment: async () => {}, verifySession: async () => {}, withOwner: async work => work(),
    nativeControl: { observe: async () => boundary(), observeMetadata: async () => boundary(), setEnabled: async (_plan, enabled) => { state.toggles.push(enabled); state.enabled = enabled; } },
    observeNativeRequests: async () => state.observations, clock: { now: () => elapsed, pause: async milliseconds => { elapsed += milliseconds; tick(); } } };
  return { ...documents, plan, state, client, input, tick, run: () => qualifyP2LifecycleNative(input), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
