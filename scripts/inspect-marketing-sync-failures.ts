import "dotenv/config";

import { desc, inArray, sql } from "drizzle-orm";

import { closePrivateDbPool, getPrivateDb } from "../src/lib/private-db/client";
import { marketingContactSyncJobs } from "../src/lib/private-db/schema";

/**
 * Read-only diagnostic for the marketing-contact sync outbox. Prints the overall
 * status breakdown and, for failed jobs (retryable_failed / dead_letter), groups
 * them by the recorded error + failing Resend step so the systematic cause is
 * obvious. No writes.
 *
 *   tsx --conditions=react-server scripts/inspect-marketing-sync-failures.ts
 */
async function main(): Promise<void> {
  const db = getPrivateDb();

  const byStatus = await db
    .select({
      status: marketingContactSyncJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(marketingContactSyncJobs)
    .groupBy(marketingContactSyncJobs.status);

  console.log("[sync-inspect] job counts by status:");
  for (const row of byStatus.sort((a, b) => b.count - a.count)) {
    console.log(`  ${row.status}: ${row.count}`);
  }

  const grouped = await db
    .select({
      step: sql<
        string | null
      >`${marketingContactSyncJobs.lastErrorContext}->>'step'`,
      lastError: marketingContactSyncJobs.lastError,
      count: sql<number>`count(*)::int`,
    })
    .from(marketingContactSyncJobs)
    .where(
      inArray(marketingContactSyncJobs.status, [
        "retryable_failed",
        "dead_letter",
      ]),
    )
    .groupBy(
      sql`${marketingContactSyncJobs.lastErrorContext}->>'step'`,
      marketingContactSyncJobs.lastError,
    )
    .orderBy(desc(sql`count(*)`));

  if (grouped.length === 0) {
    console.log(
      "\n[sync-inspect] No failed (retryable_failed/dead_letter) jobs.",
    );
    return;
  }

  console.log("\n[sync-inspect] failed jobs grouped by step + error:");
  for (const row of grouped) {
    console.log(
      `  [${row.count}] step=${row.step ?? "(none)"} :: ${row.lastError ?? "(no message)"}`,
    );
  }

  const [sample] = await db
    .select({
      email: marketingContactSyncJobs.email,
      source: marketingContactSyncJobs.source,
      attempts: marketingContactSyncJobs.attempts,
      lastError: marketingContactSyncJobs.lastError,
      lastErrorContext: marketingContactSyncJobs.lastErrorContext,
    })
    .from(marketingContactSyncJobs)
    .where(inArray(marketingContactSyncJobs.status, ["dead_letter"]))
    .limit(1);

  if (sample) {
    console.log("\n[sync-inspect] one dead_letter sample (context):");
    console.log(
      JSON.stringify({ ...sample, email: maskEmail(sample.email) }, null, 2),
    );
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

main()
  .catch((error: unknown) => {
    console.error("[sync-inspect] Failed", error);
    process.exitCode = 1;
  })
  .finally(() => closePrivateDbPool());
