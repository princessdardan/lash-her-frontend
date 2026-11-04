// Run the exact retention coordinator over the published repository on owned PG.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "/app/node_modules/pg/esm/index.mjs";
import { drizzle } from "/app/node_modules/drizzle-orm/node-postgres/index.js";
import { createDrizzleCommunityEnrollmentPublisherRepository } from "/app/dist/integrations/community/persistence/drizzle-publisher.repository.js";
import { retainDurableWork } from "/test/staging-work.mjs";

assert.equal(process.env.NODE_ENV, "test"); assert.equal(process.env.OWNED_RECOVERY_FIXTURE, "1");
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.hostname, "postgres"); assert.equal(url.pathname, "/lash_her_course_p1_test");
assert.match(url.password, /^[a-f0-9]{64}$/u);
const pool = new Pool({ connectionString: url.toString(), max: 2 });
try {
  const fixture = JSON.parse(readFileSync("/test/admin-fixture.json", "utf8"));
  const repository = createDrizzleCommunityEnrollmentPublisherRepository(drizzle(pool));
  const readPending = async () => (await pool.query(`SELECT o.event_id AS "eventId",o.stream_id AS "streamId",
    o.stream_version AS "streamVersion",o.canonical_digest AS "canonicalDigest",o.state,
    o.attempts_in_cycle AS "attemptsInCycle",o.replay_cycle AS "replayCycle",o.available_at AS "availableAt",
    o.lease_owner AS "leaseOwner",o.lease_expires_at AS "leaseExpiresAt",s.user_id AS "userId",s.course_id AS "courseId"
    FROM community_enrollment_outbox o JOIN community_enrollment_streams s ON s.id=o.stream_id
    WHERE o.state <> 'delivered' ORDER BY o.created_at,o.event_id`)).rows;
  const result = await retainDurableWork(fixture, { readPending, repository });
  process.stdout.write(JSON.stringify(result) + "\n");
} finally { await pool.end(); }
