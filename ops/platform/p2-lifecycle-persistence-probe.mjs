import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { rootCertificates } from "node:tls";
import { lifecycleWitnessPublicReceipt, p2LifecycleStateWitnessSha256, validateP2LifecycleStateWitness } from "./p2-lifecycle-state-witness.mjs";
import { parseQualificationTargetProfileRef, QualificationTargetProfileError, requireQualificationTargetProfile,
  resolveQualificationTargetProfile } from "./qualification-target-profile.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ROLE = /^[a-z][a-z0-9_]{0,62}$/u;
const STAGES = Object.freeze(["capture-export-ready", "capture-delete-baseline", "verify-delete", "lifecycle-account"]);
const PROFILES = Object.freeze({ "capture-export-ready": "export-ready-v1", "capture-delete-baseline": "delete-baseline-v1", "verify-delete": "delete-persisted-v1", "lifecycle-account": "lifecycle-account-v1" });
const sha = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
export class P2LifecyclePersistenceError extends Error { constructor(check) { super("P2_LIFECYCLE_PERSISTENCE_REFUSED"); this.check = check; } }
const demand = (condition, check) => { if (!condition) throw new P2LifecyclePersistenceError(check); };
const hasProfile = value => value && typeof value === "object" && Object.hasOwn(value, "qualificationTargetProfile");
function profileContext(expected, ...carriers) {
  if (expected === undefined) {
    if (carriers.some(hasProfile)) throw new QualificationTargetProfileError("QUALIFICATION_TARGET_PROFILE_REFUSED");
    return undefined;
  }
  const profile = parseQualificationTargetProfileRef(expected), definition = resolveQualificationTargetProfile(profile);
  demand(definition.id === "staging-current" && definition.environment === "staging" && definition.kind === "existing-staging", "profile-policy");
  return requireQualificationTargetProfile(profile, ...carriers);
}
export function p2LifecyclePersistenceTargetSha256(service, value, expectedProfile = undefined) {
  demand(["frontend", "course", "community"].includes(service), "target-service");
  profileContext(expectedProfile, value);
  return sha({ version: 1, environment: "staging", service, host: value.host, port: value.port, database: value.database,
    runtimeRole: value.runtimeRole, runtimeRoleOid: value.runtimeRoleOid, serverMajor: value.serverMajor });
}

function validateTarget(service, value, profile) {
  demand(closed(value, ["targetSha256", "host", "port", "database", "runtimeRole", "runtimeRoleOid", "serverMajor", ...(profile ? ["qualificationTargetProfile"] : [])])
    && SHA.test(value.targetSha256) && typeof value.host === "string" && /^[a-z0-9.-]+$/u.test(value.host) && !value.host.includes("..")
    && Number.isSafeInteger(value.port) && value.port > 0 && value.port < 65536 && ROLE.test(value.database) && ROLE.test(value.runtimeRole)
    && /^[1-9][0-9]*$/u.test(value.runtimeRoleOid) && [16, 18].includes(value.serverMajor)
    && value.targetSha256 === p2LifecyclePersistenceTargetSha256(service, value, profile), "target-binding");
  return value;
}

export function prepareP2LifecyclePersistencePlan(input, expectedProfile = undefined) {
  const targets = input?.targets && typeof input.targets === "object" ? Object.values(input.targets) : [];
  const profile = profileContext(expectedProfile, input, ...targets);
  demand(closed(input, ["version", ...(profile ? ["qualificationTargetProfile"] : []), "environment", "releaseId", "hostMachineId", "candidateSha256", "configurationSha256", "sources", "targets", "containerImages", "operatorSourceSha256", "frontendDeploymentSha256", "originalReleaseSha256", "expectedMigrations"])
    && input.version === (profile ? 2 : 1) && input.environment === "staging" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.releaseId)
    && /^[a-f0-9]{32}$/u.test(input.hostMachineId) && input.hostMachineId !== "0".repeat(32)
    && [input.candidateSha256, input.configurationSha256, input.operatorSourceSha256, input.frontendDeploymentSha256, input.originalReleaseSha256].every(value => SHA.test(value)), "plan-binding");
  demand(closed(input.sources, ["frontend", "course", "community"]) && Object.values(input.sources).every(value => COMMIT.test(value)), "plan-sources");
  demand(closed(input.targets, ["frontend", "course", "community"]), "plan-target-set");
  for (const [service, target] of Object.entries(input.targets)) validateTarget(service, target, profile);
  demand(closed(input.containerImages, ["course", "community"])
    && typeof input.containerImages.course === "string" && /^ghcr\.io\/princessdardan\/lash-her-platform-course-runtime@sha256:[a-f0-9]{64}$/u.test(input.containerImages.course)
    && typeof input.containerImages.community === "string" && /^ghcr\.io\/princessdardan\/lash-her-platform-community-runtime@sha256:[a-f0-9]{64}$/u.test(input.containerImages.community), "plan-images");
  demand(closed(input.expectedMigrations, ["frontend", "course", "community"]) && input.expectedMigrations.frontend === 83 && input.expectedMigrations.course === 22 && input.expectedMigrations.community === 11, "plan-migrations");
  return Object.freeze({ ...structuredClone(input), operation: "p2-lifecycle-persistence-readonly", stages: [...STAGES],
    finalDisposition: "observed-only", mutationsAuthorized: false, credentialsRead: false, networkCalled: false });
}

export function validatePersistenceWitnessInput(value, stage) {
  if (stage === "lifecycle-account") {
    demand(closed(value, ["version", "environment", "stage", "userId", "selectedCommand"]) && value.version === 1 && value.environment === "staging"
      && value.stage === stage && UUID.test(value.userId) && closed(value.selectedCommand, ["commandId", "accountVersion"])
      && UUID.test(value.selectedCommand.commandId) && Number.isSafeInteger(value.selectedCommand.accountVersion) && value.selectedCommand.accountVersion >= 1,
    "private-account-witness-shape");
    return value;
  }
  const fields = ["version", "environment", "stage", "userId", "originalEmail", "exportCommand", "attemptIds", "grantIds", "streamIds", "inboxEventIds"];
  if (stage === "verify-delete") fields.push("deleteCommand");
  demand(closed(value, fields) && value.version === 1 && value.environment === "staging" && value.stage === stage && STAGES.includes(stage)
    && UUID.test(value.userId) && typeof value.originalEmail === "string" && value.originalEmail === value.originalEmail.trim().toLowerCase()
    && value.originalEmail.length >= 3 && value.originalEmail.length <= 320 && value.originalEmail.includes("@"), "private-witness-shape");
  const command = item => closed(item, ["commandId", "accountVersion"]) && UUID.test(item.commandId) && Number.isSafeInteger(item.accountVersion) && item.accountVersion >= 1;
  demand(command(value.exportCommand) && ["attemptIds", "grantIds", "streamIds", "inboxEventIds"].every(name => Array.isArray(value[name]) && value[name].length >= 1 && value[name].length <= 100
    && value[name].every(item => UUID.test(item)) && new Set(value[name]).size === value[name].length), "private-witness-records");
  if (stage === "verify-delete") demand(command(value.deleteCommand) && value.deleteCommand.accountVersion > value.exportCommand.accountVersion, "delete-command-binding");
  return value;
}

function canonicalCommandDigest(command) { return sha(command); }
const date = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const count = (rows, name) => Number(rows[0]?.[name] ?? rows[0]?.count ?? 0);

const SQL = Object.freeze({
  frontend: Object.freeze({
    identity: "SELECT current_database() AS database,current_user AS role,current_user::regrole::oid::text AS role_oid,(current_setting('server_version_num')::int/10000)::int AS major,current_setting('transaction_read_only') AS read_only",
    account: "SELECT id::text,status,account_version::text,email,email_verified,name FROM customer_users WHERE id=$1::uuid",
    command: "SELECT command_id::text,user_id::text,account_version::text,action,issued_at,command FROM customer_account_commands WHERE command_id=$1::uuid AND user_id=$2::uuid",
    commands: "SELECT command_id::text,account_version::text,action,issued_at FROM customer_account_commands WHERE user_id=$1::uuid ORDER BY account_version",
    deliveries: "SELECT d.command_id::text,d.receiver,d.status,d.attempts,d.lease_id::text,d.lease_until,d.acknowledged_at FROM customer_account_deliveries d JOIN customer_account_commands c USING(command_id) WHERE c.user_id=$1::uuid ORDER BY c.account_version,CASE d.receiver WHEN 'course' THEN 0 ELSE 1 END",
    exports: "SELECT command_id::text,status,ready_at,expires_at,(data IS NOT NULL) AS data_present,(frontend_data IS NOT NULL) AS frontend_data_present FROM customer_account_exports WHERE user_id=$1::uuid ORDER BY command_id",
    sessions: "SELECT count(*)::int AS count FROM customer_sessions WHERE user_id=$1::uuid",
    links: "SELECT count(*)::int AS count FROM customer_provider_links WHERE user_id=$1::uuid",
    proofs: "SELECT count(*)::int AS count FROM customer_verification_tokens WHERE identifier=$1",
    preferences: "SELECT count(*)::int AS count FROM customer_account_preferences WHERE user_id=$1::uuid",
    now: "SELECT clock_timestamp() AS now",
  }),
  course: Object.freeze({
    identity: "SELECT current_database() AS database,current_user AS role,current_user::regrole::oid::text AS role_oid,(current_setting('server_version_num')::int/10000)::int AS major,current_setting('transaction_read_only') AS read_only",
    draftIdentity: `SELECT pg_catalog.current_database() AS database,current_user AS role,session_user AS session_role,
      current_user::regrole::oid::text AS role_oid,(pg_catalog.current_setting('server_version_num')::int/10000)::int AS major,
      pg_catalog.current_setting('transaction_read_only') AS read_only`,
    draftAbsent: "SELECT NOT EXISTS(SELECT 1 FROM public.courses WHERE slug=$1::text) AS absent",
    draftCurrent: "SELECT id::text AS course_id,slug,revision,status,(title<>$2::text AND title<>$3::text) AS both_titles_change FROM public.courses WHERE slug=$1::text",
    reorderCourse: "SELECT id::text AS course_id,slug,revision,status FROM public.courses WHERE slug=$1::text",
    reorderLessonParent: `SELECT id::text,slug,created_at::text,archived_at::text FROM public.modules
      WHERE id=$1::uuid AND course_id=$2::uuid`,
    reorderModules: `SELECT id::text,slug,position,created_at::text,archived_at::text FROM public.modules
      WHERE course_id=$1::uuid ORDER BY position LIMIT 1001`,
    reorderLessons: `SELECT id::text,slug,position,created_at::text,archived_at::text FROM public.lessons
      WHERE module_id=$1::uuid ORDER BY position LIMIT 1001`,
    draft: `SELECT id::text AS course_id,slug,revision,status,
      (title=$2::text AND description IS NOT DISTINCT FROM $3::text AND introduction IS NOT DISTINCT FROM $4::text
        AND currency=$5::text AND access_mode=$6::text AND price_cents=$7::int
        AND cover IS NOT DISTINCT FROM $8::jsonb AND seo IS NOT DISTINCT FROM $9::jsonb
        AND tax_classification IS NOT DISTINCT FROM $10::text) AS fields_match
      FROM public.courses WHERE slug=$1::text`,
    account: "SELECT user_id::text,status,account_version::text,updated_at FROM account_lifecycle_states WHERE user_id=$1::uuid",
    command: "SELECT command_id::text,user_id::text,account_version::text,action,canonical_digest,issued_at,accepted_at FROM account_lifecycle_commands WHERE command_id=$1::uuid AND user_id=$2::uuid",
    commands: "SELECT command_id::text,account_version::text,action,canonical_digest,issued_at,accepted_at FROM account_lifecycle_commands WHERE user_id=$1::uuid ORDER BY account_version",
    exports: "SELECT command_id::text,ready_at,expires_at,(data IS NOT NULL) AS data_present FROM account_lifecycle_exports WHERE user_id=$1::uuid ORDER BY command_id",
    user: "SELECT (email IS NOT NULL) AS email_present FROM users WHERE id=$1::uuid",
    progress: "SELECT id::text,lesson_id::text,enrollment_id::text,revision,completed_quiz_revision,completed_at,last_watched_at,created_at,updated_at FROM lesson_progress WHERE user_id=$1::uuid ORDER BY id",
    attempts: "SELECT id::text,lesson_id::text,quiz_revision_id::text,user_id::text,enrollment_id::text,request_id::text,request_hash,(answers='[]'::jsonb) AS answers_empty,jsonb_array_length(answers) AS answer_count,correct_count,total_count,passed,completed,created_at,deidentified_at FROM quiz_attempts WHERE id=ANY($1::uuid[]) ORDER BY id",
    attemptsForAccount: "SELECT qa.id::text,qa.lesson_id::text,qa.quiz_revision_id::text,qa.user_id::text,qa.enrollment_id::text,qa.request_id::text,qa.request_hash,(qa.answers='[]'::jsonb) AS answers_empty,jsonb_array_length(qa.answers) AS answer_count,qa.correct_count,qa.total_count,qa.passed,qa.completed,qa.created_at,qa.deidentified_at FROM quiz_attempts qa WHERE qa.user_id=$1::uuid OR qa.enrollment_id IN (SELECT e.id FROM enrollments e WHERE e.user_id=$1::uuid) ORDER BY qa.id LIMIT 101",
    grants: "SELECT id::text,user_id::text,course_id::text,grant_reason,granted_at FROM entitlement_grants WHERE id=ANY($1::uuid[]) ORDER BY id",
    attemptsByUser: "SELECT id::text,lesson_id::text,quiz_revision_id::text,user_id::text,enrollment_id::text,request_id::text,request_hash,(answers='[]'::jsonb) AS answers_empty,jsonb_array_length(answers) AS answer_count,correct_count,total_count,passed,completed,created_at,deidentified_at FROM quiz_attempts WHERE user_id=$1::uuid ORDER BY id",
    grantsByUser: "SELECT id::text,user_id::text,course_id::text,grant_reason,granted_at FROM entitlement_grants WHERE user_id=$1::uuid ORDER BY id",
    now: "SELECT clock_timestamp() AS now",
  }),
  community: Object.freeze({
    identity: "SELECT current_database() AS database,current_user AS role,current_user::regrole::oid::text AS role_oid,(current_setting('server_version_num')::int/10000)::int AS major,current_setting('transaction_read_only') AS read_only",
    account: "SELECT user_id::text,status,account_version::text,updated_at FROM account_lifecycle_states WHERE user_id=$1::uuid",
    command: "SELECT command_id::text,user_id::text,account_version::text,action,canonical_digest,issued_at,accepted_at FROM account_lifecycle_commands WHERE command_id=$1::uuid AND user_id=$2::uuid",
    commands: "SELECT command_id::text,account_version::text,action,canonical_digest,issued_at,accepted_at FROM account_lifecycle_commands WHERE user_id=$1::uuid ORDER BY account_version",
    exports: "SELECT command_id::text,ready_at,expires_at,(data IS NOT NULL) AS data_present FROM account_lifecycle_exports WHERE user_id=$1::uuid ORDER BY command_id",
    projections: "SELECT stream_id::text,user_id::text,course_id::text FROM course_enrollment_projections WHERE stream_id=ANY($1::uuid[]) ORDER BY stream_id",
    inbox: "SELECT event_id::text,user_id::text,stream_id::text,canonical_digest FROM course_enrollment_inbox WHERE event_id=ANY($1::uuid[]) ORDER BY event_id",
    projectionsByUser: "SELECT stream_id::text,user_id::text,course_id::text FROM course_enrollment_projections WHERE user_id=$1::uuid ORDER BY stream_id",
    inboxByUser: "SELECT event_id::text,user_id::text,stream_id::text,canonical_digest FROM course_enrollment_inbox WHERE user_id=$1::uuid ORDER BY event_id",
    now: "SELECT clock_timestamp() AS now",
  }),
});

async function read(client, service, name, values = []) {
  const statement = SQL[service]?.[name]; demand(typeof statement === "string" && /^SELECT\b/u.test(statement), "fixed-select-only");
  return (await client.query(statement, values)).rows;
}

function requireReadOnlyDatabaseIdentity(identity, target, role, roleOid) {
  demand(identity?.database === target.database && identity.role === role
    && (roleOid === undefined || identity.role_oid === roleOid)
    && Number(identity.major) === target.serverMajor && identity.read_only === "on", "database-identity");
}

export async function observePersistenceDomain(service, input, target, client, expectedProfile = undefined) {
  const profile = profileContext(expectedProfile, target);
  demand(["frontend", "course", "community"].includes(service), "service"); validatePersistenceWitnessInput(input, input.stage); validateTarget(service, target, profile);
  let begun = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
    await client.query("SET LOCAL statement_timeout='10s'");
    const identity = (await read(client, service, "identity"))[0];
    requireReadOnlyDatabaseIdentity(identity, target, target.runtimeRole, target.runtimeRoleOid);
    const selectedCommand = input.stage === "lifecycle-account" ? input.selectedCommand : input.stage === "verify-delete" ? input.deleteCommand : input.exportCommand;
    const user = input.userId;
    const account = await read(client, service, "account", [user]);
    const command = await read(client, service, "command", [selectedCommand.commandId, user]);
    const exportCommand = input.stage === "lifecycle-account" ? [] : await read(client, service, "command", [input.exportCommand.commandId, user]);
    const commands = await read(client, service, "commands", [user]);
    const exports = await read(client, service, "exports", [user]);
    const now = date((await read(client, service, "now"))[0].now);
    if (service === "frontend") {
      const deliveries = await read(client, service, "deliveries", [user]);
      const sessions = count(await read(client, service, "sessions", [user]));
      const links = count(await read(client, service, "links", [user]));
      const proofs = input.stage === "lifecycle-account" ? 0 : count(await read(client, service, "proofs", [input.originalEmail]));
      const preferences = count(await read(client, service, "preferences", [user]));
      return { service, identity, now, account, command, exportCommand, commands, deliveries, exports, sessions, links, proofs, preferences,
        originalEmailMatchesAccount: input.stage === "lifecycle-account" ? null : account.length === 1 && account[0].email === input.originalEmail,
        tombstoneEmailMatches: account.length === 1 && account[0].email === `deleted+${user}@account.invalid` };
    }
    if (service === "course") return { service, identity, now, account, command, exportCommand, commands, exports,
      user: await read(client, service, "user", [user]), progress: await read(client, service, "progress", [user]),
      attempts: input.stage === "lifecycle-account" ? await read(client, service, "attemptsByUser", [user]) : await read(client, service, "attempts", [input.attemptIds]),
      accountAttempts: input.stage === "lifecycle-account" ? [] : await read(client, service, "attemptsForAccount", [user]),
      grants: input.stage === "lifecycle-account" ? await read(client, service, "grantsByUser", [user]) : await read(client, service, "grants", [input.grantIds]) };
    return { service, identity, now, account, command, exportCommand, commands, exports,
      projections: input.stage === "lifecycle-account" ? await read(client, service, "projectionsByUser", [user]) : await read(client, service, "projections", [input.streamIds]),
      inbox: input.stage === "lifecycle-account" ? await read(client, service, "inboxByUser", [user]) : await read(client, service, "inbox", [input.inboxEventIds]) };
  } finally { if (begun) await client.query("ROLLBACK"); }
}

function normalizeDelivery(row) { return { receiver: row.receiver, status: row.status, attempts: Number(row.attempts), leaseId: row.lease_id ?? null,
  leaseUntil: row.lease_until ? date(row.lease_until) : null, acknowledgedAt: row.acknowledged_at ? date(row.acknowledged_at) : null }; }
function receiverObservation(row) { return { status: row.account[0].status, accountVersion: Number(row.account[0].account_version), latestCommandId: row.commands.at(-1).command_id,
  commandCount: row.commands.length, knownCommand: { id: row.command[0].command_id, version: Number(row.command[0].account_version), action: row.command[0].action,
    canonicalDigest: row.command[0].canonical_digest, acceptedAt: date(row.command[0].accepted_at) } }; }
function snapshot(profile, service, observation) {
  let counts, digestRows;
  if (service === "frontend") {
    counts = { accountRows: observation.account.length, commandRows: observation.commands.length, deliveryRows: observation.deliveries.length, exportRows: observation.exports.length,
      sessionRows: observation.sessions, providerLinkRows: observation.links, verificationTokenRows: observation.proofs, preferenceRows: observation.preferences };
    digestRows = { account: observation.account.map(row => ({ id: row.id, status: row.status, version: row.account_version })), commands: observation.commands,
      deliveries: observation.deliveries, exports: observation.exports.map(row => ({ command_id: row.command_id, status: row.status, ready_at: row.ready_at, expires_at: row.expires_at, data_present: row.data_present, frontend_data_present: row.frontend_data_present })) };
  } else if (service === "course") {
    counts = { accountRows: observation.account.length, commandRows: observation.commands.length, exportRows: observation.exports.length, progressRows: observation.progress.length,
      attemptRows: observation.attempts.length, grantRows: observation.grants.length };
    const retained = { attempts: observation.attempts.map(row => ({ id: row.id, lesson_id: row.lesson_id, quiz_revision_id: row.quiz_revision_id, correct_count: row.correct_count,
      total_count: row.total_count, passed: row.passed, completed: row.completed, created_at: row.created_at })), grants: observation.grants };
    digestRows = profile.startsWith("delete-") ? retained : { account: observation.account, commands: observation.commands,
      exports: observation.exports.map(row => ({ ...row, data_present: row.data_present })), progress: observation.progress, ...retained,
      attemptPrivacy: observation.attempts.map(row => ({ id: row.id, identified: row.user_id !== null, answers_empty: row.answers_empty, deidentified_at: row.deidentified_at })) };
  } else {
    counts = { accountRows: observation.account.length, commandRows: observation.commands.length, exportRows: observation.exports.length,
      projectionRows: observation.projections.length, inboxRows: observation.inbox.length };
    const retained = { projections: observation.projections, inbox: observation.inbox };
    digestRows = profile.startsWith("delete-") ? retained : { account: observation.account, commands: observation.commands,
      exports: observation.exports.map(row => ({ ...row, data_present: row.data_present })), ...retained };
  }
  return { profileId: profile, rowCount: Object.values(counts).reduce((sum, value) => sum + value, 0), counts, digest: sha(digestRows) };
}

export function buildP2LifecycleStateWitness(plan, input, observations) {
  demand(closed(observations, ["frontend", "course", "community"]), "observation-set");
  const profile = PROFILES[input.stage]; demand(profile, "stage-profile");
  const front = observations.frontend, selected = front.command[0];
  demand(front.command.length === 1 && selected.user_id === input.userId, "frontend-command");
  const command = selected.command;
  const requested = input.stage === "lifecycle-account" ? input.selectedCommand : input.stage === "verify-delete" ? input.deleteCommand : input.exportCommand;
  demand(command && selected.command_id === requested.commandId && Number(selected.account_version) === requested.accountVersion
    && command.commandId === selected.command_id && command.userId === input.userId && command.accountVersion === Number(selected.account_version)
    && command.action === selected.action && canonicalCommandDigest(command) === observations.course.command[0]?.canonical_digest
    && observations.course.command[0]?.canonical_digest === observations.community.command[0]?.canonical_digest, "canonical-command");
  const relevant = front.deliveries.filter(row => row.command_id === selected.command_id).map(normalizeDelivery);
  demand(relevant.length === 2 && relevant.map(row => row.receiver).join() === "course,community", "delivery-pair");
  const latest = front.commands.at(-1); demand(latest, "latest-command");
  const witness = { version: 1, profile, environment: "staging", candidateSha256: plan.candidateSha256, configurationSha256: plan.configurationSha256,
    sources: plan.sources, targetSha256: Object.fromEntries(Object.entries(plan.targets).map(([service, target]) => [service, target.targetSha256])), userId: input.userId,
    command: { commandId: command.commandId, accountVersion: command.accountVersion, action: command.action, issuedAt: command.issuedAt, canonicalSha256: canonicalCommandDigest(command) },
    frontend: { status: front.account[0].status, accountVersion: Number(front.account[0].account_version), latestCommandId: latest.command_id, commandCount: front.commands.length,
      deliveries: relevant, laterCommandCount: front.commands.filter(row => Number(row.account_version) > command.accountVersion).length,
      pendingOrDeliveringCount: front.deliveries.filter(row => ["pending", "delivering"].includes(row.status)).length },
    receivers: { course: receiverObservation(observations.course), community: receiverObservation(observations.community) },
    domainSnapshots: Object.fromEntries(Object.entries(observations).map(([service, observation]) => [service, snapshot(profile, service, observation)])), readOnly: true };
  return validateP2LifecycleStateWitness(witness);
}

function exportByCommand(observation, commandId) { return observation.exports.find(row => row.command_id === commandId); }
function allAcknowledged(witness) { return witness.frontend.deliveries.every(row => row.status === "acknowledged" && row.attempts >= 1 && row.leaseId === null && row.leaseUntil === null && row.acknowledgedAt !== null); }
function sameWitnessContext(current, prior) {
  return prior && current.environment === prior.environment && current.candidateSha256 === prior.candidateSha256
    && current.configurationSha256 === prior.configurationSha256 && current.userId === prior.userId
    && canonical(current.sources) === canonical(prior.sources) && canonical(current.targetSha256) === canonical(prior.targetSha256);
}
function exactAccountAttemptSet(input, observation) {
  const actual = observation.accountAttempts.map(row => row.id).sort();
  demand(actual.length <= 100 && canonical(actual) === canonical([...input.attemptIds].sort()), "complete-account-attempt-set");
}
function retainedExportHistory(input, observations, priorWitness) {
  demand(input.exportCommand.commandId === priorWitness.command.commandId && input.exportCommand.accountVersion === priorWitness.command.accountVersion
    && priorWitness.command.action === "export", "retained-export-command");
  const frontend = observations.frontend.exportCommand, course = observations.course.exportCommand, community = observations.community.exportCommand;
  demand(frontend.length === 1 && course.length === 1 && community.length === 1
    && [frontend[0], course[0], community[0]].every(row => row.command_id === priorWitness.command.commandId
      && Number(row.account_version) === priorWitness.command.accountVersion && row.action === "export")
    && canonicalCommandDigest(frontend[0].command) === priorWitness.command.canonicalSha256
    && course[0].canonical_digest === priorWitness.command.canonicalSha256 && community[0].canonical_digest === priorWitness.command.canonicalSha256,
  "retained-export-command");
  const deliveries = observations.frontend.deliveries.filter(row => row.command_id === input.exportCommand.commandId).map(normalizeDelivery);
  demand(deliveries.length === 2 && deliveries.map(row => row.receiver).join() === "course,community"
    && deliveries.every(row => row.status === "acknowledged" && row.attempts >= 1 && row.leaseId === null && row.leaseUntil === null && row.acknowledgedAt),
  "retained-export-acknowledgements");
}
function validatePrivateStageEvidence(value, stage) {
  demand(closed(value, ["version", "stage", "export"]) && value.version === 1 && value.stage === stage
    && closed(value.export, ["frontend", "course", "community"]), "private-stage-evidence");
  for (const service of ["frontend", "course", "community"]) demand(closed(value.export[service], ["readyAt", "expiresAt"])
    && !Number.isNaN(Date.parse(value.export[service].readyAt)) && !Number.isNaN(Date.parse(value.export[service].expiresAt)), "private-stage-evidence");
  return value;
}
export function persistencePrivateStageEvidence(input, observations, priorEvidence = null) {
  if (input.stage === "capture-export-ready") {
    const selected = Object.fromEntries(["frontend", "course", "community"].map(service => {
      const row = exportByCommand(observations[service], input.exportCommand.commandId);
      demand(row, "private-stage-evidence");
      return [service, { readyAt: date(row.ready_at), expiresAt: date(row.expires_at) }];
    }));
    return validatePrivateStageEvidence({ version: 1, stage: input.stage, export: selected }, input.stage);
  }
  const expected = input.stage === "capture-delete-baseline" ? "capture-export-ready" : "capture-delete-baseline";
  validatePrivateStageEvidence(priorEvidence, expected);
  return validatePrivateStageEvidence({ version: 1, stage: input.stage, export: structuredClone(priorEvidence.export) }, input.stage);
}
export function qualifyPersistenceStage(input, observations, witness, priorWitness = null, priorEvidence = null) {
  validateP2LifecycleStateWitness(witness); const stage = input.stage;
  demand(allAcknowledged(witness) && witness.frontend.laterCommandCount === 0 && witness.frontend.pendingOrDeliveringCount === 0, "ordered-acknowledgements");
  const fexp = exportByCommand(observations.frontend, input.exportCommand.commandId), cexp = exportByCommand(observations.course, input.exportCommand.commandId), mexp = exportByCommand(observations.community, input.exportCommand.commandId);
  if (stage === "capture-export-ready") {
    demand(fexp && cexp && mexp, "export-ready");
    const frontendBound = Math.min(new Date(fexp.ready_at).getTime() + 86_400_000, new Date(cexp.expires_at).getTime(), new Date(mexp.expires_at).getTime());
    demand(witness.command.action === "export" && observations.frontend.originalEmailMatchesAccount
      && fexp?.status === "ready" && fexp.data_present === true && fexp.frontend_data_present === false
      && cexp?.data_present === true && mexp?.data_present === true && [cexp, mexp].every(row => new Date(row.expires_at).getTime() - new Date(row.ready_at).getTime() === 86_400_000)
      && new Date(fexp.expires_at).getTime() === frontendBound
      && new Date(observations.frontend.now).getTime() < new Date(fexp.expires_at).getTime()
      && new Date(observations.course.now).getTime() < new Date(cexp.expires_at).getTime()
      && new Date(observations.community.now).getTime() < new Date(mexp.expires_at).getTime(), "export-ready");
    exactAccountAttemptSet(input, observations.course);
  } else if (stage === "capture-delete-baseline") {
    demand(priorWitness?.profile === "export-ready-v1" && sameWitnessContext(witness, priorWitness)
      && priorWitness.command.commandId === input.exportCommand.commandId && priorWitness.command.accountVersion === input.exportCommand.accountVersion, "export-prior-witness");
    validatePrivateStageEvidence(priorEvidence, "capture-export-ready");
    demand(fexp?.status === "expired" && fexp.data_present === false && fexp.frontend_data_present === false && !cexp && !mexp
      && date(fexp.ready_at) === priorEvidence.export.frontend.readyAt && date(fexp.expires_at) === priorEvidence.export.frontend.expiresAt
      && ["frontend", "course", "community"].every(service =>
        new Date(observations[service].now).getTime() >= new Date(priorEvidence.export[service].expiresAt).getTime()), "export-scrubbed");
    exactAccountAttemptSet(input, observations.course);
    demand(observations.frontend.originalEmailMatchesAccount && observations.frontend.sessions >= 1 && observations.frontend.links >= 1 && observations.frontend.proofs >= 1 && observations.frontend.preferences === 1
      && observations.course.user.length === 1 && observations.course.user[0].email_present === true && observations.course.progress.length >= 1
      && observations.course.attempts.length === input.attemptIds.length && observations.course.attempts.every(row => row.user_id === input.userId && row.enrollment_id && row.request_id && row.request_hash && row.answer_count > 0 && row.deidentified_at === null)
      && observations.course.grants.length === input.grantIds.length && observations.course.grants.every(row => row.user_id === input.userId)
      && observations.community.projections.length === input.streamIds.length && observations.community.projections.every(row => row.user_id === input.userId)
      && observations.community.inbox.length === input.inboxEventIds.length && observations.community.inbox.every(row => row.user_id === input.userId), "delete-baseline");
  } else if (stage === "verify-delete") {
    demand(priorWitness?.profile === "delete-baseline-v1" && sameWitnessContext(witness, priorWitness) && witness.command.action === "delete"
      && witness.command.accountVersion === priorWitness.frontend.accountVersion + 1, "delete-prior-witness");
    validatePrivateStageEvidence(priorEvidence, "capture-delete-baseline");
    retainedExportHistory(input, observations, priorWitness);
    demand(observations.frontend.tombstoneEmailMatches && observations.frontend.account[0].status === "deleted" && observations.frontend.account[0].name === null && observations.frontend.account[0].email_verified === null
      && observations.frontend.sessions === 0 && observations.frontend.links === 0 && observations.frontend.proofs === 0 && observations.frontend.preferences === 0
      && observations.frontend.exports.every(row => !row.data_present && !row.frontend_data_present), "frontend-delete-persisted");
    const accepted = new Date(observations.course.command[0].accepted_at).getTime();
    demand(observations.course.account[0].status === "deleted" && observations.course.user[0]?.email_present === false && observations.course.progress.length === 0 && observations.course.exports.length === 0
      && observations.course.accountAttempts.length === 0
      && observations.course.attempts.length === input.attemptIds.length && observations.course.attempts.every(row => row.user_id === null && row.enrollment_id === null && row.request_id === null && row.request_hash === null && row.answers_empty === true && row.deidentified_at && new Date(row.deidentified_at).getTime() >= accepted)
      && observations.course.grants.length === input.grantIds.length, "course-delete-persisted");
    demand(observations.community.account[0].status === "deleted" && observations.community.exports.length === 0
      && observations.community.projections.length === input.streamIds.length && observations.community.inbox.length === input.inboxEventIds.length, "community-delete-persisted");
    demand(witness.domainSnapshots.course.digest === priorWitness.domainSnapshots.course.digest
      && witness.domainSnapshots.community.digest === priorWitness.domainSnapshots.community.digest, "retained-minimal-history-changed");
  }
  return { ...lifecycleWitnessPublicReceipt(witness), status: stage === "capture-export-ready" ? "P2_LIFECYCLE_EXPORT_READY_CAPTURED" : stage === "capture-delete-baseline" ? "P2_LIFECYCLE_EXPORT_SCRUBBED_DELETE_BASELINE_CAPTURED" : "P2_LIFECYCLE_DELETE_PERSISTENCE_VERIFIED",
    priorWitnessSha256: priorWitness ? p2LifecycleStateWitnessSha256(priorWitness) : null, checksPassed: stage === "capture-export-ready" ? 6 : stage === "capture-delete-baseline" ? 12 : 16,
    providerTouched: false, releaseAccepted: false };
}

function privateReadOnlyOptions(connectionUrl, target, role, ca) {
  demand(typeof connectionUrl === "string", "private-database-credential");
  const url = new URL(connectionUrl); demand(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === target.host && Number(url.port || 5432) === target.port
    && decodeURIComponent(url.pathname) === `/${target.database}` && decodeURIComponent(url.username) === role && url.password && url.search === "?sslmode=verify-full" && !url.hash, "credential-target");
  return { host: target.host, port: target.port, database: target.database, user: role, password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true, servername: target.host, ...(ca === undefined ? {} : { ca }) }, enableChannelBinding: true,
    connectionTimeoutMillis: 10_000, options: "-c default_transaction_read_only=on -c search_path=pg_catalog,public -c statement_timeout=10000" };
}

async function clientFromInput(input) {
  const options = privateReadOnlyOptions(input.connectionUrl ?? process.env.STAGING_DATABASE_URL, input.target, input.target.runtimeRole, rootCertificates);
  const pgModule = await import("/app/node_modules/pg/esm/index.mjs");
  const client = new pgModule.Client(options);
  delete input.connectionUrl; return client;
}

const draftBaselines = new WeakMap();
const draftEditBaselines = new WeakMap();
const courseReorderBaselines = new WeakMap();
const draftFormFields = ["title", "slug", "description", "introduction", "currency", "accessMode", "priceCents", "cover", "seo", "taxClassification"];
const orderedDraftFields = (value, fields) => closed(value, fields) && Object.keys(value).every((key, index) => key === fields[index]);
const draftSlug = value => typeof value === "string" && value.length <= 120 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
const draftText = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() && !value.includes("\0");
const draftCover = value => {
  if (value === null) return true;
  if (!orderedDraftFields(value, ["url", "alt"]) || !draftText(value.url, 2048) || !draftText(value.alt, 500) || /[\u0000-\u0020\\]/u.test(value.url)) return false;
  try { const url = new URL(value.url); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
};

function reviewedCourseDraftBody(slug, bodySha256, draft, revision) {
  let raw;
  try { raw = JSON.stringify(draft); } catch { throw new P2LifecyclePersistenceError("course-draft-body"); }
  demand(typeof raw === "string" && Buffer.byteLength(raw) <= 1_048_576 && sha(raw) === bodySha256, "course-draft-body-hash");
  const body = JSON.parse(raw);
  demand(orderedDraftFields(body, [...draftFormFields, revision === undefined ? "status" : "expectedRevision"])
    && body.slug === slug && (revision === undefined ? body.status === "draft" : body.expectedRevision === revision) && draftText(body.title, 300)
    && [body.description, body.introduction].every(value => value === null || draftText(value, 100_000))
    && body.currency === "CAD" && ["free", "paid"].includes(body.accessMode) && Number.isInteger(body.priceCents)
    && body.priceCents <= 2_147_483_647 && (body.accessMode === "free" ? body.priceCents === 0 : body.priceCents > 0)
    && draftCover(body.cover)
    && orderedDraftFields(body.seo, [...["title", "description"].filter(key => body.seo && Object.hasOwn(body.seo, key)), "noIndex"])
    && typeof body.seo.noIndex === "boolean" && (!Object.hasOwn(body.seo, "title") || draftText(body.seo.title, 200))
    && (!Object.hasOwn(body.seo, "description") || draftText(body.seo.description, 1000))
    && (body.taxClassification === null || typeof body.taxClassification === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(body.taxClassification)),
  "course-draft-body");
  return body;
}

export function validateP2InteractiveCourseDraft(selection, draft) {
  demand(closed(selection, ["slug", "bodySha256"]) && draftSlug(selection.slug)
    && typeof selection.bodySha256 === "string" && SHA.test(selection.bodySha256), "course-draft-selection");
  return reviewedCourseDraftBody(selection.slug, selection.bodySha256, draft);
}

const draftEditSelectionFields = ["courseId", "slug", "revision", "winnerBodySha256", "staleBodySha256"];

export function validateP2InteractiveCourseDraftEdits(selection, edits) {
  demand(closed(selection, draftEditSelectionFields) && typeof selection.courseId === "string" && UUID.test(selection.courseId)
    && draftSlug(selection.slug) && Number.isInteger(selection.revision) && selection.revision >= 1 && selection.revision <= 2_147_483_646
    && [selection.winnerBodySha256, selection.staleBodySha256].every(value => typeof value === "string" && SHA.test(value))
    && selection.winnerBodySha256 !== selection.staleBodySha256, "course-draft-edit-selection");
  demand(closed(edits, ["winner", "stale"]), "course-draft-edit-bodies");
  const { slug, revision } = selection;
  const winner = reviewedCourseDraftBody(slug, selection.winnerBodySha256, edits.winner, revision);
  const stale = reviewedCourseDraftBody(slug, selection.staleBodySha256, edits.stale, revision);
  demand(winner.title !== stale.title, "course-draft-edit-title");
  return { winner, stale };
}

function selectedCourseDraftJob(job) {
  const target = job?.target;
  const profile = profileContext(job?.qualificationTargetProfile, job, target);
  demand(profile && job.schemaVersion === 2 && job.kind === "operator-migration" && job.operator === "Dardan"
    && job.environment === "staging" && job.contractPhase === "p2" && COMMIT.test(job.sourceCommit)
    && typeof job.releaseId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(job.releaseId)
    && target?.schemaVersion === 2 && target.environment === "staging" && target.service === "lash-her-course-api"
    && typeof target.host === "string" && /^[a-z0-9.-]+$/u.test(target.host) && !target.host.includes("..")
    && Number.isInteger(target.port) && target.port > 0 && target.port <= 65535 && ROLE.test(target.database)
    && ROLE.test(target.user) && ROLE.test(job.runtimeRole) && job.runtimeRole !== target.user && [16, 18].includes(target.serverMajor),
  "course-draft-job");
  return { target: { host: target.host, port: target.port, database: target.database, user: target.user, serverMajor: target.serverMajor },
    jobSha256: sha(job) };
}

async function readHeldCourseDraft(target, dependencies, roleOid, task) {
  const { verifyEnvironment, verifySession, readCourseDatabaseUrl } = dependencies;
  demand([verifyEnvironment, verifySession, readCourseDatabaseUrl].every(value => typeof value === "function"), "course-draft-held-session");
  const verify = async () => { await verifyEnvironment(); await verifySession(); };
  await verify();
  let client, begun = false, lost = false;
  try {
    const options = privateReadOnlyOptions(await readCourseDatabaseUrl(), target, target.user);
    const { Client } = await import("pg");
    client = new Client(options);
    client.on("error", () => { lost = true; });
    await verify(); await client.connect(); await verify();
    const requireTls = () => demand(!lost && client.connection?.stream?.encrypted === true
      && client.connection.stream.authorized === true, "verified-node-tls");
    requireTls();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
    const [identity] = await read(client, "course", "draftIdentity");
    requireReadOnlyDatabaseIdentity(identity, target, target.user, roleOid);
    demand(identity.session_role === target.user && /^[1-9][0-9]{0,9}$/u.test(identity.role_oid), "database-identity");
    await verify();
    const result = await task(client);
    requireTls(); await verify();
    await client.query("ROLLBACK"); begun = false;
    await client.end(); client = undefined;
    await verify();
    return { result, roleOid: identity.role_oid };
  } catch (error) {
    if (error instanceof P2LifecyclePersistenceError) throw error;
    throw new P2LifecyclePersistenceError("course-draft-observation");
  } finally {
    if (client) {
      let closeFailed = false;
      try { if (begun) await client.query("ROLLBACK"); } catch { closeFailed = true; }
      try { await client.end(); } catch { closeFailed = true; }
      demand(!closeFailed, "course-draft-close");
    }
  }
}

export async function captureP2InteractiveCourseDraftBaseline(courseJob, selection, draft, dependencies) {
  const selected = Object.freeze({ ...selection }), expected = validateP2InteractiveCourseDraft(selected, draft);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { roleOid } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const rows = await read(client, "course", "draftAbsent", [selected.slug]);
    demand(rows.length === 1 && rows[0].absent === true, "course-draft-already-present");
  });
  const baseline = Object.freeze({});
  draftBaselines.set(baseline, { selected, expected, jobSha256, roleOid, verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveCourseDraftCase(courseJob, selection, baseline, browserDraft, dependencies) {
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = draftBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && closed(selection, ["slug", "bodySha256"])
    && saved.verifyEnvironment === dependencies?.verifyEnvironment && saved.verifySession === dependencies?.verifySession
    && selection.slug === saved.selected.slug && selection.bodySha256 === saved.selected.bodySha256
    && matchesDraftReceipt(browserDraft, selection.slug, 1), "course-draft-receipt");
  draftBaselines.delete(baseline);
  const { result } = await readHeldCourseDraft(target, dependencies, saved.roleOid,
    client => readMatchingDraft(client, saved.expected, browserDraft.courseId, 1));
  return result;
}

function matchesDraftReceipt(browserDraft, slug, revision) {
  return closed(browserDraft, ["courseId", "slug", "revision", "status"]) && typeof browserDraft.courseId === "string"
    && UUID.test(browserDraft.courseId) && browserDraft.slug === slug && browserDraft.revision === revision && browserDraft.status === "draft";
}

function matchesDraftRow(row, courseId, slug, revision) {
  return row?.course_id === courseId && row.slug === slug && row.revision === revision && row.status === "draft";
}

async function readMatchingDraft(client, expected, courseId, revision) {
  const { slug, title, description, introduction, currency, accessMode, priceCents, cover, seo, taxClassification } = expected;
  const rows = await read(client, "course", "draft", [slug, title, description, introduction, currency, accessMode, priceCents, cover, seo, taxClassification]);
  demand(rows.length === 1 && matchesDraftRow(rows[0], courseId, slug, revision) && rows[0].fields_match === true, "course-draft-persistence");
  return { courseId, slug, revision, status: "draft", readOnly: true };
}

export async function captureP2InteractiveCourseDraftEditsBaseline(courseJob, selection, edits, dependencies) {
  const selected = Object.freeze({ ...selection }), { winner, stale } = validateP2InteractiveCourseDraftEdits(selected, edits);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { roleOid } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const rows = await read(client, "course", "draftCurrent", [selected.slug, winner.title, stale.title]);
    demand(rows.length === 1 && matchesDraftRow(rows[0], selected.courseId, selected.slug, selected.revision)
      && rows[0].both_titles_change === true, "course-draft-edit-baseline");
  });
  const baseline = Object.freeze({});
  draftEditBaselines.set(baseline, { selected, winner, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveCourseDraftEditsCase(courseJob, selection, baseline, browserDraft, dependencies) {
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = draftEditBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && closed(selection, draftEditSelectionFields)
    && saved.verifyEnvironment === dependencies?.verifyEnvironment && saved.verifySession === dependencies?.verifySession
    && draftEditSelectionFields.every(key => selection[key] === saved.selected[key])
    && matchesDraftReceipt(browserDraft, saved.selected.slug, saved.selected.revision + 1)
    && browserDraft.courseId === saved.selected.courseId, "course-draft-edit-receipt");
  draftEditBaselines.delete(baseline);
  const { result } = await readHeldCourseDraft(target, dependencies, saved.roleOid,
    client => readMatchingDraft(client, saved.winner, saved.selected.courseId, saved.selected.revision + 1));
  return result;
}

const courseReorderSelectionFields = ["courseId", "slug", "revision", "kind", "parentId", "winnerBodySha256", "staleBodySha256"];
const courseReorderBodyFields = ["expectedCourseRevision", "ids"];
const courseUuid = value => typeof value === "string" && UUID.test(value);
const siblingIds = value => Array.isArray(value) && value.length >= 3 && value.length <= 1000
  && [...value].every(courseUuid) && new Set(value).size === value.length;
const sameIds = (left, right) => Array.isArray(left) && left.length === right.length && right.every((id, index) => left[index] === id);

function isAdjacentSwap(before, ids) {
  if (ids.length !== before.length) return false;
  const index = before.findIndex((id, position) => id !== ids[position]);
  return index >= 0 && index < before.length - 1 && before[index] === ids[index + 1] && before[index + 1] === ids[index]
    && before.slice(index + 2).every((id, offset) => id === ids[index + 2 + offset]);
}

function reviewedReorderBody(value, bodySha256, revision, before) {
  demand(orderedDraftFields(value, courseReorderBodyFields) && value.expectedCourseRevision === revision && siblingIds(value.ids),
    "course-reorder-body");
  const ids = [...value.ids];
  demand(isAdjacentSwap(before, ids), "course-reorder-adjacent");
  const body = { expectedCourseRevision: revision, ids };
  const bytes = JSON.stringify(body);
  demand(JSON.stringify(value) === bytes && sha(bytes) === bodySha256, "course-reorder-body-hash");
  return body;
}

export function validateP2InteractiveCourseReorder(selection, reorder) {
  demand(closed(selection, courseReorderSelectionFields) && courseUuid(selection.courseId) && courseUuid(selection.parentId)
    && draftSlug(selection.slug) && Number.isInteger(selection.revision) && selection.revision >= 1 && selection.revision <= 2_147_483_646
    && ["module", "lesson"].includes(selection.kind) && (selection.kind !== "module" || selection.parentId === selection.courseId)
    && [selection.winnerBodySha256, selection.staleBodySha256].every(value => typeof value === "string" && SHA.test(value))
    && selection.winnerBodySha256 !== selection.staleBodySha256, "course-reorder-selection");
  demand(closed(reorder, ["before", "winner", "stale"]) && siblingIds(reorder.before), "course-reorder-list");
  const before = [...reorder.before];
  const winner = reviewedReorderBody(reorder.winner, selection.winnerBodySha256, selection.revision, before);
  const stale = reviewedReorderBody(reorder.stale, selection.staleBodySha256, selection.revision, before);
  demand(!sameIds(winner.ids, stale.ids), "course-reorder-distinct");
  return { before, winner, stale };
}

function siblingIdentity(row) {
  demand(courseUuid(row?.id) && typeof row.slug === "string" && typeof row.created_at === "string"
    && (row.archived_at === null || typeof row.archived_at === "string"), "course-reorder-sibling-identity");
  return JSON.stringify([row.id, row.slug, row.created_at, row.archived_at]);
}

async function readCourseReorder(client, selection, revision, ids, contiguous) {
  const { courseId, slug, kind, parentId } = selection;
  const courses = await read(client, "course", "reorderCourse", [slug]);
  demand(courses.length === 1 && matchesDraftRow(courses[0], courseId, slug, revision), "course-reorder-draft");
  let parent = null;
  if (kind === "lesson") {
    const parents = await read(client, "course", "reorderLessonParent", [parentId, courseId]);
    demand(parents.length === 1 && parents[0].id === parentId, "course-reorder-parent");
    parent = siblingIdentity(parents[0]);
  }
  const rows = await read(client, "course", kind === "module" ? "reorderModules" : "reorderLessons", [parentId]);
  demand(sameIds(rows.map(row => row.id), ids) && rows.every((row, index) =>
    Number.isInteger(row.position) && row.position > (index === 0 ? 0 : rows[index - 1].position)
      && (!contiguous || row.position === index + 1)), "course-reorder-siblings");
  return { parent, siblings: new Map(rows.map(row => [row.id, siblingIdentity(row)])) };
}

export async function captureP2InteractiveCourseReorderBaseline(courseJob, selection, reorder, dependencies) {
  const selected = Object.freeze({ ...selection }), { before, winner } = validateP2InteractiveCourseReorder(selected, reorder);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined,
    client => readCourseReorder(client, selected, selected.revision, before, false));
  const baseline = Object.freeze({});
  courseReorderBaselines.set(baseline, { selected, ids: winner.ids, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveCourseReorderCase(courseJob, selection, baseline, browserReorder, dependencies) {
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = courseReorderBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && closed(selection, courseReorderSelectionFields)
    && saved.verifyEnvironment === dependencies?.verifyEnvironment && saved.verifySession === dependencies?.verifySession
    && courseReorderSelectionFields.every(key => selection[key] === saved.selected[key])
    && closed(browserReorder, ["courseId", "parentId", "kind", "revision", "ids"])
    && ["courseId", "parentId", "kind"].every(key => browserReorder[key] === saved.selected[key])
    && browserReorder.revision === saved.selected.revision + 1 && sameIds(browserReorder.ids, saved.ids), "course-reorder-receipt");
  courseReorderBaselines.delete(baseline);
  const { courseId, parentId, kind } = saved.selected, revision = saved.selected.revision + 1;
  const { result } = await readHeldCourseDraft(target, dependencies, saved.roleOid,
    client => readCourseReorder(client, saved.selected, revision, saved.ids, true));
  demand(result.parent === saved.result.parent && saved.ids.every(id => result.siblings.get(id) === saved.result.siblings.get(id)),
    "course-reorder-identity-changed");
  return { courseId, parentId, kind, revision, ids: [...saved.ids], readOnly: true };
}

export async function runPrivatePersistenceProbeFromStdin(expectedProfile = undefined) {
  let size = 0; const chunks = [];
  try {
    if (expectedProfile !== undefined) parseQualificationTargetProfileRef(expectedProfile);
    for await (const chunk of process.stdin) { size += chunk.length; demand(size <= 262_144, "private-input-bound"); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const inputProfile = profileContext(expectedProfile, input, ...(input.mode === "combine" ? [input.plan] : [input.target]));
    if (closed(input, ["version", ...(inputProfile ? ["qualificationTargetProfile"] : []), "mode", "environment", "plan", "witness", "observations", "priorCapture"]) && input.mode === "combine") {
      demand(input.version === (inputProfile ? 2 : 1) && input.environment === "staging", "private-combine-mode");
      const witness = buildP2LifecycleStateWitness(input.plan, input.witness, input.observations);
      const priorWitness = input.priorCapture?.witness ?? null, priorEvidence = input.priorCapture?.privateEvidence ?? null;
      const receipt = input.witness.stage === "lifecycle-account"
        ? { ...lifecycleWitnessPublicReceipt(witness), status: "P2_LIFECYCLE_ACCOUNT_STATE_WITNESSED", providerTouched: false, releaseAccepted: false }
        : qualifyPersistenceStage(input.witness, input.observations, witness, priorWitness, priorEvidence);
      const privateEvidence = input.witness.stage === "lifecycle-account" ? null : persistencePrivateStageEvidence(input.witness, input.observations, priorEvidence);
      process.stdout.write(JSON.stringify({ version: inputProfile ? 2 : 1, ...(inputProfile ? { qualificationTargetProfile: inputProfile } : {}), status: "P2_LIFECYCLE_PERSISTENCE_PRIVATE_COMBINED", witness, privateEvidence, receipt, readOnly: true }) + "\n");
      return;
    }
    demand(closed(input, ["version", ...(inputProfile ? ["qualificationTargetProfile"] : []), "mode", "environment", "target", "witness", "connectionUrl"]) && input.version === (inputProfile ? 2 : 1) && input.environment === "staging"
      && ["frontend", "course", "community"].includes(input.mode), "private-child-mode");
    const client = await clientFromInput(input); let result;
    try { await client.connect(); demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true, "verified-node-tls");
      result = await observePersistenceDomain(input.mode, input.witness, input.target, client, inputProfile); }
    finally { await client.end(); }
    process.stdout.write(JSON.stringify({ version: inputProfile ? 2 : 1, ...(inputProfile ? { qualificationTargetProfile: inputProfile } : {}), status: "P2_LIFECYCLE_PERSISTENCE_PRIVATE_OBSERVATION", service: input.mode, observation: result, readOnly: true }) + "\n");
  } catch (error) {
    const check = error instanceof P2LifecyclePersistenceError && /^[a-z0-9.-]{1,120}$/u.test(error.check) ? error.check : "private-observation-failed";
    process.stdout.write(JSON.stringify({ version: 1, status: "P2_LIFECYCLE_PERSISTENCE_PRIVATE_REFUSED", check, readOnly: true }) + "\n"); process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, file] = process.argv.slice(2);
  if (operation !== "plan" || !file) { process.stderr.write("usage: p2-lifecycle-persistence-probe.mjs plan SETTINGS_JSON\n"); process.exitCode = 2; }
  else import("node:fs").then(({ readFileSync }) => process.stdout.write(JSON.stringify(prepareP2LifecyclePersistencePlan(JSON.parse(readFileSync(file, "utf8")))) + "\n"))
    .catch(() => { process.stdout.write('{"status":"P2_LIFECYCLE_PERSISTENCE_PLAN_REFUSED","credentialsRead":false,"networkCalled":false}\n'); process.exitCode = 1; });
}

export const P2_LIFECYCLE_PERSISTENCE_SQL = SQL;
