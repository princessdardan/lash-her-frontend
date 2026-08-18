import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { shippingPolicyJobs } from "@/lib/private-db/schema";

export type ShippingPolicyJobType =
  | "deadlines"
  | "decisions"
  | "remedies"
  | "refunds"
  | "returns"
  | "claims"
  | "calendar"
  | "privacy"
  | "notifications";

export interface ClaimedShippingPolicyJob {
  id: string;
  type: ShippingPolicyJobType;
  leaseOwner: string;
  stateVersion: number;
  attemptCount: number;
}

const CADENCE_MS: Record<ShippingPolicyJobType, number> = {
  deadlines: 5 * 60_000,
  decisions: 5 * 60_000,
  remedies: 5 * 60_000,
  refunds: 5 * 60_000,
  returns: 60 * 60_000,
  claims: 60 * 60_000,
  calendar: 24 * 60 * 60_000,
  privacy: 60 * 60_000,
  notifications: 60 * 60_000,
};

const TYPES = Object.keys(CADENCE_MS) as ShippingPolicyJobType[];
const MAX_ATTEMPTS = 10;
export const SHIPPING_POLICY_JOB_LEASE_MS = 5 * 60_000;

export async function enqueueDueShippingPolicyJobs(now: Date): Promise<number> {
  return getPrivateDb().transaction(async (tx) => {
    let insertedCount = 0;
    for (const type of TYPES) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"shipping-policy/" + type}))`,
      );
      const [active] = await tx
        .select({ id: shippingPolicyJobs.id })
        .from(shippingPolicyJobs)
        .where(
          and(
            eq(shippingPolicyJobs.type, type),
            inArray(shippingPolicyJobs.status, [
              "queued",
              "processing",
              "retryable_failure",
            ]),
          ),
        )
        .limit(1);
      if (active) continue;
      const [inserted] = await tx
        .insert(shippingPolicyJobs)
        .values({
          type,
          taskKey: `${type}/${Math.floor(now.getTime() / CADENCE_MS[type])}`,
          availableAt: now,
        })
        .onConflictDoNothing({ target: shippingPolicyJobs.taskKey })
        .returning({ id: shippingPolicyJobs.id });
      if (inserted) insertedCount += 1;
    }
    return insertedCount;
  });
}

export async function claimShippingPolicyJobs(input: {
  now: Date;
  limit?: number;
}): Promise<ClaimedShippingPolicyJob[]> {
  const leaseOwner = `shipping-policy/${randomUUID()}`;
  const leaseExpiresAt = new Date(
    input.now.getTime() + SHIPPING_POLICY_JOB_LEASE_MS,
  );
  const limit = Math.min(Math.max(input.limit ?? TYPES.length, 1), 50);
  return getPrivateDb().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: shippingPolicyJobs.id })
      .from(shippingPolicyJobs)
      .where(
        and(
          lte(shippingPolicyJobs.availableAt, input.now),
          or(
            inArray(shippingPolicyJobs.status, ["queued", "retryable_failure"]),
            and(
              eq(shippingPolicyJobs.status, "processing"),
              lt(shippingPolicyJobs.leaseExpiresAt, input.now),
            ),
          ),
        ),
      )
      .orderBy(asc(shippingPolicyJobs.availableAt))
      .for("update", { skipLocked: true })
      .limit(limit);
    if (!candidates.length) return [];
    return tx
      .update(shippingPolicyJobs)
      .set({
        status: "processing",
        leaseOwner,
        leaseExpiresAt,
        attemptCount: sql`${shippingPolicyJobs.attemptCount} + 1`,
        stateVersion: sql`${shippingPolicyJobs.stateVersion} + 1`,
        lastError: null,
        updatedAt: input.now,
      })
      .where(
        inArray(
          shippingPolicyJobs.id,
          candidates.map(({ id }) => id),
        ),
      )
      .returning({
        id: shippingPolicyJobs.id,
        type: shippingPolicyJobs.type,
        leaseOwner: shippingPolicyJobs.leaseOwner,
        stateVersion: shippingPolicyJobs.stateVersion,
        attemptCount: shippingPolicyJobs.attemptCount,
      })
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          type: parseType(row.type),
          leaseOwner: row.leaseOwner!,
        })),
      );
  });
}

export async function renewShippingPolicyJobLease(
  job: ClaimedShippingPolicyJob,
  now: Date,
): Promise<boolean> {
  const [renewed] = await getPrivateDb()
    .update(shippingPolicyJobs)
    .set({
      leaseExpiresAt: new Date(now.getTime() + SHIPPING_POLICY_JOB_LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(shippingPolicyJobs.id, job.id),
        eq(shippingPolicyJobs.status, "processing"),
        eq(shippingPolicyJobs.leaseOwner, job.leaseOwner),
        eq(shippingPolicyJobs.stateVersion, job.stateVersion),
        gt(shippingPolicyJobs.leaseExpiresAt, now),
      ),
    )
    .returning({ id: shippingPolicyJobs.id });
  return Boolean(renewed);
}

export async function completeShippingPolicyJob(
  job: ClaimedShippingPolicyJob,
  now: Date,
): Promise<boolean> {
  const [completed] = await getPrivateDb()
    .update(shippingPolicyJobs)
    .set({
      status: "succeeded",
      outcomeCode: "completed",
      completedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(shippingPolicyJobs.id, job.id),
        eq(shippingPolicyJobs.status, "processing"),
        eq(shippingPolicyJobs.leaseOwner, job.leaseOwner),
        eq(shippingPolicyJobs.stateVersion, job.stateVersion),
        gt(shippingPolicyJobs.leaseExpiresAt, now),
      ),
    )
    .returning({ id: shippingPolicyJobs.id });
  return Boolean(completed);
}

export async function failShippingPolicyJob(input: {
  job: ClaimedShippingPolicyJob;
  error: unknown;
  now: Date;
}): Promise<"retryable_failure" | "manual_review" | "fenced"> {
  const manualReview = input.job.attemptCount >= MAX_ATTEMPTS;
  const delayMs = Math.min(
    2 ** Math.min(input.job.attemptCount, 10) * 30_000,
    24 * 60 * 60_000,
  );
  const [failed] = await getPrivateDb()
    .update(shippingPolicyJobs)
    .set({
      status: manualReview ? "manual_review" : "retryable_failure",
      availableAt: new Date(input.now.getTime() + delayMs),
      outcomeCode: manualReview ? "permanent_failure" : "retryable_failure",
      lastError: sanitizeError(input.error),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(shippingPolicyJobs.id, input.job.id),
        eq(shippingPolicyJobs.status, "processing"),
        eq(shippingPolicyJobs.leaseOwner, input.job.leaseOwner),
        eq(shippingPolicyJobs.stateVersion, input.job.stateVersion),
      ),
    )
    .returning({ id: shippingPolicyJobs.id });
  return failed
    ? manualReview
      ? "manual_review"
      : "retryable_failure"
    : "fenced";
}

function parseType(value: string): ShippingPolicyJobType {
  if (!TYPES.includes(value as ShippingPolicyJobType))
    throw new Error("Shipping policy job type is invalid");
  return value as ShippingPolicyJobType;
}

function sanitizeError(error: unknown): string {
  const value =
    error instanceof Error ? error.message : "Shipping policy task failed";
  return value.replace(/\s+/g, " ").trim().slice(0, 1_000);
}
