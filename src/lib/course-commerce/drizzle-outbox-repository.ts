import "server-only";

import { and, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { entitlementOutbox } from "@/lib/private-db/schema";

import type { EntitlementCommand } from "./entitlement-commands";
import type {
  ClaimedEntitlementJob,
  EntitlementOutboxRepository,
} from "./entitlement-worker";

interface ClaimedOutboxRow extends Record<string, unknown> {
  attempts: number;
  command_type: "grant" | "revoke";
  course_order_item_id: string;
  id: string;
  idempotency_key: string;
  lease_owner: string;
  max_attempts: number;
  payload: EntitlementCommand;
  payload_hash: string;
  sequence: number;
}

export function createDrizzleEntitlementOutboxRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): EntitlementOutboxRepository {
  return {
    async claimDue(input) {
      return db.transaction(async (tx) => {
        const leaseExpiresAt = new Date(
          input.now.getTime() + input.leaseDurationMs,
        );

        // A worker may disappear after claiming its final permitted attempt.
        // Move that exhausted lease to an inspectable terminal state before
        // claiming more work; otherwise it remains `processing` forever.
        await tx
          .update(entitlementOutbox)
          .set({
            status: "failed",
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError:
              "LEASE_EXPIRED: Delivery lease expired at maximum attempts",
            lastErrorContext: { category: "network" },
            updatedAt: input.now,
          })
          .where(
            and(
              eq(entitlementOutbox.status, "processing"),
              lte(entitlementOutbox.leaseExpiresAt, input.now),
              gte(entitlementOutbox.attempts, entitlementOutbox.maxAttempts),
            ),
          );

        const result = await tx.execute<ClaimedOutboxRow>(sql`
          WITH due AS (
            SELECT candidate.id
            FROM ${entitlementOutbox} AS candidate
            WHERE (
              (
                candidate.status = 'pending'
                AND candidate.next_attempt_at <= ${input.now}
              )
              OR (
                candidate.status = 'processing'
                AND candidate.lease_expires_at <= ${input.now}
              )
            )
            AND candidate.attempts < candidate.max_attempts
            AND NOT EXISTS (
              SELECT 1
              FROM ${entitlementOutbox} AS predecessor
              WHERE predecessor.course_order_item_id = candidate.course_order_item_id
                AND predecessor.sequence < candidate.sequence
                AND predecessor.status <> 'completed'
            )
            ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
            FOR UPDATE OF candidate SKIP LOCKED
            LIMIT ${input.batchSize}
          )
          UPDATE ${entitlementOutbox} AS claimed
          SET
            status = 'processing',
            attempts = claimed.attempts + 1,
            lease_owner = ${input.workerId},
            lease_expires_at = ${leaseExpiresAt},
            last_attempted_at = ${input.now},
            updated_at = ${input.now}
          FROM due
          WHERE claimed.id = due.id
          RETURNING
            claimed.id,
            claimed.course_order_item_id,
            claimed.command_type,
            claimed.sequence,
            claimed.idempotency_key,
            claimed.payload,
            claimed.payload_hash,
            claimed.attempts,
            claimed.max_attempts,
            claimed.lease_owner
        `);

        return result.rows.map(toClaimedJob);
      });
    },

    async markCompleted(input) {
      const [updated] = await db
        .update(entitlementOutbox)
        .set({
          status: "completed",
          returnedGrantId: input.returnedGrantId,
          completedAt: input.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          lastErrorContext: null,
          updatedAt: input.now,
        })
        .where(activeLeasePredicate(input.jobId, input.leaseOwner, input.now))
        .returning({ id: entitlementOutbox.id });
      return updated !== undefined;
    },

    async markFailed(input) {
      const [updated] = await db
        .update(entitlementOutbox)
        .set({
          status: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: `${input.error.code}: ${input.error.message}`,
          lastErrorContext: { ...input.error.context },
          updatedAt: input.now,
        })
        .where(activeLeasePredicate(input.jobId, input.leaseOwner, input.now))
        .returning({ id: entitlementOutbox.id });
      return updated !== undefined;
    },

    async markRetry(input) {
      const [updated] = await db
        .update(entitlementOutbox)
        .set({
          status: "pending",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: input.nextAttemptAt,
          lastError: `${input.error.code}: ${input.error.message}`,
          lastErrorContext: { ...input.error.context },
          updatedAt: input.now,
        })
        .where(activeLeasePredicate(input.jobId, input.leaseOwner, input.now))
        .returning({ id: entitlementOutbox.id });
      return updated !== undefined;
    },

    async releaseClaims(input) {
      if (input.jobIds.length === 0) {
        return 0;
      }

      const released = await db
        .update(entitlementOutbox)
        .set({
          status: "pending",
          attempts: sql`greatest(${entitlementOutbox.attempts} - 1, 0)`,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            inArray(entitlementOutbox.id, input.jobIds),
            eq(entitlementOutbox.status, "processing"),
            eq(entitlementOutbox.leaseOwner, input.leaseOwner),
          ),
        )
        .returning({ id: entitlementOutbox.id });
      return released.length;
    },
  };
}

function activeLeasePredicate(jobId: string, leaseOwner: string, now: Date) {
  return and(
    eq(entitlementOutbox.id, jobId),
    eq(entitlementOutbox.status, "processing"),
    eq(entitlementOutbox.leaseOwner, leaseOwner),
    gt(entitlementOutbox.leaseExpiresAt, now),
  );
}

function toClaimedJob(row: ClaimedOutboxRow): ClaimedEntitlementJob {
  return {
    attemptCount: row.attempts,
    commandType: row.command_type,
    courseOrderItemId: row.course_order_item_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    leaseOwner: row.lease_owner,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    payloadHash: row.payload_hash,
    sequence: row.sequence,
  };
}
