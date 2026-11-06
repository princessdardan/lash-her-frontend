import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { buildP2LifecycleStateWitness, observePersistenceDomain, persistencePrivateStageEvidence, qualifyPersistenceStage } from "../p2-lifecycle-persistence-probe.mjs";

const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

export async function runOwnedPersistenceScenario({ admin, runtime, plan }) {
  const userId = randomUUID(), otherId = randomUUID(), courseId = randomUUID(), moduleId = randomUUID(), lessonId = randomUUID(), enrollmentId = randomUUID();
  const quizRevisionId = randomUUID(), attemptId = randomUUID(), secondAttemptId = randomUUID(), grantId = randomUUID(), streamId = randomUUID(), eventId = randomUUID();
  const exportCommandId = randomUUID(), deleteCommandId = randomUUID(), originalEmail = `owned-${userId}@example.invalid`;
  const readyAt = new Date("2026-11-01T12:00:00.000Z"), expiresAt = new Date(readyAt.getTime() + 86_400_000), deleteAt = new Date("2026-11-03T12:00:00.000Z");
  const exportCommand = { version: 1, commandId: exportCommandId, userId, accountVersion: 1, action: "export", issuedAt: readyAt.toISOString() };
  const deleteCommand = { version: 1, commandId: deleteCommandId, userId, accountVersion: 2, action: "delete", issuedAt: deleteAt.toISOString() };
  const exportDigest = digest(exportCommand), deleteDigest = digest(deleteCommand);
  const answer = [{ questionId: "question", optionId: "correct" }];

  await admin.frontend.query(`insert into customer_users(id,email,email_verified,name,status,account_version,created_at) values($1,$2,$3,'Owned account','active',1,$3)`, [userId, originalEmail, readyAt]);
  await admin.frontend.query(`insert into customer_sessions(token_hash,user_id,expires,created_at) values($1,$2,$3,$4)`, [digest("session"), userId, new Date(deleteAt.getTime() + 3_600_000), deleteAt]);
  await admin.frontend.query(`insert into customer_provider_links(id,user_id,provider,provider_account_id,type,created_at) values($1,$2,'google',$3,'oidc',$4)`, [randomUUID(), userId, `provider-${userId}`, readyAt]);
  await admin.frontend.query(`insert into customer_verification_tokens(token,identifier,expires) values($1,$2,$3)`, [digest("proof"), originalEmail, new Date(deleteAt.getTime() + 900_000)]);
  await admin.frontend.query(`insert into customer_account_preferences(user_id,learning_updates,updated_at) values($1,true,$2)`, [userId, readyAt]);
  await admin.frontend.query(`insert into customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command) values($1,$2,1,$1,'export',$3,$4::jsonb)`, [exportCommandId, userId, readyAt, JSON.stringify(exportCommand)]);
  for (const receiver of ["course", "community"]) await admin.frontend.query(`insert into customer_account_deliveries(command_id,receiver,status,attempts,next_run_at,acknowledged_at) values($1,$2,'acknowledged',1,$3,$3)`, [exportCommandId, receiver, readyAt]);
  await admin.frontend.query(`insert into customer_account_exports(command_id,user_id,status,frontend_data,data,ready_at,expires_at) values($1,$2,'ready',null,$3::jsonb,$4,$5)`, [exportCommandId, userId, JSON.stringify({ private: "owned-export-must-never-appear" }), readyAt, expiresAt]);

  await admin.course.query(`insert into users(id,email,created_at,updated_at) values($1,$2,$3,$3),($4,$5,$3,$3)`, [userId, originalEmail, readyAt, otherId, `editor-${otherId}@example.invalid`]);
  await admin.course.query(`insert into courses(id,slug,title,status,price_cents,currency,access_mode,revision,created_at,updated_at) values($1,'owned','Owned','published',0,'CAD','free',1,$2,$2)`, [courseId, readyAt]);
  await admin.course.query(`insert into modules(id,course_id,slug,title,position,created_at,updated_at) values($1,$2,'module','Module',1,$3,$3)`, [moduleId, courseId, readyAt]);
  await admin.course.query(`insert into lessons(id,module_id,slug,title,position,created_at,updated_at) values($1,$2,'lesson','Lesson',1,$3,$3)`, [lessonId, moduleId, readyAt]);
  await admin.course.query(`insert into enrollments(id,user_id,course_id,status,source,granted_at,created_at,updated_at) values($1,$2,$3,'active','free',$4,$4,$4)`, [enrollmentId, userId, courseId, readyAt]);
  await admin.course.query("begin");
  try {
    await admin.course.query(`insert into entitlement_idempotency_keys(idempotency_key,command_type,request_hash,created_at) values($1,'free_grant',$2,$3)`, [grantId, digest("grant-request"), readyAt]);
    await admin.course.query(`insert into entitlement_grants(id,enrollment_id,user_id,course_id,idempotency_key,request_hash,grant_reason,granted_at,status,created_at,updated_at) values($1::uuid,$2,$3,$4,$1::text,$5,'free',$6,'active',$6,$6)`, [grantId, enrollmentId, userId, courseId, digest("grant-request"), readyAt]);
    await admin.course.query("commit");
  } catch (error) { await admin.course.query("rollback"); throw error; }
  await admin.course.query(`insert into lesson_progress(id,user_id,lesson_id,enrollment_id,max_position_seconds,resume_position_seconds,revision,created_at,updated_at) values($1,$2,$3,$4,30,12,1,$5,$5)`, [randomUUID(), userId, lessonId, enrollmentId, readyAt]);
  await admin.course.query(`insert into quiz_revisions(id,lesson_id,revision,document,created_by,created_at) values($1,$2,1,$3::jsonb,$4,$5)`, [quizRevisionId, lessonId, JSON.stringify({ version: 1, mode: "graded", questions: [] }), otherId, readyAt]);
  await admin.course.query(`insert into quiz_attempts(id,user_id,lesson_id,quiz_revision_id,enrollment_id,request_id,request_hash,answers,correct_count,total_count,passed,completed,created_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,1,true,true,$9)`, [attemptId, userId, lessonId, quizRevisionId, enrollmentId, randomUUID(), digest("attempt-request"), JSON.stringify(answer), readyAt]);
  await admin.course.query(`insert into quiz_attempts(id,user_id,lesson_id,quiz_revision_id,enrollment_id,request_id,request_hash,answers,correct_count,total_count,passed,completed,created_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,0,1,false,true,$9)`, [secondAttemptId, userId, lessonId, quizRevisionId, enrollmentId, randomUUID(), digest("attempt-request-2"), JSON.stringify(answer), readyAt]);
  await admin.course.query(`insert into account_lifecycle_states(user_id,account_version,status,updated_at) values($1,1,'active',$2)`, [userId, readyAt]);
  await admin.course.query(`insert into account_lifecycle_commands(command_id,user_id,account_version,action,canonical_digest,issued_at,accepted_at) values($1,$2,1,'export',$3,$4,$4)`, [exportCommandId, userId, exportDigest, readyAt]);
  await admin.course.query(`insert into account_lifecycle_exports(command_id,user_id,account_version,data,ready_at,expires_at) values($1,$2,1,$3::jsonb,$4,$5)`, [exportCommandId, userId, JSON.stringify({ private: "course-export" }), readyAt, expiresAt]);

  await admin.community.query(`insert into account_lifecycle_states(user_id,account_version,status,updated_at) values($1,1,'active',$2)`, [userId, readyAt]);
  await admin.community.query(`insert into account_lifecycle_commands(command_id,user_id,account_version,action,canonical_digest,issued_at,accepted_at) values($1,$2,1,'export',$3,$4,$4)`, [exportCommandId, userId, exportDigest, readyAt]);
  await admin.community.query(`insert into account_lifecycle_exports(command_id,user_id,account_version,data,ready_at,expires_at) values($1,$2,1,$3::jsonb,$4,$5)`, [exportCommandId, userId, JSON.stringify({ private: "community-export" }), readyAt, expiresAt]);
  const body = { version: 1, eventId, eventType: "enrollment.activated", producer: "lash-her-course-api", occurredAt: readyAt.toISOString(), streamId, streamVersion: 1, data: { userId, courseId, state: "active", effectiveAt: readyAt.toISOString() } };
  await admin.community.query(`insert into course_enrollment_inbox(event_id,canonical_digest,canonical_body,event_type,schema_version,producer,occurred_at,stream_id,stream_version,user_id,course_id,state,status,effective_at,received_at,applied_at) values($1,$2,$3,'enrollment.activated',1,'lash-her-course-api',$4,$5,1,$6,$7,'active','applied',$4,$4,$4)`, [eventId, digest(body), JSON.stringify(body), readyAt, streamId, userId, courseId]);
  await admin.community.query(`insert into course_enrollment_projections(stream_id,user_id,course_id,state,applied_version,highest_observed_version,status,source,source_event_id,effective_at,created_at,updated_at) values($1,$2,$3,'active',1,1,'current','event',$4,$5,$5,$5)`, [streamId, userId, courseId, eventId, readyAt]);

  const common = { version: 1, environment: "staging", userId, originalEmail, exportCommand: { commandId: exportCommandId, accountVersion: 1 },
    attemptIds: [attemptId, secondAttemptId], grantIds: [grantId], streamIds: [streamId], inboxEventIds: [eventId] };
  const observe = async input => Object.fromEntries(await Promise.all(["frontend", "course", "community"].map(async service => [service,
    await observePersistenceDomain(service, input, plan.targets[service], runtime[service])])));

  const readyInput = { ...common, stage: "capture-export-ready" }, readyObservations = await observe(readyInput);
  // This disposable fixture advances the source-owned observation clock only;
  // live certification still requires the real elapsed staging deadline.
  for (const service of ["frontend", "course", "community"]) readyObservations[service].now = new Date(readyAt.getTime() + 1_000).toISOString();
  const readyWitness = buildP2LifecycleStateWitness(plan, readyInput, readyObservations), readyReceipt = qualifyPersistenceStage(readyInput, readyObservations, readyWitness);
  const readyEvidence = persistencePrivateStageEvidence(readyInput, readyObservations);
  assert.equal(readyReceipt.status, "P2_LIFECYCLE_EXPORT_READY_CAPTURED");
  const wrongVersionInput = { ...readyInput, exportCommand: { ...readyInput.exportCommand, accountVersion: 999 } };
  const wrongVersionObservations = await observe(wrongVersionInput);
  assert.throws(() => buildP2LifecycleStateWitness(plan, wrongVersionInput, wrongVersionObservations), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  const omittedInput = { ...readyInput, attemptIds: [attemptId] }, omittedObservations = await observe(omittedInput);
  const omittedWitness = buildP2LifecycleStateWitness(plan, omittedInput, omittedObservations);
  assert.throws(() => qualifyPersistenceStage(omittedInput, omittedObservations, omittedWitness), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  const expiredObservations = structuredClone(readyObservations); expiredObservations.frontend.now = new Date(expiresAt.getTime() + 1).toISOString();
  const expiredWitness = buildP2LifecycleStateWitness(plan, readyInput, expiredObservations);
  assert.throws(() => qualifyPersistenceStage(readyInput, expiredObservations, expiredWitness), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);

  await admin.frontend.query(`update customer_account_exports set status='expired',data=null,frontend_data=null where command_id=$1`, [exportCommandId]);
  await admin.course.query(`delete from account_lifecycle_exports where command_id=$1`, [exportCommandId]);
  await admin.community.query(`delete from account_lifecycle_exports where command_id=$1`, [exportCommandId]);
  const baselineInput = { ...common, stage: "capture-delete-baseline" }, baselineObservations = await observe(baselineInput);
  const baselineWitness = buildP2LifecycleStateWitness(plan, baselineInput, baselineObservations), baselineReceipt = qualifyPersistenceStage(baselineInput, baselineObservations, baselineWitness, readyWitness, readyEvidence);
  const baselineEvidence = persistencePrivateStageEvidence(baselineInput, baselineObservations, readyEvidence);
  assert.equal(baselineReceipt.status, "P2_LIFECYCLE_EXPORT_SCRUBBED_DELETE_BASELINE_CAPTURED");

  const wrongEmail = structuredClone(baselineInput); wrongEmail.originalEmail = "wrong@example.invalid";
  const wrongObservations = await observe(wrongEmail), wrongWitness = buildP2LifecycleStateWitness(plan, wrongEmail, wrongObservations);
  assert.throws(() => qualifyPersistenceStage(wrongEmail, wrongObservations, wrongWitness, readyWitness, readyEvidence), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);

  await admin.frontend.query(`insert into customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command) values($1,$2,2,$1,'delete',$3,$4::jsonb)`, [deleteCommandId, userId, deleteAt, JSON.stringify(deleteCommand)]);
  for (const receiver of ["course", "community"]) await admin.frontend.query(`insert into customer_account_deliveries(command_id,receiver,status,attempts,next_run_at,acknowledged_at) values($1,$2,'acknowledged',1,$3,$3)`, [deleteCommandId, receiver, deleteAt]);
  await admin.frontend.query(`update customer_users set status='deleted',account_version=2,email=$2,email_verified=null,name=null where id=$1`, [userId, `deleted+${userId}@account.invalid`]);
  for (const table of ["customer_sessions", "customer_provider_links", "customer_account_preferences"]) await admin.frontend.query(`delete from ${table} where user_id=$1`, [userId]);
  await admin.frontend.query(`delete from customer_verification_tokens where identifier=$1`, [originalEmail]);
  await admin.frontend.query(`update customer_account_exports set status='expired',data=null,frontend_data=null where user_id=$1`, [userId]);
  await admin.course.query(`update account_lifecycle_states set status='deleted',account_version=2,updated_at=$2 where user_id=$1`, [userId, deleteAt]);
  await admin.course.query(`insert into account_lifecycle_commands(command_id,user_id,account_version,action,canonical_digest,issued_at,accepted_at) values($1,$2,2,'delete',$3,$4,$4)`, [deleteCommandId, userId, deleteDigest, deleteAt]);
  await admin.course.query(`delete from lesson_progress where user_id=$1`, [userId]); await admin.course.query(`delete from account_lifecycle_exports where user_id=$1`, [userId]);
  await admin.course.query(`update users set email=null,updated_at=$2 where id=$1`, [userId, deleteAt]);
  await admin.course.query(`update quiz_attempts set user_id=null,enrollment_id=null,request_id=null,request_hash=null,answers='[]'::jsonb,deidentified_at=$2 where id=ANY($1::uuid[])`, [[attemptId, secondAttemptId], deleteAt]);
  await admin.community.query(`update account_lifecycle_states set status='deleted',account_version=2,updated_at=$2 where user_id=$1`, [userId, deleteAt]);
  await admin.community.query(`insert into account_lifecycle_commands(command_id,user_id,account_version,action,canonical_digest,issued_at,accepted_at) values($1,$2,2,'delete',$3,$4,$4)`, [deleteCommandId, userId, deleteDigest, deleteAt]);
  await admin.community.query(`delete from account_lifecycle_exports where user_id=$1`, [userId]);

  const deleteInput = { ...common, stage: "verify-delete", deleteCommand: { commandId: deleteCommandId, accountVersion: 2 } }, deleteObservations = await observe(deleteInput);
  const deleteWitness = buildP2LifecycleStateWitness(plan, deleteInput, deleteObservations), deleteReceipt = qualifyPersistenceStage(deleteInput, deleteObservations, deleteWitness, baselineWitness, baselineEvidence);
  assert.equal(deleteReceipt.status, "P2_LIFECYCLE_DELETE_PERSISTENCE_VERIFIED");
  const missingAck = structuredClone(deleteObservations); missingAck.frontend.deliveries.find(row => row.command_id === deleteCommandId && row.receiver === "community").status = "pending";
  const missingAckWitness = buildP2LifecycleStateWitness(plan, deleteInput, missingAck);
  assert.throws(() => qualifyPersistenceStage(deleteInput, missingAck, missingAckWitness, baselineWitness, baselineEvidence), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  const identifiedAttempt = structuredClone(deleteObservations); identifiedAttempt.course.attempts[0].answers_empty = false;
  const identifiedWitness = buildP2LifecycleStateWitness(plan, deleteInput, identifiedAttempt);
  assert.throws(() => qualifyPersistenceStage(deleteInput, identifiedAttempt, identifiedWitness, baselineWitness, baselineEvidence), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  const retainedExport = structuredClone(deleteObservations); retainedExport.community.exports.push({ command_id: exportCommandId, data_present: true });
  const retainedWitness = buildP2LifecycleStateWitness(plan, deleteInput, retainedExport);
  assert.throws(() => qualifyPersistenceStage(deleteInput, retainedExport, retainedWitness, baselineWitness, baselineEvidence), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  const missingHistory = structuredClone(deleteObservations);
  for (const service of ["frontend", "course", "community"]) missingHistory[service].exportCommand = [];
  const missingHistoryWitness = buildP2LifecycleStateWitness(plan, deleteInput, missingHistory);
  assert.throws(() => qualifyPersistenceStage(deleteInput, missingHistory, missingHistoryWitness, baselineWitness, baselineEvidence), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);
  const wrongContext = structuredClone(baselineWitness); wrongContext.candidateSha256 = "f".repeat(64);
  assert.throws(() => qualifyPersistenceStage(deleteInput, deleteObservations, deleteWitness, wrongContext, baselineEvidence), /P2_LIFECYCLE_PERSISTENCE_REFUSED/u);

  const commonOutput = JSON.stringify([readyReceipt, baselineReceipt, deleteReceipt]);
  for (const privateValue of [originalEmail, "owned-export-must-never-appear", "course-export", "community-export", "question", "correct"])
    assert.equal(commonOutput.includes(privateValue), false);
  return { readyReceipt, baselineReceipt, deleteReceipt, checks: [
    "actual-three-domain-export-ready-observed", "actual-24-hour-schema-bound-export-scrub-observed", "actual-delete-field-removal-and-retention-observed",
    "wrong-original-email-refused", "missing-receiver-ack-refused", "identified-attempt-refused", "retained-community-export-refused", "common-output-private-values-absent",
    "requested-command-version-refused", "unlisted-account-attempt-refused", "expired-ready-export-refused", "missing-export-history-refused", "cross-bound-prior-refused",
  ] };
}
