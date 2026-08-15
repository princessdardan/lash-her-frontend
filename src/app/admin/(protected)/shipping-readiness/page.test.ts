import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const actionsSource = readFileSync(
  new URL("./actions.ts", import.meta.url),
  "utf8",
);
const intakeControlsSource = readFileSync(
  new URL(
    "../../../../components/admin/shipping-intake-location-controls.tsx",
    import.meta.url,
  ),
  "utf8",
);
const intakeLocationSource = readFileSync(
  new URL("../../../../lib/shipping/intake-location.ts", import.meta.url),
  "utf8",
);
const policyControlsSource = readFileSync(
  new URL(
    "../../../../components/admin/shipping-policy-configuration-controls.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("shipping readiness is configured-owner-only and uses server provider identity", () => {
  assert.match(pageSource, /requireAdminPagePermission\("fulfillment:view"\)/);
  assert.match(pageSource, /actor\.user\.role !== "owner"/);
  assert.match(pageSource, /assertConfiguredOwnerIdentity\(actor\.user\.id\)/);
  assert.match(pageSource, /getChitChatsOperationalIdentity\(\)/);
  assert.match(pageSource, /CHITCHATS_REGION_LABELS\[identity\.region\]/);
  assert.match(pageSource, /readOnly value=\{value\}/);
  assert.doesNotMatch(pageSource, /name="providerEnvironment"/);
  assert.doesNotMatch(pageSource, /name="providerClientId"/);
  assert.doesNotMatch(pageSource, /name="region"/);
  assert.match(pageSource, /No Chit Chats branch identifier is collected/);
});

test("attestation and revocation forms carry exact CAS snapshots", () => {
  assert.match(pageSource, /Attestation ID:/);
  assert.match(
    intakeControlsSource,
    /name="expectedCurrentAttestationId"[\s\S]*?value=\{current\?\.id \?\? ""\}/,
  );
  assert.match(
    intakeControlsSource,
    /name="expectedCurrentAttestationId"[\s\S]*?value=\{current\.id\}/,
  );
  assert.match(
    intakeControlsSource,
    /name="expectedCurrentPolicyVersion"[\s\S]*?value=\{current\.policyVersion\}/,
  );
  assert.match(actionsSource, /expectedCurrentPolicyVersion:/);
  assert.match(actionsSource, /expectedCurrentAttestationId:/);
  assert.match(
    intakeLocationSource,
    /current\.policyVersion !== input\.expectedCurrentPolicyVersion/,
  );
});

test("attestation requires the exact exported statement and validated details", () => {
  assert.match(
    pageSource,
    /statement=\{CHITCHATS_INTAKE_ATTESTATION_STATEMENT\}/,
  );
  assert.match(
    intakeControlsSource,
    /name="statementVersion"[\s\S]*?value=\{statementVersion\}/,
  );
  assert.match(
    intakeControlsSource,
    /name="statementConfirmed"[\s\S]*?required[\s\S]*?value="confirmed"/,
  );
  for (const field of [
    "locationType",
    "locationName",
    "locationAddress",
    "evidenceReference",
    "rationale",
  ]) {
    assert.match(intakeControlsSource, new RegExp(`name="${field}"`));
  }
  assert.match(
    actionsSource,
    /statementVersion !== CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION/,
  );
});

test("mutations bind the complete payload and audit success inside the domain transaction", () => {
  assert.match(
    actionsSource,
    /createAdminStepUpTarget\(\{[\s\S]*?evidenceReference:[\s\S]*?locationAddress:[\s\S]*?locationName:[\s\S]*?locationType:[\s\S]*?rationale:[\s\S]*?statement:/,
  );
  assert.match(
    actionsSource,
    /createAdminStepUpTarget\(\{[\s\S]*?expectedCurrentAttestationId:[\s\S]*?expectedCurrentPolicyVersion:[\s\S]*?reason:/,
  );
  assert.match(actionsSource, /actorAdminUserId: input\.actorAdminUserId/);
  assert.match(actionsSource, /attestChitChatsIntakeLocation\(\{/);
  assert.match(actionsSource, /revokeChitChatsIntakeLocation\(\{/);
  assert.match(intakeLocationSource, /fulfillment\.intake_location_attested/);
  assert.match(intakeLocationSource, /fulfillment\.intake_location_revoked/);
  assert.match(intakeLocationSource, /tx\.insert\(adminAuditLogs\)/);
  assert.match(intakeLocationSource, /outcome: "success"/);
  assert.match(
    intakeLocationSource,
    /assertConfiguredFulfillmentOwnerInTransaction\(/,
  );
  assert.match(
    intakeLocationSource,
    /lockShippingConfiguration\(tx\);[\s\S]*?assertShippingPolicyConfigurationMutationAllowed\(\)/,
  );
  assert.doesNotMatch(
    actionsSource,
    /body\.(?:providerEnvironment|providerClientId|region|actorAdminUserId|stepUpAuthenticatedAt)/,
  );
});

test("intake controls use an unchanged-payload two-phase step-up", () => {
  assert.match(pageSource, /<AdminActionFeedback/);
  assert.match(
    intakeControlsSource,
    /fetch\("\/api\/admin\/shipping\/intake-location"/,
  );
  assert.match(intakeControlsSource, /targetLabel: scope\.targetLabel/);
  assert.match(intakeControlsSource, /resubmit the unchanged form/);
  assert.match(intakeControlsSource, /expectedCurrentPolicyVersion/);
});

test("readiness workspace exposes every supported policy and funding workflow", () => {
  assert.match(pageSource, /<ShippingPolicyConfigurationControls/);
  assert.match(policyControlsSource, /\/api\/admin\/shipping\/policy/);
  assert.match(policyControlsSource, /\/api\/admin\/shipping\/funding-reviews/);
  for (const action of [
    "assign_duty",
    "activate_fulfillment_policy",
    "certify_provider",
    "service_policy",
    "calendar_exception",
    "activate_calendar",
    "settings",
  ]) {
    assert.match(policyControlsSource, new RegExp(`value="${action}"`));
  }
  for (const duty of [
    "business_owner",
    "operations_lead",
    "finance_owner",
    "payment_fraud_owner",
    "privacy_owner",
    "security_owner",
  ]) {
    assert.match(policyControlsSource, new RegExp(`"${duty}"`));
  }
  assert.match(policyControlsSource, /targetLabel/);
  assert.match(policyControlsSource, /contractSnapshot/);
  assert.match(policyControlsSource, /forecastReviewId/);
});
