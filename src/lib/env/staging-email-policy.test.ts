import assert from "node:assert/strict";
import test from "node:test";
import { assertStagingEmailRecipients, assertStagingBulkEmailDisabled } from "./staging-email-policy.mjs";
import { VERCEL_PROJECT_BINDINGS } from "./application-environment.mjs";

const staging = {
  VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
  APP_ENV: "staging", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
  APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
  STAGING_EMAIL_RECIPIENT_ALLOWLIST: "delivered@resend.dev",
};
test("staging allows only exact reviewed recipients, including every batch recipient", () => {
  assert.doesNotThrow(() => assertStagingEmailRecipients(" Delivered@resend.dev ", staging));
  assert.throws(() => assertStagingEmailRecipients(["delivered@resend.dev", "customer@example.com"], staging), /allowlist/);
  assert.throws(() => assertStagingEmailRecipients("Name <delivered@resend.dev>", staging), /allowlist/);
  assert.throws(() => assertStagingEmailRecipients([], staging), /allowlist/);
});
test("missing or wildcard allowlists fail closed without disclosing recipient data", () => {
  for (const allowlist of ["", "*", "*@example.com"]) {
    assert.throws(() => assertStagingEmailRecipients("private@example.com", { ...staging, STAGING_EMAIL_RECIPIENT_ALLOWLIST: allowlist }),
      (error: Error) => !error.message.includes("private@example.com"));
  }
});
test("local and production recipients preserve existing behavior", () => {
  assert.doesNotThrow(() => assertStagingEmailRecipients("customer@example.com", {}));
  assert.doesNotThrow(() => assertStagingEmailRecipients("customer@example.com", {
    ...staging, APP_ENV: "production", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId,
  }));
});

test("staging rejects bulk delivery, while local and production retain broadcasts", () => {
  assert.throws(() => assertStagingBulkEmailDisabled(staging), /Bulk email/);
  assert.doesNotThrow(() => assertStagingBulkEmailDisabled({}));
  assert.doesNotThrow(() => assertStagingBulkEmailDisabled({ ...staging, APP_ENV: "production", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId }));
});
