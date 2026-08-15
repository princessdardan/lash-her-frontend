import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run readiness admin DB tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { randomUUID } from "node:crypto";
  import { and, eq, inArray, isNull } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminUsers,
    manualFulfillmentPolicyVersions,
    productTaxPolicyVersions,
    fulfillmentProviderCertifications,
    shippingCalendarExceptions,
    shippingFundingReviews,
    shippingPackageProfiles,
    shippingPolicyAssignments,
    shippingServicePolicies,
  } from "./src/lib/private-db/schema.ts";
  import {
    approveManualFulfillmentPolicy,
    approveProductTaxPolicy,
    loadReadinessAdminState,
    saveShippingPackageProfile,
  } from "./src/lib/shipping/readiness-admin.ts";
  import {
    certifyFulfillmentProvider,
    removeShippingCalendarException,
    revokeFulfillmentProviderCertification,
    upsertShippingCalendarException,
    upsertShippingServicePolicy,
  } from "./src/lib/shipping/policy-admin.ts";
  import {
    approveFundingReview,
    recordInitialShippingFundingForecast,
    recordShippingFundingControl,
  } from "./src/lib/shipping/funding.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const suffix = randomUUID();
  const ownerEmail = "readiness-admin-" + suffix + "@example.invalid";
  process.env.ADMIN_OWNER_EMAILS = ownerEmail;
  const duties = [
    "business_owner",
    "operations_lead",
    "finance_owner",
    "payment_fraud_owner",
    "privacy_owner",
    "security_owner",
  ];
  let ownerId;
  let packageId;
  const taxIds = [];
  const manualIds = [];
  const certificationIds = [];
  const displacedCertificationIds = [];
  const fundingIds = [];
  let calendarExceptionId;
  let servicePolicyId;

  try {
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "readiness-admin-" + suffix,
      email: ownerEmail,
      emailNormalized: ownerEmail,
      displayName: "Nataliea Lavoie",
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;
    await db.insert(shippingPolicyAssignments).values(
      duties.map((duty) => ({ duty, adminUserId: owner.id, active: true })),
    );

    const stepUp = new Date();
    const packageProfile = await saveShippingPackageProfile({
      actorAdminUserId: owner.id,
      capacityUnits: 4,
      enabled: true,
      evidenceReference: "test://readiness-admin/package/" + suffix,
      heightCm: 8,
      lengthCm: 30,
      maxWeightGrams: 2000,
      name: "Verified package " + suffix,
      packageType: "parcel",
      rank: 90,
      slug: "verified-" + suffix,
      stepUpAuthenticatedAt: stepUp,
      tareWeightGrams: 80,
      widthCm: 20,
    });
    packageId = packageProfile.id;
    assert.equal(packageProfile.enabled, true);
    assert.match(packageProfile.reviewEvidenceHash, /^[0-9a-f]{64}$/);
    await assert.rejects(
      saveShippingPackageProfile({
        actorAdminUserId: owner.id,
        capacityUnits: 4,
        enabled: false,
        evidenceReference: "test://readiness-admin/package-update/" + suffix,
        expectedUpdatedAt: new Date(0),
        heightCm: 8,
        id: packageProfile.id,
        lengthCm: 30,
        maxWeightGrams: 2000,
        name: packageProfile.name,
        packageType: "parcel",
        rank: 90,
        slug: packageProfile.slug,
        stepUpAuthenticatedAt: new Date(),
        tareWeightGrams: 80,
        widthCm: 20,
      }),
      /changed; refresh before retrying/,
    );

    const tax = await approveProductTaxPolicy({
      actorAdminUserId: owner.id,
      coverage: {
        merchandise: true,
        shipping: true,
        supplements: true,
        usOrders: true,
        componentRefunds: true,
      },
      evidenceReference: "test://readiness-admin/tax/" + suffix,
      stepUpAuthenticatedAt: new Date(),
      version: "tax-" + suffix,
    });
    taxIds.push(tax.id);
    assert.equal(tax.status, "effective");
    assert.equal(tax.approvedByAdminUserId, owner.id);
    assert.match(tax.approvalEvidenceHash, /^[0-9a-f]{64}$/);

    await assert.rejects(
      approveProductTaxPolicy({
        actorAdminUserId: owner.id,
        coverage: {
          merchandise: true,
          shipping: true,
          supplements: false,
          usOrders: true,
          componentRefunds: true,
        },
        evidenceReference: "test://readiness-admin/tax-invalid/" + suffix,
        expectedCurrentEffectiveId: tax.id,
        stepUpAuthenticatedAt: new Date(),
        version: "tax-invalid-" + suffix,
      }),
      /must cover merchandise/,
    );

    const manualText =
      "Before pickup or dispatch, manual orders are cancelled for a full refund unless documented irreversible custom or product-preparation work has already started. " +
      "Packing, administration, and unpurchased postage do not reduce the refund.";
    const manual = await approveManualFulfillmentPolicy({
      actorAdminUserId: owner.id,
      cancellationPolicyText: manualText,
      evidenceReference: "test://readiness-admin/manual/" + suffix,
      stepUpAuthenticatedAt: new Date(),
      version: "manual-" + suffix,
    });
    manualIds.push(manual.id);
    assert.equal(manual.status, "effective");
    assert.equal(manual.approvedByAdminUserId, owner.id);
    assert.match(manual.policyTextHash, /^[0-9a-f]{64}$/);
    assert.match(manual.approvalEvidenceHash, /^[0-9a-f]{64}$/);

    const calendarDay = String((parseInt(suffix.slice(0, 2), 16) % 28) + 1).padStart(2, "0");
    const exceptionDate = "2099-02-" + calendarDay;
    await upsertShippingCalendarException({
      actorAdminUserId: owner.id,
      exceptionDate,
      kind: "branch_closure",
      label: "Initial closure",
      stepUpAuthenticatedAt: new Date(),
    });
    const [exception] = await db.select().from(shippingCalendarExceptions).where(
      and(
        eq(shippingCalendarExceptions.exceptionDate, exceptionDate),
        eq(shippingCalendarExceptions.kind, "branch_closure"),
      ),
    ).limit(1);
    calendarExceptionId = exception.id;
    await assert.rejects(
      upsertShippingCalendarException({
        actorAdminUserId: owner.id,
        exceptionDate,
        expectedUpdatedAt: new Date(0),
        id: exception.id,
        kind: "branch_closure",
        label: "Stale update",
        stepUpAuthenticatedAt: new Date(),
      }),
      /changed; refresh/,
    );
    const removed = await removeShippingCalendarException({
      actorAdminUserId: owner.id,
      expectedUpdatedAt: exception.updatedAt,
      id: exception.id,
      stepUpAuthenticatedAt: new Date(),
    });
    assert.equal(removed.id, exception.id);
    calendarExceptionId = undefined;

    const service = await upsertShippingServicePolicy({
      actorAdminUserId: owner.id,
      claimDeadlineDays: 30,
      claimWaitingDays: 7,
      destinationCountryCode: "CA",
      enabled: true,
      evidenceReference: "test://readiness-admin/service/" + suffix,
      insuranceLimitCents: 10000,
      postageType: "test-service-" + suffix,
      signatureCapable: true,
      stepUpAuthenticatedAt: new Date(),
      trackingRequired: true,
    });
    servicePolicyId = service.id;
    await assert.rejects(
      upsertShippingServicePolicy({
        actorAdminUserId: owner.id,
        claimDeadlineDays: 30,
        claimWaitingDays: 7,
        destinationCountryCode: "CA",
        enabled: false,
        evidenceReference: "test://readiness-admin/service-update/" + suffix,
        expectedUpdatedAt: new Date(0),
        id: service.id,
        insuranceLimitCents: 10000,
        postageType: service.postageType,
        signatureCapable: true,
        stepUpAuthenticatedAt: new Date(),
        trackingRequired: true,
      }),
      /changed; refresh/,
    );

    const displacedCertifications = await db.select({ id: fulfillmentProviderCertifications.id }).from(fulfillmentProviderCertifications).where(
      and(
        eq(fulfillmentProviderCertifications.provider, "chitchats"),
        eq(fulfillmentProviderCertifications.environment, "staging"),
        eq(fulfillmentProviderCertifications.scope, "canada"),
        isNull(fulfillmentProviderCertifications.revokedAt),
      ),
    );
    displacedCertificationIds.push(...displacedCertifications.map((entry) => entry.id));
    const certification = await certifyFulfillmentProvider({
      actorAdminUserId: owner.id,
      environment: "staging",
      evidenceReference: "test://readiness-admin/chitchats/" + suffix,
      provider: "chitchats",
      scope: "canada",
      stepUpAuthenticatedAt: new Date(),
      validUntil: new Date(Date.now() + 86400000),
      version: "test-" + suffix,
    });
    certificationIds.push(certification.id);
    const revoked = await revokeFulfillmentProviderCertification({
      actorAdminUserId: owner.id,
      certificationId: certification.id,
      expectedValidUntil: certification.validUntil,
      reason: "Test evidence was deliberately superseded.",
      stepUpAuthenticatedAt: new Date(),
    });
    assert.ok(revoked.revokedAt);

    const forecast = await recordInitialShippingFundingForecast({
      actorAdminUserId: owner.id,
      calculatedFiveBusinessDaySpendCents: 5000,
      calculatedTwoBusinessDaySpendCents: 2000,
      dedicatedBusinessCardConfirmed: true,
      evidenceReference: "test://readiness-admin/funding/" + suffix,
      issuerAlertsConfirmed: true,
      reloadAmountCents: 10000,
      reloadThresholdCents: 2500,
    });
    fundingIds.push(forecast.id);
    assert.equal(forecast.balanceCents, null);
    assert.equal(forecast.topUpAmountCents, null);
    const approvedForecast = await approveFundingReview({
      actorAdminUserId: owner.id,
      markApplied: false,
      reviewId: forecast.id,
    });
    assert.equal(approvedForecast.status, "approved");
    const balance = await recordShippingFundingControl({
      actorAdminUserId: owner.id,
      balanceCents: 15000,
      dedicatedBusinessCardConfirmed: true,
      externalEvidenceReference: "test://readiness-admin/balance/" + suffix,
      forecastReviewId: forecast.id,
      issuerAlertsConfirmed: true,
      kind: "balance_check",
      observedAt: new Date(),
      validUntil: new Date(Date.now() + 3600000),
    });
    fundingIds.push(balance.id);
    assert.equal(balance.reloadAmountCents, null);
    assert.equal(balance.topUpAmountCents, null);

    const state = await loadReadinessAdminState();
    assert.ok(state.packageProfiles.some((entry) => entry.id === packageProfile.id));
    assert.ok(state.taxPolicies.some((entry) => entry.id === tax.id));
    assert.ok(state.manualPolicies.some((entry) => entry.id === manual.id));
  } finally {
    if (fundingIds.length) {
      await db.delete(shippingFundingReviews).where(inArray(shippingFundingReviews.id, fundingIds));
    }
    if (certificationIds.length) {
      await db.delete(fulfillmentProviderCertifications).where(inArray(fulfillmentProviderCertifications.id, certificationIds));
    }
    if (displacedCertificationIds.length) {
      await db.update(fulfillmentProviderCertifications).set({ revokedAt: null }).where(inArray(fulfillmentProviderCertifications.id, displacedCertificationIds));
    }
    if (calendarExceptionId) {
      await db.delete(shippingCalendarExceptions).where(eq(shippingCalendarExceptions.id, calendarExceptionId));
    }
    if (servicePolicyId) {
      await db.delete(shippingServicePolicies).where(eq(shippingServicePolicies.id, servicePolicyId));
    }
    if (manualIds.length) {
      await db.delete(manualFulfillmentPolicyVersions).where(
        inArray(manualFulfillmentPolicyVersions.id, manualIds),
      );
    }
    if (taxIds.length) {
      await db.delete(productTaxPolicyVersions).where(
        inArray(productTaxPolicyVersions.id, taxIds),
      );
    }
    if (packageId) {
      await db.delete(shippingPackageProfiles).where(eq(shippingPackageProfiles.id, packageId));
    }
    if (ownerId) {
      await db.delete(shippingPolicyAssignments).where(
        and(
          eq(shippingPolicyAssignments.adminUserId, ownerId),
          inArray(shippingPolicyAssignments.duty, duties),
        ),
      );
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "owner workflows create package, tax, and manual readiness evidence with conflict fencing",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        scenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "inherit" },
    );
  },
);
