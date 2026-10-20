import "server-only";
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { crmMarketingEnabled, locationId, crmSyncEnabled } from "./config";
import { HighLevelError } from "./contract";
import { claimJobs, finishJob, type CrmContact } from "./store";
import { stopJourneys, syncJob } from "./sync";

let activeRun: ReturnType<typeof processHighLevelJobs> | undefined;

export function runHighLevelWorker() {
  // Fluid/serverless instances may receive overlapping cron invocations. Share
  // the local run so transaction-held effect locks cannot exhaust its DB pool.
  if (!activeRun)
    activeRun = processHighLevelJobs().finally(() => {
      activeRun = undefined;
    });
  return activeRun;
}

async function processHighLevelJobs() {
  const summary = {
    enabled: crmSyncEnabled(),
    processed: 0,
    succeeded: 0,
    skipped: 0,
    retry: 0,
    review: 0,
    dead_letter: 0,
  };
  // Marketing pause is independent of CRM sync. Cancel known admissions even
  // when new CRM jobs are paused; a provider outage is surfaced as a failed cron.
  if (process.env.HIGHLEVEL_LOCATION_ID && !crmMarketingEnabled()) {
    const active = await getPrivateDb().execute<CrmContact>(
      sql`select c.* from highlevel_contacts c where c.location_id = ${locationId()} and c.deleted_at is null and exists(select 1 from highlevel_effects e where e.contact_id = c.id and e.kind = 'workflow' and e.state <> 'cancelled') limit 10`,
    );
    for (const contact of active.rows) await stopJourneys(contact);
  }
  if (!summary.enabled) return summary;
  const started = Date.now();
  for (let count = 0; count < 20 && Date.now() - started < 180_000; count++) {
    const [job] = await claimJobs(1);
    if (!job) break;
    summary.processed++;
    try {
      const status = await syncJob(job);
      await finishJob(job, status);
      summary[status]++;
    } catch (error) {
      const known = error instanceof HighLevelError;
      const status =
        known && !error.retryable
          ? "review"
          : job.attempts >= 8 &&
              !(
                known &&
                ["marketing_journey_busy", "marketing_paused"].includes(
                  error.code,
                )
              )
            ? "dead_letter"
            : "retry";
      const code = known ? error.code : "crm_internal_error";
      await finishJob(
        job,
        status,
        code,
        Math.max(
          known ? error.retryAfterSeconds : 60,
          Math.min(3600, 30 * 2 ** job.attempts),
        ),
      );
      summary[status]++;
    }
  }
  return summary;
}

export function createCrmCronHandler(run = runHighLevelWorker) {
  return async function GET(request: Request): Promise<Response> {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) return new Response(null, { status: 404 });
    const expected = Buffer.from(`Bearer ${secret}`);
    const received = Buffer.from(request.headers.get("authorization") ?? "");
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    )
      return new Response(null, { status: 401 });
    try {
      const summary = await run();
      return Response.json(summary, {
        status:
          summary.retry + summary.review + summary.dead_letter ? 503 : 200,
      });
    } catch {
      return Response.json({ error: "crm_worker_failed" }, { status: 503 });
    }
  };
}
