// Pure coordinator over the selected image's shipped outbox repository. The
// reviewed host parent owns runtime identity, SQL/TLS adapter and process stop.
import { randomUUID } from "node:crypto";

const demand = (value, code) => { if (!value) throw new Error(code); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = /^[a-f0-9]{64}$/u;
const sameSet = (left, right) => left.length === right.length && new Set(left).size === left.length
  && left.every(value => right.includes(value));

export async function retainDurableWork(fixture, { readPending, repository, now = () => new Date() }) {
  demand(fixture?.status === "STAGING_FIXTURE_TWO_GRANTS_CREATED" && fixture.environment === "staging"
    && fixture.syntheticIdentitiesOnly === true && fixture.coursePublished === false
    && uuid.test(fixture.courseId) && /^p1-recovery-[a-f0-9]{32}$/u.test(fixture.courseSlug)
    && Array.isArray(fixture.grants) && fixture.grants.length === 2
    && fixture.grants.every(grant => uuid.test(grant.userId) && uuid.test(grant.grantId) && uuid.test(grant.commandId))
    && new Set(fixture.grants.map(grant => grant.userId)).size === 2,
  "STAGING_WORK_EXACT_SYNTHETIC_FIXTURE_REQUIRED");
  demand(typeof readPending === "function" && repository
    && ["claimBatch", "recordRetry", "inspectEventForOperator"].every(key => typeof repository[key] === "function"),
  "STAGING_WORK_TRUSTED_REPOSITORY_REQUIRED");
  const instant = now();
  demand(instant instanceof Date && Number.isFinite(instant.getTime()), "STAGING_WORK_CLOCK_REQUIRED");
  // The adapter returns *all* undelivered events, with stream user/course IDs.
  // Refuse to claim if any unrelated pending or dead-letter work exists.
  const pending = await readPending();
  demand(Array.isArray(pending) && pending.length === 2
    && sameSet(pending.map(event => event.userId), fixture.grants.map(grant => grant.userId))
    && new Set(pending.map(event => event.eventId)).size === 2
    && pending.every(event => uuid.test(event.eventId) && uuid.test(event.streamId) && hash.test(event.canonicalDigest)
      && event.courseId === fixture.courseId && event.streamVersion === 1 && event.state === "pending"
      && event.attemptsInCycle === 0 && event.replayCycle === 0 && event.leaseOwner === null && event.leaseExpiresAt === null
      && Number.isFinite(Date.parse(event.availableAt)) && Date.parse(event.availableAt) <= instant.getTime()),
  "STAGING_WORK_ONLY_TWO_NEW_FIXTURE_EVENTS_REQUIRED");
  const operator = { operatorId: "dardan", reason: `P1 non-customer durable recovery qualification ${fixture.actionId}`, now: instant };
  for (const event of pending) {
    const inspected = await repository.inspectEventForOperator({ ...operator, eventId: event.eventId });
    demand(inspected?.eventId === event.eventId && inspected.canonicalDigest === event.canonicalDigest
      && inspected.state === "pending" && inspected.leaseOwner === null && inspected.leaseExpiresAt === null,
    "STAGING_WORK_AUDITED_ORIGINAL_STATE_REQUIRED");
  }
  const workerId = `p1-exited-qualification-${randomUUID()}`;
  const claimed = await repository.claimBatch({ workerId, now: instant, limit: 2, leaseMs: 60_000 });
  demand(Array.isArray(claimed) && sameSet(claimed.map(event => event.eventId), pending.map(event => event.eventId))
    && claimed.every(event => event.canonicalDigest === pending.find(row => row.eventId === event.eventId)?.canonicalDigest
      && new Date(event.leaseExpiresAt).getTime() === instant.getTime() + 60_000), "STAGING_WORK_EXACT_CLAIMS_REQUIRED");
  const retryAt = new Date(instant.getTime() + 45_000);
  demand(await repository.recordRetry({ eventId: claimed[1].eventId, workerId, attemptsInCycle: 1,
    availableAt: retryAt, failureCode: "p1_qualification_transport_timeout", now: instant }) === true,
  "STAGING_WORK_RETRY_RETAINED_REQUIRED");
  const observed = now();
  demand(observed instanceof Date && observed.getTime() >= instant.getTime() && observed.getTime() < retryAt.getTime() - 1000,
    "STAGING_WORK_ELIGIBILITY_WINDOW_REQUIRED");
  const competing = await repository.claimBatch({ workerId: `p1-competing-${randomUUID()}`, now: observed, limit: 50 });
  demand(Array.isArray(competing) && competing.length === 0, "STAGING_WORK_EARLY_COMPETING_CLAIM_REFUSED_REQUIRED");
  const records = [];
  for (const [index, event] of claimed.entries()) {
    const row = await repository.inspectEventForOperator({ ...operator, now: observed, eventId: event.eventId });
    demand(row?.state === "pending" && row.eventId === event.eventId && row.canonicalDigest === event.canonicalDigest
      && row.deliveredAt === null && (index === 0
        ? row.leaseOwner === workerId && new Date(row.leaseExpiresAt).getTime() === instant.getTime() + 60_000 && row.attemptsInCycle === 0
        : row.leaseOwner === null && row.leaseExpiresAt === null && row.attemptsInCycle === 1
          && new Date(row.availableAt).getTime() === retryAt.getTime()), "STAGING_WORK_PENDING_STATE_UNVERIFIED");
    records.push({ eventId: event.eventId, streamId: event.streamId, canonicalDigest: event.canonicalDigest,
      kind: index === 0 ? "expired-lease" : "scheduled-retry", notBefore: index === 0 ? new Date(event.leaseExpiresAt).toISOString() : retryAt.toISOString(),
      attemptsInCycle: row.attemptsInCycle });
  }
  return { status: "STAGING_DURABLE_WORK_RETAINED", environment: "staging", actionId: fixture.actionId,
    courseId: fixture.courseId, courseSlug: fixture.courseSlug, retainedAt: instant.toISOString(), events: records,
    earlyCompetingClaimCount: 0, ownerProcessMustExitWithoutReleasingLease: true,
    migrationsExecuted: false, recovered: false, trafficAuthorized: false };
}

export function verifyRecoveredWork(retained, outbox, inbox) {
  demand(retained?.status === "STAGING_DURABLE_WORK_RETAINED" && retained.environment === "staging"
    && Array.isArray(retained.events) && retained.events.length === 2
    && Array.isArray(outbox) && outbox.length === 2 && Array.isArray(inbox) && inbox.length === 2
    && sameSet(outbox.map(row => row.eventId), retained.events.map(event => event.eventId))
    && sameSet(inbox.map(row => row.eventId), retained.events.map(event => event.eventId)), "STAGING_WORK_EXACT_RECOVERY_ROWS_REQUIRED");
  for (const event of retained.events) {
    const source = outbox.find(row => row.eventId === event.eventId), receiver = inbox.find(row => row.eventId === event.eventId);
    demand(source.canonicalDigest === event.canonicalDigest && receiver.canonicalDigest === event.canonicalDigest
      && source.state === "delivered" && source.leaseOwner === null && source.leaseExpiresAt === null
      && Number.isFinite(Date.parse(source.deliveredAt)) && Date.parse(source.deliveredAt) >= Date.parse(event.notBefore)
      && Number.isSafeInteger(source.attemptsInCycle) && source.attemptsInCycle >= event.attemptsInCycle
      && receiver.status === "applied", "STAGING_WORK_ACTUAL_PUBLICATION_REQUIRED");
  }
  return { status: "STAGING_DURABLE_WORK_RECOVERED", eventsRecovered: 2, canonicalDigestsPreserved: true,
    leasesCleared: true, retryAttemptsPreserved: true, eligibilityFloorsRespected: true };
}
