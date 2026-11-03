// Leave actual published repository leases/retries behind when this process ends.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "/app/node_modules/pg/esm/index.mjs";
import { drizzle } from "/app/node_modules/drizzle-orm/node-postgres/index.js";
import { createDrizzleCommunityEnrollmentPublisherRepository } from "/app/dist/integrations/community/persistence/drizzle-publisher.repository.js";

assert.equal(process.env.NODE_ENV, "test"); assert.equal(process.env.OWNED_RECOVERY_FIXTURE, "1");
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.hostname, "postgres"); assert.equal(url.pathname, "/lash_her_course_p1_test");
assert.match(url.password, /^[a-f0-9]{64}$/u);
const pool = new Pool({ connectionString: url.toString(), max: 2 });
try {
  const repository = createDrizzleCommunityEnrollmentPublisherRepository(drizzle(pool));
  const owner = `exited-fixture-${randomUUID()}`, now = new Date();
  const events = await repository.claimBatch({ workerId: owner, now, limit: 2, leaseMs: 30_000 });
  assert.equal(events.length, 2);
  const retryAt = new Date(now.getTime() + 15_000);
  assert.equal(await repository.recordRetry({ eventId: events[1].eventId, workerId: owner, attemptsInCycle: 1,
    availableAt: retryAt, failureCode: "fixture_transport_timeout", now }), true);
  assert.deepEqual(await repository.claimBatch({ workerId: `competing-${randomUUID()}`, now: new Date(now.getTime() + 1000), limit: 50 }), []);
  process.stdout.write(JSON.stringify({ status: "OWNED_LEASE_AND_RETRY_RETAINED", ownerProcessExitsWithoutReleasingLease: true,
    events: [{ eventId: events[0].eventId, canonicalDigest: events[0].canonicalDigest, kind: "expired-lease", notBefore: events[0].leaseExpiresAt },
             { eventId: events[1].eventId, canonicalDigest: events[1].canonicalDigest, kind: "scheduled-retry", notBefore: retryAt }] }) + "\n");
} finally { await pool.end(); }
