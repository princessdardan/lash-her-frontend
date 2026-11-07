// Explicit staging certification component. No ambient credentials or automatic reopening.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { changeFrontendAdmission } from "./frontend-admission.mjs";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";

export const P2_LIFECYCLE_NATIVE_PROJECT = "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM";
export const P2_LIFECYCLE_NATIVE_SCHEDULE = Object.freeze({ path: "/api/cron/account-lifecycle", schedule: "* * * * *" });
export const P2_NATIVE_FEATURE_NAMES = Object.freeze(["INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_CHECKOUT_ENABLED",
  "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "INTEGRATION_COMMUNITY_READS_ENABLED", "INTEGRATION_COMMUNITY_WRITES_ENABLED", "INTEGRATION_LEARNING_ROUTES_ENABLED",
  "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED"]);
const reviewedSource = {
  "src/app/api/cron/account-lifecycle/route.ts": "a42e9786c20525a9d2a1a6c574913f841d14c37ab9ce54e00f2ad15c424b1a1b",
  "src/lib/customer-lifecycle/cron.ts": "019f2a5c7b76bbd812fa0663d88279d0709670b0590a7f741ad6bdfa0bc82786",
  "src/lib/customer-lifecycle/context.ts": "c88a1cc943fc8403e4aa8ff225a79cd2c86746d605ae41261c4457574a990a24",
  "src/lib/customer-lifecycle/worker.ts": "6ba8a493f9267bab172cbce9899644a4c298758a8ada5e5d5f1aa09ef6d7f90e",
  "src/lib/customer-lifecycle/store.ts": "6dd02a6006432fbfe4184dd44e58ffbbeae28760df2a9a355328297d36d42bcc",
  "src/lib/writer-admission/runtime.ts": "b3939e6cc76c028137b7e28cb21c0bf89e36a8d67c2b5e6503c20aebb032c376",
  "src/lib/writer-admission/context.ts": "79999820266972cbe58881ce58099198c5d47de8461808ffa002e99b8d3dee38",
  "src/lib/writer-admission/config.ts": "da308d0aef19c443d0f4d1ee7f52244ce11e60aee943ebbadd576b097cbc3c1b",
  "src/lib/api-integration/account-lifecycle-client.ts": "756fa4eb0c5ef24cc9b8143855cae64d7eeaaa4e3c3e32a06382412272a0ad3b",
  "ops/platform/frontend-admission.mjs": "9ebc4b95fced781a4150d4bca2fab9e01ef9189a839cbe6d6c782c1e5a6bba34",
  "ops/platform/frontend-admission.sql": "b8ec48242871a6e44fef415b127709e9b107a60751e47bc0fa328b99244ab6ab",
  "src/lib/customer-lifecycle/native-trace.ts": "3c88d9f7e81e9951b3e0df67f2401bdbe8c973c63823ceb9eea2b58ec3a3bf08",
  "src/app/api/internal/release-probe/handler.ts": "e2ee81c21bc158a19eeb0fb5ca14f4f35b7828919fc02f4272341bbefd3835c9"
};
const reviewedScopedSource = {
  ...reviewedSource,
  "src/lib/customer-lifecycle/cron.ts": "1b2c99f2627a3e6dc32cb6c0b676cfbce7bfd322b911b35b6fc55a7a2831b289",
  "src/lib/customer-lifecycle/store.ts": "55af0e8385428f92177a69239aa615f97f611c47aea1077bb8fc49fa7f99d572",
  "src/app/api/internal/release-probe/handler.ts": "f8ee3d196736f55d74f233e6f15ed232b59bb50695a78f0d97704a72b38198b3"
};
const reviewedInteractiveSource = {
  ...reviewedScopedSource,
  "src/lib/writer-admission/runtime.ts": "82304625d3d26944ab3d4b2bba9c147d82aeadc35b7008a8cd5db8a13ed54784",
  "ops/platform/frontend-admission.mjs": "a12d999e243de1269b7ad9d844fab44133a87ad24c831eb735e528428249a8b4"
};
const reviewedInteractiveDependencies = {
  "src/lib/writer-admission/interactive-proof.ts": "fc832f7cbb07f270861e2753a8bf62253109240fb7ce0135097bdf834526de93",
  "src/proxy.ts": "790b076d78dc67a992a9662bd0d0f3b54b2ea5a23965a2d8be881e20099a0a80",
  "src/app/admin/auth-actions.ts": "e2420cae789e8239f44058ba66d82d46fd7bfcf0b08c69ea59c1dab8ecd54de1"
};
const reviewedGatewayProofDependencies = {
  ...reviewedInteractiveDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "a7b55a52a4194f67f90058fd2e17939f63af9f0669b1f9601f1bb80f24accc9f",
  "src/lib/api-integration/gateway-transport.ts": "69fdca4874a44faad96318151270dbf37948becabed33c5255d1f6516ce4cbf8"
};
const reviewedLifecyclePermitSource = {
  ...reviewedInteractiveSource,
  "src/lib/writer-admission/runtime.ts": "b787f2e9b0746a342d0dac6e855c5e4510670772d5357ac516e7ac42998b6e23",
  "src/lib/writer-admission/context.ts": "5cc5f69904ef7b76a079f0c8525616370edcd57b5b4c9f0364c2053812eb3d25"
};
const reviewedLifecyclePermitDependencies = {
  ...reviewedGatewayProofDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "bcdc988d36f15be015af59c277f337d4cff6936f01f3c3a14ec8af798b3b4e8c",
  "src/lib/customer-lifecycle/handler.ts": "88f53c68378e5931123026d0f245a629a5a052b06fbec50cf303b60ddf047c1d",
  "src/app/(site)/account/page.tsx": "e159f2ceb622a9b56bc31afcdb09e2afdf8d2e91c7ebacfa1455c43c51e075c0"
};
const reviewedIdentityPermitDependencies = {
  ...reviewedLifecyclePermitDependencies,
  "src/lib/writer-admission/interactive-proof.ts": "f66a93e2e154704d84e4527f9f7909609531bceab1a4830cc72697ab9d351721"
};
const root = realpathSync(fileURLToPath(new URL("../..", import.meta.url))), plans = new WeakSet();
const demand = ok => { if (!ok) throw new Error("P2_LIFECYCLE_NATIVE_REFUSED"); };
const digest = (value, length = 64) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value) && !/^0+$/u.test(value);
const epoch = value => typeof value === "string" && /^[1-9][0-9]{0,17}$/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
export const p2NativeHash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(ordered(value))).digest("hex");
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const iso = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));

function sourcePolicy(sourceCommit) {
  demand(Object.keys(reviewedSource).length >= 8);
  const readSourceHash = file => {
    const bytes = execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", `safe.directory=${root}`,
      "show", "--no-ext-diff", "--no-textconv", `${sourceCommit}:${file}`],
      { cwd: root, maxBuffer: 2_000_000, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    return p2NativeHash(bytes);
  };
  const selected = Object.fromEntries(Object.keys(reviewedSource).map(file => [file, readSourceHash(file)]));
  if (same(selected, reviewedSource) || same(selected, reviewedScopedSource)) return selected;
  if (same(selected, reviewedLifecyclePermitSource)) {
    const dependencies = Object.fromEntries(Object.keys(reviewedLifecyclePermitDependencies).map(file => [file, readSourceHash(file)]));
    demand(same(dependencies, reviewedLifecyclePermitDependencies) || same(dependencies, reviewedIdentityPermitDependencies));
    return { ...selected, ...dependencies };
  }
  demand(same(selected, reviewedInteractiveSource));
  const dependencies = Object.fromEntries(Object.keys(reviewedInteractiveDependencies).map(file => [file, readSourceHash(file)]));
  if (same(dependencies, reviewedInteractiveDependencies)) return { ...selected, ...dependencies };
  dependencies["src/lib/api-integration/gateway-transport.ts"] = readSourceHash("src/lib/api-integration/gateway-transport.ts");
  demand(same(dependencies, reviewedGatewayProofDependencies));
  return { ...selected, ...dependencies };
}
export function prepareP2LifecycleNativePlan(candidate, input, expectedProfile) {
  try {
    const publicOnly = value => { if (!value || typeof value !== "object") return; for (const [key, child] of Object.entries(value)) { demand(!/password|credential|databaseurl|access.?token|private.?key/iu.test(key)); publicOnly(child); } };
    publicOnly(candidate);
    const carriers = [candidate, candidate?.workload, candidate?.sources?.frontend, input, input?.target];
    let profileFields = {};
    if (expectedProfile === undefined) {
      demand(!carriers.some(carrier => carrier && "qualificationTargetProfile" in carrier));
    } else {
      const qualificationTargetProfile = requireQualificationTargetProfile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE,
        { qualificationTargetProfile: expectedProfile }, ...carriers);
      profileFields = { qualificationTargetProfile };
    }
    demand(candidate?.version === (expectedProfile === undefined ? 2 : 3) && candidate.environment === "staging" && candidate.contractPhase === "p2" && candidate.integration?.state === "passed" &&
      candidate.sourceApproval?.mode === "single-operator-dispatch" && candidate.sourceApproval.operatorGithubUserId === "8996309" &&
      candidate.workload?.projectId === P2_LIFECYCLE_NATIVE_PROJECT && candidate.workload.environment === "production" &&
      candidate.sources?.frontend?.repository === "https://github.com/princessdardan/lash-her-frontend.git" && candidate.sources.frontend.requiredChecks === "passed" &&
      digest(candidate.sources.frontend.commit, 40) && /^sha256:[a-f0-9]{64}$/u.test(candidate.phase2ContractManifestSha256 ?? "") &&
      input?.version === (expectedProfile === undefined ? 1 : 2) && input.actionId === candidate.releaseId && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) &&
      /^dpl_[A-Za-z0-9]+$/u.test(input.deploymentId ?? "") && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(input.deploymentUrl ?? "") &&
      digest(input.configurationRecordSha256) && epoch(input.epoch) && digest(input.producer?.producerSha256) &&
      /^[a-z][a-z0-9_]{0,62}$/u.test(input.producer.role?.name ?? "") && /^[1-9][0-9]{0,9}$/u.test(input.producer.role?.oid ?? "") &&
      /^[a-z][a-z0-9_]{0,62}$/u.test(input.owner?.name ?? "") && /^[1-9][0-9]{0,9}$/u.test(input.owner?.oid ?? "") &&
      input.owner.name !== input.producer.role.name && input.owner.oid !== input.producer.role.oid && input.target?.user !== input.producer.role.name &&
      input.targetSha256 === frontendAdmissionTargetSha256("staging", input.target) && input.finalDisposition === "disabled-and-admission-closed" &&
      Number.isInteger(input.windowSeconds) && input.windowSeconds >= 60 && input.windowSeconds <= 180 && Number.isInteger(input.drainSeconds) && input.drainSeconds >= 1 && input.drainSeconds <= 180 &&
      input.featureControls && same(Object.keys(input.featureControls).sort(), [...P2_NATIVE_FEATURE_NAMES].sort()) && Object.values(input.featureControls).every(value => typeof value === "boolean") &&
      input.featureControls.CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED === true && input.featureControls.CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED === true &&
      Array.isArray(input.commandWitnesses) && input.commandWitnesses.length > 0 && input.commandWitnesses.length <= 32 &&
      input.commandWitnesses.every(row => uuid(row.commandId) && epoch(row.accountVersion) && ['suspend','restore','export','delete'].includes(row.action)) &&
      new Set(input.commandWitnesses.map(row => row.commandId)).size === input.commandWitnesses.length);
    const base = { version: input.version, ...profileFields, environment: "staging", actionId: input.actionId, projectId: P2_LIFECYCLE_NATIVE_PROJECT,
      sourceCommit: candidate.sources.frontend.commit, candidateSha256: p2NativeHash(candidate), phase2ContractManifestSha256: candidate.phase2ContractManifestSha256,
      sourcePolicy: sourcePolicy(candidate.sources.frontend.commit), deploymentId: input.deploymentId, deploymentUrl: input.deploymentUrl,
      configurationRecordSha256: input.configurationRecordSha256, featureControls: { ...input.featureControls }, targetSha256: input.targetSha256,
      target: { ...Object.fromEntries(["host","port","database","user","serverMajor"].map(key => [key, input.target[key]])), ...profileFields }, owner: { name:input.owner.name,oid:input.owner.oid },
      producer: {producerSha256:input.producer.producerSha256,role:{name:input.producer.role.name,oid:input.producer.role.oid}},
      initialEpoch: input.epoch, schedule: P2_LIFECYCLE_NATIVE_SCHEDULE, windowSeconds: input.windowSeconds, drainSeconds: input.drainSeconds,
      commandWitnesses: input.commandWitnesses.map(row => ({ commandId: row.commandId, accountVersion: row.accountVersion, action: row.action })),
      writerAdmissionBinding: { mode: "enforce", targetSha256: input.targetSha256, producerSha256: input.producer.producerSha256, sourceCommit: candidate.sources.frontend.commit, roleName: input.producer.role.name },
      finalDisposition: input.finalDisposition, providerQueuedInventory: null, automaticReplayAllowed: false, migrationAuthorized: false, wholeReleaseAccepted: false };
    const plan = freeze({ ...base, planSha256: p2NativeHash(base) }); plans.add(plan); return plan;
  } catch { throw new Error("P2_LIFECYCLE_NATIVE_PLAN_REFUSED"); }
}

function store(directory) {
  demand(typeof directory === "string" && resolve(directory) === directory && realpathSync(directory) === directory);
  const info = lstatSync(directory); demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  for (let path = directory;; path = dirname(path)) { demand(!existsSync(join(path, ".git"))); if (dirname(path) === path) break; }
  const write = (name, value) => {
    demand(/^[a-z0-9][a-z0-9.-]+\.json$/u.test(name));
    const temporary = join(directory, `.${name}.${randomUUID()}`), fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); linkSync(temporary, join(directory, name));
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { closeSync(fd); try { unlinkSync(temporary); } catch { /* Never overwrite/delete original evidence. */ } }
  };
  return { write, exists: name => existsSync(join(directory, name)) };
}
function retained(directory, name) {
  store(directory);
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = fstatSync(fd); demand(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= 2_000_000); return JSON.parse(readFileSync(fd, "utf8")); }
  finally { closeSync(fd); }
}

export async function observeP2LifecycleNativeLedger(plan, client, dependencies, windowEpoch = null) {
  demand(plans.has(plan) && typeof dependencies.withOwner === "function"); await dependencies.verifySession();
  const result = await dependencies.withOwner(async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const owner = (await client.query("SELECT current_user AS username,current_user::regrole::oid::text AS role_oid,(SELECT nspowner::text FROM pg_namespace WHERE nspname='frontend_admission') AS schema_owner_oid")).rows[0];
      demand(owner?.username === plan.owner.name && owner.role_oid === plan.owner.oid && owner.schema_owner_oid === plan.owner.oid);
      const policies = (await client.query("SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton")).rows;
      demand(policies.length === 1 && policies[0].environment === "staging" && policies[0].target_sha256 === plan.targetSha256);
      const producer = (await client.query("SELECT producer_sha256,source_sha,database_role::text AS role_oid,enabled FROM frontend_admission.producers WHERE producer_sha256=$1", [plan.producer.producerSha256])).rows;
      demand(producer.length === 1 && producer[0].source_sha === plan.sourceCommit && producer[0].role_oid === plan.producer.role.oid && producer[0].enabled === true);
      const counts = (await client.query("SELECT count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations")).rows[0];
      demand(epoch(policies[0].epoch) && typeof policies[0].new_work === "boolean" && typeof policies[0].recovery === "boolean" &&
        Number.isInteger(counts?.active) && counts.active >= 0 && Number.isInteger(counts.uncertain) && counts.uncertain >= 0);
      const operations = windowEpoch === null ? [] : (await client.query(`SELECT id::text,producer_sha256,source_sha,database_role::text AS role_oid,epoch::text,kind,state,started_at,completed_at,reconciliation_sha256
        FROM frontend_admission.operations WHERE epoch >= $1::bigint ORDER BY started_at,id LIMIT 4097`, [windowEpoch])).rows;
      demand(operations.length <= 4096);
      // The admission owner deliberately has no public business-table grants.
      // Keep the same read-only snapshot and switch back to the migration
      // session's own role for the bounded command/receipt projection.
      demand(/^[a-z][a-z0-9_]{0,62}$/u.test(plan.target.user));
      await client.query(`SET LOCAL ROLE "${plan.target.user}"`);
      const commands = (await client.query(`SELECT command_id::text,account_version::text,action FROM public.customer_account_commands WHERE command_id=ANY($1::uuid[]) ORDER BY command_id`, [plan.commandWitnesses.map(row => row.commandId)])).rows;
      demand(commands.length === plan.commandWitnesses.length && commands.every(row => plan.commandWitnesses.some(expected => expected.commandId === row.command_id && expected.accountVersion === row.account_version && expected.action === row.action)));
      const deliveries = (await client.query(`SELECT command_id::text,receiver,status,attempts,acknowledged_at,lease_until FROM public.customer_account_deliveries
        WHERE command_id=ANY($1::uuid[]) ORDER BY command_id,receiver`, [plan.commandWitnesses.map(row => row.commandId)])).rows;
      demand(deliveries.length === commands.length * 2 && commands.every(command => ['course','community'].every(receiver => deliveries.filter(row => row.command_id === command.command_id && row.receiver === receiver).length === 1)));
      const orderViolations = (await client.query(`SELECT later.command_id::text AS later_command_id,prior.command_id::text AS prior_command_id,d.receiver
        FROM public.customer_account_commands later JOIN public.customer_account_deliveries d ON d.command_id=later.command_id
        JOIN public.customer_account_commands prior ON prior.user_id=later.user_id AND prior.account_version<later.account_version
        LEFT JOIN public.customer_account_deliveries pd ON pd.command_id=prior.command_id AND pd.receiver=d.receiver
        WHERE later.command_id=ANY($1::uuid[]) AND d.status='acknowledged' AND (pd.status IS DISTINCT FROM 'acknowledged' OR pd.acknowledged_at IS NULL OR pd.acknowledged_at>d.acknowledged_at) LIMIT 4097`, [plan.commandWitnesses.map(row => row.commandId)])).rows;
      demand(orderViolations.length <= 4096);
      const policy = policies[0]; return { epoch: policy.epoch, newWork: policy.new_work, recovery: policy.recovery, active: counts.active, uncertain: counts.uncertain,
        operations, commands, deliveries, orderViolations };
    } finally { await client.query("ROLLBACK"); }
  });
  await dependencies.verifySession(); return freeze(result);
}

// These are precise operator observations of provider request details, not a
// claimed runtime-log API schema or an exhaustive queue/invocation inventory.
export function validateP2NativeRequestObservation(plan, observation, windowEpoch) {
  demand(plans.has(plan) && epoch(windowEpoch) && observation?.version === 1 && observation.kind === "vercel-native-request-details"
    && observation.reviewerGithubUserId === "8996309" && observation.projectId === plan.projectId && observation.deploymentId === plan.deploymentId
    && observation.path === plan.schedule.path && observation.method === "GET" && observation.providerRequestTypeFilter === "cron"
    && typeof observation.providerRequestId === "string" && /^[A-Za-z0-9:._-]{1,200}$/u.test(observation.providerRequestId)
    && iso(observation.startedAt) && iso(observation.completedAt) && Date.parse(observation.completedAt) >= Date.parse(observation.startedAt)
    && [200,503].includes(observation.httpStatus) && observation.logScope === "this-provider-request-details"
    && (observation.admittedLogLine === null && observation.httpStatus === 503 || typeof observation.admittedLogLine === "string" && observation.admittedLogLine.length <= 2048));
  const event = observation.admittedLogLine === null ? null : JSON.parse(observation.admittedLogLine);
  demand(event === null || same(Object.keys(event).sort(), ['version','status','environment','projectId','operationId','producerSha256','sourceCommit','epoch','kind','targetSha256'].sort()) &&
    event.version === 1 && event.status === "P2_LIFECYCLE_CRON_ADMITTED" && event.environment === "staging" && event.projectId === plan.projectId &&
    uuid(event.operationId) && event.producerSha256 === plan.producer.producerSha256 && event.sourceCommit === plan.sourceCommit && event.epoch === windowEpoch && event.kind === "recovery" && event.targetSha256 === plan.targetSha256);
  // No completeness, cancellation, user-agent or header inference is admitted.
  demand(!Object.keys(observation).some(key => /complete|cancel|queue|header|secret|token|password/iu.test(key) && key !== "completedAt"));
  const fact = Object.fromEntries(['version','kind','reviewerGithubUserId','projectId','deploymentId','path','method','providerRequestTypeFilter','providerRequestId','startedAt','completedAt','httpStatus','logScope','admittedLogLine'].map(key => [key, observation[key]]));
  return freeze({ ...fact, event, observationSha256: p2NativeHash(fact) });
}

function verifier(plan, client, verifyEnvironment, verifySession) {
  let physicalPid;
  return async () => {
    await verifyEnvironment(); await verifySession();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true && client.connectionParameters?.host === plan.target.host && Number(client.connectionParameters.port) === plan.target.port);
    const actual = (await client.query("SELECT pg_backend_pid() AS pid,current_user AS username,session_user AS session_username,current_database() AS database,current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(actual && Number.isInteger(actual.pid) && (physicalPid === undefined || physicalPid === actual.pid) && actual.username === plan.target.user && actual.session_username === plan.target.user && actual.database === plan.target.database && actual.major === plan.target.serverMajor);
    physicalPid ??= actual.pid;
    demand((await client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objsubid=1 AND classid=((hashtext($1)::bigint >> 32)&4294967295)::oid AND objid=(hashtext($1)::bigint&4294967295)::oid) AS held`, ['lash-her:private-db:migrations'])).rows[0]?.held === true);
  };
}

export async function qualifyP2LifecycleNative(input) {
  const { plan, client, directory, verifyEnvironment, verifySession, withOwner, nativeControl, observeNativeRequests } = input;
  demand(plans.has(plan) && input.confirmation === `staging/${plan.actionId}` && typeof verifyEnvironment === "function" && typeof verifySession === "function" && typeof withOwner === "function" &&
    typeof nativeControl?.observe === "function" && typeof nativeControl.observeMetadata === "function" && typeof nativeControl.setEnabled === "function" && typeof observeNativeRequests === "function");
  const receipts = store(directory); demand(!receipts.exists("p2-native-started.json") && !receipts.exists("p2-native-outcome.json"));
  const now = input.clock?.now ?? (() => performance.now()), pause = input.clock?.pause ?? sleep;
  let phase = "preflight", nativeEnableAttempted = false, nativeDisableAttempted = false, nativeDisabled = false, admissionMutationUnknown = false, windowEpoch, finalAdmission, scoped, after,
    observedRequests = [], failure = false, epoch = plan.initialEpoch, enableMutationOutcome = "not-started", disableMutationOutcome = "not-started", fenceCurrent = false;
  const failurePhases = [], recordFailure = () => { failure = true; if (!failurePhases.includes(phase)) failurePhases.push(phase); };
  const dependencies = { verifySession, withOwner };
  const verify = verifier(plan, client, verifyEnvironment, verifySession);
  const boundary = async expectedEnabled => {
    await verify(); const value = await nativeControl.observe(plan);
    demand(value.projectId === plan.projectId && value.deploymentId === plan.deploymentId && value.sourceCommit === plan.sourceCommit && value.deploymentUrl === plan.deploymentUrl &&
      value.configurationRecordSha256 === plan.configurationRecordSha256 && same(value.schedule, plan.schedule) && same(value.featureControls, plan.featureControls) &&
      same(value.writerAdmissionBinding, plan.writerAdmissionBinding) && value.nativeEnabled === expectedEnabled);
    await verify(); return value;
  };
  receipts.write("p2-native-started.json", { ...plan, status: "P2_LIFECYCLE_NATIVE_STARTED" });
  const containmentRecord = (name, value) => {
    // The already-durable started plan authorizes mandatory disable/closure.
    // Later record loss cannot justify leaving that temporary capability open.
    try { receipts.write(name, value); } catch { recordFailure(); }
  };
  try {
    sourcePolicy(plan.sourceCommit); const preflight = await boundary(false);
    receipts.write("p2-native-runtime-preflight.json", { planSha256:plan.planSha256, observation:Object.fromEntries(['projectId','deploymentId','sourceCommit','deploymentUrl','configurationRecordSha256','nativeEnabled','schedule','featureControls','writerAdmissionBinding'].map(key=>[key,preflight[key]])) });
    const start = await observeP2LifecycleNativeLedger(plan, client, dependencies);
    demand(start.epoch === epoch && start.recovery === true && start.active === 0 && start.uncertain === 0 && start.deliveries.some(row => row.status !== "acknowledged"));
    phase = "recovery-only-epoch-barrier";
    receipts.write("p2-native-recovery-only-intent.json", { planSha256: plan.planSha256, epoch, newWork: false, recovery: true });
    admissionMutationUnknown = true;
    const changed = await withOwner(() => changeFrontendAdmission(client, { environment: "staging", targetSha256: plan.targetSha256 }, epoch, { newWork: false, recovery: true }));
    epoch = windowEpoch = changed.epoch; admissionMutationUnknown = false;
    scoped = await observeP2LifecycleNativeLedger(plan, client, dependencies, windowEpoch);
    demand(scoped.epoch === epoch && scoped.newWork === false && scoped.recovery === true && scoped.active === 0 && scoped.uncertain === 0 && scoped.operations.length === 0);
    receipts.write("p2-native-recovery-only-observed.json", scoped);
    demand(scoped.deliveries.some(row => row.status !== "acknowledged"));
    phase = "enable-native"; receipts.write("p2-native-enable-intent.json", { planSha256: plan.planSha256, windowEpoch, schedule: plan.schedule });
    await verify(); nativeEnableAttempted = true; enableMutationOutcome = "unknown"; await nativeControl.setEnabled(plan, true); await boundary(true); enableMutationOutcome = "observed-enabled";
    phase = "bounded-native-window";
    const deadline = now() + plan.windowSeconds * 1000;
    while (now() < deadline) { await pause(Math.min(1000, deadline - now())); await verify(); }
  } catch { recordFailure(); }
  finally {
    // A distinct disable/closure is containment, never a retry of enable. A
    // killed process leaves its durable intent; recovery must inspect it.
    if (nativeEnableAttempted) {
      phase = "disable-native";
      try {
        await verify(); const current = await nativeControl.observeMetadata(plan);
        demand(current.projectId === plan.projectId && current.deploymentId === plan.deploymentId && current.sourceCommit === plan.sourceCommit);
        if (current.nativeEnabled !== false) { containmentRecord("p2-native-disable-intent.json", { planSha256: plan.planSha256, windowEpoch }); nativeDisableAttempted = true; disableMutationOutcome = "unknown"; await nativeControl.setEnabled(plan, false); }
        const disabled = await nativeControl.observeMetadata(plan);
        demand(disabled.projectId === plan.projectId && disabled.deploymentId === plan.deploymentId && disabled.sourceCommit === plan.sourceCommit && same(disabled.schedule, plan.schedule) && disabled.nativeEnabled === false);
        nativeDisabled = true; disableMutationOutcome = nativeDisableAttempted ? "observed-disabled" : "observed-disabled-without-mutation"; await boundary(false);
      } catch { recordFailure(); }
    }
    if (windowEpoch && !admissionMutationUnknown) {
      phase = "source-admission-closure";
      try {
        await verify(); containmentRecord("p2-native-admission-close-intent.json", { planSha256: plan.planSha256, epoch, newWork: false, recovery: false });
        admissionMutationUnknown = true;
        const closed = await withOwner(() => changeFrontendAdmission(client, { environment: "staging", targetSha256: plan.targetSha256 }, epoch, { newWork: false, recovery: false }));
        epoch = closed.epoch; admissionMutationUnknown = false;
        const deadline = now() + plan.drainSeconds * 1000;
        do {
          await verify(); after = await observeP2LifecycleNativeLedger(plan, client, dependencies, windowEpoch);
          demand(after.epoch === epoch && after.newWork === false && after.recovery === false);
          if (after.active === 0 || after.uncertain > 0 || now() >= deadline) break;
          await pause(Math.min(1000, deadline - now()));
        } while (true);
        finalAdmission = { epoch: after.epoch, newWork: after.newWork, recovery: after.recovery, active: after.active, uncertain: after.uncertain };
        containmentRecord("p2-native-closed-ledger-observed.json", after);
      } catch { recordFailure(); }
    }
  }
  phase = "provider-request-correlation";
  try {
    if (nativeDisabled && finalAdmission?.active === 0 && finalAdmission?.uncertain === 0) {
      await boundary(false);
      const observations = await observeNativeRequests(plan, windowEpoch);
      demand(Array.isArray(observations) && observations.length <= 4096);
      observedRequests = observations.map(observation => validateP2NativeRequestObservation(plan, observation, windowEpoch));
      demand(new Set(observedRequests.map(row => row.providerRequestId)).size === observedRequests.length && new Set(observedRequests.filter(row => row.event).map(row => row.event.operationId)).size === observedRequests.filter(row => row.event).length);
      receipts.write("p2-native-request-observations.json", observedRequests);
    }
  } catch { recordFailure(); }
  // Operator log inspection can take time. Never qualify a stale pre-inspection
  // project or ledger snapshot, even while the reviewed parent retains locks.
  if (nativeDisabled && finalAdmission && !admissionMutationUnknown) {
    phase = "final-closed-boundary";
    try {
      await boundary(false); after = await observeP2LifecycleNativeLedger(plan,client,dependencies,windowEpoch);
      demand(after.epoch === epoch && after.newWork === false && after.recovery === false);
      await boundary(false);
      finalAdmission = {epoch:after.epoch,newWork:after.newWork,recovery:after.recovery,active:after.active,uncertain:after.uncertain};
      fenceCurrent = true; containmentRecord("p2-native-final-ledger-observed.json",after);
    } catch { recordFailure(); finalAdmission = null; }
  }
  const correlatedRequests = observedRequests.filter(row => row.event);
  const matched = Boolean(after && correlatedRequests.length > 0 && after.operations.length === correlatedRequests.length && after.operations.every(operation =>
    operation.kind === "recovery" && operation.state === "completed" && operation.completed_at !== null && operation.reconciliation_sha256 === null && operation.epoch === windowEpoch && operation.producer_sha256 === plan.producer.producerSha256 &&
    operation.source_sha === plan.sourceCommit && operation.role_oid === plan.producer.role.oid && correlatedRequests.some(row => row.event.operationId === operation.id && row.httpStatus === 200)));
  const orderedEffects = Boolean(after && after.orderViolations.length === 0 && after.deliveries.every(row => row.status === "acknowledged" && row.acknowledged_at !== null && row.lease_until === null) &&
    scoped && after.deliveries.some(row => scoped.deliveries.some(before => before.command_id === row.command_id && before.receiver === row.receiver && before.status !== 'acknowledged' && row.attempts > before.attempts)));
  const fenced = fenceCurrent && nativeDisabled && finalAdmission?.newWork === false && finalAdmission?.recovery === false && finalAdmission.active === 0 && finalAdmission.uncertain === 0 && !admissionMutationUnknown;
  const qualified = !failure && matched && orderedEffects && fenced;
  const outcome = { version: 1, actionId: plan.actionId, sourceCommit: plan.sourceCommit, projectId: plan.projectId, deploymentId: plan.deploymentId, planSha256: plan.planSha256,
    status: qualified ? "P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED" : "P2_LIFECYCLE_NATIVE_OPEN_REQUIRES_REVIEW", phase, windowEpoch: windowEpoch ?? null,
    nativeEnableAttempted, nativeDisableAttempted, enableMutationOutcome, disableMutationOutcome, failurePhases, nativeEnabled: fenceCurrent && nativeDisabled ? false : null, finalAdmission: finalAdmission ?? null,
    nativeInvocationObserved: observedRequests.length > 0, nativeLedgerCorrelationVerified: matched, orderedReceiverPersistenceVerified: orderedEffects,
    sourceAdmissionFenceVerified: fenced, providerQueuedInvocations: null, providerActiveInvocations: null, providerCancellationVerified: false,
    admissionMutationUnknown, automaticReplayAllowed: false, finalDisposition: plan.finalDisposition, wholeReleaseAccepted: false, migrationAuthorized: false };
  receipts.write("p2-native-outcome.json", outcome); return freeze(outcome);
}

export async function observeP2LifecycleNativeState(input) {
  const { plan, client, verifyEnvironment, verifySession, nativeControl } = input;
  demand(plans.has(plan) && typeof nativeControl?.observeMetadata === "function");
  const verify = verifier(plan, client, verifyEnvironment, verifySession);
  await verify(); const metadata = await nativeControl.observeMetadata(plan);
  demand(metadata.projectId === plan.projectId && metadata.deploymentId === plan.deploymentId && metadata.sourceCommit === plan.sourceCommit && same(metadata.schedule, plan.schedule));
  const ledger = await observeP2LifecycleNativeLedger(plan, client, input, String(BigInt(plan.initialEpoch) + 1n)); await verify();
  return freeze({ version:1, planSha256:plan.planSha256, native:metadata, ledger, observationOnly:true, automaticReplayAllowed:false, migrationAuthorized:false });
}

// Explicit containment after interruption. This never resumes a window, enables
// native scheduling, reopens admission, settles operations or accepts P2.
export async function containP2LifecycleNative(input) {
  const { plan, client, verifyEnvironment, verifySession, withOwner, nativeControl, directory, originalDirectory } = input;
  demand(plans.has(plan) && input.confirmation === `staging/${plan.actionId}` && epoch(input.expectedEpoch) && directory !== originalDirectory);
  const original = retained(originalDirectory,"p2-native-started.json"), preflight = retained(originalDirectory,"p2-native-runtime-preflight.json");
  demand(original.planSha256 === plan.planSha256 && original.sourceCommit === plan.sourceCommit && original.finalDisposition === plan.finalDisposition &&
    preflight.planSha256 === plan.planSha256 && same(preflight.observation.writerAdmissionBinding,plan.writerAdmissionBinding) && same(preflight.observation.featureControls,plan.featureControls) &&
    preflight.observation.deploymentId === plan.deploymentId && preflight.observation.configurationRecordSha256 === plan.configurationRecordSha256 &&
    BigInt(input.expectedEpoch) >= BigInt(plan.initialEpoch) && BigInt(input.expectedEpoch) <= BigInt(plan.initialEpoch)+2n);
  const receipts=store(directory); demand(!receipts.exists('p2-native-containment-started.json'));
  receipts.write('p2-native-containment-started.json',{version:1,planSha256:plan.planSha256,expectedEpoch:input.expectedEpoch,status:'P2_NATIVE_CONTAINMENT_STARTED',enableAllowed:false});
  const verify=verifier(plan,client,verifyEnvironment,verifySession), now=input.clock?.now ?? (()=>performance.now()), pause=input.clock?.pause ?? sleep;
  const disabledBoundary=async()=>{
    await verify();const metadata=await nativeControl.observeMetadata(plan);
    demand(metadata.projectId===plan.projectId && metadata.deploymentId===plan.deploymentId && metadata.sourceCommit===plan.sourceCommit &&
      metadata.deploymentUrl===plan.deploymentUrl && metadata.nativeEnabled===false && same(metadata.schedule,plan.schedule));
    await verify();return Object.fromEntries(['projectId','deploymentId','sourceCommit','deploymentUrl','schedule','nativeEnabled'].map(key=>[key,metadata[key]]));
  };
  let nativeDisabled=false, mutationUnknown=false, finalAdmission=null, failure=false;
  try {
    sourcePolicy(plan.sourceCommit); const actual=await observeP2LifecycleNativeState(input); demand(actual.ledger.epoch===input.expectedEpoch);
    await verify();
    if(actual.native.nativeEnabled===true) { receipts.write('p2-native-containment-disable-intent.json',{planSha256:plan.planSha256}); await nativeControl.setEnabled(plan,false); }
    await disabledBoundary();
    let selectedEpoch=actual.ledger.epoch;
    if(actual.ledger.newWork || actual.ledger.recovery) {
      receipts.write('p2-native-containment-close-intent.json',{planSha256:plan.planSha256,epoch:selectedEpoch,newWork:false,recovery:false}); mutationUnknown=true;
      const closed=await withOwner(()=>changeFrontendAdmission(client,{environment:'staging',targetSha256:plan.targetSha256},selectedEpoch,{newWork:false,recovery:false})); selectedEpoch=closed.epoch; mutationUnknown=false;
    }
    const deadline=now()+plan.drainSeconds*1000;
    do {
      await verify(); const ledger=await observeP2LifecycleNativeLedger(plan,client,input,String(BigInt(plan.initialEpoch)+1n));
      demand(ledger.epoch===selectedEpoch && ledger.newWork===false && ledger.recovery===false);
      finalAdmission={epoch:ledger.epoch,newWork:false,recovery:false,active:ledger.active,uncertain:ledger.uncertain};
      if(ledger.active===0 || ledger.uncertain>0 || now()>=deadline)break; await pause(Math.min(1000,deadline-now()));
    }while(true);
    // A disable readback before drain cannot establish the final source fence.
    sourcePolicy(plan.sourceCommit);const finalNative=await disabledBoundary();
    receipts.write('p2-native-containment-final-boundary.json',{version:1,planSha256:plan.planSha256,native:finalNative,finalAdmission});
    nativeDisabled=true;
  }catch{failure=true;}
  const outcome={version:1,planSha256:plan.planSha256,status:'P2_LIFECYCLE_NATIVE_CONTAINMENT_REQUIRES_REVIEW',nativeEnabled:nativeDisabled?false:null,finalAdmission,admissionMutationUnknown:mutationUnknown,
    sourceAdmissionFenceVerified:!failure && !mutationUnknown && nativeDisabled && finalAdmission?.active===0 && finalAdmission?.uncertain===0, nativeQualificationAccepted:false,
    providerQueuedInvocations:null,providerCancellationVerified:false,automaticReplayAllowed:false,migrationAuthorized:false};
  receipts.write('p2-native-containment-outcome.json',outcome);return freeze(outcome);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2); if (args[0] === "--plan") args.shift(); demand(args.length === 2);
    const document = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try { const info = fstatSync(fd); demand(info.isFile() && info.size > 0 && info.size < 2_000_000); return JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); } };
    process.stdout.write(`${JSON.stringify(prepareP2LifecycleNativePlan(document(args[0]), document(args[1])))}\n`);
  } catch { process.stderr.write('{"status":"P2_LIFECYCLE_NATIVE_PLAN_REFUSED"}\n'); process.exitCode = 1; }
}
