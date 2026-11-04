import { resolveApplicationEnvironment } from "../../src/lib/env/application-environment.mjs";

// Preserve the ordinary business schedules. Qualification builds replace this
// entire list, so enabling their native scheduler cannot run business jobs.
const ordinaryCrons = [
  { path: "/api/admin/private-data-retention", schedule: "17 8 * * *" },
  { path: "/api/cron/backup-validation", schedule: "0 6 * * 1" },
  { path: "/api/admin/payment-reconciliation", schedule: "*/30 * * * *" },
  { path: "/api/cron/chitchats-shipping", schedule: "* * * * *" },
  { path: "/api/cron/customer-email-outbox", schedule: "*/5 * * * *" },
  { path: "/api/cron/product-stock-reservations", schedule: "*/15 * * * *" },
  { path: "/api/admin/marketing-contact-sync", schedule: "*/5 * * * *" },
  { path: "/api/cron/shipping-rate-cache-refresh", schedule: "30 7 * * 1" },
  { path: "/api/cron/highlevel-sync", schedule: "* * * * *" },
];

/** Build-time only. This never enables a project's native scheduler.
 * @param {Record<string, string | undefined>} env
 */
export function createVercelConfiguration(env, now = Date.now()) {
  const mode = env.LASH_RELEASE_SCHEDULER_QUALIFICATION;
  if (mode !== undefined && mode !== "false" && mode !== "true") {
    throw new Error("Invalid release scheduler qualification mode");
  }
  let crons = ordinaryCrons.map((job) => ({ ...job }));
  if (mode === "true") {
    const expires = Number(env.LASH_RELEASE_PROBE_EXPIRES_AT);
    if (resolveApplicationEnvironment(env) !== "staging" || env.VERCEL_ENV !== "production" ||
        !/^[a-f0-9]{40}$/u.test(env.VERCEL_GIT_COMMIT_SHA ?? "") || /^0+$/u.test(env.VERCEL_GIT_COMMIT_SHA ?? "") ||
        !Number.isSafeInteger(expires) || expires <= now || expires > now + 3_600_000) {
      throw new Error("Scheduler qualification requires the exact staging target and a live bounded window");
    }
    crons = [{ path: "/api/internal/release-scheduler-probe", schedule: "* * * * *" }];
  }
  // Release branches advance source independently of the explicit release action.
  // This controls Git push events; reviewed API/CLI deployments remain explicit.
  return { crons, git: { deploymentEnabled: false } };
}
