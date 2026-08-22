import "dotenv/config";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { closePrivateDbPool, getPrivateDb } from "../src/lib/private-db/client";
import {
  marketingContacts,
  marketingContactSyncJobs,
} from "../src/lib/private-db/schema";

/**
 * Resets failed marketing sync jobs (dead_letter / retryable_failed) back to
 * `queued` so the scheduled worker retries them with fresh attempts. Run this
 * AFTER deploying a fix to the sync path — otherwise they just fail again.
 *
 * Only requeues jobs whose contact is still opted in (unsubscribed_at IS NULL),
 * so a contact who unsubscribed while their job was failing is not re-synced.
 *
 * Dry run by default; pass --execute to write.
 *   tsx --conditions=react-server scripts/requeue-marketing-sync-failures.ts --execute
 */

const REQUEUE_FROM = ["dead_letter", "retryable_failed"] as const;

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const db = getPrivateDb();

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketingContactSyncJobs)
    .innerJoin(
      marketingContacts,
      eq(
        marketingContacts.emailNormalized,
        marketingContactSyncJobs.emailNormalized,
      ),
    )
    .where(
      and(
        inArray(marketingContactSyncJobs.status, [...REQUEUE_FROM]),
        isNull(marketingContacts.unsubscribedAt),
      ),
    );

  const count = row?.count ?? 0;
  console.log(
    `[sync-requeue] ${count} failed job(s) for still-opted-in contacts`,
  );

  if (count === 0) {
    console.log("[sync-requeue] Nothing to requeue.");
    return;
  }

  if (!execute) {
    console.log(
      "[sync-requeue] Dry run only. Re-run with --execute to reset them to queued.",
    );
    return;
  }

  const now = new Date();

  // Scope to jobs whose contact is still opted in, so an unsubscribed contact's
  // failed job stays terminal.
  const optedInEmails = db
    .select({ emailNormalized: marketingContacts.emailNormalized })
    .from(marketingContacts)
    .where(isNull(marketingContacts.unsubscribedAt));

  const updated = await db
    .update(marketingContactSyncJobs)
    .set({
      status: "queued",
      attempts: 0,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      lastErrorContext: null,
      deadLetteredAt: null,
      nextRunAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(marketingContactSyncJobs.status, [...REQUEUE_FROM]),
        inArray(marketingContactSyncJobs.emailNormalized, optedInEmails),
      ),
    )
    .returning({ id: marketingContactSyncJobs.id });

  console.log(
    `[sync-requeue] Reset ${updated.length} job(s) to queued. The scheduled worker will retry them.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("[sync-requeue] Failed", error);
    process.exitCode = 1;
  })
  .finally(() => closePrivateDbPool());
