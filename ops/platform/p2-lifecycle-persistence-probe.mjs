import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { rootCertificates } from "node:tls";
import { setTimeout as wait } from "node:timers/promises";
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

const paidArchiveHistoryLimit = 1000;
const independentCommunityLimit = 4096;
const jsonbSha = fields => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${fields})::text,'UTF8')),'hex')`;
const paidArchiveDigest = (from, identity = "r.id", fields = "pg_catalog.to_jsonb(r)", limit = paidArchiveHistoryLimit) =>
  `SELECT count(*)::int AS row_count, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
    pg_catalog.string_agg(row_sha256,'' ORDER BY row_id),''),'UTF8')),'hex') AS digest
  FROM (SELECT ${identity} AS row_id, ${jsonbSha(fields)} AS row_sha256
    ${from} ORDER BY ${identity} LIMIT ${limit + 1}) bounded`;
const paidRevokeOutboxReceipt = `SELECT o.event_id::text,o.stream_version,o.canonical_digest,o.created_at::text,o.state,
  ${jsonbSha("pg_catalog.to_jsonb(o)")} AS delivery_sha256,
  (o.canonical_digest=${jsonbSha("o.canonical_body")}) AS digest_matches,
  (o.last_attempt_at>=o.created_at AND o.delivered_at>=o.last_attempt_at AND o.lease_owner IS NULL AND o.lease_expires_at IS NULL
    AND o.dead_lettered_at IS NULL AND o.last_failure_code IS NULL AND o.last_failure_detail IS NULL) AS settled
  FROM public.community_enrollment_outbox o WHERE o.stream_id=$1::uuid`;
const paidEligibleEnrollment = `FROM public.enrollments e WHERE e.user_id=$2::uuid AND e.status='active'
    AND NOT EXISTS(SELECT 1 FROM public.account_lifecycle_states a WHERE a.user_id=e.user_id AND a.status<>'active')
    AND EXISTS(SELECT 1 FROM public.entitlement_grants g WHERE g.user_id=e.user_id AND g.course_id=e.course_id
      AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>pg_catalog.transaction_timestamp()))`;
const paidIndependentEligibility = `${paidEligibleEnrollment} AND e.course_id<>$1::uuid
  AND EXISTS(SELECT 1 FROM public.courses c WHERE c.id=e.course_id AND c.status='published')`;

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
    curriculumCourse: "SELECT id::text AS course_id,slug,revision,status FROM public.courses WHERE slug=$1::text",
    curriculumLessonParent: `SELECT id::text,slug,created_at::text,archived_at::text FROM public.modules
      WHERE id=$1::uuid AND course_id=$2::uuid`,
    curriculumModules: `SELECT id::text,slug,position,created_at::text,archived_at::text FROM public.modules
      WHERE course_id=$1::uuid ORDER BY position LIMIT 1002`,
    curriculumLessons: `SELECT id::text,slug,position,created_at::text,archived_at::text FROM public.lessons
      WHERE module_id=$1::uuid ORDER BY position LIMIT 1002`,
    curriculumCreatedModule: `SELECT m.id::text AS item_id,m.slug,m.position,
      (m.title=$3::text AND m.description IS NOT DISTINCT FROM $4::text AND m.archived_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM public.lessons WHERE module_id=m.id)) AS fields_match
      FROM public.modules m WHERE m.id=$1::uuid AND m.course_id=$2::uuid`,
    curriculumCreatedLesson: `SELECT id::text AS item_id,slug,position,
      (title=$3::text AND content IS NULL AND content_document=$4::jsonb AND transcript IS NOT DISTINCT FROM $5::text
        AND is_preview=$6::boolean AND captions='[]'::jsonb AND archived_at IS NULL) AS fields_match
      FROM public.lessons WHERE id=$1::uuid AND module_id=$2::uuid`,
    publicationState: `SELECT id::text AS course_id,slug,revision,status,updated_at::text,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
        title,description,introduction,currency,access_mode,price_cents,cover,seo,tax_classification,created_at
      )::text,'UTF8')),'hex') AS metadata_sha256
      FROM public.courses WHERE slug=$1::text`,
    publicationCatalog: "SELECT id::text AS course_id,slug FROM public.courses WHERE slug=$1::text AND status='published' LIMIT 1",
    quizLesson: `SELECT c.id::text AS course_id,c.slug,c.revision,c.status,m.id::text AS module_id,
      pg_catalog.clock_timestamp()::text AS observed_at
      FROM public.lessons l JOIN public.modules m ON m.id=l.module_id JOIN public.courses c ON c.id=m.course_id
      WHERE l.id=$1::uuid AND l.archived_at IS NULL AND m.archived_at IS NULL`,
    quizLatest: `SELECT id::text AS quiz_id,revision FROM public.quiz_revisions
      WHERE lesson_id=$1::uuid ORDER BY revision DESC LIMIT 1`,
    quizHistory: `SELECT count(*)::text AS row_count,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(q)::text,'UTF8')),'hex'),
        '' ORDER BY q.revision),''),'UTF8')),'hex') AS digest
      FROM public.quiz_revisions q WHERE q.lesson_id=$1::uuid AND q.revision<=$2::int`,
    quizAttemptHistory: `SELECT count(*)::text AS row_count,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(a)::text,'UTF8')),'hex'),
        '' ORDER BY a.id),''),'UTF8')),'hex') AS digest
      FROM public.quiz_attempts a WHERE a.lesson_id=$1::uuid`,
    quizCreated: `SELECT id::text AS quiz_id,revision,
      (created_by=$3::uuid AND document=$4::jsonb AND created_at>$5::timestamptz
        AND created_at<=pg_catalog.statement_timestamp()) AS fields_match
      FROM public.quiz_revisions WHERE lesson_id=$1::uuid AND revision=$2::int`,
    freeEnrollmentCourse: `SELECT id::text AS course_id,slug,${jsonbSha("pg_catalog.to_jsonb(c)")} AS fingerprint
      FROM public.courses c WHERE slug=$1::text
      AND status='published' AND access_mode='free' AND currency='CAD' AND price_cents=0`,
    enrollmentGrant: `SELECT id::text AS grant_id,enrollment_id::text,granted_at::text,
      (grant_reason=$5::text AND status='active' AND idempotency_key=$3::text AND request_hash=$4::text
        AND external_order_id IS NULL AND external_payment_id IS NULL AND provider IS NULL AND expires_at IS NULL
        AND revoked_at IS NULL AND revoke_reason IS NULL AND revoke_idempotency_key IS NULL AND revoke_request_hash IS NULL) AS fields_match
      FROM public.entitlement_grants WHERE user_id=$1::uuid AND course_id=$2::uuid LIMIT 3`,
    enrollmentRecord: `SELECT id::text AS enrollment_id,granted_at::text,
      (status='active' AND source=$3::text AND revoked_at IS NULL AND refunded_at IS NULL) AS fields_match
      FROM public.enrollments WHERE user_id=$1::uuid AND course_id=$2::uuid LIMIT 2`,
    enrollmentKey: `SELECT (command_type=$3::text AND request_hash=$2::text) AS fields_match,
      ${jsonbSha("pg_catalog.to_jsonb(k)")} AS fingerprint
      FROM public.entitlement_idempotency_keys k WHERE idempotency_key=$1::text`,
    enrollmentOutbox: `${paidRevokeOutboxReceipt} LIMIT 2`,
    enrollmentProgress: `SELECT NOT EXISTS(SELECT 1 FROM public.lesson_progress p
      JOIN public.lessons l ON l.id=p.lesson_id JOIN public.modules m ON m.id=l.module_id
      LEFT JOIN public.enrollments e ON e.id=p.enrollment_id
      WHERE p.user_id=$1::uuid AND (m.course_id=$2::uuid OR (e.user_id=$1::uuid AND e.course_id=$2::uuid))) AS absent`,
    paidGrantCourse: `SELECT id::text AS course_id,revision FROM public.courses WHERE id=$1::uuid
      AND status='published' AND access_mode='paid' AND currency='CAD' AND price_cents>0`,
    paidGrantCommand: `SELECT id::text AS command_id,effective_at::text,
      (action='grant' AND scope='userCourse' AND actor_user_id=$2::text AND target_user_id=$3::uuid
        AND target_course_id=$4::uuid AND target_grant_id IS NULL AND reason=$5::text
        AND request_hash=$6::text AND outcome='applied' AND effect_count=1) AS fields_match
      FROM public.admin_entitlement_commands WHERE idempotency_key=$1::text LIMIT 2`,
    paidGrantEffect: `SELECT (command_id=$1::uuid AND entitlement_grant_id=$2::uuid
      AND effect_type='grant_created' AND previous_status IS NULL AND resulting_status='active') AS fields_match
      FROM public.admin_entitlement_command_effects WHERE command_id=$1::uuid OR entitlement_grant_id=$2::uuid LIMIT 2`,
    paidArchiveCourse: `SELECT slug FROM public.courses WHERE id=$1::uuid
      AND access_mode='paid' AND currency='CAD' AND price_cents>0`,
    paidCourseOwnerGrant: `SELECT (g.status='active' AND e.status='active' AND e.revoked_at IS NULL AND e.refunded_at IS NULL) AS active
      FROM public.entitlement_grants g
      JOIN public.enrollments e ON e.id=g.enrollment_id AND e.user_id=g.user_id AND e.course_id=g.course_id
      JOIN public.entitlement_idempotency_keys k ON k.idempotency_key=g.idempotency_key AND k.request_hash=g.request_hash
      JOIN public.admin_entitlement_commands a ON a.idempotency_key=g.idempotency_key AND a.request_hash=g.request_hash
      JOIN public.admin_entitlement_command_effects f ON f.command_id=a.id AND f.entitlement_grant_id=g.id
      WHERE g.course_id=$1::uuid AND g.user_id=$2::uuid AND g.id=$3::uuid AND g.grant_reason='manual'
        AND g.expires_at IS NULL AND g.external_order_id IS NULL AND g.external_payment_id IS NULL AND g.provider IS NULL
        AND e.source='admin'
        AND k.command_type='admin_grant' AND pg_catalog.starts_with(g.idempotency_key,'owner-paid:')
        AND a.action='grant' AND a.scope='userCourse' AND a.target_course_id=g.course_id AND a.target_user_id=g.user_id
        AND a.target_grant_id IS NULL AND a.outcome='applied' AND a.effect_count=1
        AND a.effective_at=g.granted_at AND pg_catalog.starts_with(a.reason,'[paid-course revision ')
        AND f.effect_type='grant_created' AND f.previous_status IS NULL AND f.resulting_status='active'`,
    paidCourseAccess: `SELECT (c.status='published' AND p.eligible) AS eligible,p.eligible AS eligible_if_published
      FROM public.courses c CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 ${paidEligibleEnrollment} AND e.course_id=c.id) AS eligible) p
      WHERE c.id=$1::uuid`,
    paidArchiveIndependentAccess: paidArchiveDigest(paidIndependentEligibility,
      "e.course_id", "pg_catalog.to_jsonb(e.course_id)"),
    paidRevokeIndependentCourses: `SELECT e.course_id::text ${paidIndependentEligibility} ORDER BY e.course_id LIMIT ${independentCommunityLimit + 1}`,
    paidCourseAccount: paidArchiveDigest("FROM public.account_lifecycle_states r WHERE r.user_id=$1::uuid", "r.user_id"),
    paidLearnerActiveAccount: `SELECT NOT EXISTS(SELECT 1 FROM public.account_lifecycle_states
      WHERE user_id=$1::uuid AND status<>'active') AS active`,
    paidLearnerLesson: `SELECT c.slug,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      v.id,v.generation,v.mux_asset_id,v.mux_playback_id,v.provider_environment_id,v.managed_by_course,v.duration_seconds,
      v.status,v.is_current,v.superseded_at,v.deleted_at,v.caption_tracks,v.last_error_code,
      CASE WHEN $3::boolean THEN NULL ELSE v.last_token_expires_at END
      )::text,'UTF8')),'hex') AS media_sha256
      FROM public.lessons l JOIN public.modules m ON m.id=l.module_id JOIN public.courses c ON c.id=m.course_id
      JOIN LATERAL (SELECT q.document FROM public.quiz_revisions q WHERE q.lesson_id=l.id ORDER BY q.revision DESC LIMIT 1) quiz
        ON quiz.document->>'mode'='graded' AND pg_catalog.jsonb_array_length(quiz.document->'questions')>0
      JOIN public.video_assets v ON v.lesson_id=l.id AND v.is_current AND v.deleted_at IS NULL AND v.status='ready'
        AND v.mux_asset_id<>'' AND v.mux_playback_id<>''
      WHERE c.id=$1::uuid AND l.id=$2::uuid AND l.archived_at IS NULL AND m.archived_at IS NULL AND NOT l.is_preview`,
    lessonEntryLesson: `SELECT v.id::text AS asset_id,v.duration_seconds,v.last_token_expires_at::text,pg_catalog.clock_timestamp()::text AS observed_at,
      ${jsonbSha("pg_catalog.to_jsonb(c)")} AS course_fingerprint,${jsonbSha("v.mux_playback_id")} AS playback_id_sha256
      FROM public.lessons l JOIN public.modules m ON m.id=l.module_id JOIN public.courses c ON c.id=m.course_id
      JOIN LATERAL (SELECT q.document FROM public.quiz_revisions q WHERE q.lesson_id=l.id ORDER BY q.revision DESC LIMIT 1) quiz
        ON pg_catalog.jsonb_array_length(quiz.document->'questions') BETWEEN 1 AND 100
      JOIN public.video_assets v ON v.lesson_id=l.id AND v.is_current AND v.status='ready' AND v.deleted_at IS NULL
        AND v.superseded_at IS NULL AND v.managed_by_course AND v.provider_environment_id<>'' AND v.mux_asset_id<>'' AND v.mux_playback_id<>''
      WHERE c.id=$1::uuid AND l.id=$2::uuid AND c.status='published' AND c.access_mode='free' AND c.currency='CAD' AND c.price_cents=0
        AND l.archived_at IS NULL AND m.archived_at IS NULL AND NOT l.is_preview`,
    lessonEntryFreeGrant: `SELECT e.id::text AS enrollment_id,${jsonbSha("pg_catalog.to_jsonb(k)")} AS key_fingerprint
      FROM public.entitlement_grants g JOIN public.enrollments e ON e.id=g.enrollment_id AND e.user_id=g.user_id AND e.course_id=g.course_id
      JOIN public.entitlement_idempotency_keys k ON k.idempotency_key=g.idempotency_key AND k.request_hash=g.request_hash
      WHERE g.id=$1::uuid AND g.user_id=$2::uuid AND g.course_id=$3::uuid AND g.request_hash=$4::text AND k.command_type='free_grant'
        AND g.status='active' AND g.grant_reason='free' AND g.expires_at IS NULL AND g.external_order_id IS NULL AND g.external_payment_id IS NULL
        AND g.provider IS NULL AND g.revoked_at IS NULL AND g.revoke_reason IS NULL AND g.revoke_idempotency_key IS NULL AND g.revoke_request_hash IS NULL
        AND e.status='active' AND e.source='free' AND e.revoked_at IS NULL AND e.refunded_at IS NULL AND e.granted_at=g.granted_at`,
    lessonEntryProgress: `SELECT id::text AS progress_id,enrollment_id::text,created_at::text,
      revision,resume_position_seconds,max_position_seconds,updated_at::text,
      (completed_at IS NULL AND completed_quiz_revision IS NULL AND last_watched_at=updated_at) AS incomplete,
      (revision=1 AND resume_position_seconds=0 AND max_position_seconds=0 AND completed_at IS NULL AND completed_quiz_revision IS NULL
        AND last_watched_at=created_at AND created_at=updated_at) AS started
      FROM public.lesson_progress WHERE user_id=$1::uuid AND lesson_id=$2::uuid LIMIT 2`,
    lessonEntryAttemptAbsent: `SELECT NOT EXISTS(SELECT 1 FROM public.quiz_attempts
      WHERE lesson_id=$1::uuid AND (user_id=$2::uuid OR enrollment_id=$3::uuid)) AS absent`,
    lessonEntryOtherProgress: paidArchiveDigest(`FROM public.lesson_progress r JOIN public.lessons l ON l.id=r.lesson_id
      JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid AND (r.user_id<>$2::uuid OR r.lesson_id<>$3::uuid)`),
    lessonEntryMediaHistory: paidArchiveDigest(`FROM public.video_assets r JOIN public.lessons l ON l.id=r.lesson_id
      JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid`, "r.id",
    "CASE WHEN r.id=$2::uuid THEN pg_catalog.to_jsonb(r)-'last_token_expires_at' ELSE pg_catalog.to_jsonb(r) END"),
    lessonDenialActiveAccounts: `SELECT NOT EXISTS(SELECT 1 FROM public.account_lifecycle_states
      WHERE user_id=ANY($1::uuid[]) AND status<>'active') AS active`,
    lessonDenialCanaries: `SELECT pg_catalog.jsonb_path_exists(l.content_document,
      '$.blocks[*].children[*] ? (@._type == "span" && @.text like_regex "p2q-s07-private-content")')
      AND pg_catalog.strpos(l.transcript,'p2q-s07-private-transcript')>0
      AND pg_catalog.jsonb_path_exists(quiz.document,
        '$.questions[*] ? (@.prompt like_regex "p2q-s07-private-quiz")') AS canaries
      FROM public.lessons l JOIN LATERAL (
        SELECT q.document FROM public.quiz_revisions q WHERE q.lesson_id=l.id ORDER BY q.revision DESC LIMIT 1
      ) quiz ON true WHERE l.id=$1::uuid`,
    lessonDenialPristine: `SELECT NOT EXISTS(SELECT 1 FROM public.enrollments WHERE course_id=$1::uuid AND user_id=$2::uuid)
      AND NOT EXISTS(SELECT 1 FROM public.entitlement_grants WHERE course_id=$1::uuid AND user_id=$2::uuid)
      AND NOT EXISTS(SELECT 1 FROM public.lesson_progress p JOIN public.lessons l ON l.id=p.lesson_id
        JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid AND p.user_id=$2::uuid)
      AND NOT EXISTS(SELECT 1 FROM public.quiz_attempts a JOIN public.lessons l ON l.id=a.lesson_id
        JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid AND a.user_id=$2::uuid) AS pristine`,
    lessonDenialMediaHistory: paidArchiveDigest(`FROM public.video_assets r JOIN public.lessons l ON l.id=r.lesson_id
      JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid`),
    lessonDenialIdentity: paidArchiveDigest("FROM public.users r WHERE r.id=ANY($1::uuid[])"),
    lessonDenialCommands: paidArchiveDigest("FROM public.account_lifecycle_commands r WHERE r.user_id=ANY($1::uuid[])", "r.command_id"),
    assessmentLesson: `SELECT quiz.id::text AS quiz_id,pg_catalog.clock_timestamp()::text AS observed_at,
      ${jsonbSha("pg_catalog.to_jsonb(c)")} AS course_fingerprint,
      grades.total_count,grades.fail_count,grades.pass_count
      FROM public.lessons l JOIN public.modules m ON m.id=l.module_id JOIN public.courses c ON c.id=m.course_id
      JOIN LATERAL (SELECT q.id,q.revision,q.document FROM public.quiz_revisions q
        WHERE q.lesson_id=l.id ORDER BY q.revision DESC LIMIT 1) quiz ON quiz.revision=$3::int
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS total_count,
          count(*) FILTER(WHERE q.question->>'correctOptionId'=answer.failed->>'optionId')::int AS fail_count,
          count(*) FILTER(WHERE q.question->>'correctOptionId'=answer.passed->>'optionId')::int AS pass_count
        FROM pg_catalog.jsonb_array_elements(quiz.document->'questions') WITH ORDINALITY q(question,position)
        CROSS JOIN LATERAL (SELECT $4::jsonb->(q.position::int-1) AS failed,$5::jsonb->(q.position::int-1) AS passed) answer
        WHERE q.question->>'id'=answer.failed->>'questionId' AND q.question->>'id'=answer.passed->>'questionId'
          AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(q.question->'options') o WHERE o->>'id'=answer.failed->>'optionId')
          AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(q.question->'options') o WHERE o->>'id'=answer.passed->>'optionId')
      ) grades
      WHERE c.id=$1::uuid AND l.id=$2::uuid AND c.status='published' AND c.access_mode='free' AND c.currency='CAD' AND c.price_cents=0
        AND l.archived_at IS NULL AND m.archived_at IS NULL AND NOT l.is_preview
        AND NOT EXISTS(SELECT 1 FROM public.video_assets v WHERE v.lesson_id=l.id)
        AND quiz.document->>'mode'='graded' AND (quiz.document->>'passingPercent')::int BETWEEN 1 AND 100
        AND grades.total_count=pg_catalog.jsonb_array_length(quiz.document->'questions')
        AND grades.total_count=pg_catalog.jsonb_array_length($4::jsonb) AND grades.total_count=pg_catalog.jsonb_array_length($5::jsonb)
        AND grades.fail_count*100<(quiz.document->>'passingPercent')::int*grades.total_count
        AND grades.pass_count*100>=(quiz.document->>'passingPercent')::int*grades.total_count`,
    assessmentProgress: `SELECT id::text AS progress_id,enrollment_id::text,revision,completed_quiz_revision,
      completed_at::text,created_at::text,
      (resume_position_seconds=0 AND max_position_seconds=0 AND last_watched_at=completed_at AND updated_at=completed_at) AS completed_in_place
      FROM public.lesson_progress WHERE user_id=$1::uuid AND lesson_id=$2::uuid LIMIT 2`,
    assessmentAttemptRows: `SELECT id::text AS attempt_id,request_id::text,request_hash,quiz_revision_id::text,
      user_id::text,enrollment_id::text,correct_count,total_count,passed,completed,created_at::text,
      (deidentified_at IS NULL AND CASE
        WHEN request_id=$4::uuid THEN answers=$5::jsonb
        WHEN request_id=$6::uuid THEN answers=$7::jsonb ELSE false END) AS answers_match
      FROM public.quiz_attempts WHERE lesson_id=$1::uuid AND (user_id=$2::uuid OR enrollment_id=$3::uuid)
      ORDER BY created_at,id LIMIT 3`,
    assessmentOtherAttempts: paidArchiveDigest(`FROM public.quiz_attempts r JOIN public.lessons l ON l.id=r.lesson_id
      JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid
        AND (r.user_id IS DISTINCT FROM $2::uuid OR r.lesson_id<>$3::uuid)`),
    assessmentOutbox: paidArchiveDigest(`FROM public.community_enrollment_outbox r JOIN public.community_enrollment_streams s
      ON s.id=r.stream_id WHERE s.course_id=$1::uuid`, "r.event_id"),
    paidArchiveModules: paidArchiveDigest("FROM public.modules r WHERE r.course_id=$1::uuid"),
    paidArchiveLessons: paidArchiveDigest(`FROM public.lessons r JOIN public.modules m ON m.id=r.module_id
      WHERE m.course_id=$1::uuid`),
    paidArchiveQuizRevisions: paidArchiveDigest(`FROM public.quiz_revisions r JOIN public.lessons l ON l.id=r.lesson_id
      JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid`),
    paidArchiveAttempts: paidArchiveDigest(`FROM public.quiz_attempts r JOIN public.lessons l ON l.id=r.lesson_id
      JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid`),
    paidArchiveProgress: paidArchiveDigest(`FROM public.lesson_progress r JOIN public.lessons l ON l.id=r.lesson_id
      JOIN public.modules m ON m.id=l.module_id WHERE m.course_id=$1::uuid`),
    paidArchiveEnrollments: paidArchiveDigest("FROM public.enrollments r WHERE r.course_id=$1::uuid"),
    paidArchiveGrants: paidArchiveDigest("FROM public.entitlement_grants r WHERE r.course_id=$1::uuid"),
    paidArchiveRevocations: paidArchiveDigest(`FROM public.entitlement_revocations r JOIN public.entitlement_grants g
      ON g.id=r.entitlement_grant_id WHERE g.course_id=$1::uuid`),
    paidArchiveCommands: paidArchiveDigest("FROM public.admin_entitlement_commands r WHERE r.target_course_id=$1::uuid"),
    paidArchiveEffects: paidArchiveDigest(`FROM public.admin_entitlement_command_effects r JOIN public.admin_entitlement_commands a
      ON a.id=r.command_id WHERE a.target_course_id=$1::uuid`),
    paidArchiveStreams: paidArchiveDigest("FROM public.community_enrollment_streams r WHERE r.course_id=$1::uuid"),
    paidArchiveEvents: paidArchiveDigest(`FROM public.community_enrollment_outbox r JOIN public.community_enrollment_streams s
      ON s.id=r.stream_id WHERE s.course_id=$1::uuid`, "r.event_id",
    "pg_catalog.jsonb_build_array(r.event_id,r.stream_id,r.stream_version,r.canonical_body,r.canonical_digest,r.created_at)"),
    paidRevokeTarget: `SELECT e.id::text AS enrollment_id,e.status AS enrollment_status,e.revoked_at::text AS enrollment_revoked_at,
      e.updated_at::text AS enrollment_updated_at,g.status AS grant_status,g.revoke_reason,g.revoked_at::text AS grant_revoked_at,
      g.updated_at::text AS grant_updated_at,${jsonbSha("pg_catalog.to_jsonb(g)-ARRAY['status','revoke_reason','revoked_at','updated_at']")} AS grant_identity,
      ${jsonbSha("pg_catalog.to_jsonb(e)-ARRAY['status','revoked_at','updated_at']")} AS enrollment_identity
      FROM public.entitlement_grants g JOIN public.enrollments e ON e.id=g.enrollment_id AND e.user_id=g.user_id AND e.course_id=g.course_id
      WHERE g.id=$1::uuid AND g.user_id=$2::uuid AND g.course_id=$3::uuid`,
    paidRevokeOtherAccess: `SELECT EXISTS(SELECT 1 FROM public.entitlement_grants g WHERE g.course_id=$1::uuid
      AND g.user_id=$2::uuid AND g.id<>$3::uuid AND g.status='active') AS active,
      EXISTS(SELECT 1 FROM public.entitlement_grants g WHERE g.course_id=$1::uuid AND g.user_id=$2::uuid AND g.id<>$3::uuid
        AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>pg_catalog.transaction_timestamp())) AS eligible`,
    paidRevokeCommand: `SELECT id::text AS command_id,effective_at::text,
      (action='revoke' AND scope='grantId' AND actor_user_id=$2::text AND target_user_id=$3::uuid
        AND target_course_id=$4::uuid AND target_grant_id=$5::uuid AND reason=$6::text AND request_hash=$7::text
        AND outcome='applied' AND effect_count=1) AS fields_match
      FROM public.admin_entitlement_commands WHERE idempotency_key=$1::text`,
    paidRevokeEffect: `SELECT (entitlement_grant_id=$2::uuid AND effect_type='grant_revoked'
      AND previous_status='active' AND resulting_status='revoked') AS fields_match
      FROM public.admin_entitlement_command_effects WHERE command_id=$1::uuid LIMIT 2`,
    paidRevokeOtherGrants: paidArchiveDigest("FROM public.entitlement_grants r WHERE r.course_id=$1::uuid AND r.id<>$2::uuid"),
    paidGrantOtherGrants: paidArchiveDigest("FROM public.entitlement_grants r WHERE r.course_id=$1::uuid AND r.idempotency_key<>$2::text"),
    paidRevokeOtherEnrollments: paidArchiveDigest("FROM public.enrollments r WHERE r.course_id=$1::uuid AND r.id<>$2::uuid"),
    paidRevokeOtherCommands: paidArchiveDigest("FROM public.admin_entitlement_commands r WHERE r.target_course_id=$1::uuid AND r.idempotency_key<>$2::text"),
    paidRevokeOtherEffects: paidArchiveDigest(`FROM public.admin_entitlement_command_effects r JOIN public.admin_entitlement_commands a
      ON a.id=r.command_id WHERE a.target_course_id=$1::uuid AND a.idempotency_key<>$2::text`),
    paidRevokeStream: `SELECT id::text AS stream_id,version,state,effective_at::text,created_at::text,updated_at::text
      FROM public.community_enrollment_streams WHERE course_id=$1::uuid AND user_id=$2::uuid`,
    paidRevokeOtherStreams: paidArchiveDigest("FROM public.community_enrollment_streams r WHERE r.course_id=$1::uuid AND r.user_id<>$2::uuid"),
    paidRevokePriorEvents: paidArchiveDigest(`FROM public.community_enrollment_outbox r JOIN public.community_enrollment_streams s
      ON s.id=r.stream_id WHERE s.course_id=$1::uuid AND (s.user_id<>$2::uuid OR r.stream_version<=$3::int)`, "r.event_id",
    "pg_catalog.jsonb_build_array(r.event_id,r.stream_id,r.stream_version,r.canonical_body,r.canonical_digest,r.created_at)"),
    paidRevokeCurrentEvent: `${paidRevokeOutboxReceipt} AND o.stream_version=$2::int LIMIT 2`,
    paidRevokeNewEvents: `${paidRevokeOutboxReceipt} AND o.stream_version>$2::int LIMIT 2`,
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
    heldIdentity: "SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_user::regrole::oid::text AS role_oid,(current_setting('server_version_num')::int/10000)::int AS major,current_setting('transaction_read_only') AS read_only",
    enrollmentPairAbsent: `SELECT NOT EXISTS(SELECT 1 FROM public.course_enrollment_projections WHERE user_id=$1::uuid AND course_id=$2::uuid)
      AND NOT EXISTS(SELECT 1 FROM public.course_enrollment_inbox WHERE user_id=$1::uuid AND course_id=$2::uuid) AS absent`,
    enrollmentPairInboxHistory: paidArchiveDigest(`FROM public.course_enrollment_inbox r
      WHERE (r.user_id=$1::uuid AND r.course_id=$2::uuid) OR r.stream_id=$3::uuid`, "r.event_id"),
    paidRevokeInbox: `SELECT (i.event_id=$1::uuid AND i.stream_id=$2::uuid AND i.stream_version=$3::int AND i.user_id=$4::uuid AND i.course_id=$5::uuid
      AND i.state=$6::text AND i.canonical_digest=$7::text AND i.effective_at=$8::timestamptz AND i.occurred_at=$9::timestamptz
      AND i.event_type=$10::text AND i.schema_version=1 AND i.producer='lash-her-course-api' AND i.status='applied'
      AND i.applied_at IS NOT NULL AND i.quarantine_code IS NULL AND i.canonical_digest=${jsonbSha("i.canonical_body")}) AS fields_match,
      ${jsonbSha("pg_catalog.to_jsonb(i)")} AS fingerprint
      FROM public.course_enrollment_inbox i WHERE i.event_id=$1::uuid OR (i.stream_id=$2::uuid AND i.stream_version=$3::int) LIMIT 2`,
    paidRevokeProjection: `SELECT (p.stream_id=$1::uuid AND p.user_id=$2::uuid AND p.course_id=$3::uuid AND p.applied_version=$4::int
      AND p.highest_observed_version=$4::int AND p.state=$5::text AND p.status='current' AND p.source='event'
      AND p.source_event_id=$6::uuid AND p.effective_at=$7::timestamptz) AS fields_match,
      ${jsonbSha("pg_catalog.to_jsonb(p)")} AS fingerprint
      FROM public.course_enrollment_projections p WHERE p.stream_id=$1::uuid OR (p.user_id=$2::uuid AND p.course_id=$3::uuid) LIMIT 2`,
    paidRevokeIndependentActive: paidArchiveDigest(`FROM public.course_enrollment_projections r WHERE r.user_id=$1::uuid
      AND r.course_id=ANY($2::uuid[]) AND r.state='active' AND r.status='current' AND r.applied_version=r.highest_observed_version`,
    "r.stream_id", "pg_catalog.to_jsonb(r)", independentCommunityLimit),
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
const curriculumCreateBaselines = new WeakMap();
const publicationBaselines = new WeakMap();
const quizSaveBaselines = new WeakMap();
const freeEnrollmentBaselines = new WeakMap();
const paidGrantBaselines = new WeakMap();
const paidArchiveBaselines = new WeakMap();
const paidRepublishBaselines = new WeakMap();
const paidLearnerAccessBaselines = new WeakMap();
const lessonEntryBaselines = new WeakMap();
const lessonResumeBaselines = new WeakMap();
const lessonRestoreBaselines = new WeakMap();
const lessonAckLossBaselines = new WeakMap();
const lessonDenialBaselines = new WeakMap();
const assessmentBaselines = new WeakMap();
const paidRevokeBaselines = new WeakMap();
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

function selectedHeldApiJob(job, service, check) {
  const target = job?.target;
  const profile = profileContext(job?.qualificationTargetProfile, job, target);
  demand(profile && job.schemaVersion === 2 && job.kind === "operator-migration" && job.operator === "Dardan"
    && job.environment === "staging" && job.contractPhase === "p2" && COMMIT.test(job.sourceCommit)
    && typeof job.releaseId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(job.releaseId)
    && target?.schemaVersion === 2 && target.environment === "staging" && target.service === `lash-her-${service}-api`
    && typeof target.host === "string" && /^[a-z0-9.-]+$/u.test(target.host) && !target.host.includes("..")
    && Number.isInteger(target.port) && target.port > 0 && target.port <= 65535 && ROLE.test(target.database)
    && ROLE.test(target.user) && ROLE.test(job.runtimeRole) && job.runtimeRole !== target.user && [16, 18].includes(target.serverMajor),
  check);
  return { target: { host: target.host, port: target.port, database: target.database, user: target.user, serverMajor: target.serverMajor },
    jobSha256: sha(job) };
}

const selectedCourseDraftJob = job => selectedHeldApiJob(job, "course", "course-draft-job");

async function verifyHeldApi(dependencies, check) {
  demand(!dependencies.signal?.aborted, `${check}-held-session`);
  await dependencies.verifyEnvironment(); await dependencies.verifySession();
  demand(!dependencies.signal?.aborted, `${check}-held-session`);
}

async function readHeldApi(target, dependencies, roleOid, task, { service, identityQuery, readDatabaseUrl, check }) {
  const { verifyEnvironment, verifySession } = dependencies;
  demand([verifyEnvironment, verifySession, readDatabaseUrl].every(value => typeof value === "function"), `${check}-held-session`);
  const verify = () => verifyHeldApi(dependencies, check);
  await verify();
  let client, begun = false, lost = false;
  try {
    const options = privateReadOnlyOptions(await readDatabaseUrl(), target, target.user);
    const { Client } = await import("pg");
    client = new Client(options);
    client.on("error", () => { lost = true; });
    await verify(); await client.connect(); await verify();
    const requireTls = () => demand(!lost && client.connection?.stream?.encrypted === true
      && client.connection.stream.authorized === true, "verified-node-tls");
    requireTls();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
    const [identity] = await read(client, service, identityQuery);
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
    throw new P2LifecyclePersistenceError(`${check}-observation`);
  } finally {
    if (client) {
      let closeFailed = false;
      try { if (begun) await client.query("ROLLBACK"); } catch { closeFailed = true; }
      try { await client.end(); } catch { closeFailed = true; }
      demand(!closeFailed, `${check}-close`);
    }
  }
}

const readHeldCourseDraft = (target, dependencies, roleOid, task) => readHeldApi(target, dependencies, roleOid, task,
  { service: "course", identityQuery: "draftIdentity", readDatabaseUrl: dependencies.readCourseDatabaseUrl, check: "course-draft" });

const readHeldCommunityDelivery = (target, dependencies, roleOid, task) => readHeldApi(target, dependencies, roleOid, task,
  { service: "community", identityQuery: "heldIdentity", readDatabaseUrl: dependencies.readCommunityDatabaseUrl, check: "community-delivery" });

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

async function readCourseCurriculum(client, selection, revision, check) {
  const { courseId, slug, kind, parentId } = selection;
  const courses = await read(client, "course", "curriculumCourse", [slug]);
  demand(courses.length === 1 && matchesDraftRow(courses[0], courseId, slug, revision), `${check}-draft`);
  let parent = null;
  if (kind === "lesson") {
    const parents = await read(client, "course", "curriculumLessonParent", [parentId, courseId]);
    demand(parents.length === 1 && parents[0].id === parentId, `${check}-parent`);
    parent = parents[0];
  }
  const rows = await read(client, "course", kind === "module" ? "curriculumModules" : "curriculumLessons", [parentId]);
  demand(rows.every((row, index) => Number.isInteger(row.position) && row.position > (index === 0 ? 0 : rows[index - 1].position)),
    `${check}-siblings`);
  return { parent, rows };
}

async function readCourseReorder(client, selection, revision, ids, contiguous) {
  const { parent, rows } = await readCourseCurriculum(client, selection, revision, "course-reorder");
  demand(sameIds(rows.map(row => row.id), ids) && (!contiguous || rows.every((row, index) => row.position === index + 1)), "course-reorder-siblings");
  return { parent: parent === null ? null : siblingIdentity(parent), siblings: new Map(rows.map(row => [row.id, siblingIdentity(row)])) };
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

const curriculumCreateSelectionFields = ["courseId", "slug", "revision", "kind", "parentId", "childSlug", "bodySha256"];
const curriculumCreateModuleFields = ["expectedCourseRevision", "title", "slug", "description", "position"];
const curriculumCreateLessonFields = ["expectedCourseRevision", "title", "slug", "position", "contentDocument", "transcript", "isPreview", "captions"];

let pinnedCourseContracts;
function courseMutationContract(path, method, property, check) {
  try {
    // The interactive operator has the reviewed frontend source and Ajv. The
    // private persistence child never invokes this path in its migration image.
    if (!pinnedCourseContracts) {
      const directory = new URL("../../contracts/api-integration/p2-candidate/", import.meta.url);
      const manifestBytes = readFileSync(new URL("manifest.json", directory)), manifest = JSON.parse(manifestBytes);
      const contractBytes = readFileSync(new URL("course-api.json", directory)), course = manifest.artifacts?.course;
      demand(manifest.version === 1 && ["candidate", "released"].includes(manifest.status) && course?.repository === "lash-her-course-api"
        && course.file === "course-api.json" && course.sourcePath === "openapi/course-api.json" && COMMIT.test(course.revision)
        && sha(contractBytes) === course.sha256, check);
      const { default: Ajv2020 } = createRequire(import.meta.url)("ajv/dist/2020");
      const ajv = new Ajv2020({ strict: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
      pinnedCourseContracts = { contract: JSON.parse(contractBytes), ajv, validators: new Map(),
        courseRevision: course.revision, manifestSha256: `sha256:${sha(manifestBytes)}` };
    }
    const { contract, ajv, validators, courseRevision, manifestSha256 } = pinnedCourseContracts;
    const key = `${method} ${path}`;
    if (!validators.has(key)) {
      const schema = contract.paths?.[path]?.[method]?.requestBody?.content?.["application/json"]?.schema;
      demand(schema?.type === "object" && schema.additionalProperties === false && schema.properties?.[property], check);
      validators.set(key, ajv.compile({ ...schema, components: contract.components }));
    }
    return { validate: validators.get(key), courseRevision, manifestSha256 };
  } catch {
    throw new P2LifecyclePersistenceError(check);
  }
}

const curriculumLessonContract = () => courseMutationContract("/v1/admin/modules/{moduleId}/lessons", "post", "contentDocument",
  "course-curriculum-create-contract");
const quizSaveContract = () => courseMutationContract("/v1/admin/lessons/{lessonId}/quiz", "put", "document", "course-quiz-save-contract");

function safeCurriculumLink(href) {
  if (/[\u0000-\u0020\\]/u.test(href)) return false;
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  try { const url = new URL(href); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}

export function validateP2InteractiveCurriculumCreate(selection, input) {
  demand(closed(selection, curriculumCreateSelectionFields) && courseUuid(selection.courseId) && courseUuid(selection.parentId)
    && draftSlug(selection.slug) && draftSlug(selection.childSlug)
    && Number.isInteger(selection.revision) && selection.revision >= 1 && selection.revision <= 2_147_483_646
    && ["module", "lesson"].includes(selection.kind) && (selection.kind !== "module" || selection.parentId === selection.courseId)
    && typeof selection.bodySha256 === "string" && SHA.test(selection.bodySha256), "course-curriculum-create-selection");
  let raw;
  try { raw = JSON.stringify(input); } catch { throw new P2LifecyclePersistenceError("course-curriculum-create-body"); }
  demand(typeof raw === "string" && Buffer.byteLength(raw) <= 1_048_576 && sha(raw) === selection.bodySha256, "course-curriculum-create-body-hash");
  const body = JSON.parse(raw), createsModule = selection.kind === "module";
  demand(orderedDraftFields(body, createsModule ? curriculumCreateModuleFields : curriculumCreateLessonFields)
    && body.expectedCourseRevision === selection.revision && body.slug === selection.childSlug && draftText(body.title, 300)
    && Number.isInteger(body.position) && body.position >= 1 && body.position <= 2_147_483_647, "course-curriculum-create-body");
  if (createsModule) demand(body.description === null || draftText(body.description, 100_000), "course-curriculum-create-module");
  else demand(orderedDraftFields(body.contentDocument, ["version", "blocks"]) && curriculumLessonContract().validate(body)
    && Buffer.byteLength(JSON.stringify(body.contentDocument)) <= 1_000_000
    && body.contentDocument.blocks.every(block => (block.markDefs ?? []).every(link => safeCurriculumLink(link.href)))
    && (body.transcript === null || draftText(body.transcript, 500_000)) && typeof body.isPreview === "boolean"
    && Array.isArray(body.captions) && body.captions.length === 0, "course-curriculum-create-lesson");
  return body;
}

function retainedCurriculumSibling(row) {
  return JSON.stringify([row.position, siblingIdentity(row)]);
}

export async function captureP2InteractiveCurriculumCreateBaseline(courseJob, selection, input, dependencies) {
  const selected = Object.freeze({ ...selection }), expected = validateP2InteractiveCurriculumCreate(selected, input);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  if (selected.kind === "lesson") {
    const { courseRevision, manifestSha256 } = curriculumLessonContract();
    demand(courseJob.sourceCommit === courseRevision && courseJob.phase2ContractManifestSha256 === manifestSha256,
      "course-curriculum-create-contract-target");
  }
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const { parent, rows } = await readCourseCurriculum(client, selected, selected.revision, "course-curriculum-create");
    demand(parent === null || parent.archived_at === null, "course-curriculum-create-parent");
    demand(rows.length <= 1000 && rows.every(row => row.slug !== selected.childSlug && row.position !== expected.position),
      "course-curriculum-create-occupied");
    return { parent: parent === null ? null : siblingIdentity(parent), siblings: rows.map(retainedCurriculumSibling) };
  });
  const baseline = Object.freeze({});
  curriculumCreateBaselines.set(baseline, { selected, expected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveCurriculumCreateCase(courseJob, selection, baseline, browserBody, dependencies) {
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = curriculumCreateBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && closed(selection, curriculumCreateSelectionFields)
    && saved.verifyEnvironment === dependencies?.verifyEnvironment && saved.verifySession === dependencies?.verifySession
    && curriculumCreateSelectionFields.every(key => selection[key] === saved.selected[key])
    && closed(browserBody, ["courseId", "parentId", "kind", "itemId", "slug", "revision"])
    && ["courseId", "parentId", "kind"].every(key => browserBody[key] === saved.selected[key]) && courseUuid(browserBody.itemId)
    && browserBody.slug === saved.selected.childSlug && browserBody.revision === saved.selected.revision + 1, "course-curriculum-create-receipt");
  curriculumCreateBaselines.delete(baseline);
  const { courseId, parentId, kind, childSlug } = saved.selected, revision = saved.selected.revision + 1;
  const { itemId } = browserBody;
  const { expected } = saved;
  await readHeldCourseDraft(target, dependencies, saved.roleOid, async client => {
    const { parent, rows } = await readCourseCurriculum(client, saved.selected, revision, "course-curriculum-create");
    const siblings = rows.filter(row => row.id !== itemId);
    demand(rows.length === saved.result.siblings.length + 1 && siblings.length === saved.result.siblings.length
      && siblings.every((row, index) => retainedCurriculumSibling(row) === saved.result.siblings[index])
      && (parent === null ? null : siblingIdentity(parent)) === saved.result.parent, "course-curriculum-create-siblings");
    const key = kind === "module" ? "curriculumCreatedModule" : "curriculumCreatedLesson";
    const args = [itemId, parentId, expected.title, ...(kind === "module"
      ? [expected.description] : [expected.contentDocument, expected.transcript, expected.isPreview])];
    const created = await read(client, "course", key, args);
    demand(created.length === 1 && created[0].item_id === itemId && created[0].slug === childSlug
      && created[0].position === expected.position && created[0].fields_match === true, "course-curriculum-create-persistence");
  });
  return { courseId, parentId, kind, itemId, slug: childSlug, revision, readOnly: true };
}

const publicationSelectionFields = ["courseId", "slug", "revision", "outcome", "issueCodes"];
const publicationIssueCode = /^[A-Z][A-Z0-9_]{0,63}$/u;
const validPublicationIssueCodes = (outcome, codes) => outcome === "published" ? codes.length === 0
  : codes.length > 0 && codes.length <= 16 && [...codes].every((code, index) =>
    typeof code === "string" && publicationIssueCode.test(code) && (index === 0 || codes[index - 1] < code));

export function validateP2InteractivePublication(selection, input) {
  demand(input === undefined && closed(selection, publicationSelectionFields) && courseUuid(selection.courseId)
    && draftSlug(selection.slug) && Number.isInteger(selection.revision) && selection.revision >= 1 && selection.revision <= 2_147_483_646
    && ["published", "blocked"].includes(selection.outcome) && Array.isArray(selection.issueCodes), "course-publication-selection");
  demand(validPublicationIssueCodes(selection.outcome, selection.issueCodes), "course-publication-issue-codes");
}

async function readCoursePublication(client, selection, revision, status) {
  const { courseId, slug } = selection;
  const states = await read(client, "course", "publicationState", [slug]);
  const row = states[0];
  demand(states.length === 1 && row.course_id === courseId && row.slug === slug && row.revision === revision
    && row.status === status && typeof row.metadata_sha256 === "string" && SHA.test(row.metadata_sha256)
    && typeof row.updated_at === "string", "course-publication-state");
  const catalog = await read(client, "course", "publicationCatalog", [slug]);
  demand(status === "published" ? catalog.length === 1 && catalog[0].course_id === courseId && catalog[0].slug === slug
    : catalog.length === 0, "course-publication-catalog");
  return { metadataSha256: row.metadata_sha256, updatedAt: row.updated_at };
}

export async function captureP2InteractivePublicationBaseline(courseJob, selection, input, dependencies) {
  validateP2InteractivePublication(selection, input);
  const selected = Object.freeze({ ...selection, issueCodes: Object.freeze([...selection.issueCodes]) });
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined,
    client => readCoursePublication(client, selected, selected.revision, "draft"));
  const baseline = Object.freeze({});
  publicationBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractivePublicationCase(courseJob, selection, baseline, browserBody, dependencies) {
  validateP2InteractivePublication(selection, undefined);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = publicationBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && ["courseId", "slug", "revision", "outcome"].every(key => selection[key] === saved.selected[key])
    && sameIds(selection.issueCodes, saved.selected.issueCodes), "course-publication-receipt");
  const { courseId, slug, issueCodes } = saved.selected;
  const published = saved.selected.outcome === "published", revision = saved.selected.revision + (published ? 1 : 0);
  const status = published ? "published" : "draft";
  // Issue codes are separately observed at the browser/API boundary.
  demand(closed(browserBody, ["courseId", "slug", "revision", "status", "issueCodes"]) && browserBody.courseId === courseId
    && browserBody.slug === slug && browserBody.revision === revision && browserBody.status === status
    && sameIds(browserBody.issueCodes, issueCodes), "course-publication-receipt");
  publicationBaselines.delete(baseline);
  const { result } = await readHeldCourseDraft(target, dependencies, saved.roleOid,
    client => readCoursePublication(client, saved.selected, revision, status));
  demand(result.metadataSha256 === saved.result.metadataSha256 && (published || result.updatedAt === saved.result.updatedAt),
    "course-publication-metadata");
  return { courseId, slug, revision, status, issueCodes: [...issueCodes], readOnly: true };
}

const quizSaveSelectionFields = ["courseId", "slug", "revision", "lessonId", "quizRevision", "documentSha256", "bodySha256", "actorId"];
const quizDocumentFields = ["version", "mode", "passingPercent", "questions"];
const canonicalAsciiJson = document => JSON.stringify(document, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);

export function validateP2InteractiveQuizSave(selection, input) {
  demand(closed(selection, quizSaveSelectionFields) && [selection.courseId, selection.lessonId, selection.actorId].every(courseUuid)
    && draftSlug(selection.slug) && Number.isInteger(selection.revision) && selection.revision >= 1 && selection.revision <= 2_147_483_646
    && Number.isInteger(selection.quizRevision) && selection.quizRevision >= 0 && selection.quizRevision <= 2_147_483_646
    && [selection.bodySha256, selection.documentSha256].every(value => typeof value === "string" && SHA.test(value)), "course-quiz-save-selection");
  let raw;
  try { raw = JSON.stringify(input); } catch { throw new P2LifecyclePersistenceError("course-quiz-save-body"); }
  demand(typeof raw === "string" && Buffer.byteLength(raw) <= 1_048_576 && sha(raw) === selection.bodySha256, "course-quiz-save-body-hash");
  const body = JSON.parse(raw);
  demand(orderedDraftFields(body, ["expectedCourseRevision", "document"]) && body.expectedCourseRevision === selection.revision
    && quizSaveContract().validate(body), "course-quiz-save-body");
  const { document } = body;
  demand(closed(document, quizDocumentFields) && document.version === 1 && ["practice", "graded"].includes(document.mode)
    && Number.isInteger(document.passingPercent) && document.passingPercent >= 1 && document.passingPercent <= 100
    && Buffer.byteLength(JSON.stringify(document)) <= 1_000_000, "course-quiz-save-document");
  demand(new Set(document.questions.map(question => question.id)).size === document.questions.length && document.questions.every(question => {
    const optionIds = new Set(question.options.map(option => option.id));
    return optionIds.size === question.options.length && optionIds.has(question.correctOptionId);
  }), "course-quiz-save-questions");
  demand(sha(canonicalAsciiJson(document)) === selection.documentSha256, "course-quiz-save-document-hash");
  return body;
}

async function readQuizSaveState(client, selection, courseRevision, quizRevision) {
  const { courseId, slug, lessonId } = selection;
  const lessons = await read(client, "course", "quizLesson", [lessonId]), lesson = lessons[0];
  demand(lessons.length === 1 && matchesDraftRow(lesson, courseId, slug, courseRevision) && courseUuid(lesson.module_id)
    && typeof lesson.observed_at === "string", "course-quiz-save-lesson");
  const latest = await read(client, "course", "quizLatest", [lessonId]);
  demand(quizRevision === 0 ? latest.length === 0
    : latest.length === 1 && latest[0].revision === quizRevision && courseUuid(latest[0].quiz_id), "course-quiz-save-revision");
  const [history] = await read(client, "course", "quizHistory", [lessonId, selection.quizRevision]);
  const [attempts] = await read(client, "course", "quizAttemptHistory", [lessonId]);
  demand(history?.row_count === String(selection.quizRevision) && typeof history.digest === "string" && SHA.test(history.digest)
    && typeof attempts?.row_count === "string" && /^(0|[1-9][0-9]*)$/u.test(attempts.row_count)
    && typeof attempts.digest === "string" && SHA.test(attempts.digest), "course-quiz-save-history");
  return { moduleId: lesson.module_id, cutoff: lesson.observed_at, quizId: latest[0]?.quiz_id ?? null,
    historyDigest: history.digest, attemptsCount: attempts.row_count, attemptsDigest: attempts.digest };
}

export async function captureP2InteractiveQuizSaveBaseline(courseJob, selection, input, dependencies) {
  const selected = Object.freeze({ ...selection }), { document } = validateP2InteractiveQuizSave(selected, input);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { courseRevision, manifestSha256 } = quizSaveContract();
  demand(courseJob.sourceCommit === courseRevision && courseJob.phase2ContractManifestSha256 === manifestSha256, "course-quiz-save-contract-target");
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined,
    client => readQuizSaveState(client, selected, selected.revision, selected.quizRevision));
  const baseline = Object.freeze({});
  quizSaveBaselines.set(baseline, { selected, document, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveQuizSaveCase(courseJob, selection, baseline, browserBody, dependencies) {
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = quizSaveBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && closed(selection, quizSaveSelectionFields)
    && saved.verifyEnvironment === dependencies?.verifyEnvironment && saved.verifySession === dependencies?.verifySession
    && quizSaveSelectionFields.every(key => selection[key] === saved.selected[key]), "course-quiz-save-receipt");
  const { courseId, slug, lessonId, documentSha256, actorId } = saved.selected;
  const revision = saved.selected.revision + 1, quizRevision = saved.selected.quizRevision + 1;
  demand(closed(browserBody, ["courseId", "slug", "lessonId", "quizId", "revision", "quizRevision", "documentSha256"])
    && ["courseId", "slug", "lessonId", "documentSha256"].every(key => browserBody[key] === saved.selected[key])
    && courseUuid(browserBody.quizId) && browserBody.quizId !== saved.result.quizId
    && browserBody.revision === revision && browserBody.quizRevision === quizRevision, "course-quiz-save-receipt");
  quizSaveBaselines.delete(baseline);
  const { quizId } = browserBody;
  await readHeldCourseDraft(target, dependencies, saved.roleOid, async client => {
    const current = await readQuizSaveState(client, saved.selected, revision, quizRevision);
    demand(current.quizId === quizId && current.moduleId === saved.result.moduleId, "course-quiz-save-persistence");
    demand(current.historyDigest === saved.result.historyDigest && current.attemptsCount === saved.result.attemptsCount
      && current.attemptsDigest === saved.result.attemptsDigest, "course-quiz-save-history-changed");
    const rows = await read(client, "course", "quizCreated", [lessonId, quizRevision, actorId, saved.document, saved.result.cutoff]);
    demand(rows.length === 1 && rows[0].quiz_id === quizId && rows[0].revision === quizRevision && rows[0].fields_match === true,
      "course-quiz-save-persistence");
  });
  return { courseId, slug, lessonId, quizId, revision, quizRevision, documentSha256, readOnly: true };
}

const freeEnrollmentSelectionFields = ["actorId", "courseId", "slug", "idempotencyKey"];
const freeEnrollmentPriorFields = ["grantId", "enrollmentId", "eventId", "streamId", "canonicalDigest"];
const freeEnrollmentBrowserFields = ["courseId", "grantId", "enrollmentId", "source", "status", "idempotentReplay"];
const uuidV4 = value => courseUuid(value) && value[14] === "4";

function selectedFreeEnrollment(value) {
  const replay = value && Object.hasOwn(value, "prior");
  demand(closed(value, replay ? [...freeEnrollmentSelectionFields, "prior"] : freeEnrollmentSelectionFields)
    && [value.actorId, value.courseId, value.idempotencyKey].every(courseUuid)
    && draftSlug(value.slug), "course-free-enrollment-selection");
  if (!replay) return Object.freeze({ ...value });
  const { prior } = value;
  demand(closed(prior, freeEnrollmentPriorFields) && [prior.grantId, prior.enrollmentId].every(courseUuid)
    && [prior.eventId, prior.streamId].every(uuidV4) && typeof prior.canonicalDigest === "string"
    && SHA.test(prior.canonicalDigest) && prior.canonicalDigest !== "0".repeat(64), "course-free-enrollment-selection");
  return Object.freeze({ ...value, prior: Object.freeze({ ...prior }) });
}

async function readEnrollmentPair(client, { userId, courseId, idempotencyKey, requestHash, grantReason, enrollmentSource, commandType }, check, first = true) {
  const pair = [userId, courseId];
  if (first) {
    const progress = await read(client, "course", "enrollmentProgress", pair);
    demand(progress.length === 1 && progress[0].absent === true, `${check}-progress`);
  }
  return {
    grants: await read(client, "course", "enrollmentGrant", [...pair, idempotencyKey, requestHash, grantReason]),
    enrollments: await read(client, "course", "enrollmentRecord", [...pair, enrollmentSource]),
    keys: await read(client, "course", "enrollmentKey", [idempotencyKey, requestHash, commandType]),
    streams: await read(client, "course", "paidRevokeStream", [courseId, userId]),
  };
}

async function readFreeEnrollmentPair(client, selection) {
  const { actorId, courseId, slug, idempotencyKey } = selection;
  const courses = await read(client, "course", "freeEnrollmentCourse", [slug]);
  demand(courses.length === 1 && courses[0].course_id === courseId && courses[0].slug === slug && SHA.test(courses[0].fingerprint),
    "course-free-enrollment-eligibility");
  const requestHash = sha(JSON.stringify({ command: "free_grant", userId: actorId, courseId }));
  const pair = await readEnrollmentPair(client, { userId: actorId, courseId, idempotencyKey, requestHash, grantReason: "free",
    enrollmentSource: "free", commandType: "free_grant" }, "course-free-enrollment", !selection.prior);
  return { pair, courseSha256: courses[0].fingerprint };
}

function requireJoinedEnrollment(pair, grantId, check, priorGrantId) {
  const grant = pair.grants.find(row => row.grant_id === grantId), enrollment = pair.enrollments[0], stream = pair.streams[0];
  demand(pair.grants.length === (priorGrantId ? 2 : 1) && (!priorGrantId || (grantId !== priorGrantId
    && pair.grants.some(row => row.grant_id === priorGrantId && row.enrollment_id === enrollment?.enrollment_id)))
    && [pair.enrollments, pair.keys].every(rows => rows.length === 1 && rows[0].fields_match === true)
    && pair.streams.length === 1 && grant?.fields_match === true && courseUuid(enrollment.enrollment_id)
    && grant.enrollment_id === enrollment.enrollment_id && uuidV4(stream.stream_id) && stream.version === 1 && stream.state === "active"
    && stream.effective_at === enrollment.granted_at && (priorGrantId || grant.granted_at === enrollment.granted_at), `${check}-persistence`);
  return { enrollmentId: enrollment.enrollment_id, grantedAt: grant.granted_at, stream };
}

async function observeEnrollmentActivation(client, { courseId, userId }, stream, check) {
  const outbox = await read(client, "course", "enrollmentOutbox", [stream.stream_id]);
  const event = enrollmentDeliveryEvent({ courseId, userId }, stream, outbox, check);
  demand(event.state === "active" && event.streamVersion === 1 && event.occurredAt === event.effectiveAt
    && outbox[0].created_at === stream.effective_at, `${check}-outbox`);
  return event;
}

function selectedActivationCommunityJob(courseJob, dependencies) {
  const community = selectedHeldApiJob(dependencies?.communityJob, "community", "community-delivery-job");
  demand(dependencies.communityJob.releaseId === courseJob.releaseId, "community-delivery-job");
  demand(typeof dependencies.readCommunityDatabaseUrl === "function", "community-delivery-held-session");
  return community;
}

async function readActivationReceiverBaseline(community, dependencies, selection, event, check, preserveInbox = false) {
  const { courseId, userId } = selection;
  const { result: receiver, roleOid: communityRoleOid } = await readHeldCommunityDelivery(community.target, dependencies, undefined, async client => {
    if (event) return readCommunityEnrollmentEvent(client, selection, event, check, preserveInbox);
    const rows = await read(client, "community", "enrollmentPairAbsent", [userId, courseId]);
    demand(rows.length === 1 && rows[0].absent === true, `${check}-baseline`);
  });
  return { receiver, communityRoleOid, communityJobSha256: community.jobSha256, readCommunityDatabaseUrl: dependencies.readCommunityDatabaseUrl };
}

const matchesActivationReceiverBinding = (saved, community, dependencies) => saved?.communityJobSha256 === community.jobSha256
  && saved.readCommunityDatabaseUrl === dependencies.readCommunityDatabaseUrl;

async function verifyEnrollmentDelivery(target, community, dependencies, saved, selection, source, check, receiverCheck, preserveInbox = false) {
  const event = await waitForEnrollmentDelivery(target, dependencies, saved.roleOid, selection, source.stream, source.event, check);
  const { result: receiver } = await readHeldCommunityDelivery(community.target, dependencies, saved.communityRoleOid,
    client => readCommunityEnrollmentEvent(client, selection, event, receiverCheck, preserveInbox));
  const final = await recheckEnrollmentDelivery(target, dependencies, saved.roleOid, selection, source.stream, event, undefined, check);
  demand(final.delivered && final.deliverySha256 === event.deliverySha256, `${check}-outbox`);
  if (preserveInbox) demand(receiver.inboxHistory === saved.receiver?.inboxHistory, `${receiverCheck}-inbox`);
  if (saved.receiver) demand(receiver.inbox === saved.receiver.inbox && receiver.projection === saved.receiver.projection, `${receiverCheck}-projection`);
  const { streamId, streamVersion, eventId, canonicalDigest, state } = event;
  return { streamId, streamVersion, eventId, canonicalDigest, state };
}

async function readFreeEnrollmentReplay(client, selection, { pair, courseSha256 }) {
  const { courseId, actorId, prior } = selection;
  const { enrollmentId, stream } = requireJoinedEnrollment(pair, prior.grantId, "course-free-enrollment");
  const event = await observeEnrollmentActivation(client, { courseId, userId: actorId }, stream, "course-free-enrollment");
  demand(enrollmentId === prior.enrollmentId && event.delivered && event.eventId === prior.eventId && event.streamId === prior.streamId
    && event.canonicalDigest === prior.canonicalDigest && SHA.test(pair.keys[0].fingerprint), "course-free-enrollment-prior");
  const history = [courseSha256, pair.keys[0].fingerprint,
    ...await readPaidArchiveDigests(client, [courseId], [...paidArchiveHistory, ...paidArchiveProjection]),
    ...await readPaidArchiveDigests(client, [actorId], ["paidCourseAccount"]),
  ];
  return { stream, event, history };
}

export async function captureP2InteractiveFreeEnrollmentBaseline(courseJob, selection, dependencies) {
  const selected = selectedFreeEnrollment(selection), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const community = selectedActivationCommunityJob(courseJob, dependencies);
  const identity = { courseId: selected.courseId, userId: selected.actorId };
  const { roleOid, result: prior } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const state = await readFreeEnrollmentPair(client, selected);
    if (selected.prior) return readFreeEnrollmentReplay(client, selected, state);
    demand(Object.values(state.pair).every(rows => rows.length === 0), "course-free-enrollment-baseline");
  });
  const receiver = await readActivationReceiverBaseline(community, dependencies, identity, prior?.event, "community-free-enrollment", Boolean(prior));
  if (prior) {
    const final = await recheckEnrollmentDelivery(target, dependencies, roleOid, identity, prior.stream, prior.event, undefined, "course-free-enrollment");
    demand(final.delivered && final.deliverySha256 === prior.event.deliverySha256, "course-free-enrollment-outbox");
  }
  const baseline = Object.freeze({});
  freeEnrollmentBaselines.set(baseline, { selected, jobSha256, roleOid, prior, ...receiver,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveFreeEnrollmentCase(courseJob, selection, baseline, browserBody, dependencies) {
  const selected = selectedFreeEnrollment(selection), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const community = selectedActivationCommunityJob(courseJob, dependencies);
  const saved = freeEnrollmentBaselines.get(baseline), idempotentReplay = Boolean(selected.prior);
  demand(saved?.jobSha256 === jobSha256 && matchesActivationReceiverBinding(saved, community, dependencies) && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && freeEnrollmentSelectionFields.every(key => selected[key] === saved.selected[key])
    && idempotentReplay === Boolean(saved.selected.prior)
    && (!idempotentReplay || freeEnrollmentPriorFields.every(key => selected.prior[key] === saved.selected.prior[key]))
    && closed(browserBody, freeEnrollmentBrowserFields) && browserBody.courseId === selected.courseId
    && [browserBody.grantId, browserBody.enrollmentId].every(courseUuid) && browserBody.source === "free"
    && browserBody.status === "active" && browserBody.idempotentReplay === idempotentReplay
    && (!idempotentReplay || (browserBody.grantId === selected.prior.grantId && browserBody.enrollmentId === selected.prior.enrollmentId)),
  "course-free-enrollment-receipt");
  freeEnrollmentBaselines.delete(baseline);
  const { courseId, actorId } = saved.selected;
  const { grantId, enrollmentId } = browserBody;
  const pair = { courseId, userId: actorId };
  const { result: source } = await readHeldCourseDraft(target, dependencies, saved.roleOid, async client => {
    const state = await readFreeEnrollmentPair(client, saved.selected);
    if (idempotentReplay) {
      const prior = await readFreeEnrollmentReplay(client, saved.selected, state);
      demand(sameIds(prior.history, saved.prior.history) && sha(prior.stream) === sha(saved.prior.stream)
        && sameEnrollmentDeliveryEvent(prior.event, saved.prior.event) && prior.event.deliverySha256 === saved.prior.event.deliverySha256,
      "course-free-enrollment-history");
      return prior;
    }
    const joined = requireJoinedEnrollment(state.pair, grantId, "course-free-enrollment");
    demand(joined.enrollmentId === enrollmentId, "course-free-enrollment-persistence");
    return { stream: joined.stream, event: await observeEnrollmentActivation(client, pair, joined.stream, "course-free-enrollment") };
  });
  const communityDelivery = await verifyEnrollmentDelivery(target, community, dependencies, saved, pair, source, "course-free-enrollment",
    "community-free-enrollment", idempotentReplay);
  return { courseId, grantId, enrollmentId, source: "free", status: "active", idempotentReplay, transitionId: communityDelivery.eventId,
    communityDelivery, readOnly: true };
}

const paidGrantSelectionFields = ["actorId", "courseId", "userId", "revision", "idempotencyKey", "reason"];
const paidGrantBrowserFields = ["courseId", "userId", "commandId", "grantId", "courseRevision"];

function selectedPaidGrant(value) {
  const second = value && Object.hasOwn(value, "priorGrantId");
  demand(closed(value, second ? [...paidGrantSelectionFields, "priorGrantId"] : paidGrantSelectionFields)
    && [value.actorId, value.courseId, value.userId, value.idempotencyKey].every(courseUuid) && (!second || courseUuid(value.priorGrantId))
    && Number.isInteger(value.revision) && value.revision >= 1 && value.revision <= 2_147_483_647
    && draftText(value.reason, 1800), "course-paid-grant-selection");
  return Object.freeze({ ...value });
}

async function readPaidGrantPair(client, selected) {
  const { actorId, courseId, userId, revision } = selected;
  const courses = await read(client, "course", "paidGrantCourse", [courseId]);
  demand(courses.length === 1 && courses[0].course_id === courseId && courses[0].revision === revision, "course-paid-grant-eligibility");
  const idempotencyKey = `owner-paid:${selected.idempotencyKey}`, reason = `[paid-course revision ${revision}] ${selected.reason}`;
  const requestHash = sha(canonicalAsciiJson({ action: "grant", scope: "userCourse", actorUserId: actorId, target: { userId, courseId }, reason }));
  const pair = await readEnrollmentPair(client, { userId, courseId, idempotencyKey, requestHash, grantReason: "manual",
    enrollmentSource: "admin", commandType: "admin_grant" }, "course-paid-grant", !selected.priorGrantId);
  const commands = await read(client, "course", "paidGrantCommand", [idempotencyKey, actorId, userId, courseId, reason, requestHash]);
  return { pair, commands, idempotencyKey };
}

async function readPriorPaidGrant(client, selection, { pair, idempotencyKey }) {
  const { courseId, userId, priorGrantId } = selection, prior = pair.grants.find(row => row.grant_id === priorGrantId);
  const enrollment = pair.enrollments[0], stream = pair.streams[0];
  const original = await read(client, "course", "paidCourseOwnerGrant", [courseId, userId, priorGrantId]);
  demand(original.length === 1 && original[0].active === true && prior && pair.enrollments.length === 1 && enrollment.fields_match === true
    && courseUuid(enrollment.enrollment_id) && prior.enrollment_id === enrollment.enrollment_id && prior.granted_at === enrollment.granted_at
    && pair.streams.length === 1 && uuidV4(stream.stream_id) && stream.version === 1 && stream.state === "active"
    && stream.effective_at === prior.granted_at, "course-paid-grant-prior");
  const event = await observeEnrollmentActivation(client, selection, stream, "course-paid-grant");
  demand(event.delivered, "course-paid-grant-delivery-baseline");
  const history = [
    ...await readPaidArchiveDigests(client, [courseId], [...paidCourseLearningHistory, "paidArchiveEnrollments", "paidArchiveRevocations", ...paidArchiveProjection]),
    ...await readPaidArchiveDigests(client, [courseId, idempotencyKey], ["paidGrantOtherGrants", "paidRevokeOtherCommands", "paidRevokeOtherEffects"]),
  ];
  return { stream, event, history };
}

export async function captureP2InteractivePaidGrantBaseline(courseJob, selection, dependencies) {
  const selected = selectedPaidGrant(selection), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const community = selectedActivationCommunityJob(courseJob, dependencies);
  const { result: prior, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const state = await readPaidGrantPair(client, selected), { pair, commands } = state;
    demand(commands.length === 0 && (selected.priorGrantId ? pair.grants.length === 1 && pair.keys.length === 0
      : Object.values(pair).every(rows => rows.length === 0)), "course-paid-grant-baseline");
    if (selected.priorGrantId) return readPriorPaidGrant(client, selected, state);
  });
  const receiver = await readActivationReceiverBaseline(community, dependencies, selected, prior?.event, "community-paid-grant");
  if (prior) {
    const final = await recheckEnrollmentDelivery(target, dependencies, roleOid, selected, prior.stream, prior.event, undefined, "course-paid-grant");
    demand(final.delivered && final.deliverySha256 === prior.event.deliverySha256, "course-paid-grant-outbox");
  }
  const baseline = Object.freeze({});
  paidGrantBaselines.set(baseline, { selected, jobSha256, roleOid, prior, ...receiver,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractivePaidGrantCase(courseJob, selection, baseline, browserBody, dependencies) {
  const selected = selectedPaidGrant(selection), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const community = selectedActivationCommunityJob(courseJob, dependencies);
  const saved = paidGrantBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && matchesActivationReceiverBinding(saved, community, dependencies) && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && paidGrantSelectionFields.every(key => selected[key] === saved.selected[key])
    && selected.priorGrantId === saved.selected.priorGrantId
    && closed(browserBody, paidGrantBrowserFields) && browserBody.courseId === selected.courseId && browserBody.userId === selected.userId
    && browserBody.courseRevision === selected.revision && [browserBody.commandId, browserBody.grantId].every(courseUuid), "course-paid-grant-receipt");
  paidGrantBaselines.delete(baseline);
  const { courseId, userId, revision: courseRevision, priorGrantId } = saved.selected, { commandId, grantId } = browserBody;
  const { result: source } = await readHeldCourseDraft(target, dependencies, saved.roleOid, async client => {
    const state = await readPaidGrantPair(client, saved.selected), { pair, commands } = state;
    const { enrollmentId, grantedAt, stream } = requireJoinedEnrollment(pair, grantId, "course-paid-grant", priorGrantId);
    demand(commands.length === 1 && commands[0].command_id === commandId && commands[0].fields_match === true
      && commands[0].effective_at === grantedAt, "course-paid-grant-command");
    const effects = await read(client, "course", "paidGrantEffect", [commandId, grantId]);
    demand(effects.length === 1 && effects[0].fields_match === true, "course-paid-grant-effect");
    if (priorGrantId) {
      const prior = await readPriorPaidGrant(client, saved.selected, state);
      demand(sameIds(prior.history, saved.prior.history) && sha(prior.stream) === sha(saved.prior.stream)
        && sameEnrollmentDeliveryEvent(prior.event, saved.prior.event) && prior.event.deliverySha256 === saved.prior.event.deliverySha256,
      "course-paid-grant-history");
      return { enrollmentId, stream, event: prior.event };
    }
    return { enrollmentId, stream, event: await observeEnrollmentActivation(client, saved.selected, stream, "course-paid-grant") };
  });
  const communityDelivery = await verifyEnrollmentDelivery(target, community, dependencies, saved, saved.selected, source, "course-paid-grant", "community-paid-grant");
  return { courseId, userId, commandId, grantId, courseRevision, enrollmentId: source.enrollmentId,
    ...(priorGrantId ? { priorGrantId } : {}), transitionId: priorGrantId ? null : communityDelivery.eventId, communityDelivery, readOnly: true };
}

const paidArchiveSelectionFields = ["courseId", "slug", "revision", "userId", "grantId"];
const paidCourseLearningHistory = ["paidArchiveModules", "paidArchiveLessons", "paidArchiveQuizRevisions", "paidArchiveAttempts", "paidArchiveProgress"];
const paidArchiveHistory = [...paidCourseLearningHistory, "paidArchiveEnrollments", "paidArchiveGrants", "paidArchiveRevocations",
  "paidArchiveCommands", "paidArchiveEffects"];
const paidArchiveProjection = ["paidArchiveStreams", "paidArchiveEvents"];

export function validateP2InteractivePaidArchive(selection, input) {
  demand(input === undefined && closed(selection, paidArchiveSelectionFields) && draftSlug(selection.slug)
    && [selection.courseId, selection.userId, selection.grantId].every(courseUuid) && Number.isInteger(selection.revision)
    && selection.revision >= 1 && selection.revision <= 2_147_483_646, "course-paid-archive-selection");
}

async function readPaidArchiveDigests(client, values, queries) {
  const digests = [];
  for (const query of queries) {
    const rows = await read(client, "course", query, values), row = rows[0];
    demand(rows.length === 1 && Number.isInteger(row.row_count) && row.row_count >= 0 && row.row_count <= paidArchiveHistoryLimit
      && SHA.test(row.digest), "course-paid-archive-history-limit");
    digests.push(row.digest);
  }
  return digests;
}

async function readPaidCourseTransition(client, selection, revision, status, { check, activeGrant = true, expectedAccess = true }) {
  const { courseId, userId, grantId } = selection;
  const publication = await readCoursePublication(client, selection, revision, status);
  demand((await read(client, "course", "paidArchiveCourse", [courseId])).length === 1, `${check}-eligibility`);
  const grants = await read(client, "course", "paidCourseOwnerGrant", [courseId, userId, grantId]);
  demand(grants.length === 1 && (!activeGrant || grants[0].active === true), `${check}-grant`);
  const access = await read(client, "course", "paidCourseAccess", [courseId, userId]);
  demand(access.length === 1 && access[0].eligible_if_published === expectedAccess
    && access[0].eligible === (status === "published" && expectedAccess), `${check}-access`);
  return { ...publication,
    history: await readPaidArchiveDigests(client, [courseId], paidArchiveHistory),
    projection: await readPaidArchiveDigests(client, [courseId], paidArchiveProjection),
    independentEligibility: await readPaidArchiveDigests(client, [courseId, userId], ["paidArchiveIndependentAccess"]) };
}

function requireUnchangedPaidCourseHistory(result, previous, check) {
  demand(result.metadataSha256 === previous.metadataSha256 && sameIds(result.history, previous.history), `${check}-history`);
  // The pinned Course status changes do not write to the outbox. Existing events may deliver independently.
  demand(sameIds(result.independentEligibility, previous.independentEligibility) && sameIds(result.projection, previous.projection),
    `${check}-community-authority`);
}

export async function captureP2InteractivePaidArchiveBaseline(courseJob, selection, input, dependencies) {
  validateP2InteractivePaidArchive(selection, input);
  const selected = Object.freeze({ ...selection }), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined,
    client => readPaidCourseTransition(client, selected, selected.revision, "published", { check: "course-paid-archive" }));
  const baseline = Object.freeze({});
  paidArchiveBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractivePaidArchiveCase(courseJob, selection, baseline, browserBody, dependencies) {
  validateP2InteractivePaidArchive(selection, undefined);
  const { courseId, slug, userId, grantId } = selection, revision = selection.revision + 1, status = "archived";
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = paidArchiveBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && paidArchiveSelectionFields.every(key => selection[key] === saved.selected[key])
    && closed(browserBody, ["courseId", "slug", "revision", "status"]) && browserBody.courseId === courseId
    && browserBody.slug === slug && browserBody.revision === revision && browserBody.status === status, "course-paid-archive-receipt");
  paidArchiveBaselines.delete(baseline);
  const { result } = await readHeldCourseDraft(target, dependencies, saved.roleOid,
    client => readPaidCourseTransition(client, saved.selected, revision, status, { check: "course-paid-archive" }));
  requireUnchangedPaidCourseHistory(result, saved.result, "course-paid-archive");
  return { courseId, slug, revision, status, userId, grantId, historyPreserved: true, readOnly: true };
}

const paidRepublishSelectionFields = [...paidArchiveSelectionFields, "outcome", "issueCodes", "expectedAccess"];
export function validateP2InteractivePaidRepublish(selection, input) {
  demand(input === undefined && closed(selection, paidRepublishSelectionFields) && draftSlug(selection.slug)
    && [selection.courseId, selection.userId, selection.grantId].every(courseUuid) && Number.isInteger(selection.revision)
    && selection.revision >= 1 && selection.revision <= 2_147_483_645 && typeof selection.expectedAccess === "boolean"
    && ["published", "blocked"].includes(selection.outcome) && Array.isArray(selection.issueCodes), "course-paid-republish-selection");
  demand(validPublicationIssueCodes(selection.outcome, selection.issueCodes), "course-paid-republish-issue-codes");
}

async function readPaidRepublish(client, selection, revision, status) {
  const snapshot = await readPaidCourseTransition(client, selection, revision, status,
    { check: "course-paid-republish", activeGrant: false, expectedAccess: selection.expectedAccess });
  const [accountSha256] = await readPaidArchiveDigests(client, [selection.userId], ["paidCourseAccount"]);
  return { ...snapshot, accountSha256 };
}

export async function captureP2InteractivePaidRepublishBaseline(courseJob, selection, input, dependencies) {
  validateP2InteractivePaidRepublish(selection, input);
  const selected = Object.freeze({ ...selection, issueCodes: Object.freeze([...selection.issueCodes]) });
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined,
    client => readPaidRepublish(client, selected, selected.revision, "archived"));
  const baseline = Object.freeze({});
  paidRepublishBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractivePaidRepublishCase(courseJob, selection, baseline, browserBody, dependencies) {
  validateP2InteractivePaidRepublish(selection, undefined);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = paidRepublishBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession
    && paidRepublishSelectionFields.every(key => key === "issueCodes" || selection[key] === saved.selected[key])
    && sameIds(selection.issueCodes, saved.selected.issueCodes), "course-paid-republish-receipt");
  const { courseId, slug, userId, grantId, issueCodes, expectedAccess } = saved.selected;
  const published = saved.selected.outcome === "published", revision = saved.selected.revision + (published ? 2 : 1);
  const status = published ? "published" : "draft";
  // Issue codes are separately observed at the browser/API boundary.
  demand(closed(browserBody, ["courseId", "slug", "revision", "status", "issueCodes"]) && browserBody.courseId === courseId
    && browserBody.slug === slug && browserBody.revision === revision && browserBody.status === status
    && sameIds(browserBody.issueCodes, issueCodes), "course-paid-republish-receipt");
  paidRepublishBaselines.delete(baseline);
  const { result } = await readHeldCourseDraft(target, dependencies, saved.roleOid,
    client => readPaidRepublish(client, saved.selected, revision, status));
  requireUnchangedPaidCourseHistory(result, saved.result, "course-paid-republish");
  demand(result.accountSha256 === saved.result.accountSha256, "course-paid-republish-account-history");
  return { courseId, slug, revision, status, issueCodes: [...issueCodes], userId, grantId, historyPreserved: true,
    effectiveAccess: published && expectedAccess, readOnly: true };
}

const paidLearnerAccessFields = ["actorId", "courseId", "lessonId", "grantId", "revision", "outcome"];
const paidLearnerCourseStatus = Object.freeze({ allowed: "published", archived: "archived", draft: "draft", restricted: "published" });

export function validateP2InteractivePaidLearnerAccess(selection, input) {
  demand(input === undefined && closed(selection, paidLearnerAccessFields)
    && [selection.actorId, selection.courseId, selection.lessonId, selection.grantId].every(courseUuid)
    && Number.isInteger(selection.revision) && selection.revision >= 1 && selection.revision <= 2_147_483_647
    && typeof selection.outcome === "string" && Object.hasOwn(paidLearnerCourseStatus, selection.outcome), "course-paid-learner-selection");
}

async function readPaidLearnerAccess(client, { actorId, courseId, lessonId, grantId, revision, outcome }) {
  const account = await read(client, "course", "paidLearnerActiveAccount", [actorId]);
  demand(account.length === 1 && account[0].active === true, "course-paid-learner-account");
  // Successful playback legitimately records expiry. Denied access must leave that receipt unchanged.
  const lessons = await read(client, "course", "paidLearnerLesson", [courseId, lessonId, outcome === "allowed"]), lesson = lessons[0];
  demand(lessons.length === 1 && draftSlug(lesson.slug) && SHA.test(lesson.media_sha256), "course-paid-learner-lesson");
  const snapshot = await readPaidCourseTransition(client, { courseId, slug: lesson.slug, userId: actorId, grantId },
    revision, paidLearnerCourseStatus[outcome], { check: "course-paid-learner", activeGrant: false, expectedAccess: outcome !== "restricted" });
  const [accountSha256] = await readPaidArchiveDigests(client, [actorId], ["paidCourseAccount"]);
  return { ...snapshot, slug: lesson.slug, accountSha256, mediaSha256: lesson.media_sha256 };
}

export async function captureP2InteractivePaidLearnerAccessBaseline(courseJob, selection, input, dependencies) {
  validateP2InteractivePaidLearnerAccess(selection, input);
  const selected = Object.freeze({ ...selection }), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, client => readPaidLearnerAccess(client, selected));
  const baseline = Object.freeze({});
  paidLearnerAccessBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractivePaidLearnerAccessCase(courseJob, selection, baseline, browserBody, dependencies) {
  validateP2InteractivePaidLearnerAccess(selection, undefined);
  const { courseId, lessonId, outcome, actorId, grantId, revision } = selection;
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = paidLearnerAccessBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && paidLearnerAccessFields.every(key => selection[key] === saved.selected[key])
    && closed(browserBody, ["courseId", "lessonId", "outcome"]) && browserBody.courseId === courseId
    && browserBody.lessonId === lessonId && browserBody.outcome === outcome, "course-paid-learner-receipt");
  paidLearnerAccessBaselines.delete(baseline);
  const { result } = await readHeldCourseDraft(target, dependencies, saved.roleOid, client => readPaidLearnerAccess(client, saved.selected));
  requireUnchangedPaidCourseHistory(result, saved.result, "course-paid-learner");
  demand(result.slug === saved.result.slug && result.updatedAt === saved.result.updatedAt && result.accountSha256 === saved.result.accountSha256
    && result.mediaSha256 === saved.result.mediaSha256, "course-paid-learner-state-drift");
  return { courseId, lessonId, outcome, actorId, grantId, revision, effectiveAccess: outcome === "allowed", readOnly: true };
}

const lessonEntrySelectionFields = ["actorId", "courseId", "lessonId", "grantId"];
const lessonEntryHistoryQueries = [...paidArchiveHistory.filter(query => query !== "paidArchiveProgress"), ...paidArchiveProjection];

function validateLessonEntrySelection(selection) {
  demand(closed(selection, lessonEntrySelectionFields) && lessonEntrySelectionFields.every(key => courseUuid(selection[key])), "course-lesson-entry-selection");
}

async function readLessonEntry(client, { actorId, courseId, lessonId, grantId },
  { check = "course-lesson-entry", historyQueries = lessonEntryHistoryQueries } = {}) {
  const lessons = await read(client, "course", "lessonEntryLesson", [courseId, lessonId]), lesson = lessons[0];
  demand(lessons.length === 1 && courseUuid(lesson.asset_id) && SHA.test(lesson.course_fingerprint)
    && Number.isFinite(Date.parse(lesson.observed_at)) && (lesson.last_token_expires_at === null || Number.isFinite(Date.parse(lesson.last_token_expires_at))),
  `${check}-lesson`);
  const requestHash = sha(JSON.stringify({ command: "free_grant", userId: actorId, courseId }));
  const grants = await read(client, "course", "lessonEntryFreeGrant", [grantId, actorId, courseId, requestHash]), grant = grants[0];
  demand(grants.length === 1 && courseUuid(grant.enrollment_id) && SHA.test(grant.key_fingerprint), `${check}-grant`);
  const access = await read(client, "course", "paidCourseAccess", [courseId, actorId]);
  demand(access.length === 1 && access[0].eligible === true, `${check}-access`);
  const attempts = await read(client, "course", "lessonEntryAttemptAbsent", [lessonId, actorId, grant.enrollment_id]);
  demand(attempts.length === 1 && attempts[0].absent === true, `${check}-attempt`);
  const progress = await read(client, "course", "lessonEntryProgress", [actorId, lessonId]);
  const history = [lesson.course_fingerprint, grant.key_fingerprint,
    ...await readPaidArchiveDigests(client, [courseId], historyQueries),
    ...await readPaidArchiveDigests(client, [courseId, actorId, lessonId], ["lessonEntryOtherProgress"]),
    ...await readPaidArchiveDigests(client, [actorId], ["paidCourseAccount"]),
  ];
  const [mediaSha256] = await readPaidArchiveDigests(client, [courseId, lesson.asset_id], ["lessonEntryMediaHistory"]);
  return { lesson, enrollmentId: grant.enrollment_id, progress, history, mediaSha256 };
}

function lessonEntryBrowserExpiry(receipt, courseId, lessonId) {
  const check = "course-lesson-entry-receipt";
  demand(closed(receipt, ["page", "playback", "progress"]), check);
  const { page, playback, progress } = receipt;
  demand(closed(page, ["pathname", "flight"]) && page.pathname === `/academy/courses/${courseId}/lessons/${lessonId}` && page.flight === true
    && closed(progress, ["requestId", "progressId", "enrollmentId", "revision"])
    && [progress.requestId, progress.progressId, progress.enrollmentId].every(courseUuid)
    && playback?.requestId !== progress.requestId && progress.revision === 1, check);
  return reviewedPlaybackExpiry(playback, check);
}

function reviewedPlaybackExpiry(playback, check, withPlaybackId = false) {
  demand(closed(playback, ["requestId", "expiresAt", "thumbnailExpiresAt", "lifetimeMs",
    ...(withPlaybackId ? ["playbackIdSha256"] : [])]) && courseUuid(playback.requestId)
    && (!withPlaybackId || typeof playback.playbackIdSha256 === "string" && SHA.test(playback.playbackIdSha256)), check);
  const dates = [playback.expiresAt, playback.thumbnailExpiresAt];
  const timestamps = dates.map(value => typeof value === "string" ? Date.parse(value) : NaN);
  demand(timestamps.every((value, index) => Number.isFinite(value) && date(value) === dates[index])
    && Number.isSafeInteger(playback.lifetimeMs) && playback.lifetimeMs >= 590_000
    && playback.lifetimeMs + Math.abs(timestamps[0] - timestamps[1]) <= 601_000, check);
  return Math.max(...timestamps);
}

export async function captureP2InteractiveLessonEntryBaseline(courseJob, selection, dependencies) {
  validateLessonEntrySelection(selection);
  const selected = Object.freeze({ ...selection }), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const before = await readLessonEntry(client, selected);
    demand(before.progress.length === 0, "course-lesson-entry-baseline");
    return before;
  });
  const baseline = Object.freeze({});
  lessonEntryBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveLessonEntryCase(courseJob, selection, baseline, browserReceipt, dependencies) {
  validateLessonEntrySelection(selection);
  const { courseId, lessonId, grantId, actorId } = selection, { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const saved = lessonEntryBaselines.get(baseline), playbackExpiry = lessonEntryBrowserExpiry(browserReceipt, courseId, lessonId);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && lessonEntrySelectionFields.every(key => selection[key] === saved.selected[key])
    && browserReceipt.progress.enrollmentId === saved.result.enrollmentId, "course-lesson-entry-receipt");
  lessonEntryBaselines.delete(baseline);
  const { progressId, enrollmentId } = browserReceipt.progress, before = saved.result;
  const { result: after } = await readHeldCourseDraft(target, dependencies, saved.roleOid, client => readLessonEntry(client, saved.selected));
  const progress = after.progress[0], startedAt = Date.parse(progress?.created_at);
  demand(after.enrollmentId === enrollmentId && after.progress.length === 1 && progress.progress_id === progressId
    && progress.enrollment_id === enrollmentId && progress.started === true && startedAt >= Date.parse(before.lesson.observed_at)
    && startedAt <= Date.parse(after.lesson.observed_at), "course-lesson-entry-progress");
  demand(sameIds(after.history, before.history), "course-lesson-entry-history");
  const baselineExpiry = before.lesson.last_token_expires_at === null ? 0 : Date.parse(before.lesson.last_token_expires_at);
  demand(after.lesson.asset_id === before.lesson.asset_id && after.mediaSha256 === before.mediaSha256
    && Date.parse(after.lesson.last_token_expires_at) === Math.max(baselineExpiry, playbackExpiry), "course-lesson-entry-media");
  return { courseId, lessonId, grantId, actorId, enrollmentId, progressId, revision: 1, playbackExpiresAt: date(playbackExpiry), readOnly: true };
}

const lessonResumeHistoryQueries = [...lessonEntryHistoryQueries.filter(query => query !== "paidArchiveEvents"), "assessmentOutbox"];

function validateLessonResumeSelection(selection) {
  demand(closed(selection, lessonEntrySelectionFields) && lessonEntrySelectionFields.every(key => courseUuid(selection[key])),
    "course-lesson-resume-selection");
}

async function readLessonResume(client, selection, check = "course-lesson-resume") {
  const { actorId } = selection;
  const result = await readLessonEntry(client, selection, { check, historyQueries: lessonResumeHistoryQueries });
  demand(Number.isInteger(result.lesson.duration_seconds) && result.lesson.duration_seconds >= 22, `${check}-lesson`);
  const account = await read(client, "course", "paidLearnerActiveAccount", [actorId]);
  demand(account.length === 1 && account[0].active === true, `${check}-access`);
  demand(typeof result.lesson.playback_id_sha256 === "string" && SHA.test(result.lesson.playback_id_sha256), `${check}-media`);
  return { ...result, history: [...result.history,
    ...await readPaidArchiveDigests(client, [[actorId]], ["lessonDenialIdentity", "lessonDenialCommands"]),
  ] };
}

function validateLessonResumeReceipt(receipt, { courseId, lessonId }, before) {
  const check = "course-lesson-resume-receipt";
  demand(closed(receipt, ["page", "playback", "started", "writes", "media"]), check);
  const { page, playback, started, writes, media } = receipt;
  const playbackExpiry = reviewedPlaybackExpiry(playback, check, true);
  demand(closed(page, ["pathname", "status"]) && page.pathname === `/academy/courses/${courseId}/lessons/${lessonId}` && page.status === 200
    && playback.playbackIdSha256 === before.lesson.playback_id_sha256
    && closed(started, ["requestId", "progressId", "enrollmentId", "revision"])
    && [started.requestId, started.progressId, started.enrollmentId].every(courseUuid)
    && started.enrollmentId === before.enrollmentId && started.revision === 1 && Array.isArray(writes) && writes.length === 3, check);
  for (const [index, write] of writes.entries()) {
    demand(closed(write, ["requestId", "expectedProgressRevision", "revision", "resumePositionSeconds",
      "submittedMaxPositionSeconds", "maxPositionSeconds"]) && courseUuid(write.requestId)
      && write.expectedProgressRevision === index + 1 && write.revision === index + 2
      && [write.resumePositionSeconds, write.submittedMaxPositionSeconds, write.maxPositionSeconds].every(Number.isSafeInteger)
      && write.maxPositionSeconds === Math.max(write.resumePositionSeconds, write.submittedMaxPositionSeconds), check);
  }
  const [heartbeat, pause, rewind] = writes;
  demand(new Set([playback.requestId, started.requestId, ...writes.map(write => write.requestId)]).size === 5
    && heartbeat.resumePositionSeconds >= 10 && heartbeat.resumePositionSeconds <= 12
    && heartbeat.submittedMaxPositionSeconds === heartbeat.resumePositionSeconds
    && pause.resumePositionSeconds >= 13 && pause.resumePositionSeconds <= 16 && pause.resumePositionSeconds >= heartbeat.resumePositionSeconds
    && pause.submittedMaxPositionSeconds >= heartbeat.maxPositionSeconds && pause.submittedMaxPositionSeconds <= pause.resumePositionSeconds
    && pause.resumePositionSeconds - pause.submittedMaxPositionSeconds <= 1
    && rewind.resumePositionSeconds === pause.resumePositionSeconds - 10
    && rewind.submittedMaxPositionSeconds === pause.maxPositionSeconds && rewind.maxPositionSeconds === pause.maxPositionSeconds, check);
  demand(closed(media, ["durationSeconds", "videoWidth", "heartbeatSeconds", "pausedSeconds", "rewoundSeconds", "manifestObserved", "segmentObserved"])
    && [media.durationSeconds, media.videoWidth, media.heartbeatSeconds, media.pausedSeconds, media.rewoundSeconds].every(Number.isSafeInteger)
    && media.durationSeconds >= 22 && media.videoWidth > 0 && media.manifestObserved === true && media.segmentObserved === true
    && media.heartbeatSeconds >= heartbeat.resumePositionSeconds && media.heartbeatSeconds <= heartbeat.resumePositionSeconds + 1
    && media.pausedSeconds === pause.resumePositionSeconds && media.rewoundSeconds === rewind.resumePositionSeconds, check);
  return playbackExpiry;
}

export async function captureP2InteractiveResumeBaseline(courseJob, selection, dependencies) {
  validateLessonResumeSelection(selection);
  const selected = Object.freeze({ ...selection }), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const before = await readLessonResume(client, selected);
    demand(before.progress.length === 0, "course-lesson-resume-baseline");
    return before;
  });
  const baseline = Object.freeze({});
  lessonResumeBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveResumeCase(courseJob, selection, baseline, browserReceipt, dependencies) {
  validateLessonResumeSelection(selection);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = lessonResumeBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && lessonEntrySelectionFields.every(key => selection[key] === saved.selected[key]),
  "course-lesson-resume-receipt");
  const before = saved.result, playbackExpiry = validateLessonResumeReceipt(browserReceipt, saved.selected, before);
  lessonResumeBaselines.delete(baseline);
  const { progressId, enrollmentId } = browserReceipt.started;
  const { revision, resumePositionSeconds, maxPositionSeconds } = browserReceipt.writes[2];
  const { result: after } = await readHeldCourseDraft(target, dependencies, saved.roleOid, client => readLessonResume(client, saved.selected));
  const progress = after.progress[0], createdAt = Date.parse(progress?.created_at), updatedAt = Date.parse(progress?.updated_at);
  demand(after.enrollmentId === enrollmentId && after.progress.length === 1 && progress.progress_id === progressId
    && progress.enrollment_id === enrollmentId && progress.revision === revision && progress.resume_position_seconds === resumePositionSeconds
    && progress.max_position_seconds === maxPositionSeconds && progress.incomplete === true
    && createdAt >= Date.parse(before.lesson.observed_at) && updatedAt >= createdAt && updatedAt <= Date.parse(after.lesson.observed_at),
  "course-lesson-resume-progress");
  demand(sameIds(after.history, before.history), "course-lesson-resume-history");
  const baselineExpiry = before.lesson.last_token_expires_at === null ? 0 : Date.parse(before.lesson.last_token_expires_at);
  demand(after.lesson.asset_id === before.lesson.asset_id && after.mediaSha256 === before.mediaSha256
    && after.lesson.playback_id_sha256 === browserReceipt.playback.playbackIdSha256
    && Date.parse(after.lesson.last_token_expires_at) === Math.max(baselineExpiry, playbackExpiry), "course-lesson-resume-media");
  return { ...saved.selected, enrollmentId, progressId, revision, resumePositionSeconds, maxPositionSeconds,
    playbackExpiresAt: date(playbackExpiry), playbackIdSha256: after.lesson.playback_id_sha256, readOnly: true };
}

const lessonRestorePriorFields = ["actionId", "outcomeSha256", "progressId", "enrollmentId",
  "resumePositionSeconds", "maxPositionSeconds", "playbackIdSha256", "playbackExpiresAt"];

function validateLessonRestoreSelection(selection) {
  const check = "course-lesson-restore-selection";
  demand(closed(selection, [...lessonEntrySelectionFields, "prior"])
    && lessonEntrySelectionFields.every(key => courseUuid(selection[key])) && closed(selection.prior, lessonRestorePriorFields), check);
  const { prior } = selection, expiry = typeof prior.playbackExpiresAt === "string" ? Date.parse(prior.playbackExpiresAt) : NaN;
  demand(typeof prior.actionId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(prior.actionId)
    && [prior.outcomeSha256, prior.playbackIdSha256].every(value => typeof value === "string" && SHA.test(value) && !/^0{64}$/u.test(value))
    && courseUuid(prior.progressId) && courseUuid(prior.enrollmentId)
    && Number.isSafeInteger(prior.resumePositionSeconds) && prior.resumePositionSeconds >= 3 && prior.resumePositionSeconds <= 6
    && prior.maxPositionSeconds === prior.resumePositionSeconds + 10
    && Number.isFinite(expiry) && prior.playbackExpiresAt.length === 24 && prior.playbackExpiresAt.slice(0, 4) !== "0000"
    && date(expiry) === prior.playbackExpiresAt, check);
}

async function readPinnedLessonPosition(client, selection, position, revision, check) {
  const result = await readLessonResume(client, selection, check), progress = result.progress[0];
  const createdAt = Date.parse(progress?.created_at), updatedAt = Date.parse(progress?.updated_at);
  demand(result.enrollmentId === position.enrollmentId && result.progress.length === 1
    && progress.progress_id === position.progressId && progress.enrollment_id === position.enrollmentId
    && progress.revision === revision && progress.resume_position_seconds === position.resumePositionSeconds
    && progress.max_position_seconds === position.maxPositionSeconds && progress.incomplete === true
    && createdAt <= updatedAt && updatedAt <= Date.parse(result.lesson.observed_at), `${check}-progress`);
  demand(result.lesson.playback_id_sha256 === position.playbackIdSha256, `${check}-media`);
  return result;
}

async function readLessonRestore(client, selection, revision) {
  const result = await readPinnedLessonPosition(client, selection, selection.prior, revision, "course-lesson-restore");
  demand(Date.parse(result.lesson.last_token_expires_at) >= Date.parse(selection.prior.playbackExpiresAt), "course-lesson-restore-media");
  return result;
}

function validateLessonRestoreReceipt(receipt, { courseId, lessonId, prior }, before) {
  const check = "course-lesson-restore-receipt";
  demand(closed(receipt, ["page", "playback", "started", "restored", "media"]), check);
  const { page, playback, started, restored, media } = receipt;
  const expiry = reviewedPlaybackExpiry(playback, check, true);
  demand(closed(page, ["pathname", "status"]) && page.pathname === `/academy/courses/${courseId}/lessons/${lessonId}` && page.status === 200
    && playback.playbackIdSha256 === prior.playbackIdSha256 && expiry > Date.parse(prior.playbackExpiresAt)
    && expiry > Date.parse(before.lesson.observed_at)
    && closed(started, ["requestId", "progressId", "enrollmentId", "revision"])
    && closed(restored, ["requestId", "progressId", "enrollmentId", "revision", "resumePositionSeconds", "maxPositionSeconds"])
    && [started, restored].every(write => courseUuid(write.requestId)
      && write.progressId === prior.progressId && write.enrollmentId === prior.enrollmentId)
    && new Set([playback.requestId, started.requestId, restored.requestId]).size === 3
    && started.revision === 5 && restored.revision === 6
    && restored.resumePositionSeconds === prior.resumePositionSeconds && restored.maxPositionSeconds === prior.maxPositionSeconds
    && closed(media, ["durationSeconds", "videoWidth", "restoredSeconds", "paused", "manifestObserved", "segmentObserved"])
    && Number.isSafeInteger(media.durationSeconds) && media.durationSeconds >= 22 && Number.isSafeInteger(media.videoWidth) && media.videoWidth > 0
    && media.restoredSeconds === prior.resumePositionSeconds && media.paused === true && media.manifestObserved === true
    && media.segmentObserved === true, check);
  return expiry;
}

export async function captureP2InteractiveRestoreBaseline(courseJob, selection, dependencies) {
  validateLessonRestoreSelection(selection);
  const selected = Object.freeze({ ...selection, prior: Object.freeze({ ...selection.prior }) });
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, client => readLessonRestore(client, selected, 4));
  const baseline = Object.freeze({});
  lessonRestoreBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveRestoreCase(courseJob, selection, baseline, browserReceipt, dependencies) {
  validateLessonRestoreSelection(selection);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = lessonRestoreBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && lessonEntrySelectionFields.every(key => selection[key] === saved.selected[key])
    && lessonRestorePriorFields.every(key => selection.prior[key] === saved.selected.prior[key]), "course-lesson-restore-receipt");
  const before = saved.result, playbackExpiry = validateLessonRestoreReceipt(browserReceipt, saved.selected, before);
  lessonRestoreBaselines.delete(baseline);
  const { result: after } = await readHeldCourseDraft(target, dependencies, saved.roleOid, client => readLessonRestore(client, saved.selected, 6));
  demand(after.progress[0].created_at === before.progress[0].created_at
    && Date.parse(after.progress[0].updated_at) >= Date.parse(before.lesson.observed_at), "course-lesson-restore-progress");
  demand(sameIds(after.history, before.history), "course-lesson-restore-history");
  demand(after.lesson.asset_id === before.lesson.asset_id && after.mediaSha256 === before.mediaSha256
    && Date.parse(after.lesson.last_token_expires_at) === Math.max(Date.parse(before.lesson.last_token_expires_at), playbackExpiry),
  "course-lesson-restore-media");
  const { actorId, courseId, lessonId, grantId, prior } = saved.selected;
  return { actorId, courseId, lessonId, grantId, enrollmentId: prior.enrollmentId, progressId: prior.progressId, revision: 6,
    resumePositionSeconds: prior.resumePositionSeconds, maxPositionSeconds: prior.maxPositionSeconds, playbackExpiresAt: date(playbackExpiry),
    playbackIdSha256: prior.playbackIdSha256, readOnly: true };
}

const lessonAckLossIdentityFields = [...lessonEntrySelectionFields, "progressId", "enrollmentId"];
const lessonAckLossSelectionFields = [...lessonAckLossIdentityFields, "resumePositionSeconds", "maxPositionSeconds", "playbackIdSha256"];
const lessonAckLossProgressFields = ["requestId", "progressId", "enrollmentId", "revision", "resumePositionSeconds", "maxPositionSeconds"];

function validateLessonAckLossSelection(selection) {
  demand(closed(selection, lessonAckLossSelectionFields) && lessonAckLossIdentityFields.every(key => courseUuid(selection[key]))
    && Number.isInteger(selection.resumePositionSeconds) && selection.resumePositionSeconds >= 3 && selection.resumePositionSeconds <= 6
    && selection.maxPositionSeconds === selection.resumePositionSeconds + 10
    && typeof selection.playbackIdSha256 === "string" && SHA.test(selection.playbackIdSha256) && !/^0{64}$/u.test(selection.playbackIdSha256),
  "course-lesson-ack-loss-selection");
}

function validateLessonAckLossReceipt(receipt, selection, before) {
  const check = "course-lesson-ack-loss-receipt";
  demand(closed(receipt, ["page", "playback", "writes", "recovery", "media"]), check);
  const { page, playback, writes, recovery, media } = receipt;
  const { courseId, lessonId, progressId, enrollmentId, resumePositionSeconds, maxPositionSeconds, playbackIdSha256 } = selection;
  demand(closed(page, ["pathname", "status"]) && page.pathname === `/academy/courses/${courseId}/lessons/${lessonId}` && page.status === 200
    && Array.isArray(playback) && playback.length === 2 && Array.isArray(writes) && writes.length === 5, check);
  const expiries = [...playback].map(item => reviewedPlaybackExpiry(item, check, true));
  const hasPosition = (row, revision, resume) => courseUuid(row.requestId) && row.progressId === progressId && row.enrollmentId === enrollmentId
    && row.revision === revision && row.resumePositionSeconds === resume && row.maxPositionSeconds === maxPositionSeconds;
  demand([...playback].every((item, index) => item.playbackIdSha256 === playbackIdSha256 && expiries[index] > Date.parse(before.lesson.observed_at))
    && [...writes].every((row, index) => closed(row, lessonAckLossProgressFields)
      && hasPosition(row, index + 7, index < 2 ? resumePositionSeconds : maxPositionSeconds))
    && closed(recovery, [...lessonAckLossProgressFields, "browserFailure", "unconfirmedObserved", "noReplay"])
    && hasPosition(recovery, 9, maxPositionSeconds) && recovery.browserFailure === "connectionreset"
    && recovery.unconfirmedObserved === true && recovery.noReplay === true
    && new Set([...playback, ...writes, recovery].map(row => row.requestId)).size === 8, check);
  demand(closed(media, ["beforeSeconds", "afterSeconds", "paused", "manifestObserved", "segmentObserved"])
    && media.beforeSeconds === resumePositionSeconds && media.afterSeconds === maxPositionSeconds
    && media.paused === true && media.manifestObserved === true && media.segmentObserved === true, check);
  return Math.max(...expiries);
}

export async function captureP2InteractiveAckLossBaseline(courseJob, selection, dependencies) {
  validateLessonAckLossSelection(selection);
  const selected = Object.freeze({ ...selection }), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined,
    client => readPinnedLessonPosition(client, selected, selected, 6, "course-lesson-ack-loss"));
  const baseline = Object.freeze({});
  lessonAckLossBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveAckLossCase(courseJob, selection, baseline, browserReceipt, dependencies) {
  validateLessonAckLossSelection(selection);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = lessonAckLossBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && lessonAckLossSelectionFields.every(key => selection[key] === saved.selected[key]),
  "course-lesson-ack-loss-receipt");
  const before = saved.result, playbackExpiry = validateLessonAckLossReceipt(browserReceipt, saved.selected, before);
  lessonAckLossBaselines.delete(baseline);
  const position = { ...saved.selected, resumePositionSeconds: saved.selected.maxPositionSeconds };
  const { result: after } = await readHeldCourseDraft(target, dependencies, saved.roleOid,
    client => readPinnedLessonPosition(client, saved.selected, position, 11, "course-lesson-ack-loss"));
  demand(after.progress[0].created_at === before.progress[0].created_at
    && Date.parse(after.progress[0].updated_at) >= Date.parse(before.lesson.observed_at), "course-lesson-ack-loss-progress");
  demand(sameIds(after.history, before.history), "course-lesson-ack-loss-history");
  const baselineExpiry = before.lesson.last_token_expires_at === null ? 0 : Date.parse(before.lesson.last_token_expires_at);
  demand(after.lesson.asset_id === before.lesson.asset_id && after.mediaSha256 === before.mediaSha256
    && Date.parse(after.lesson.last_token_expires_at) === Math.max(baselineExpiry, playbackExpiry), "course-lesson-ack-loss-media");
  return { ...position, revision: 11, playbackExpiresAt: date(playbackExpiry), readOnly: true };
}

const lessonDenialSelectionFields = [...lessonEntrySelectionFields, "enrolledActorId"];

function validateLessonDenialSelection(selection) {
  demand(closed(selection, lessonDenialSelectionFields) && lessonDenialSelectionFields.every(key => courseUuid(selection[key]))
    && selection.actorId !== selection.enrolledActorId, "course-lesson-denial-selection");
}

async function readLessonDenial(client, { actorId, courseId, lessonId, enrolledActorId, grantId }) {
  const lessons = await read(client, "course", "lessonEntryLesson", [courseId, lessonId]), lesson = lessons[0];
  demand(lessons.length === 1 && courseUuid(lesson.asset_id) && SHA.test(lesson.course_fingerprint)
    && lesson.last_token_expires_at !== null && Number.isFinite(Date.parse(lesson.last_token_expires_at)), "course-lesson-denial-lesson");
  const canaries = await read(client, "course", "lessonDenialCanaries", [lessonId]);
  demand(canaries.length === 1 && canaries[0].canaries === true, "course-lesson-denial-canaries");
  const actors = [actorId, enrolledActorId];
  const accounts = await read(client, "course", "lessonDenialActiveAccounts", [actors]);
  demand(accounts.length === 1 && accounts[0].active === true, "course-lesson-denial-account");
  const requestHash = sha(JSON.stringify({ command: "free_grant", userId: enrolledActorId, courseId }));
  const grants = await read(client, "course", "lessonEntryFreeGrant", [grantId, enrolledActorId, courseId, requestHash]), grant = grants[0];
  demand(grants.length === 1 && courseUuid(grant.enrollment_id) && SHA.test(grant.key_fingerprint), "course-lesson-denial-grant");
  const enrolled = await read(client, "course", "paidCourseAccess", [courseId, enrolledActorId]);
  const denied = await read(client, "course", "paidCourseAccess", [courseId, actorId]);
  demand(enrolled.length === 1 && enrolled[0].eligible === true && denied.length === 1 && denied[0].eligible === false, "course-lesson-denial-access");
  const progress = await read(client, "course", "lessonEntryProgress", [enrolledActorId, lessonId]);
  demand(progress.length === 1 && courseUuid(progress[0].progress_id) && progress[0].started === true
    && progress[0].enrollment_id === grant.enrollment_id, "course-lesson-denial-progress");
  const pristine = await read(client, "course", "lessonDenialPristine", [courseId, actorId]);
  demand(pristine.length === 1 && pristine[0].pristine === true, "course-lesson-denial-pristine");
  return {
    history: [lesson.course_fingerprint, grant.key_fingerprint,
      ...await readPaidArchiveDigests(client, [courseId], [...paidArchiveHistory, ...paidArchiveProjection]),
      ...await readPaidArchiveDigests(client, [actorId], ["paidCourseAccount"]),
      ...await readPaidArchiveDigests(client, [enrolledActorId], ["paidCourseAccount"]),
      ...await readPaidArchiveDigests(client, [actors], ["lessonDenialIdentity", "lessonDenialCommands"]),
    ],
    media: await readPaidArchiveDigests(client, [courseId], ["lessonDenialMediaHistory"]),
  };
}

function validateLessonDenialReceipt(receipt, { courseId, lessonId }) {
  const check = "course-lesson-denial-receipt";
  demand(closed(receipt, ["page", "reads"]), check);
  const { page, reads } = receipt, lesson = `/api/academy/lessons/${lessonId}`;
  const targets = [lesson, `${lesson}/playback`, `/api/academy/progress?lessonId=${lessonId}`, `${lesson}/quiz`, `${lesson}/quiz/attempts`];
  demand(closed(page, ["pathname", "documentStatus", "flightStatus", "documentRequestId", "flightRequestId"])
    && page.pathname === `/academy/courses/${courseId}/lessons/${lessonId}` && page.documentStatus === 200 && page.flightStatus === 200
    && courseUuid(page.documentRequestId) && courseUuid(page.flightRequestId)
    && Array.isArray(reads) && reads.length === targets.length && targets.every((target, index) => {
      const read = reads[index];
      return closed(read, ["target", "status", "requestId", "code"]) && read.target === target && read.status === 403
        && courseUuid(read.requestId) && read.code === "access_required";
    }) && new Set([page.documentRequestId, page.flightRequestId, ...reads.map(read => read.requestId)]).size === targets.length + 2, check);
}

export async function captureP2InteractiveLessonDenialBaseline(courseJob, selection, dependencies) {
  validateLessonDenialSelection(selection);
  const selected = Object.freeze({ ...selection }), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, client => readLessonDenial(client, selected));
  const baseline = Object.freeze({});
  lessonDenialBaselines.set(baseline, { selected, result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveLessonDenialCase(courseJob, selection, baseline, browserReceipt, dependencies) {
  validateLessonDenialSelection(selection);
  validateLessonDenialReceipt(browserReceipt, selection);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = lessonDenialBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && lessonDenialSelectionFields.every(key => selection[key] === saved.selected[key]),
  "course-lesson-denial-receipt");
  lessonDenialBaselines.delete(baseline);
  const { result } = await readHeldCourseDraft(target, dependencies, saved.roleOid, client => readLessonDenial(client, saved.selected));
  demand(sameIds(result.history, saved.result.history), "course-lesson-denial-history");
  demand(sameIds(result.media, saved.result.media), "course-lesson-denial-media");
  return { ...saved.selected, effectiveAccess: false, readOnly: true };
}

const assessmentSelectionFields = [...lessonEntrySelectionFields, "quizRevision", "failAnswers", "passAnswers"];
const assessmentAnswerKey = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/u;
const assessmentPayloadId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const assessmentHistory = [...paidArchiveHistory.filter(name => name !== "paidArchiveAttempts" && name !== "paidArchiveProgress"),
  "paidArchiveStreams", "assessmentOutbox", "lessonDenialMediaHistory"];

function validateAssessmentSelection(selection) {
  const check = "course-assessment-selection";
  demand(closed(selection, assessmentSelectionFields) && lessonEntrySelectionFields.every(key => courseUuid(selection[key]))
    && Number.isInteger(selection.quizRevision) && selection.quizRevision >= 1 && selection.quizRevision <= 2_147_483_647, check);
  const { failAnswers, passAnswers } = selection;
  for (const answers of [failAnswers, passAnswers]) {
    demand(Array.isArray(answers) && answers.length >= 1 && answers.length <= 100
      && Array.from(answers).every(answer => closed(answer, ["questionId", "optionId"])
        && [answer.questionId, answer.optionId].every(id => typeof id === "string" && assessmentAnswerKey.test(id)))
      && new Set(answers.map(answer => answer.questionId)).size === answers.length, check);
  }
  demand(failAnswers.length === passAnswers.length && failAnswers.every((answer, index) => answer.questionId === passAnswers[index].questionId)
    && failAnswers.some((answer, index) => answer.optionId !== passAnswers[index].optionId), check);
}

async function readAssessmentState(client, { actorId, courseId, lessonId, grantId, quizRevision, failAnswers, passAnswers }) {
  const lessons = await read(client, "course", "assessmentLesson", [
    courseId, lessonId, quizRevision, JSON.stringify(failAnswers), JSON.stringify(passAnswers),
  ]);
  const lesson = lessons[0];
  demand(lessons.length === 1 && courseUuid(lesson.quiz_id) && SHA.test(lesson.course_fingerprint)
    && Number.isFinite(Date.parse(lesson.observed_at)) && lesson.total_count === failAnswers.length
    && [lesson.fail_count, lesson.pass_count].every(count => Number.isInteger(count) && count >= 0 && count <= lesson.total_count)
    && lesson.fail_count < lesson.pass_count, "course-assessment-lesson");
  const accounts = await read(client, "course", "paidLearnerActiveAccount", [actorId]);
  const access = await read(client, "course", "paidCourseAccess", [courseId, actorId]);
  demand(accounts.length === 1 && accounts[0].active === true && access.length === 1 && access[0].eligible === true, "course-assessment-access");
  const requestHash = sha(JSON.stringify({ command: "free_grant", userId: actorId, courseId }));
  const grants = await read(client, "course", "lessonEntryFreeGrant", [grantId, actorId, courseId, requestHash]);
  const grant = grants[0];
  demand(grants.length === 1 && courseUuid(grant.enrollment_id) && SHA.test(grant.key_fingerprint), "course-assessment-grant");
  return { lesson, enrollmentId: grant.enrollment_id, history: [
    lesson.course_fingerprint, grant.key_fingerprint,
    ...await readPaidArchiveDigests(client, [courseId], assessmentHistory),
    ...await readPaidArchiveDigests(client, [courseId, actorId, lessonId], ["lessonEntryOtherProgress", "assessmentOtherAttempts"]),
    ...await readPaidArchiveDigests(client, [actorId], ["paidCourseAccount"]),
    ...await readPaidArchiveDigests(client, [[actorId]], ["lessonDenialIdentity", "lessonDenialCommands"]),
  ] };
}

const assessmentDate = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && date(value) === value;

function validateAssessmentReceipt(receipt, { courseId, lessonId, quizRevision }, before) {
  const check = "course-assessment-receipt";
  demand(closed(receipt, ["page", "playback", "started", "attempts"]), check);
  const { page, playback, started, attempts } = receipt;
  demand(closed(page, ["pathname", "status"]) && page.pathname === `/academy/courses/${courseId}/lessons/${lessonId}` && page.status === 200
    && closed(playback, ["requestId", "status"]) && playback.status === 404 && courseUuid(playback.requestId)
    && closed(started, ["requestId", "progressId", "enrollmentId", "revision"])
    && [started.requestId, started.progressId].every(courseUuid) && started.enrollmentId === before.enrollmentId && started.revision === 1
    && Array.isArray(attempts) && attempts.length === 2, check);
  for (const [index, expectedCorrectCount] of [before.lesson.fail_count, before.lesson.pass_count].entries()) {
    const attempt = attempts[index], passed = index === 1;
    demand(closed(attempt, ["requestId", "payloadRequestId", "attemptId", "quizRevisionId", "quizRevision",
      "correctCount", "totalCount", "passed", "completed", "createdAt", "progress"])
      && [attempt.requestId, attempt.attemptId].every(courseUuid)
      && typeof attempt.payloadRequestId === "string" && assessmentPayloadId.test(attempt.payloadRequestId)
      && attempt.quizRevisionId === before.lesson.quiz_id && attempt.quizRevision === quizRevision
      && attempt.correctCount === expectedCorrectCount && attempt.totalCount === before.lesson.total_count
      && attempt.passed === passed && attempt.completed === passed && assessmentDate(attempt.createdAt), check);
    const progress = attempt.progress;
    demand(closed(progress, ["requestId", "progressId", "enrollmentId", "revision", "completedAt", "completedQuizRevision"])
      && courseUuid(progress.requestId) && progress.progressId === started.progressId && progress.enrollmentId === started.enrollmentId
      && progress.revision === index + 2 && progress.completedAt === (passed ? attempt.createdAt : null)
      && progress.completedQuizRevision === (passed ? quizRevision : null), check);
  }
  const [failed, passed] = attempts;
  demand(new Set([playback.requestId, started.requestId, ...attempts.flatMap(attempt =>
    [attempt.requestId, attempt.payloadRequestId, attempt.progress.requestId, attempt.attemptId])]).size === 10
    && failed.createdAt <= passed.createdAt, check);
}

function storedAssessmentAnswers(answers) {
  return answers.map(({ questionId, optionId }) => ({ questionId, optionId }))
    .sort((a, b) => a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0);
}

export async function captureP2InteractiveAssessmentBaseline(courseJob, selection, dependencies) {
  validateAssessmentSelection(selection);
  const selected = structuredClone(selection), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const { actorId, lessonId } = selected;
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const before = await readAssessmentState(client, selected);
    const progress = await read(client, "course", "assessmentProgress", [actorId, lessonId]);
    const attempts = await read(client, "course", "lessonEntryAttemptAbsent", [lessonId, actorId, before.enrollmentId]);
    demand(progress.length === 0 && attempts.length === 1 && attempts[0].absent === true, "course-assessment-pristine");
    return before;
  });
  const baseline = Object.freeze({});
  assessmentBaselines.set(baseline, { selected, selectionSha256: sha(selected), result, jobSha256, roleOid,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractiveAssessmentCase(courseJob, selection, baseline, browserReceipt, dependencies) {
  validateAssessmentSelection(selection);
  const { target, jobSha256 } = selectedCourseDraftJob(courseJob), saved = assessmentBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && saved.selectionSha256 === sha(selection), "course-assessment-receipt");
  validateAssessmentReceipt(browserReceipt, saved.selected, saved.result);
  const { started, attempts: [failed, passed] } = structuredClone(browserReceipt);
  assessmentBaselines.delete(baseline);
  const { actorId, courseId, lessonId, grantId, quizRevision, failAnswers, passAnswers } = saved.selected;
  const { enrollmentId } = saved.result;
  const answers = [failAnswers, passAnswers].map(storedAssessmentAnswers);
  const reviewedAttempts = [failed, passed];
  await readHeldCourseDraft(target, dependencies, saved.roleOid, async client => {
    const after = await readAssessmentState(client, saved.selected);
    demand(after.enrollmentId === enrollmentId && after.lesson.quiz_id === saved.result.lesson.quiz_id
      && sameIds(after.history, saved.result.history), "course-assessment-history");
    const attempts = await read(client, "course", "assessmentAttemptRows", [
      lessonId, actorId, enrollmentId, failed.payloadRequestId, JSON.stringify(answers[0]), passed.payloadRequestId, JSON.stringify(answers[1]),
    ]);
    demand(attempts.length === 2, "course-assessment-attempts");
    for (const [index, receipt] of reviewedAttempts.entries()) {
      const row = attempts.find(attempt => attempt.request_id === receipt.payloadRequestId);
      const requestHash = sha(JSON.stringify({ userId: actorId, lessonId, quizRevision, answers: answers[index] }));
      demand(row?.attempt_id === receipt.attemptId && row.request_hash === requestHash && row.answers_match === true
        && row.user_id === actorId && row.enrollment_id === enrollmentId && row.quiz_revision_id === receipt.quizRevisionId
        && row.correct_count === receipt.correctCount && row.total_count === receipt.totalCount && row.passed === receipt.passed
        && row.completed === receipt.completed && Date.parse(row.created_at) === Date.parse(receipt.createdAt), "course-assessment-attempts");
    }
    const rows = await read(client, "course", "assessmentProgress", [actorId, lessonId]), progress = rows[0];
    const createdAt = Date.parse(progress?.created_at);
    demand(rows.length === 1 && progress.progress_id === started.progressId && progress.enrollment_id === enrollmentId
      && progress.revision === 3 && progress.completed_quiz_revision === quizRevision && progress.completed_in_place === true
      && createdAt >= Date.parse(saved.result.lesson.observed_at) && createdAt <= Date.parse(failed.createdAt)
      && Date.parse(progress.completed_at) === Date.parse(passed.createdAt)
      && Date.parse(passed.createdAt) <= Date.parse(after.lesson.observed_at), "course-assessment-progress");
  });
  return { actorId, courseId, lessonId, grantId, quizRevision, enrollmentId, progressId: started.progressId,
    attemptIds: [failed.attemptId, passed.attemptId], progressRevision: 3, readOnly: true };
}

const paidRevokeSelectionFields = ["courseId", "userId", "grantId", "actorId", "revision", "idempotencyKey", "reason", "remainingAccess"];

export function validateP2InteractivePaidRevoke(selection, input) {
  demand(input === undefined && closed(selection, paidRevokeSelectionFields)
    && [selection.courseId, selection.userId, selection.grantId, selection.actorId, selection.idempotencyKey].every(courseUuid)
    && Number.isInteger(selection.revision) && selection.revision >= 1 && selection.revision <= 2_147_483_647
    && draftText(selection.reason, 1800) && typeof selection.remainingAccess === "boolean", "course-paid-revoke-selection");
}

async function paidRevokeIndependentCourses(client, { courseId, userId }) {
  const rows = await read(client, "course", "paidRevokeIndependentCourses", [courseId, userId]);
  demand(rows.length >= 1 && rows.length <= independentCommunityLimit && rows.every(row => courseUuid(row.course_id)), "community-paid-revoke-independent");
  return rows.map(row => row.course_id);
}

async function readPaidRevoke(client, selection, priorVersion) {
  const { courseId, userId, grantId, actorId, revision, remainingAccess } = selection, initial = priorVersion === undefined;
  const paidCourses = await read(client, "course", "paidArchiveCourse", [courseId]);
  demand(paidCourses.length === 1 && draftSlug(paidCourses[0].slug), "course-paid-revoke-eligibility");
  const { slug } = paidCourses[0];
  const course = await readCoursePublication(client, { courseId, slug }, revision, "published");
  const grant = await read(client, "course", "paidCourseOwnerGrant", [courseId, userId, grantId]);
  const targets = await read(client, "course", "paidRevokeTarget", [grantId, userId, courseId]), target = targets[0];
  demand(grant.length === 1 && grant[0].active === initial && targets.length === 1 && courseUuid(target.enrollment_id)
    && SHA.test(target.grant_identity) && SHA.test(target.enrollment_identity), "course-paid-revoke-grant");
  const account = await read(client, "course", "paidLearnerActiveAccount", [userId]);
  const access = await read(client, "course", "paidCourseAccess", [courseId, userId]);
  const others = await read(client, "course", "paidRevokeOtherAccess", [courseId, userId, grantId]);
  demand(account.length === 1 && account[0].active === true && access.length === 1 && access[0].eligible === (initial || remainingAccess)
    && others.length === 1 && others[0].eligible === remainingAccess && typeof others[0].active === "boolean", "course-paid-revoke-access");
  const streams = await read(client, "course", "paidRevokeStream", [courseId, userId]), stream = streams[0];
  demand(streams.length === 1 && uuidV4(stream.stream_id) && Number.isInteger(stream.version) && stream.version >= 0
    && (!initial || (stream.state === "active" && stream.version < 2_147_483_647)), "course-paid-revoke-stream");
  const reviewedVersion = priorVersion ?? stream.version;
  const idempotencyKey = `owner-paid-revoke:${selection.idempotencyKey}`, reason = `[paid-course revision ${revision}] ${selection.reason}`;
  const requestHash = sha(canonicalAsciiJson({ action: "revoke", scope: "grantId", actorUserId: actorId, target: { grantId }, reason }));
  const keys = await read(client, "course", "enrollmentKey", [idempotencyKey, requestHash, "admin_revoke"]);
  const commands = await read(client, "course", "paidRevokeCommand", [idempotencyKey, actorId, userId, courseId, grantId, reason, requestHash]);
  const events = await read(client, "course", "paidRevokeNewEvents", [stream.stream_id, reviewedVersion]);
  const history = [
    ...await readPaidArchiveDigests(client, [courseId], [...paidCourseLearningHistory, "paidArchiveRevocations"]),
    ...await readPaidArchiveDigests(client, [courseId, grantId], ["paidRevokeOtherGrants"]),
    ...await readPaidArchiveDigests(client, [courseId, target.enrollment_id], ["paidRevokeOtherEnrollments"]),
    ...await readPaidArchiveDigests(client, [courseId, idempotencyKey], ["paidRevokeOtherCommands", "paidRevokeOtherEffects"]),
    ...await readPaidArchiveDigests(client, [userId], ["paidCourseAccount"]),
    ...await readPaidArchiveDigests(client, [courseId, userId], ["paidRevokeOtherStreams"]),
    ...await readPaidArchiveDigests(client, [courseId, userId, reviewedVersion], ["paidRevokePriorEvents"]),
  ];
  return { slug, course, target, otherActive: others[0].active, stream, keys, commands, events, history };
}

function enrollmentDeliveryEvent(selection, stream, events, check) {
  const { courseId, userId } = selection, { state } = stream, event = events[0];
  demand(events.length === 1 && event.stream_version === stream.version && event.digest_matches === true && uuidV4(event.event_id)
    && SHA.test(event.delivery_sha256) && (event.state === "pending" || (event.state === "delivered" && event.settled === true)), `${check}-outbox`);
  const effectiveAt = date(stream.effective_at), occurredAt = date(event.created_at);
  const eventType = state === "active" ? "enrollment.activated" : "enrollment.revoked";
  const expected = { eventId: event.event_id, eventType, schemaVersion: 1, producer: "lash-her-course-api", occurredAt,
    stream: { id: stream.stream_id, version: stream.version }, data: { userId, courseId, state, effectiveAt } };
  demand(event.canonical_digest === sha(canonicalAsciiJson(expected)), `${check}-outbox`);
  return { eventId: event.event_id, streamId: stream.stream_id, streamVersion: stream.version, state, eventType, effectiveAt, occurredAt,
    canonicalDigest: event.canonical_digest, delivered: event.state === "delivered", deliverySha256: event.delivery_sha256 };
}

const sameEnrollmentDeliveryEvent = (left, right) => ["eventId", "streamId", "streamVersion", "state", "eventType", "effectiveAt", "occurredAt", "canonicalDigest"]
  .every(key => left[key] === right[key]);

async function readCurrentEnrollmentEvent(client, selection, stream, check = "course-paid-revoke") {
  const rows = await read(client, "course", "paidRevokeCurrentEvent", [stream.stream_id, stream.version]);
  return enrollmentDeliveryEvent(selection, stream, rows, check);
}

function observePaidRevokeTransition(selection, previous, current, effectiveAt) {
  const { remainingAccess } = selection, { stream, events } = current;
  demand(stream.stream_id === previous.stream_id && stream.created_at === previous.created_at, "course-paid-revoke-stream");
  if (remainingAccess) {
    demand(stream.state === "active" && stream.version === previous.version && stream.effective_at === previous.effective_at
      && stream.updated_at === previous.updated_at && events.length === 0, "course-paid-revoke-outbox");
    return null;
  }
  demand(stream.state === "revoked" && stream.version === previous.version + 1 && stream.effective_at === effectiveAt
    && stream.updated_at === effectiveAt, "course-paid-revoke-stream");
  const event = enrollmentDeliveryEvent(selection, stream, events, "course-paid-revoke");
  demand(event.occurredAt === event.effectiveAt, "course-paid-revoke-outbox");
  return event;
}

async function readCommunityEnrollmentEvent(client, { courseId, userId }, event, check, preserveInbox = false) {
  const { eventId, streamId, streamVersion, state, canonicalDigest, effectiveAt, occurredAt, eventType } = event;
  const inbox = await read(client, "community", "paidRevokeInbox", [eventId, streamId, streamVersion, userId, courseId, state,
    canonicalDigest, effectiveAt, occurredAt, eventType]);
  demand(inbox.length === 1 && inbox[0].fields_match === true && SHA.test(inbox[0].fingerprint), `${check}-inbox`);
  const projection = await read(client, "community", "paidRevokeProjection", [streamId, userId, courseId, streamVersion, state, eventId, effectiveAt]);
  demand(projection.length === 1 && projection[0].fields_match === true && SHA.test(projection[0].fingerprint), `${check}-projection`);
  const result = { inbox: inbox[0].fingerprint, projection: projection[0].fingerprint };
  if (!preserveInbox) return result;
  const rows = await read(client, "community", "enrollmentPairInboxHistory", [userId, courseId, streamId]);
  demand(rows.length === 1 && Number.isInteger(rows[0].row_count) && rows[0].row_count >= 1 && rows[0].row_count <= paidArchiveHistoryLimit
    && SHA.test(rows[0].digest), `${check}-inbox`);
  return { ...result, inboxHistory: rows[0].digest };
}

async function readPaidRevokeCommunity(client, selection, event, independentCourses) {
  const selected = await readCommunityEnrollmentEvent(client, selection, event, "community-paid-revoke");
  const independent = await read(client, "community", "paidRevokeIndependentActive", [selection.userId, independentCourses]), row = independent[0];
  demand(independent.length === 1 && Number.isInteger(row.row_count) && row.row_count >= 1 && row.row_count <= independentCommunityLimit
    && SHA.test(row.digest), "community-paid-revoke-independent");
  return { ...selected, independentActiveCount: row.row_count, independentActiveSha256: row.digest };
}

async function recheckEnrollmentDelivery(target, dependencies, roleOid, selection, stream, expected, independentCourses, check = "course-paid-revoke") {
  const { result } = await readHeldCourseDraft(target, dependencies, roleOid, async client => {
    const rows = await read(client, "course", "paidRevokeStream", [selection.courseId, selection.userId]);
    demand(rows.length === 1 && sha(rows[0]) === sha(stream), `${check}-stream`);
    const access = await read(client, "course", "paidCourseAccess", [selection.courseId, selection.userId]);
    demand(access.length === 1 && access[0].eligible === (stream.state === "active"), `${check}-access`);
    const actual = await readCurrentEnrollmentEvent(client, selection, rows[0], check);
    demand(sameEnrollmentDeliveryEvent(actual, expected), `${check}-outbox`);
    if (independentCourses) demand(sameIds(await paidRevokeIndependentCourses(client, selection), independentCourses), "community-paid-revoke-independent");
    return actual;
  });
  return result;
}

async function waitForEnrollmentDelivery(target, dependencies, roleOid, selection, stream, event, check = "course-paid-revoke") {
  const deadline = performance.now() + 8_000;
  while (!event.delivered) {
    await verifyHeldApi(dependencies, check);
    const remaining = deadline - performance.now();
    demand(remaining > 0, `${check}-delivery-timeout`);
    try { await wait(Math.min(250, remaining), undefined, { signal: dependencies.signal }); }
    catch { throw new P2LifecyclePersistenceError(`${check}-held-session`); }
    event = await recheckEnrollmentDelivery(target, dependencies, roleOid, selection, stream, event, undefined, check);
    demand(performance.now() <= deadline, `${check}-delivery-timeout`);
  }
  return event;
}

export async function captureP2InteractivePaidRevokeBaseline(courseJob, selection, dependencies) {
  validateP2InteractivePaidRevoke(selection, undefined);
  const selected = Object.freeze({ ...selection }), { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const community = selectedHeldApiJob(dependencies?.communityJob, "community", "community-delivery-job");
  demand(dependencies.communityJob.releaseId === courseJob.releaseId, "community-delivery-job");
  demand(typeof dependencies.readCommunityDatabaseUrl === "function", "community-delivery-held-session");
  const { result, roleOid } = await readHeldCourseDraft(target, dependencies, undefined, async client => {
    const before = await readPaidRevoke(client, selected);
    demand(before.keys.length === 0 && before.commands.length === 0 && before.events.length === 0, "course-paid-revoke-baseline");
    const event = await readCurrentEnrollmentEvent(client, selected, before.stream);
    demand(event.delivered, "course-paid-revoke-delivery-baseline");
    return { ...before, event, independentCourses: await paidRevokeIndependentCourses(client, selected) };
  });
  const { result: receiver, roleOid: communityRoleOid } = await readHeldCommunityDelivery(community.target, dependencies, undefined,
    client => readPaidRevokeCommunity(client, selected, result.event, result.independentCourses));
  demand((await recheckEnrollmentDelivery(target, dependencies, roleOid, selected, result.stream, result.event, result.independentCourses)).delivered,
    "course-paid-revoke-delivery-baseline");
  const baseline = Object.freeze({});
  paidRevokeBaselines.set(baseline, { selected, result, jobSha256, roleOid, communityJobSha256: community.jobSha256, communityRoleOid, receiver,
    readCommunityDatabaseUrl: dependencies.readCommunityDatabaseUrl,
    verifyEnvironment: dependencies.verifyEnvironment, verifySession: dependencies.verifySession });
  return baseline;
}

export async function observeP2InteractivePaidRevokeCase(courseJob, selection, baseline, browserBody, dependencies) {
  validateP2InteractivePaidRevoke(selection, undefined);
  const { courseId, userId, grantId, remainingAccess, revision: courseRevision } = selection, { target, jobSha256 } = selectedCourseDraftJob(courseJob);
  const community = selectedHeldApiJob(dependencies?.communityJob, "community", "community-delivery-job");
  demand(dependencies.communityJob.releaseId === courseJob.releaseId, "community-delivery-job");
  const saved = paidRevokeBaselines.get(baseline);
  demand(saved?.jobSha256 === jobSha256 && saved.communityJobSha256 === community.jobSha256
    && saved.readCommunityDatabaseUrl === dependencies.readCommunityDatabaseUrl && saved.verifyEnvironment === dependencies?.verifyEnvironment
    && saved.verifySession === dependencies?.verifySession && paidRevokeSelectionFields.every(key => selection[key] === saved.selected[key])
    && closed(browserBody, ["courseId", "userId", "grantId", "commandId", "courseRevision"]) && browserBody.courseId === courseId
    && browserBody.userId === userId && browserBody.grantId === grantId && browserBody.courseRevision === courseRevision
    && courseUuid(browserBody.commandId), "course-paid-revoke-receipt");
  paidRevokeBaselines.delete(baseline);
  const { commandId } = browserBody, before = saved.result;
  const { result: source } = await readHeldCourseDraft(target, dependencies, saved.roleOid, async client => {
    const after = await readPaidRevoke(client, saved.selected, before.stream.version), { keys, commands } = after;
    demand(keys.length === 1 && keys[0].fields_match === true && commands.length === 1 && commands[0].command_id === commandId
      && commands[0].fields_match === true && typeof commands[0].effective_at === "string", "course-paid-revoke-command");
    const effects = await read(client, "course", "paidRevokeEffect", [commandId, grantId]);
    demand(effects.length === 1 && effects[0].fields_match === true, "course-paid-revoke-effect");
    const { effective_at: effectiveAt } = commands[0], row = after.target, prior = before.target;
    demand(row.grant_status === "revoked" && row.revoke_reason === "manual" && row.grant_revoked_at === effectiveAt
      && row.grant_updated_at === effectiveAt && row.grant_identity === prior.grant_identity, "course-paid-revoke-grant");
    // Course closes the enrollment only when no active grant row remains, even if every remaining row is past expiry.
    demand(after.otherActive === before.otherActive && row.enrollment_identity === prior.enrollment_identity
      && (before.otherActive ? row.enrollment_status === "active" && row.enrollment_revoked_at === prior.enrollment_revoked_at
        && row.enrollment_updated_at === prior.enrollment_updated_at : row.enrollment_status === "revoked"
        && row.enrollment_revoked_at === effectiveAt && row.enrollment_updated_at === effectiveAt), "course-paid-revoke-enrollment");
    demand(after.slug === before.slug && after.course.metadataSha256 === before.course.metadataSha256 && after.course.updatedAt === before.course.updatedAt
      && sameIds(after.history, before.history), "course-paid-revoke-history");
    demand(sameIds(await paidRevokeIndependentCourses(client, saved.selected), before.independentCourses), "community-paid-revoke-independent");
    const transition = observePaidRevokeTransition(saved.selected, before.stream, after, effectiveAt);
    const event = transition ?? await readCurrentEnrollmentEvent(client, saved.selected, after.stream);
    if (remainingAccess) demand(event.delivered && sameEnrollmentDeliveryEvent(event, before.event), "course-paid-revoke-outbox");
    return { event, stream: after.stream };
  });
  const event = await waitForEnrollmentDelivery(target, dependencies, saved.roleOid, saved.selected, source.stream, source.event);
  const { result: receiver } = await readHeldCommunityDelivery(community.target, dependencies, saved.communityRoleOid,
    client => readPaidRevokeCommunity(client, saved.selected, event, before.independentCourses));
  const { independentActiveCount, independentActiveSha256 } = receiver;
  demand(independentActiveCount === saved.receiver.independentActiveCount && independentActiveSha256 === saved.receiver.independentActiveSha256,
    "community-paid-revoke-independent");
  if (remainingAccess) demand(receiver.inbox === saved.receiver.inbox && receiver.projection === saved.receiver.projection, "community-paid-revoke-projection");
  demand((await recheckEnrollmentDelivery(target, dependencies, saved.roleOid, saved.selected, source.stream, event, before.independentCourses)).delivered,
    "course-paid-revoke-outbox");
  const { eventId, streamId, streamVersion, canonicalDigest, state } = event;
  const communityDelivery = { streamId, streamVersion, eventId, canonicalDigest, state, independentActiveCount, independentActiveSha256 };
  return { courseId, userId, grantId, commandId, courseRevision, remainingAccess, transitionId: remainingAccess ? null : eventId, communityDelivery, readOnly: true };
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
