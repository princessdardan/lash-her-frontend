import { resolveApplicationEnvironment } from "./application-environment.mjs";

/**
 * Restrict staging deliveries before any provider call; never echo addresses.
 * @param {string | string[]} to
 * @param {Record<string, string | undefined>} env
 */
export function assertStagingEmailRecipients(to, env = process.env) {
  if (resolveApplicationEnvironment(env) !== "staging") return;
  const normalize = (value) => value.trim().toLowerCase();
  const address = /^[^\s@<>,;*]+@[^\s@<>,;*]+\.[^\s@<>,;*]+$/;
  const allowed = (env.STAGING_EMAIL_RECIPIENT_ALLOWLIST ?? "")
    .split(",").map(normalize).filter(Boolean);
  const recipients = (Array.isArray(to) ? to : [to]).map(normalize);
  if (allowed.length === 0 || recipients.length === 0 ||
      [...allowed, ...recipients].some(value => !address.test(value)) ||
      recipients.some(value => !allowed.includes(value))) {
    throw new Error("Staging email recipients must match the configured allowlist");
  }
}

/**
 * Bulk broadcasts cannot enforce the transactional recipient allowlist.
 * @param {Record<string, string | undefined>} env
 */
export function assertStagingBulkEmailDisabled(env = process.env) {
  if (resolveApplicationEnvironment(env) === "staging") {
    throw new Error("Bulk email delivery is disabled in staging");
  }
}
