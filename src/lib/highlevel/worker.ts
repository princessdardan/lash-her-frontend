import "server-only";
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { crmMarketingEnabled, locationId, crmSyncEnabled } from "./config";
import { HighLevelError } from "./contract";
import { claimJobs, finishJob, type CrmContact } from "./store";
import { stopJourneys, syncJob } from "./sync";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
} from "@/lib/writer-admission/runtime";

export interface HighLevelWorkerDependencies {
  syncEnabled: typeof crmSyncEnabled;
  marketingEnabled: typeof crmMarketingEnabled;
  hasLocation: () => boolean;
  listActiveContacts: () => Promise<CrmContact[]>;
  stopJourneys: typeof stopJourneys;
  claimJobs: typeof claimJobs;
  syncJob: typeof syncJob;
  finishJob: typeof finishJob;
  now: () => number;
}

const processJobs = createHighLevelWorker({
  syncEnabled: crmSyncEnabled,
  marketingEnabled: crmMarketingEnabled,
  hasLocation: () => Boolean(process.env.HIGHLEVEL_LOCATION_ID),
  listActiveContacts: async () =>
    (
      await getPrivateDb().execute<CrmContact>(
        sql`select c.* from highlevel_contacts c where c.location_id = ${locationId()} and c.deleted_at is null and exists(select 1 from highlevel_effects e where e.contact_id = c.id and e.kind = 'workflow' and e.state <> 'cancelled') limit 10`,
      )
    ).rows,
  stopJourneys,
  claimJobs,
  syncJob,
  finishJob,
  now: Date.now,
});

let activeRun: ReturnType<typeof processHighLevelJobs> | undefined;

export function runHighLevelWorker() {
  // Fluid/serverless instances may receive overlapping cron invocations. Share
  // the local run so transaction-held effect locks cannot exhaust its DB pool.
  if (!activeRun)
    activeRun = processJobs().finally(() => {
      activeRun = undefined;
    });
  return activeRun;
}

export function createHighLevelWorker(
  dependencies: HighLevelWorkerDependencies,
  run: WriterAdmissionRunner = runWriterAdmission,
) {
  return () => run("recovery", () => processHighLevelJobs(dependencies));
}

async function processHighLevelJobs(dependencies: HighLevelWorkerDependencies) {
  const summary = {
    enabled: dependencies.syncEnabled(),
    processed: 0,
    succeeded: 0,
    skipped: 0,
    retry: 0,
    review: 0,
    dead_letter: 0,
  };
  // Marketing pause is independent of CRM sync. Cancel known admissions even
  // when new CRM jobs are paused; a provider outage is surfaced as a failed cron.
  if (dependencies.hasLocation() && !dependencies.marketingEnabled()) {
    const active = await dependencies.listActiveContacts();
    for (const contact of active) await dependencies.stopJourneys(contact);
  }
  if (!summary.enabled) return summary;
  const started = dependencies.now();
  for (
    let count = 0;
    count < 20 && dependencies.now() - started < 180_000;
    count++
  ) {
    const [job] = await dependencies.claimJobs(1);
    if (!job) break;
    summary.processed++;
    try {
      const status = await dependencies.syncJob(job);
      await dependencies.finishJob(job, status);
      summary[status]++;
    } catch (error) {
      // Retry/review persistence does not prove a provider effect did not occur.
      // Continue the batch, but retain its durable operation for reconciliation.
      markWriterOperationUncertain();
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
      await dependencies.finishJob(
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
