import "server-only";

import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  fulfillmentPolicyVersions,
  fulfillmentProviderCertifications,
  productTaxPolicyVersions,
  shippingCalendarExceptions,
  shippingFundingReviews,
  shippingPackageProfiles,
  shippingPolicyAssignments,
  shippingPolicySettings,
  shippingServicePolicies,
  type ShippingPolicyDuty,
} from "@/lib/private-db/schema";

import { getChitChatsConfig, isChitChatsCheckoutEnabled } from "./config";
import { getShippingPolicyEnforcementMode } from "./policy";

export const REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT = 1786748337233;
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
  taxPolicyVersion: string | null;
}

export async function evaluateCheckoutReadiness(input: {
  destinationCountryCode: "CA" | "US";
  now?: Date;
}): Promise<CheckoutReadinessResult> {
  const now = input.now ?? new Date();
  const blockers: string[] = [];
  if (!isChitChatsCheckoutEnabled()) blockers.push("checkout_flag_disabled");
  if (getShippingPolicyEnforcementMode() !== "enforce") {
    blockers.push("policy_not_enforced");
  }
  const siteOrigin = canonicalHttpsOrigin(process.env.NEXT_PUBLIC_SITE_URL);
  if (!siteOrigin) blockers.push("site_origin_invalid");
  for (const name of [
    "CHITCHATS_QUOTE_SIGNING_SECRET",
    "CHITCHATS_WORKER_CRON_SECRET",
    "SHIPPING_DECISION_TOKEN_SECRET",
    "ADDRESS_CHANGE_TOKEN_SECRET",
  ]) {
    if (!isStrongSecret(process.env[name]))
      blockers.push(`secret_invalid:${name}`);
  }
  if (!process.env.CHITCHATS_BRANCH_ID?.trim())
    blockers.push("branch_not_configured");

  let config: ReturnType<typeof getChitChatsConfig> | null = null;
  try {
    config = getChitChatsConfig();
  } catch {
    blockers.push("chitchats_credentials_invalid");
  }
  if (input.destinationCountryCode === "US" && !config?.usShippingEnabled) {
    blockers.push("us_checkout_disabled");
  }

  const db = getPrivateDb();
  const certificationScope =
    input.destinationCountryCode === "US" ? "us_ddu" : "canada";
  const [
    schemaResult,
    policy,
    taxPolicy,
    assignments,
    packages,
    settings,
    services,
    certifications,
    funding,
    calendarCoverage,
  ] = await Promise.all([
    db.execute<{ created_at: string }>(sql`
      select created_at::text
      from drizzle.__drizzle_migrations
      order by created_at desc nulls last
      limit 1
    `),
    db.query.fulfillmentPolicyVersions.findFirst({
      where: and(
        eq(fulfillmentPolicyVersions.status, "effective"),
        isNotNull(fulfillmentPolicyVersions.privacyLegalAttestedAt),
        isNotNull(fulfillmentPolicyVersions.securityAttestedAt),
        isNotNull(fulfillmentPolicyVersions.operationsAttestedAt),
      ),
      orderBy: (table, { desc }) => [desc(table.effectiveAt)],
    }),
    db.query.productTaxPolicyVersions.findFirst({
      where: and(
        eq(productTaxPolicyVersions.status, "effective"),
        isNotNull(productTaxPolicyVersions.approvedAt),
      ),
      orderBy: (table, { desc }) => [desc(table.effectiveAt)],
    }),
    db
      .select({
        duty: shippingPolicyAssignments.duty,
        adminUserId: shippingPolicyAssignments.adminUserId,
        adminEmail: adminUsers.email,
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
        evidenceReference: shippingPackageProfiles.evidenceReference,
      })
      .from(shippingPackageProfiles)
      .where(eq(shippingPackageProfiles.enabled, true)),
    db.query.shippingPolicySettings.findFirst({
      where: eq(shippingPolicySettings.singletonKey, "default"),
    }),
    db
      .select({
        postageType: shippingServicePolicies.postageType,
        reviewedAt: shippingServicePolicies.reviewedAt,
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
        scope: fulfillmentProviderCertifications.scope,
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
          isNull(fulfillmentProviderCertifications.revokedAt),
        ),
      ),
    db.query.shippingFundingReviews.findFirst({
      where: and(
        eq(shippingFundingReviews.status, "recorded"),
        isNotNull(shippingFundingReviews.externalEvidenceReference),
        gt(shippingFundingReviews.validUntil, now),
      ),
      orderBy: (table, { desc }) => [desc(table.observedAt)],
    }),
    db
      .select({
        coverageThrough: sql<
          string | null
        >`max(${shippingCalendarExceptions.exceptionDate})::text`,
      })
      .from(shippingCalendarExceptions)
      .where(eq(shippingCalendarExceptions.kind, "ontario_holiday")),
  ]);

  const latestMigration = Number(schemaResult.rows[0]?.created_at ?? 0);
  if (latestMigration < REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT) {
    blockers.push("private_schema_outdated");
  }
  if (!policy) blockers.push("policy_version_not_effective");
  if (!taxPolicy || !taxCoverageComplete(taxPolicy.coverage)) {
    blockers.push("product_tax_policy_not_approved");
  }
  if (
    assignments.length !== REQUIRED_DUTIES.length ||
    new Set(assignments.map((item) => item.adminUserId)).size !== 1 ||
    assignments.some(
      (item) => item.adminRole !== "owner" || item.adminStatus !== "active",
    ) ||
    !assignments.every((item) => isConfiguredOwnerEmail(item.adminEmail))
  ) {
    blockers.push("owner_role_assignments_incomplete");
  }
  if (
    !packages.length ||
    packages.some(
      (profile) => !profile.reviewedAt || !profile.evidenceReference?.trim(),
    )
  ) {
    blockers.push("package_profiles_unreviewed");
  }
  if (!settings) blockers.push("shipping_policy_settings_missing");
  if (
    !services.length ||
    services.some(
      (service) =>
        service.reviewedAt < new Date(now.getTime() - 90 * 24 * 60 * 60_000),
    )
  ) {
    blockers.push("service_policy_missing_or_stale");
  }
  if (
    !certifications.some(
      (item) => item.provider === "helcim" && item.scope === "product_payments",
    )
  ) {
    blockers.push("helcim_not_certified");
  }
  if (
    !certifications.some(
      (item) =>
        item.provider === "chitchats" && item.scope === certificationScope,
    )
  ) {
    blockers.push("chitchats_not_certified");
  }
  if (
    !funding ||
    funding.balanceCents === null ||
    funding.calculatedTwoBusinessDaySpendCents === null ||
    funding.balanceCents < funding.calculatedTwoBusinessDaySpendCents
  ) {
    blockers.push("funding_attestation_stale_or_insufficient");
  }
  const coverageThrough = calendarCoverage[0]?.coverageThrough
    ? new Date(`${calendarCoverage[0].coverageThrough}T23:59:59.999Z`)
    : null;
  const requiredCoverage = new Date(now);
  requiredCoverage.setUTCMonth(requiredCoverage.getUTCMonth() + 21);
  if (!coverageThrough || coverageThrough < requiredCoverage) {
    blockers.push("calendar_coverage_below_21_months");
  }

  return {
    ready: blockers.length === 0,
    blockers,
    policyVersion: policy?.version ?? null,
    taxPolicyVersion: taxPolicy?.version ?? null,
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

function taxCoverageComplete(value: Record<string, boolean>): boolean {
  return [
    "merchandise",
    "shipping",
    "supplements",
    "usOrders",
    "componentRefunds",
  ].every((key) => value[key] === true);
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

function isConfiguredOwnerEmail(email: string): boolean {
  const configured = new Set(
    (process.env.ADMIN_OWNER_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return configured.has(email.trim().toLowerCase());
}
