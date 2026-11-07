// Mandatory owned CI receipt. Every check is appended only after real work and
// its assertions settle; a status string or a count alone cannot qualify it.
import assert from "node:assert/strict";

export const REQUIRED_IDENTITY_ENTRY_CHECKS = Object.freeze([
  "actual-auth-exports-closed-before-callback-throttle-cleanup-token-session-or-provider-writes-and-head-never-consumes",
  "actual-auth-email-proof-durable-before-synthetic-resend-and-whole-new-work-completes-on-real-tls-database",
  "closed-real-single-use-callback-retains-its-proof-before-throttle-and-consumption",
  "actual-auth-email-callback-single-use-canonical-session-private-read-and-signout-accounted-with-admin-cookie-isolation",
  "actual-auth-email-reject-retains-proof-and-uncertainty-without-provider-replay",
  "actual-auth-email-missing-receipt-retains-proof-and-uncertainty-without-provider-replay",
  "actual-auth-delayed-resend-close-whole-entry-stays-unresolved-until-provider-settles-no-automatic-replay",
  "actual-auth-delayed-resend-ledger-death-whole-entry-stays-unresolved-until-provider-settles-no-automatic-replay",
  "actual-auth-begin-lost-acknowledgement-preserves-original-receipt-and-never-replays",
  "actual-auth-finish-lost-acknowledgement-preserves-original-receipt-and-never-replays",
  "actual-google-export-closed-before-token-exchange-and-positive-oidc-callback-owns-profile-link-and-session-through-ledger-settlement",
  "actual-auth-blocked-session-insert-close-retains-whole-entry-through-real-sql-without-reconsuming-proof",
  "actual-auth-blocked-session-insert-ledger-death-retains-whole-entry-through-real-sql-without-reconsuming-proof",
  "actual-auth-lost-session-sql-commit-ack-preserves-committed-session-and-consumed-proof-without-cookie-or-replay",
  "actual-auth-customer_verification_tokens-missing-persistence-refuses-and-retains-uncertainty",
  "actual-auth-customer_sessions-missing-persistence-refuses-and-retains-uncertainty",
  "actual-auth-signout-suppressed-missing-or-mutated-persistence-refuses-with-whole-operation-uncertainty",
  "actual-auth-token-restored-after-consumption-missing-or-mutated-persistence-refuses-with-whole-operation-uncertainty",
  "actual-auth-google-link-suppressed-missing-or-mutated-persistence-refuses-with-whole-operation-uncertainty",
  "actual-auth-throttle-reset-after-write-missing-or-mutated-persistence-refuses-with-whole-operation-uncertainty",
  "actual-account-exports-with-next-request-storage-real-active-session-closed-before-writes-and-exact-command-replay",
  "actual-account-customer_account_preferences-missing-receipt-rolls-back-completely-and-preserves-whole-uncertainty",
  "actual-account-customer_account_commands-missing-receipt-rolls-back-completely-and-preserves-whole-uncertainty",
  "actual-account-customer_account_deliveries-missing-receipt-rolls-back-completely-and-preserves-whole-uncertainty",
  "actual-account-blocked-preferences-close-whole-admission-awaits-real-transaction-and-preserves-committed-state",
  "actual-account-blocked-preferences-ledger-death-whole-admission-awaits-real-transaction-and-preserves-committed-state",
  "actual-account-expired-session-real-cookie-and-store-deny-both-writers-before-admission",
  "actual-account-suspended-user-real-cookie-and-store-deny-both-writers-before-admission",
  "actual-account-session-revoked-after-route-read-is-rechecked-under-customer-lock-with-clean-denial",
  "actual-account-command-ledger-death-preserves-committed-command-and-both-deliveries-owner-reconciled-exact-retry-does-not-rewrite",
  "actual-account-delete-requires-fresh-real-session-creates-both-receiver-commands-and-revoked-session-cannot-write",
  "actual-admin-lifecycle-command-closed-before-auth-refresh-fresh-owner-whole-authorization-and-session-revocation-accounted",
  "actual-admin-lifecycle-nonowner-real-auth-js-and-persistent-guard-deny-command-without-session-revocation",
  "actual-admin-lifecycle-stale-google-proof-real-auth-js-and-persistent-guard-deny-command-without-session-revocation",
  "actual-admin-lifecycle-disabled-owner-real-auth-js-and-persistent-guard-deny-command-without-session-revocation",
  "actual-admin-lifecycle-lost-authorization-sql-commit-ack-retains-all-parent-uncertainty-and-committed-refresh-without-command-or-automatic-replay",
  "actual-admin-lifecycle-parent-and-full-authorization-stay-active-through-blocked-refresh-and-final-command",
  "actual-lifecycle-cron-bearer-and-closed-recovery-refuse-before-claims-empty-positive-entry-completes",
  "actual-lifecycle-cron-success-whole-claim-delivery-settlement-and-owner-reconciled-exact-command-recovery",
  "actual-lifecycle-cron-outage-whole-claim-delivery-settlement-and-owner-reconciled-exact-command-recovery",
  "actual-lifecycle-cron-missing-receipt-whole-claim-delivery-settlement-and-owner-reconciled-exact-command-recovery",
  "actual-lifecycle-cron-blocked-settlement-close-awaits-all-receiver-effects-and-preserves-original-receipts",
  "actual-lifecycle-cron-blocked-settlement-ledger-death-awaits-all-receiver-effects-and-preserves-original-receipts"
]);

export function assertOwnedIdentityReceipt(result, { major, sourceManifestSha256 }) {
  assert.ok([16, 18].includes(major));
  assert.match(sourceManifestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result?.status, "FRONTEND_IDENTITY_OWNED_PASS");
  assert.equal(result.postgresMajor, major);
  assert.equal(result.applicationSourceManifestSha256, sourceManifestSha256);
  assert.deepEqual(result.findings, []);
  assert.ok(Array.isArray(result.checks));
  assert.equal(result.executedChecks, result.checks.length);
  assert.equal(result.skipped, 0);
  assert.equal(new Set(result.checks).size, result.checks.length);
  for (const name of REQUIRED_IDENTITY_ENTRY_CHECKS) assert.ok(result.checks.includes(name), name);
  assert.ok(Array.isArray(result.reconciliationEvidenceSha256));
  assert.equal(result.reconciliationEvidenceSha256.length, result.checks.length);
  for (const digest of result.reconciliationEvidenceSha256) assert.match(digest, /^[a-f0-9]{64}$/u);
  for (const flag of ["actualAuthRouteExport", "actualAccountRouteExports", "actualAuthJs", "actualAdminLifecycleRouteExport",
    "actualLifecycleCronExport", "constructedNextRequestStorage", "loopbackHttp", "verifiedPostgresTls", "realBusinessDatabase",
    "providersIntercepted", "syntheticLedgerSourceIdentity"]) assert.equal(result[flag], true, flag);
  for (const flag of ["nativeNextServer", "providerTouched", "historicalWritersFenced", "migrationAuthorized"])
    assert.equal(result[flag], false, flag);
  return result;
}

export function runOwnedIdentityChild(runOwnedChild, { port, password, major, sourceManifestSha256 }) {
  const result = runOwnedChild("ops/platform/harness/owned-frontend-identity-admission.mjs", {
    FRONTEND_IDENTITY_OWNED_TEST: "true", OWNED_RECONCILIATION_PORT: String(port),
    OWNED_RECONCILIATION_PASSWORD: password, OWNED_RECONCILIATION_MAJOR: String(major),
  }, "FRONTEND_IDENTITY_OWNED_PASS");
  return assertOwnedIdentityReceipt(result, { major, sourceManifestSha256 });
}
