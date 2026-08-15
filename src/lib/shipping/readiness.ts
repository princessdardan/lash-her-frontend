import "server-only";

import { createHash } from "node:crypto";

import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  getConfiguredHelcimProductPaymentsContract,
  getHelcimContractIdentitySnapshot,
  helcimContractIsEffective,
  parseHelcimProductPaymentsContract,
} from "@/lib/commerce/helcim-certified-contract";
import {
  adminUsers,
  fulfillmentPolicyVersions,
  fulfillmentProviderCertifications,
  manualFulfillmentPolicyVersions,
  productTaxPolicyVersions,
  shippingCalendarVersions,
  shippingFundingReviews,
  shippingPackageProfiles,
  shippingPolicyAssignments,
  shippingPolicySettings,
  shippingServicePolicies,
  type HelcimProductPaymentsCertificationContractSnapshot,
  type FulfillmentProviderCertificationContractSnapshot,
  type ProductTaxPolicyApprovalSnapshot,
  type ShippingPolicyDuty,
} from "@/lib/private-db/schema";
export type { ProductTaxPolicyApprovalSnapshot } from "@/lib/private-db/schema";

import {
  getChitChatsConfig,
  getChitChatsOperationalIdentity,
  isChitChatsCheckoutEnabled,
} from "./config";
import {
  getChitChatsIntakeLocationReadinessRecord,
  intakeLocationRecordMatchesConfiguration,
} from "./intake-location";
import { getShippingPolicyEnforcementMode } from "./policy";
import {
  providerCertificationWindowAcceptsEvidence,
  providerContractWindowIsActive,
} from "./policy-admin";
import {
  shippingQuoteContextsEqual,
  type ShippingQuoteContext,
} from "./quote-token";
export { calendarCoverageComplete } from "./calendar-validation";
import { calendarCoverageComplete } from "./calendar-validation";
import {
  privateShippingSchemaIsCurrent,
  REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT,
} from "./readiness-schema";
export { REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT } from "./readiness-schema";

const REQUIRED_DUTIES: ShippingPolicyDuty[] = [
  "business_owner",
  "operations_lead",
  "finance_owner",
  "payment_fraud_owner",
  "privacy_owner",
  "security_owner",
];

export interface CheckoutReadinessResult {
  ready: boolean;
  blockers: string[];
  policyVersion: string | null;
  taxPolicyApproval: ProductTaxPolicyApprovalSnapshot | null;
  taxPolicyVersion: string | null;
  calendarVersionId: string | null;
  quoteContext: ShippingQuoteContext | null;
}

export async function evaluateCheckoutReadiness(input: {
  admission?: boolean;
  destinationCountryCode: "CA" | "US";
  now?: Date;
}): Promise<CheckoutReadinessResult> {
  const now = input.now ?? new Date();
  const blockers: string[] = [];
  if (input.admission !== false && !isChitChatsCheckoutEnabled()) {
    blockers.push("checkout_flag_disabled");
  }
  if (getShippingPolicyEnforcementMode() !== "enforce") {
    blockers.push("policy_not_enforced");
  }
  const siteOrigin = canonicalHttpsOrigin(process.env.NEXT_PUBLIC_SITE_URL);
  if (!siteOrigin) blockers.push("site_origin_invalid");
  for (const name of [
    "AUTH_SECRET",
    "CHITCHATS_QUOTE_SIGNING_SECRET",
    "CHITCHATS_WORKER_CRON_SECRET",
    "SHIPPING_DECISION_TOKEN_SECRET",
    "ADDRESS_CHANGE_TOKEN_SECRET",
  ]) {
    if (!isStrongSecret(process.env[name]))
      blockers.push(`secret_invalid:${name}`);
  }
  addFinancialRuntimeBlockers(blockers, process.env);
  const configuredHelcimContract = getConfiguredHelcimProductPaymentsContract();
  if (
    !configuredHelcimContract ||
    !helcimContractIsEffective(configuredHelcimContract, now)
  ) {
    blockers.push("helcim_contract_not_configured_or_expired");
  }
  let config: ReturnType<typeof getChitChatsConfig> | null = null;
  try {
    config = getChitChatsConfig();
  } catch {
    blockers.push("chitchats_configuration_invalid");
  }
  if (input.destinationCountryCode === "US" && !config?.usShippingEnabled) {
    blockers.push("us_checkout_disabled");
  }

  const db = getPrivateDb();
  const schemaResult = await db.execute<{ created_at: string }>(sql`
    select created_at::text
    from drizzle.__drizzle_migrations
    order by created_at desc nulls last
    limit 1
  `);
  const latestMigration = Number(schemaResult.rows[0]?.created_at ?? 0);
  if (!privateShippingSchemaIsCurrent(latestMigration)) {
    return {
      ready: false,
      blockers: [...blockers, "private_schema_outdated"],
      policyVersion: null,
      taxPolicyApproval: null,
      taxPolicyVersion: null,
      calendarVersionId: null,
      quoteContext: null,
    };
  }

  const certificationScope =
    input.destinationCountryCode === "US" ? "us_shipping_contract" : "canada";
  const configuredOwnerEmails = configuredOwnerEmailList();
  const activeOwners = await db
    .select({ id: adminUsers.id, email: adminUsers.email })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, "owner"), eq(adminUsers.status, "active")));
  const configuredOwner =
    configuredOwnerEmails.length === 1 &&
    activeOwners.length === 1 &&
    activeOwners[0].email.trim().toLowerCase() === configuredOwnerEmails[0]
      ? activeOwners[0]
      : null;
  if (!configuredOwner) blockers.push("sole_owner_configuration_invalid");
  const [
    policy,
    taxPolicy,
    assignments,
    packages,
    settings,
    services,
    certifications,
    funding,
    calendarVersion,
    intakeLocation,
  ] = await Promise.all([
    db.query.fulfillmentPolicyVersions.findFirst({
      where: and(
        eq(fulfillmentPolicyVersions.status, "effective"),
        isNotNull(fulfillmentPolicyVersions.privacyLegalAttestedAt),
        isNotNull(fulfillmentPolicyVersions.securityAttestedAt),
        isNotNull(fulfillmentPolicyVersions.operationsAttestedAt),
        isNotNull(fulfillmentPolicyVersions.attestedByAdminUserId),
        isNotNull(fulfillmentPolicyVersions.attestationEvidenceReference),
        lte(fulfillmentPolicyVersions.effectiveAt, now),
        isNull(fulfillmentPolicyVersions.supersededAt),
        sql`length(trim(${fulfillmentPolicyVersions.attestationEvidenceReference})) > 0`,
      ),
      orderBy: (table, { desc }) => [desc(table.effectiveAt)],
    }),
    db.query.productTaxPolicyVersions.findFirst({
      where: and(
        eq(productTaxPolicyVersions.status, "effective"),
        isNotNull(productTaxPolicyVersions.approvedByAdminUserId),
        isNotNull(productTaxPolicyVersions.approvalStepUpAuthenticatedAt),
        isNotNull(productTaxPolicyVersions.approvedAt),
        isNotNull(productTaxPolicyVersions.approvalEvidenceHash),
        isNotNull(productTaxPolicyVersions.approvalEvidenceVersion),
        eq(
          productTaxPolicyVersions.approvalAction,
          "approve_product_tax_policy",
        ),
        sql`${productTaxPolicyVersions.approvalEvidenceHash} ~ '^[0-9a-f]{64}$'`,
        sql`length(trim(${productTaxPolicyVersions.approvalEvidenceVersion})) > 0`,
        sql`length(trim(${productTaxPolicyVersions.evidenceReference})) > 0`,
        lte(
          productTaxPolicyVersions.approvedAt,
          productTaxPolicyVersions.effectiveAt,
        ),
        lte(
          productTaxPolicyVersions.approvalStepUpAuthenticatedAt,
          productTaxPolicyVersions.approvedAt,
        ),
        sql`${productTaxPolicyVersions.approvalStepUpAuthenticatedAt} >= ${productTaxPolicyVersions.approvedAt} - interval '5 minutes'`,
        lte(productTaxPolicyVersions.effectiveAt, now),
        isNull(productTaxPolicyVersions.supersededAt),
      ),
      orderBy: (table, { desc }) => [desc(table.effectiveAt)],
    }),
    db
      .select({
        duty: shippingPolicyAssignments.duty,
        adminUserId: shippingPolicyAssignments.adminUserId,
        adminEmail: adminUsers.email,
        adminDisplayName: adminUsers.displayName,
        adminRole: adminUsers.role,
        adminStatus: adminUsers.status,
      })
      .from(shippingPolicyAssignments)
      .innerJoin(
        adminUsers,
        eq(adminUsers.id, shippingPolicyAssignments.adminUserId),
      )
      .where(
        and(
          eq(shippingPolicyAssignments.active, true),
          inArray(shippingPolicyAssignments.duty, REQUIRED_DUTIES),
        ),
      ),
    db
      .select({
        id: shippingPackageProfiles.id,
        reviewedAt: shippingPackageProfiles.reviewedAt,
        reviewedByAdminUserId: shippingPackageProfiles.reviewedByAdminUserId,
        reviewStepUpAuthenticatedAt:
          shippingPackageProfiles.reviewStepUpAuthenticatedAt,
        evidenceReference: shippingPackageProfiles.evidenceReference,
        reviewEvidenceHash: shippingPackageProfiles.reviewEvidenceHash,
        reviewEvidenceVersion: shippingPackageProfiles.reviewEvidenceVersion,
        reviewAction: shippingPackageProfiles.reviewAction,
      })
      .from(shippingPackageProfiles)
      .where(eq(shippingPackageProfiles.enabled, true)),
    db.query.shippingPolicySettings.findFirst({
      where: eq(shippingPolicySettings.singletonKey, "default"),
    }),
    db
      .select({
        claimDeadlineDays: shippingServicePolicies.claimDeadlineDays,
        claimWaitingDays: shippingServicePolicies.claimWaitingDays,
        destinationCountryCode: shippingServicePolicies.destinationCountryCode,
        insuranceLimitCents: shippingServicePolicies.insuranceLimitCents,
        postageType: shippingServicePolicies.postageType,
        reviewedAt: shippingServicePolicies.reviewedAt,
        reviewedByAdminUserId: shippingServicePolicies.reviewedByAdminUserId,
        reviewStepUpAuthenticatedAt:
          shippingServicePolicies.reviewStepUpAuthenticatedAt,
        evidenceReference: shippingServicePolicies.evidenceReference,
        reviewEvidenceHash: shippingServicePolicies.reviewEvidenceHash,
        reviewEvidenceVersion: shippingServicePolicies.reviewEvidenceVersion,
        reviewAction: shippingServicePolicies.reviewAction,
        signatureCapable: shippingServicePolicies.signatureCapable,
        trackingRequired: shippingServicePolicies.trackingRequired,
      })
      .from(shippingServicePolicies)
      .where(
        and(
          eq(shippingServicePolicies.enabled, true),
          eq(
            shippingServicePolicies.destinationCountryCode,
            input.destinationCountryCode,
          ),
        ),
      ),
    db
      .select({
        provider: fulfillmentProviderCertifications.provider,
        environment: fulfillmentProviderCertifications.environment,
        scope: fulfillmentProviderCertifications.scope,
        version: fulfillmentProviderCertifications.version,
        evidenceReference: fulfillmentProviderCertifications.evidenceReference,
        certifiedAt: fulfillmentProviderCertifications.certifiedAt,
        certifiedByAdminUserId:
          fulfillmentProviderCertifications.certifiedByAdminUserId,
        certificationStepUpAuthenticatedAt:
          fulfillmentProviderCertifications.certificationStepUpAuthenticatedAt,
        certificationEvidenceHash:
          fulfillmentProviderCertifications.certificationEvidenceHash,
        certificationEvidenceVersion:
          fulfillmentProviderCertifications.certificationEvidenceVersion,
        certificationAction:
          fulfillmentProviderCertifications.certificationAction,
        validUntil: fulfillmentProviderCertifications.validUntil,
        contractSnapshot: fulfillmentProviderCertifications.contractSnapshot,
      })
      .from(fulfillmentProviderCertifications)
      .where(
        and(
          inArray(fulfillmentProviderCertifications.provider, [
            "helcim",
            "chitchats",
          ]),
          inArray(fulfillmentProviderCertifications.scope, [
            "product_payments",
            certificationScope,
          ]),
          eq(
            fulfillmentProviderCertifications.environment,
            config?.environment ?? "staging",
          ),
          gt(fulfillmentProviderCertifications.validUntil, now),
          lte(fulfillmentProviderCertifications.certifiedAt, now),
          sql`length(trim(${fulfillmentProviderCertifications.evidenceReference})) > 0`,
          isNull(fulfillmentProviderCertifications.revokedAt),
        ),
      ),
    db.query.shippingFundingReviews.findFirst({
      where: and(
        eq(shippingFundingReviews.status, "recorded"),
        eq(shippingFundingReviews.kind, "balance_check"),
        isNotNull(shippingFundingReviews.externalEvidenceReference),
        isNotNull(shippingFundingReviews.observedAt),
        isNotNull(shippingFundingReviews.forecastReviewId),
        lte(shippingFundingReviews.observedAt, now),
        gt(shippingFundingReviews.validUntil, now),
        sql`length(trim(${shippingFundingReviews.externalEvidenceReference})) > 0`,
      ),
      orderBy: (table, { desc }) => [desc(table.observedAt)],
    }),
    db.query.shippingCalendarVersions.findFirst({
      where: and(
        eq(shippingCalendarVersions.status, "effective"),
        isNotNull(shippingCalendarVersions.attestedByAdminUserId),
        isNotNull(shippingCalendarVersions.attestedAt),
        isNotNull(shippingCalendarVersions.evidenceReference),
        lte(shippingCalendarVersions.effectiveAt, now),
        isNull(shippingCalendarVersions.supersededAt),
        sql`length(trim(${shippingCalendarVersions.evidenceReference})) > 0`,
      ),
      orderBy: (table, { desc }) => [desc(table.effectiveAt)],
    }),
    config
      ? getChitChatsIntakeLocationReadinessRecord(config)
      : Promise.resolve(null),
  ]);

  if (!policy || policy.attestedByAdminUserId !== configuredOwner?.id)
    blockers.push("policy_version_not_effective");
  if (!policyHasP10PreCapAmendment(policy?.policySnapshot))
    blockers.push("p10_pre_cap_policy_not_effective");
  if (
    assignments.length !== REQUIRED_DUTIES.length ||
    new Set(assignments.map((item) => item.adminUserId)).size !== 1 ||
    assignments.some(
      (item) => item.adminRole !== "owner" || item.adminStatus !== "active",
    ) ||
    !assignments.every((item) => isConfiguredOwnerEmail(item.adminEmail)) ||
    assignments.some((item) => item.adminUserId !== configuredOwner?.id)
  ) {
    blockers.push("owner_role_assignments_incomplete");
  }
  const configuredBusinessOwnerId =
    assignments.find((item) => item.duty === "business_owner")?.adminUserId ??
    null;
  const configuredBusinessOwner = assignments.find(
    (item) => item.duty === "business_owner",
  );
  const taxPolicyApproval = taxPolicy
    ? toProductTaxPolicyApprovalSnapshot(taxPolicy)
    : null;
  if (
    !taxPolicyApproval ||
    taxPolicyApproval.approvedByAdminUserId !== configuredBusinessOwnerId ||
    taxPolicyApproval.ownerName.trim() !==
      configuredBusinessOwner?.adminDisplayName?.trim()
  ) {
    blockers.push("product_tax_policy_not_approved");
  }
  if (
    !config ||
    !intakeLocationRecordMatchesConfiguration({
      configuredOwnerId: configuredBusinessOwnerId,
      effectivePolicyVersion: policy?.version ?? null,
      identity: config,
      now,
      record: intakeLocation,
    })
  ) {
    blockers.push("intake_location_not_attested");
  }
  const usShippingCertification =
    input.destinationCountryCode === "US"
      ? certifications.find(
          (item) =>
            item.provider === "chitchats" &&
            item.scope === certificationScope &&
            providerCertificationHasOwnerProof(
              item,
              configuredBusinessOwnerId,
            ) &&
            usShippingContractIsCurrent(item, services, now),
        )
      : null;
  const usShippingContract =
    usShippingCertification?.contractSnapshot &&
    "importTerms" in usShippingCertification.contractSnapshot
      ? usShippingCertification.contractSnapshot
      : null;
  if (
    !packages.length ||
    packages.some(
      (profile) =>
        !profile.reviewedAt ||
        profile.reviewedByAdminUserId !== configuredBusinessOwnerId ||
        !profile.reviewStepUpAuthenticatedAt ||
        profile.reviewStepUpAuthenticatedAt > profile.reviewedAt ||
        profile.reviewStepUpAuthenticatedAt <
          new Date(profile.reviewedAt.getTime() - 5 * 60_000) ||
        !profile.evidenceReference?.trim() ||
        !/^[0-9a-f]{64}$/.test(profile.reviewEvidenceHash ?? "") ||
        !profile.reviewEvidenceVersion?.trim() ||
        profile.reviewAction !== "approve_shipping_package_profile",
    )
  ) {
    blockers.push("package_profiles_unreviewed");
  }
  if (!settings) blockers.push("shipping_policy_settings_missing");
  if (policy && settings && settings.policyVersion !== policy.version) {
    blockers.push("shipping_policy_settings_version_mismatch");
  }
  if (
    !services.length ||
    services.some(
      (service) =>
        service.reviewedAt < new Date(now.getTime() - 90 * 24 * 60 * 60_000) ||
        service.reviewedByAdminUserId !== configuredBusinessOwnerId ||
        !service.reviewStepUpAuthenticatedAt ||
        service.reviewStepUpAuthenticatedAt > service.reviewedAt ||
        service.reviewStepUpAuthenticatedAt <
          new Date(service.reviewedAt.getTime() - 5 * 60_000) ||
        !service.evidenceReference?.trim() ||
        !/^[0-9a-f]{64}$/.test(service.reviewEvidenceHash ?? "") ||
        !service.reviewEvidenceVersion?.trim() ||
        service.reviewAction !== "approve_shipping_service_policy",
    )
  ) {
    blockers.push("service_policy_missing_or_stale");
  }
  const helcimCertification = certifications.find(
    (item) =>
      item.provider === "helcim" &&
      item.scope === "product_payments" &&
      providerCertificationHasOwnerProof(item, configuredBusinessOwnerId) &&
      configuredHelcimContract &&
      helcimCertificationMatchesConfiguredContract(
        item,
        configuredHelcimContract,
        now,
      ),
  );
  if (!helcimCertification) {
    blockers.push("helcim_not_certified");
  }
  if (
    (input.destinationCountryCode === "US" && !usShippingCertification) ||
    (input.destinationCountryCode === "CA" &&
      !certifications.some(
        (item) =>
          item.provider === "chitchats" &&
          item.scope === certificationScope &&
          providerCertificationHasOwnerProof(item, configuredBusinessOwnerId),
      ))
  ) {
    blockers.push("chitchats_not_certified");
  }
  if (
    !funding ||
    funding.recordedByAdminUserId !== configuredBusinessOwnerId ||
    funding.balanceCents === null ||
    funding.calculatedTwoBusinessDaySpendCents === null ||
    funding.balanceCents < funding.calculatedTwoBusinessDaySpendCents
  ) {
    blockers.push("funding_attestation_stale_or_insufficient");
  } else {
    const forecast = await db.query.shippingFundingReviews.findFirst({
      where: and(
        eq(shippingFundingReviews.id, funding.forecastReviewId!),
        eq(shippingFundingReviews.kind, "thirty_day_review"),
        inArray(shippingFundingReviews.status, ["approved", "applied"]),
      ),
    });
    if (
      !forecast ||
      forecast.financeApprovedByAdminUserId !== configuredBusinessOwnerId ||
      forecast.businessOwnerApprovedByAdminUserId !==
        configuredBusinessOwnerId ||
      forecast.calculatedTwoBusinessDaySpendCents !==
        funding.calculatedTwoBusinessDaySpendCents
    ) {
      blockers.push("funding_forecast_not_approved");
    }
  }
  if (!calendarVersion || !calendarCoverageComplete(calendarVersion, now)) {
    blockers.push("calendar_coverage_below_21_months");
  } else if (
    calendarVersion.attestedByAdminUserId !== configuredBusinessOwnerId
  ) {
    blockers.push("calendar_owner_attestation_invalid");
  }

  const quoteContext: ShippingQuoteContext | null =
    blockers.length === 0 &&
    config &&
    intakeLocation &&
    policy &&
    taxPolicy &&
    settings &&
    funding &&
    calendarVersion
      ? {
          calendarVersionId: calendarVersion.id,
          fundingAttestationId: funding.id,
          helcimProductPaymentsContract: configuredHelcimContract!,
          intakeLocationAttestationId: intakeLocation.id,
          packageProfileApprovals: packages
            .map((profile) => ({
              ...profile,
              evidenceReference: profile.evidenceReference!,
              reviewAction:
                profile.reviewAction as "approve_shipping_package_profile",
              reviewEvidenceHash: profile.reviewEvidenceHash!,
              reviewEvidenceVersion: profile.reviewEvidenceVersion!,
              reviewedAt: profile.reviewedAt!.toISOString(),
              reviewedByAdminUserId: profile.reviewedByAdminUserId!,
              reviewStepUpAuthenticatedAt:
                profile.reviewStepUpAuthenticatedAt!.toISOString(),
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
          policyVersion: policy.version,
          providerCertificationApprovals: certifications
            .map((certification) => ({
              certificationAction:
                certification.certificationAction as "certify_fulfillment_provider",
              certificationEvidenceHash:
                certification.certificationEvidenceHash!,
              certificationEvidenceVersion:
                certification.certificationEvidenceVersion!,
              certificationStepUpAuthenticatedAt:
                certification.certificationStepUpAuthenticatedAt!.toISOString(),
              certifiedAt: certification.certifiedAt.toISOString(),
              certifiedByAdminUserId: certification.certifiedByAdminUserId!,
              environment: certification.environment,
              evidenceReference: certification.evidenceReference,
              provider: certification.provider,
              scope: certification.scope,
              validUntil: certification.validUntil.toISOString(),
              version: certification.version,
            }))
            .sort((left, right) =>
              `${left.provider}:${left.scope}`.localeCompare(
                `${right.provider}:${right.scope}`,
              ),
            ),
          region: config.region,
          servicePolicies: services
            .map((service) => ({
              ...service,
              destinationCountryCode: service.destinationCountryCode as
                | "CA"
                | "US",
              evidenceReference: service.evidenceReference!,
              reviewAction:
                service.reviewAction as "approve_shipping_service_policy",
              reviewEvidenceHash: service.reviewEvidenceHash!,
              reviewEvidenceVersion: service.reviewEvidenceVersion!,
              reviewedAt: service.reviewedAt.toISOString(),
              reviewedByAdminUserId: service.reviewedByAdminUserId!,
              reviewStepUpAuthenticatedAt:
                service.reviewStepUpAuthenticatedAt!.toISOString(),
            }))
            .sort((left, right) =>
              left.postageType.localeCompare(right.postageType),
            ),
          shippingPolicySnapshot: {
            afterCutoffHandoffBusinessDays:
              settings.afterCutoffHandoffBusinessDays,
            autoRefundBusinessDays: settings.autoRefundBusinessDays,
            beforeCutoffHandoffBusinessDays:
              settings.beforeCutoffHandoffBusinessDays,
            closureDates: calendarVersion.closureDates,
            coverageEndsAt: settings.coverageEndsAt,
            coverageStartsAt: settings.coverageStartsAt,
            orderCutoff: settings.orderCutoff,
            signatureThresholdCents: settings.signatureThresholdCents,
            timezone: calendarVersion.timezone,
          },
          taxPolicyApproval: taxPolicyApproval!,
          taxPolicyVersion: taxPolicy.version,
          usShippingContract,
        }
      : null;
  return {
    ready: blockers.length === 0,
    blockers,
    policyVersion: policy?.version ?? null,
    taxPolicyVersion: taxPolicy?.version ?? null,
    taxPolicyApproval,
    calendarVersionId: calendarVersion?.id ?? null,
    quoteContext,
  };
}

export async function assertShippingQuoteContextCurrent(input: {
  destinationCountryCode?: "CA" | "US";
  expectedContext?: ShippingQuoteContext | null;
  intakeLocationAttestationId: string | null;
  now?: Date;
}): Promise<ShippingQuoteContext | null> {
  const now = input.now ?? new Date();
  if (input.expectedContext && input.destinationCountryCode) {
    const readiness = await evaluateCheckoutReadiness({
      admission: false,
      destinationCountryCode: input.destinationCountryCode,
      now,
    });
    if (
      !readiness.quoteContext ||
      !shippingQuoteContextsEqual(readiness.quoteContext, input.expectedContext)
    ) {
      throw new CheckoutNotReadyError(["shipping_quote_context_changed"]);
    }
    return readiness.quoteContext;
  }
  if (!input.intakeLocationAttestationId) {
    if (getShippingPolicyEnforcementMode() === "enforce") {
      throw new CheckoutNotReadyError(["shipping_quote_context_missing"]);
    }
    return null;
  }
  const identity = getChitChatsOperationalIdentity();
  const [record, policy, businessOwners] = await Promise.all([
    getChitChatsIntakeLocationReadinessRecord(identity),
    getPrivateDb().query.fulfillmentPolicyVersions.findFirst({
      where: and(
        eq(fulfillmentPolicyVersions.status, "effective"),
        isNotNull(fulfillmentPolicyVersions.operationsAttestedAt),
        lte(fulfillmentPolicyVersions.effectiveAt, now),
        isNull(fulfillmentPolicyVersions.supersededAt),
      ),
      orderBy: (table, { desc }) => [desc(table.effectiveAt)],
    }),
    getPrivateDb()
      .select({
        adminUserId: shippingPolicyAssignments.adminUserId,
        email: adminUsers.email,
        role: adminUsers.role,
        status: adminUsers.status,
      })
      .from(shippingPolicyAssignments)
      .innerJoin(
        adminUsers,
        eq(adminUsers.id, shippingPolicyAssignments.adminUserId),
      )
      .where(
        and(
          eq(shippingPolicyAssignments.active, true),
          eq(shippingPolicyAssignments.duty, "business_owner"),
        ),
      ),
  ]);
  const configuredOwnerId =
    businessOwners.length === 1 &&
    businessOwners[0]?.role === "owner" &&
    businessOwners[0].status === "active" &&
    isConfiguredOwnerEmail(businessOwners[0].email)
      ? businessOwners[0].adminUserId
      : null;
  if (
    !record ||
    record.id !== input.intakeLocationAttestationId ||
    !intakeLocationRecordMatchesConfiguration({
      configuredOwnerId,
      effectivePolicyVersion: policy?.version ?? null,
      identity,
      now,
      record,
    })
  ) {
    throw new CheckoutNotReadyError(["shipping_quote_context_changed"]);
  }
  return null;
}

export async function assertUsShippingContractCurrent(input: {
  snapshot: FulfillmentProviderCertificationContractSnapshot | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const config = getChitChatsConfig();
  const snapshot = input.snapshot;
  if (
    snapshot?.importTerms !== "DDU" ||
    new Date(snapshot.effectiveFrom) > now ||
    new Date(snapshot.effectiveUntil) <= now
  )
    throw new CheckoutNotReadyError(["us_shipping_contract_changed"]);
  const [certification] = await getPrivateDb()
    .select({ id: fulfillmentProviderCertifications.id })
    .from(fulfillmentProviderCertifications)
    .where(
      and(
        eq(fulfillmentProviderCertifications.provider, "chitchats"),
        eq(fulfillmentProviderCertifications.environment, config.environment),
        eq(fulfillmentProviderCertifications.scope, "us_shipping_contract"),
        eq(fulfillmentProviderCertifications.version, snapshot.version),
        eq(
          fulfillmentProviderCertifications.evidenceReference,
          snapshot.evidenceReference,
        ),
        sql`${fulfillmentProviderCertifications.contractSnapshot} = ${JSON.stringify(snapshot)}::jsonb`,
        lte(fulfillmentProviderCertifications.certifiedAt, now),
        gt(fulfillmentProviderCertifications.validUntil, now),
        isNull(fulfillmentProviderCertifications.revokedAt),
      ),
    )
    .limit(1)
    .for("share");
  if (!certification)
    throw new CheckoutNotReadyError(["us_shipping_contract_changed"]);
}

type PrivateDbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export async function assertShippingQuoteContextAtCheckoutCommit(
  tx: PrivateDbTransaction,
  input: {
    destinationCountryCode: "CA" | "US";
    expectedContext: ShippingQuoteContext;
    now?: Date;
  },
): Promise<CheckoutReadinessResult> {
  // The second readiness read uses the normal readiness service while these
  // table locks prevent policy/configuration writers from changing its result
  // before the order, obligation, and quote attachment commit.
  await lockShippingCheckoutReadinessConfiguration(tx);
  const readiness = await evaluateCheckoutReadiness({
    destinationCountryCode: input.destinationCountryCode,
    now: input.now,
  });
  if (
    !readiness.ready ||
    !readiness.quoteContext ||
    !shippingQuoteContextsEqual(readiness.quoteContext, input.expectedContext)
  ) {
    throw new CheckoutNotReadyError(
      readiness.blockers.length
        ? readiness.blockers
        : ["shipping_quote_context_changed"],
    );
  }
  return readiness;
}

export async function lockShippingCheckoutReadinessConfiguration(
  tx: PrivateDbTransaction,
): Promise<void> {
  await tx.execute(sql`
    lock table
      admin_users,
      fulfillment_policy_versions,
      fulfillment_provider_certifications,
      product_tax_policy_versions,
      shipping_policy_assignments,
      shipping_package_profiles,
      shipping_policy_settings,
      shipping_service_policies,
      shipping_funding_reviews,
      shipping_calendar_versions,
      chitchats_intake_location_attestations
    in share mode
  `);
}

export async function assertHelcimProductPaymentsCertificationInTransaction(
  tx: PrivateDbTransaction,
  now = new Date(),
): Promise<NonNullable<ReturnType<typeof getHelcimContractIdentitySnapshot>>> {
  const contract = getConfiguredHelcimProductPaymentsContract();
  const identity = getHelcimContractIdentitySnapshot(now);
  if (!contract || !identity || !helcimContractIsEffective(contract, now)) {
    throw new CheckoutNotReadyError(["helcim_not_certified"]);
  }
  const providerEnvironment =
    process.env.VERCEL_ENV === "production" ? "production" : "staging";
  const configuredOwnerEmails = configuredOwnerEmailList();
  const [businessOwners, activeOwners] = await Promise.all([
    tx
      .select({
        adminUserId: shippingPolicyAssignments.adminUserId,
        email: adminUsers.email,
        role: adminUsers.role,
        status: adminUsers.status,
      })
      .from(shippingPolicyAssignments)
      .innerJoin(
        adminUsers,
        eq(adminUsers.id, shippingPolicyAssignments.adminUserId),
      )
      .where(
        and(
          eq(shippingPolicyAssignments.active, true),
          eq(shippingPolicyAssignments.duty, "business_owner"),
        ),
      ),
    tx
      .select({ id: adminUsers.id, email: adminUsers.email })
      .from(adminUsers)
      .where(
        and(eq(adminUsers.role, "owner"), eq(adminUsers.status, "active")),
      ),
  ]);
  const configuredOwnerId =
    businessOwners.length === 1 &&
    activeOwners.length === 1 &&
    businessOwners[0]?.role === "owner" &&
    businessOwners[0].status === "active" &&
    configuredOwnerEmails.length === 1 &&
    businessOwners[0].adminUserId === activeOwners[0].id &&
    businessOwners[0].email.toLowerCase() === configuredOwnerEmails[0] &&
    activeOwners[0].email.toLowerCase() === configuredOwnerEmails[0]
      ? businessOwners[0].adminUserId
      : null;
  const [certification] = await tx
    .select({
      id: fulfillmentProviderCertifications.id,
      certifiedAt: fulfillmentProviderCertifications.certifiedAt,
      certifiedByAdminUserId:
        fulfillmentProviderCertifications.certifiedByAdminUserId,
      certificationStepUpAuthenticatedAt:
        fulfillmentProviderCertifications.certificationStepUpAuthenticatedAt,
      certificationEvidenceHash:
        fulfillmentProviderCertifications.certificationEvidenceHash,
      certificationEvidenceVersion:
        fulfillmentProviderCertifications.certificationEvidenceVersion,
      certificationAction:
        fulfillmentProviderCertifications.certificationAction,
    })
    .from(fulfillmentProviderCertifications)
    .where(
      and(
        eq(fulfillmentProviderCertifications.provider, "helcim"),
        eq(fulfillmentProviderCertifications.environment, providerEnvironment),
        eq(fulfillmentProviderCertifications.scope, "product_payments"),
        eq(fulfillmentProviderCertifications.version, contract.version),
        eq(
          fulfillmentProviderCertifications.evidenceReference,
          contract.evidenceReference,
        ),
        sql`${fulfillmentProviderCertifications.contractSnapshot} = ${JSON.stringify(contract)}::jsonb`,
        lte(fulfillmentProviderCertifications.certifiedAt, now),
        eq(
          fulfillmentProviderCertifications.validUntil,
          new Date(contract.effectiveUntil),
        ),
        gt(fulfillmentProviderCertifications.validUntil, now),
        isNull(fulfillmentProviderCertifications.revokedAt),
      ),
    )
    .limit(1)
    .for("share");
  if (
    !certification ||
    !providerCertificationHasOwnerProof(certification, configuredOwnerId)
  ) {
    throw new CheckoutNotReadyError(["helcim_not_certified"]);
  }
  return identity;
}

export async function assertProductTaxPolicyApprovalInTransaction(
  tx: PrivateDbTransaction,
  expected: ProductTaxPolicyApprovalSnapshot,
  now = new Date(),
): Promise<ProductTaxPolicyApprovalSnapshot> {
  const configuredOwnerEmails = configuredOwnerEmailList();
  const [activeOwners, effectivePolicies] = await Promise.all([
    tx
      .select({
        displayName: adminUsers.displayName,
        email: adminUsers.email,
        id: adminUsers.id,
      })
      .from(adminUsers)
      .where(and(eq(adminUsers.role, "owner"), eq(adminUsers.status, "active")))
      .for("share"),
    tx
      .select({ id: productTaxPolicyVersions.id })
      .from(productTaxPolicyVersions)
      .where(eq(productTaxPolicyVersions.status, "effective"))
      .limit(2)
      .for("share"),
  ]);
  const configuredOwner =
    configuredOwnerEmails.length === 1 &&
    activeOwners.length === 1 &&
    activeOwners[0].email.trim().toLowerCase() === configuredOwnerEmails[0]
      ? activeOwners[0]
      : null;
  const [policy] = await tx
    .select()
    .from(productTaxPolicyVersions)
    .where(
      and(
        eq(productTaxPolicyVersions.version, expected.version),
        eq(productTaxPolicyVersions.status, "effective"),
        lte(productTaxPolicyVersions.effectiveAt, now),
        isNull(productTaxPolicyVersions.supersededAt),
      ),
    )
    .limit(1)
    .for("share");
  const snapshot = policy ? toProductTaxPolicyApprovalSnapshot(policy) : null;
  if (
    !configuredOwner ||
    effectivePolicies.length !== 1 ||
    effectivePolicies[0]?.id !== policy?.id ||
    !policy ||
    !snapshot ||
    !configuredOwner.displayName?.trim() ||
    policy.approvedByAdminUserId !== configuredOwner.id ||
    policy.ownerName.trim() !== configuredOwner.displayName.trim() ||
    stableReadinessJson(snapshot) !== stableReadinessJson(expected)
  ) {
    throw new CheckoutNotReadyError(["product_tax_policy_not_approved"]);
  }
  return snapshot;
}

export interface ManualCheckoutPolicyApproval {
  version: string;
  text: string;
  textHash: string;
  evidenceReference: string;
  approvedByAdminUserId: string;
  approvedAt: Date;
  effectiveAt: Date;
}

export interface ManualCheckoutReadinessResult {
  ready: boolean;
  blockers: string[];
  policy: ManualCheckoutPolicyApproval | null;
  fulfillmentPolicyVersion: string | null;
  policyVersion: string | null;
  taxPolicyVersion: string | null;
  taxPolicyApproval: ProductTaxPolicyApprovalSnapshot | null;
}

export async function assertManualCheckoutReadinessInTransaction(
  tx: PrivateDbTransaction,
  expected: {
    fulfillmentPolicyVersion: string;
    manualPolicy: ManualCheckoutPolicyApproval;
    taxPolicyApproval: ProductTaxPolicyApprovalSnapshot;
  },
  now = new Date(),
) {
  await tx.execute(sql`
    lock table
      admin_users,
      fulfillment_policy_versions,
      fulfillment_provider_certifications,
      manual_fulfillment_policy_versions,
      product_tax_policy_versions,
      shipping_policy_assignments
    in share mode
  `);
  const blockers: string[] = [];
  if (process.env.MANUAL_PRODUCT_CHECKOUT_ENABLED !== "true") {
    blockers.push("manual_checkout_flag_disabled");
  }
  if (process.env.SHIPPING_POLICY_ENFORCEMENT_MODE !== "enforce") {
    blockers.push("policy_not_enforced");
  }
  if (!canonicalHttpsOrigin(process.env.NEXT_PUBLIC_SITE_URL)) {
    blockers.push("site_origin_invalid");
  }
  addFinancialRuntimeBlockers(blockers, process.env);
  if (blockers.length) throw new CheckoutNotReadyError(blockers);

  const configuredOwnerEmails = configuredOwnerEmailList();
  const activeOwners = await tx
    .select({
      displayName: adminUsers.displayName,
      email: adminUsers.email,
      id: adminUsers.id,
    })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, "owner"), eq(adminUsers.status, "active")))
    .for("share");
  const configuredOwner =
    configuredOwnerEmails.length === 1 &&
    activeOwners.length === 1 &&
    activeOwners[0].email.trim().toLowerCase() === configuredOwnerEmails[0]
      ? activeOwners[0]
      : null;
  if (!configuredOwner) {
    throw new CheckoutNotReadyError(["sole_owner_configuration_invalid"]);
  }

  const [fulfillmentPolicy, manualPolicy] = await Promise.all([
    tx
      .select()
      .from(fulfillmentPolicyVersions)
      .where(
        and(
          eq(
            fulfillmentPolicyVersions.version,
            expected.fulfillmentPolicyVersion,
          ),
          eq(fulfillmentPolicyVersions.status, "effective"),
          eq(
            fulfillmentPolicyVersions.attestedByAdminUserId,
            configuredOwner.id,
          ),
          isNotNull(fulfillmentPolicyVersions.privacyLegalAttestedAt),
          isNotNull(fulfillmentPolicyVersions.securityAttestedAt),
          isNotNull(fulfillmentPolicyVersions.operationsAttestedAt),
          isNotNull(fulfillmentPolicyVersions.attestationEvidenceReference),
          sql`length(trim(${fulfillmentPolicyVersions.attestationEvidenceReference})) > 0`,
          lte(fulfillmentPolicyVersions.effectiveAt, now),
          isNull(fulfillmentPolicyVersions.supersededAt),
        ),
      )
      .limit(1)
      .for("share")
      .then((rows) => rows[0] ?? null),
    tx
      .select()
      .from(manualFulfillmentPolicyVersions)
      .where(
        and(
          eq(
            manualFulfillmentPolicyVersions.version,
            expected.manualPolicy.version,
          ),
          eq(manualFulfillmentPolicyVersions.status, "effective"),
          eq(
            manualFulfillmentPolicyVersions.approvedByAdminUserId,
            configuredOwner.id,
          ),
          lte(manualFulfillmentPolicyVersions.effectiveAt, now),
          isNull(manualFulfillmentPolicyVersions.supersededAt),
        ),
      )
      .limit(1)
      .for("share")
      .then((rows) => rows[0] ?? null),
  ]);
  const currentManualPolicy = manualPolicy
    ? toManualCheckoutPolicyApproval(manualPolicy, configuredOwner.id)
    : null;
  if (
    !fulfillmentPolicy ||
    !currentManualPolicy ||
    stableReadinessJson(currentManualPolicy) !==
      stableReadinessJson(expected.manualPolicy)
  ) {
    throw new CheckoutNotReadyError(["manual_policy_not_approved"]);
  }
  const [taxPolicyApproval, helcimContract] = await Promise.all([
    assertProductTaxPolicyApprovalInTransaction(
      tx,
      expected.taxPolicyApproval,
      now,
    ),
    assertHelcimProductPaymentsCertificationInTransaction(tx, now),
  ]);
  return { helcimContract, taxPolicyApproval };
}

export async function evaluateManualCheckoutReadiness(
  input: {
    catalogMetadataReady?: boolean;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
): Promise<ManualCheckoutReadinessResult> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const blockers: string[] = [];
  if (env.MANUAL_PRODUCT_CHECKOUT_ENABLED !== "true") {
    blockers.push("manual_checkout_flag_disabled");
  }
  if (env.SHIPPING_POLICY_ENFORCEMENT_MODE !== "enforce") {
    blockers.push("policy_not_enforced");
  }
  if (!canonicalHttpsOrigin(env.NEXT_PUBLIC_SITE_URL)) {
    blockers.push("site_origin_invalid");
  }
  addFinancialRuntimeBlockers(blockers, env);
  const configuredHelcimContract = parseConfiguredHelcimContract(env);
  if (
    !configuredHelcimContract ||
    !helcimContractIsEffective(configuredHelcimContract, now)
  ) {
    blockers.push("helcim_contract_not_configured_or_expired");
  }
  if (input.catalogMetadataReady === false) {
    blockers.push("catalog_metadata_incomplete");
  }

  const db = getPrivateDb();
  const schemaResult = await db.execute<{ created_at: string }>(sql`
    select created_at::text
    from drizzle.__drizzle_migrations
    order by created_at desc nulls last
    limit 1
  `);
  if (
    Number(schemaResult.rows[0]?.created_at ?? 0) <
    REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT
  ) {
    blockers.push("private_schema_outdated");
  }
  const configuredOwnerEmails = configuredOwnerEmailList(env);
  const activeOwners = await db
    .select({
      id: adminUsers.id,
      displayName: adminUsers.displayName,
      email: adminUsers.email,
    })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, "owner"), eq(adminUsers.status, "active")));
  const configuredOwner =
    configuredOwnerEmails.length === 1 &&
    activeOwners.length === 1 &&
    activeOwners[0].email.trim().toLowerCase() === configuredOwnerEmails[0]
      ? activeOwners[0]
      : null;
  if (!configuredOwner) blockers.push("sole_owner_configuration_invalid");
  const providerEnvironment =
    env.VERCEL_ENV === "production" ? "production" : "staging";
  const [fulfillmentPolicy, taxPolicy, helcimCertification, policyRow] =
    await Promise.all([
      db.query.fulfillmentPolicyVersions.findFirst({
        where: and(
          eq(fulfillmentPolicyVersions.status, "effective"),
          isNotNull(fulfillmentPolicyVersions.privacyLegalAttestedAt),
          isNotNull(fulfillmentPolicyVersions.securityAttestedAt),
          isNotNull(fulfillmentPolicyVersions.operationsAttestedAt),
          isNotNull(fulfillmentPolicyVersions.attestedByAdminUserId),
          isNotNull(fulfillmentPolicyVersions.attestationEvidenceReference),
          lte(fulfillmentPolicyVersions.effectiveAt, now),
          isNull(fulfillmentPolicyVersions.supersededAt),
        ),
        orderBy: (table, { desc }) => [desc(table.effectiveAt)],
      }),
      db.query.productTaxPolicyVersions.findFirst({
        where: and(
          eq(productTaxPolicyVersions.status, "effective"),
          isNotNull(productTaxPolicyVersions.approvedByAdminUserId),
          isNotNull(productTaxPolicyVersions.approvalStepUpAuthenticatedAt),
          isNotNull(productTaxPolicyVersions.approvedAt),
          isNotNull(productTaxPolicyVersions.approvalEvidenceHash),
          isNotNull(productTaxPolicyVersions.approvalEvidenceVersion),
          eq(
            productTaxPolicyVersions.approvalAction,
            "approve_product_tax_policy",
          ),
          sql`${productTaxPolicyVersions.approvalEvidenceHash} ~ '^[0-9a-f]{64}$'`,
          sql`length(trim(${productTaxPolicyVersions.approvalEvidenceVersion})) > 0`,
          sql`length(trim(${productTaxPolicyVersions.evidenceReference})) > 0`,
          lte(
            productTaxPolicyVersions.approvedAt,
            productTaxPolicyVersions.effectiveAt,
          ),
          lte(
            productTaxPolicyVersions.approvalStepUpAuthenticatedAt,
            productTaxPolicyVersions.approvedAt,
          ),
          sql`${productTaxPolicyVersions.approvalStepUpAuthenticatedAt} >= ${productTaxPolicyVersions.approvedAt} - interval '5 minutes'`,
          lte(productTaxPolicyVersions.effectiveAt, now),
          isNull(productTaxPolicyVersions.supersededAt),
        ),
        orderBy: (table, { desc }) => [desc(table.effectiveAt)],
      }),
      db.query.fulfillmentProviderCertifications.findFirst({
        where: and(
          eq(fulfillmentProviderCertifications.provider, "helcim"),
          eq(
            fulfillmentProviderCertifications.environment,
            providerEnvironment,
          ),
          eq(fulfillmentProviderCertifications.scope, "product_payments"),
          configuredHelcimContract
            ? and(
                eq(
                  fulfillmentProviderCertifications.version,
                  configuredHelcimContract.version,
                ),
                eq(
                  fulfillmentProviderCertifications.evidenceReference,
                  configuredHelcimContract.evidenceReference,
                ),
              )
            : sql`false`,
          lte(fulfillmentProviderCertifications.certifiedAt, now),
          gt(fulfillmentProviderCertifications.validUntil, now),
          sql`length(trim(${fulfillmentProviderCertifications.evidenceReference})) > 0`,
          isNull(fulfillmentProviderCertifications.revokedAt),
        ),
      }),
      db.query.manualFulfillmentPolicyVersions.findFirst({
        where: and(
          eq(manualFulfillmentPolicyVersions.status, "effective"),
          isNotNull(manualFulfillmentPolicyVersions.approvedByAdminUserId),
          isNotNull(manualFulfillmentPolicyVersions.evidenceReference),
          isNotNull(manualFulfillmentPolicyVersions.policyTextHash),
          isNotNull(manualFulfillmentPolicyVersions.approvedAt),
          isNotNull(manualFulfillmentPolicyVersions.effectiveAt),
          lte(manualFulfillmentPolicyVersions.effectiveAt, now),
          isNull(manualFulfillmentPolicyVersions.supersededAt),
          sql`length(trim(${manualFulfillmentPolicyVersions.evidenceReference})) > 0`,
          sql`${manualFulfillmentPolicyVersions.policyTextHash} ~ '^[0-9a-f]{64}$'`,
        ),
        orderBy: (table, { desc }) => [desc(table.effectiveAt)],
      }),
    ]);

  if (
    !fulfillmentPolicy ||
    fulfillmentPolicy.attestedByAdminUserId !== configuredOwner?.id
  ) {
    blockers.push("policy_version_not_effective");
  }
  if (!policyHasP10PreCapAmendment(fulfillmentPolicy?.policySnapshot))
    blockers.push("p10_pre_cap_policy_not_effective");
  const taxPolicyApproval = taxPolicy
    ? toProductTaxPolicyApprovalSnapshot(taxPolicy)
    : null;
  if (
    !taxPolicy ||
    !taxPolicyApproval ||
    taxPolicy.approvedByAdminUserId !== configuredOwner?.id ||
    !configuredOwner?.displayName?.trim() ||
    taxPolicy.ownerName.trim() !== configuredOwner.displayName.trim()
  ) {
    blockers.push("product_tax_policy_not_approved");
  }
  if (
    !helcimCertification ||
    !providerCertificationHasOwnerProof(
      helcimCertification,
      configuredOwner?.id ?? null,
    ) ||
    !configuredHelcimContract ||
    !helcimCertificationMatchesConfiguredContract(
      helcimCertification,
      configuredHelcimContract,
      now,
    )
  ) {
    blockers.push("helcim_not_certified");
  }

  const policy = policyRow
    ? toManualCheckoutPolicyApproval(policyRow, configuredOwner?.id ?? null)
    : null;
  if (!policy) blockers.push("manual_policy_not_approved");

  return {
    ready: blockers.length === 0,
    blockers,
    policy,
    policyVersion: policy?.version ?? null,
    fulfillmentPolicyVersion: fulfillmentPolicy?.version ?? null,
    taxPolicyVersion: taxPolicy?.version ?? null,
    taxPolicyApproval,
  };
}

export async function assertCheckoutReadiness(input: {
  destinationCountryCode: "CA" | "US";
}): Promise<CheckoutReadinessResult> {
  const result = await evaluateCheckoutReadiness(input);
  if (!result.ready) throw new CheckoutNotReadyError(result.blockers);
  return result;
}

export class CheckoutNotReadyError extends Error {
  constructor(readonly blockers: string[]) {
    super("Product checkout is not operationally ready");
    this.name = "CheckoutNotReadyError";
  }
}

function toProductTaxPolicyApprovalSnapshot(
  policy: typeof productTaxPolicyVersions.$inferSelect,
): ProductTaxPolicyApprovalSnapshot | null {
  const stepUp = policy.approvalStepUpAuthenticatedAt;
  if (
    policy.status !== "effective" ||
    !policy.approvedByAdminUserId ||
    !stepUp ||
    !policy.approvedAt ||
    stepUp > policy.approvedAt ||
    stepUp < new Date(policy.approvedAt.getTime() - 5 * 60_000) ||
    !policy.effectiveAt ||
    policy.effectiveAt < policy.approvedAt ||
    policy.supersededAt ||
    !policy.evidenceReference.trim() ||
    !/^[0-9a-f]{64}$/.test(policy.approvalEvidenceHash ?? "") ||
    !policy.approvalEvidenceVersion?.trim() ||
    policy.approvalAction !== "approve_product_tax_policy" ||
    !taxCoverageComplete(policy.coverage)
  ) {
    return null;
  }
  return {
    version: policy.version,
    coverage: policy.coverage,
    ownerName: policy.ownerName,
    approvedByAdminUserId: policy.approvedByAdminUserId,
    approvalStepUpAuthenticatedAt: stepUp.toISOString(),
    evidenceReference: policy.evidenceReference!,
    approvalEvidenceHash: policy.approvalEvidenceHash!,
    approvalEvidenceVersion: policy.approvalEvidenceVersion!,
    approvalAction: policy.approvalAction!,
    approvedAt: policy.approvedAt.toISOString(),
    effectiveAt: policy.effectiveAt.toISOString(),
  };
}

function toManualCheckoutPolicyApproval(
  policy: typeof manualFulfillmentPolicyVersions.$inferSelect,
  configuredOwnerId: string | null,
): ManualCheckoutPolicyApproval | null {
  const text = cleanReadinessText(policy.policySnapshot.cancellationPolicyText);
  const storedHash = cleanReadinessText(policy.policyTextHash);
  const calculatedHash = text
    ? createHash("sha256").update(text, "utf8").digest("hex")
    : null;
  if (
    policy.status !== "effective" ||
    !configuredOwnerId ||
    policy.approvedByAdminUserId !== configuredOwnerId ||
    !policy.approvedAt ||
    !policy.effectiveAt ||
    policy.effectiveAt < policy.approvedAt ||
    policy.supersededAt ||
    !policy.evidenceReference?.trim() ||
    !text ||
    !storedHash ||
    storedHash !== calculatedHash
  ) {
    return null;
  }
  return {
    version: policy.version,
    text,
    textHash: storedHash,
    evidenceReference: policy.evidenceReference.trim(),
    approvedByAdminUserId: policy.approvedByAdminUserId,
    approvedAt: policy.approvedAt,
    effectiveAt: policy.effectiveAt,
  };
}

function taxCoverageComplete(value: Record<string, boolean>): boolean {
  return [
    "merchandise",
    "shipping",
    "supplements",
    "usOrders",
    "componentRefunds",
  ].every((key) => value[key] === true);
}

function usShippingContractIsCurrent(
  certification: {
    version: string;
    evidenceReference: string;
    certifiedAt: Date;
    validUntil: Date;
    contractSnapshot:
      | FulfillmentProviderCertificationContractSnapshot
      | HelcimProductPaymentsCertificationContractSnapshot
      | null;
  },
  services: Array<{ postageType: string; reviewedAt: Date }>,
  now: Date,
): boolean {
  const snapshot = certification.contractSnapshot;
  if (
    !snapshot ||
    !("importTerms" in snapshot) ||
    snapshot.importTerms !== "DDU" ||
    !snapshot.disclosure?.version?.trim() ||
    !snapshot.disclosure.text?.trim()
  ) {
    return false;
  }
  if (
    snapshot.version !== certification.version ||
    snapshot.evidenceReference !== certification.evidenceReference ||
    snapshot.trackedRequired !== true ||
    snapshot.insuredRequired !== true ||
    !Array.isArray(snapshot.allowedServiceCodes) ||
    snapshot.allowedServiceCodes.length === 0 ||
    snapshot.allowedServiceCodes.some(
      (code) => typeof code !== "string" || code.trim().length === 0,
    ) ||
    services.some(
      (service) => !snapshot.allowedServiceCodes.includes(service.postageType),
    )
  ) {
    return false;
  }
  const tariffFields = snapshot.tariffMetadataSchema?.fields;
  if (
    !snapshot.tariffMetadataSchema?.version?.trim() ||
    snapshot.tariffMetadataSchema.additionalTariffDetails !==
      "required_when_applicable" ||
    !Array.isArray(tariffFields) ||
    tariffFields.length !== 3 ||
    !["steel", "copper", "aluminum"].every((field) =>
      tariffFields.includes(field as "steel" | "copper" | "aluminum"),
    ) ||
    !snapshot.fdaRequirements?.version?.trim() ||
    snapshot.fdaRequirements.mode !== "required_when_applicable"
  ) {
    return false;
  }
  const effectiveUntil = new Date(snapshot.effectiveUntil);
  return (
    providerContractWindowIsActive(
      snapshot.effectiveFrom,
      snapshot.effectiveUntil,
      now,
    ) &&
    certification.certifiedAt <= now &&
    providerCertificationWindowAcceptsEvidence(
      snapshot.effectiveFrom,
      snapshot.effectiveUntil,
      certification.certifiedAt,
    ) &&
    effectiveUntil.getTime() === certification.validUntil.getTime()
  );
}

function canonicalHttpsOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isStrongSecret(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return Buffer.byteLength(normalized) >= 32 && new Set(normalized).size >= 12;
}

function addFinancialRuntimeBlockers(
  blockers: string[],
  env: NodeJS.ProcessEnv,
): void {
  if (!isStrongSecret(env.CRON_SECRET)) {
    blockers.push("secret_invalid:CRON_SECRET");
  }
  for (const name of [
    "CHECKOUT_SECRET_ENCRYPTION_KEY",
    "CHECKOUT_PII_ENCRYPTION_KEY",
  ] as const) {
    if (!isBase64EncryptionKey(env[name])) {
      blockers.push(`secret_invalid:${name}`);
    }
  }
  for (const name of [
    "HELCIM_GENERAL_API_TOKEN",
    "HELCIM_TRANSACTION_API_TOKEN",
  ] as const) {
    if (!isProviderToken(env[name])) {
      blockers.push(`provider_token_invalid:${name}`);
    }
  }
}

function parseConfiguredHelcimContract(
  env: NodeJS.ProcessEnv,
): HelcimProductPaymentsCertificationContractSnapshot | null {
  const raw = env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON?.trim();
  if (!raw) return null;
  try {
    return parseHelcimProductPaymentsContract(JSON.parse(raw));
  } catch {
    return null;
  }
}

function helcimCertificationMatchesConfiguredContract(
  certification: {
    version: string;
    evidenceReference: string;
    certifiedAt: Date;
    validUntil: Date;
    contractSnapshot:
      | FulfillmentProviderCertificationContractSnapshot
      | HelcimProductPaymentsCertificationContractSnapshot
      | null;
  },
  configured: HelcimProductPaymentsCertificationContractSnapshot,
  now: Date,
): boolean {
  const snapshot = parseHelcimProductPaymentsContract(
    certification.contractSnapshot,
  );
  if (
    !snapshot ||
    certification.version !== configured.version ||
    certification.evidenceReference !== configured.evidenceReference ||
    stableReadinessJson(snapshot) !== stableReadinessJson(configured) ||
    !helcimContractIsEffective(snapshot, now)
  ) {
    return false;
  }
  const effectiveUntil = new Date(snapshot.effectiveUntil);
  return (
    certification.certifiedAt <= now &&
    providerCertificationWindowAcceptsEvidence(
      snapshot.effectiveFrom,
      snapshot.effectiveUntil,
      certification.certifiedAt,
    ) &&
    certification.validUntil.getTime() === effectiveUntil.getTime()
  );
}

function stableReadinessJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableReadinessJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableReadinessJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isBase64EncryptionKey(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function isProviderToken(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && !/\s/.test(normalized);
}

function cleanReadinessText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

function isConfiguredOwnerEmail(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = new Set(
    (env.ADMIN_OWNER_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return configured.has(email.trim().toLowerCase());
}

function configuredOwnerEmailList(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...new Set(
      (env.ADMIN_OWNER_EMAILS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function policyHasP10PreCapAmendment(
  snapshot: Record<string, unknown> | undefined,
): boolean {
  return (
    snapshot?.p10TerminationNoticeDays === 350 &&
    snapshot.p10DefaultExecutionDays === 360 &&
    snapshot.p10HardCapDays === 365
  );
}

function providerCertificationHasOwnerProof(
  certification: {
    certifiedAt: Date;
    certifiedByAdminUserId: string | null;
    certificationStepUpAuthenticatedAt: Date | null;
    certificationEvidenceHash: string | null;
    certificationEvidenceVersion: string | null;
    certificationAction: string | null;
  },
  configuredOwnerId: string | null,
): boolean {
  const stepUp = certification.certificationStepUpAuthenticatedAt;
  return Boolean(
    configuredOwnerId &&
    certification.certifiedByAdminUserId === configuredOwnerId &&
    stepUp &&
    stepUp <= certification.certifiedAt &&
    stepUp >= new Date(certification.certifiedAt.getTime() - 5 * 60_000) &&
    /^[0-9a-f]{64}$/.test(certification.certificationEvidenceHash ?? "") &&
    certification.certificationEvidenceVersion?.trim() &&
    certification.certificationAction === "certify_fulfillment_provider",
  );
}
