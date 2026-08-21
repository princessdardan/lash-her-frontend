import "dotenv/config";

import { and, eq, isNull, notExists, sql } from "drizzle-orm";

import { closePrivateDbPool, getPrivateDb } from "../src/lib/private-db/client";
import {
  marketingContacts,
  marketingContactSyncJobs,
  type MarketingContactSyncJobPayload,
} from "../src/lib/private-db/schema";

/**
 * Enqueues a marketing-contact sync job for every opted-in contact that has NO
 * sync job at all (the "No sync record" rows in the admin). These are contacts
 * that predate the durable sync outbox or were imported without enqueuing. The
 * scheduled worker (/api/admin/marketing-contact-sync) then syncs them into the
 * Resend marketing segment.
 *
 * Scope is deliberately narrow: contacts with `unsubscribed_at IS NULL` and no
 * existing job row. Contacts that already have a queued job ("Waiting for sync")
 * drain on their own once the worker runs, and terminal failed/skipped jobs are
 * left alone (they failed for a reason — investigate separately).
 *
 * Idempotent: each job uses `mc-backfill:<contactId>` as its idempotency key, so
 * re-running never double-enqueues.
 *
 * Dry run by default; pass --execute to write. Run with the react-server
 * condition so the server-only DB path resolves:
 *   tsx --conditions=react-server scripts/backfill-marketing-sync-jobs.ts --execute
 */

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const db = getPrivateDb();

  const contacts = await db
    .select({
      id: marketingContacts.id,
      email: marketingContacts.email,
      emailNormalized: marketingContacts.emailNormalized,
      name: marketingContacts.name,
      phone: marketingContacts.phone,
      instagram: marketingContacts.instagram,
      source: marketingContacts.source,
      consentText: marketingContacts.consentText,
      lastConsentedAt: marketingContacts.lastConsentedAt,
    })
    .from(marketingContacts)
    .where(
      and(
        isNull(marketingContacts.unsubscribedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(marketingContactSyncJobs)
            .where(
              eq(
                marketingContactSyncJobs.emailNormalized,
                marketingContacts.emailNormalized,
              ),
            ),
        ),
      ),
    );

  console.log(
    `[marketing-sync-backfill] ${contacts.length} opted-in contact(s) with no sync record`,
  );

  if (contacts.length === 0) {
    console.log("[marketing-sync-backfill] Nothing to enqueue.");
    return;
  }

  if (!execute) {
    console.log(
      "[marketing-sync-backfill] Dry run only. Re-run with --execute to enqueue sync jobs.",
    );
    return;
  }

  const now = new Date();
  let enqueued = 0;

  for (let start = 0; start < contacts.length; start += BATCH_SIZE) {
    const batch = contacts.slice(start, start + BATCH_SIZE);

    const rows = batch.map((contact) => {
      const payload: MarketingContactSyncJobPayload = {
        consentedAt: contact.lastConsentedAt.toISOString(),
        email: contact.email,
        source: contact.source,
        ...(contact.name ? { name: contact.name } : {}),
        ...(contact.phone ? { phone: contact.phone } : {}),
        ...(contact.instagram ? { instagram: contact.instagram } : {}),
        ...(contact.consentText ? { consentText: contact.consentText } : {}),
        contactId: contact.id,
      };

      return {
        idempotencyKey: `mc-backfill:${contact.id}`,
        contactId: contact.id,
        email: contact.email,
        emailNormalized: contact.emailNormalized,
        source: contact.source,
        kind: "opt_in_sync" as const,
        payload,
        status: "queued" as const,
        attempts: 0,
        maxAttempts: 5,
        nextRunAt: now,
      };
    });

    const inserted = await db
      .insert(marketingContactSyncJobs)
      .values(rows)
      .onConflictDoNothing({
        target: marketingContactSyncJobs.idempotencyKey,
      })
      .returning({ id: marketingContactSyncJobs.id });

    enqueued += inserted.length;
    console.log(
      `[marketing-sync-backfill] batch ${start / BATCH_SIZE + 1}: enqueued ${inserted.length}/${batch.length}`,
    );
  }

  console.log(
    `[marketing-sync-backfill] Done — enqueued ${enqueued} sync job(s). The scheduled worker will sync them to Resend.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("[marketing-sync-backfill] Failed", error);
    process.exitCode = 1;
  })
  .finally(() => closePrivateDbPool());
