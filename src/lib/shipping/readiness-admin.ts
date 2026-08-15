import "server-only";

import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { getConfiguredHelcimProductPaymentsContract } from "@/lib/commerce/helcim-certified-contract";
import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import {
  fulfillmentPolicyVersions,
  fulfillmentProviderCertifications,
  manualFulfillmentPolicyVersions,
  productTaxPolicyVersions,
  shippingCalendarExceptions,
  shippingCalendarVersions,
  shippingFundingReviews,
  shippingPackageProfiles,
  shippingPolicyAssignments,
  shippingPolicySettings,
  shippingServicePolicies,
} from "@/lib/private-db/schema";

import { assertConfiguredFulfillmentOwnerInTransaction } from "./configured-owner";

const OWNER_PROOF_WINDOW_MS = 5 * 60_000;
const PACKAGE_REVIEW_EVIDENCE_VERSION = "shipping-package-profile/v1";
const TAX_APPROVAL_EVIDENCE_VERSION = "product-tax-policy/v1";
const MANUAL_APPROVAL_EVIDENCE_VERSION = "manual-fulfillment-policy/v1";

type PrivateDbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export interface ReadinessAdminState {
  calendarExceptions: Array<{
    exceptionDate: string;
    id: string;
    kind: string;
    label: string;
    updatedAt: Date;
  }>;
  calendarVersions: Array<{
    coverageEndsOn: string;
    coverageStartsOn: string;
    createdAt: Date;
    effectiveAt: Date | null;
    evidenceReference: string | null;
    id: string;
    status: string;
    timezone: string;
    version: string;
  }>;
  fulfillmentPolicies: Array<{
    createdAt: Date;
    effectiveAt: Date | null;
    evidenceReference: string | null;
    id: string;
    policySnapshot: Record<string, unknown>;
    snapshotHash: string;
    status: string;
    version: string;
  }>;
  fundingReviews: Array<{
    balanceCents: number | null;
    calculatedFiveBusinessDaySpendCents: number | null;
    calculatedTwoBusinessDaySpendCents: number | null;
    createdAt: Date;
    externalEvidenceReference: string | null;
    id: string;
    kind: string;
    observedAt: Date | null;
    status: string;
    validUntil: Date | null;
  }>;
  helcimContract: ReturnType<typeof getConfiguredHelcimProductPaymentsContract>;
  manualPolicies: Array<{
    approvedAt: Date | null;
    createdAt: Date;
    effectiveAt: Date | null;
    evidenceReference: string | null;
    id: string;
    policyText: string;
    status: string;
    version: string;
  }>;
  packageProfiles: Array<{
    capacityUnits: number;
    enabled: boolean;
    evidenceReference: string | null;
    heightCm: number;
    id: string;
    lengthCm: number;
    maxWeightGrams: number;
    name: string;
    packageType: string;
    rank: number;
    reviewedAt: Date | null;
    slug: string;
    tareWeightGrams: number;
    updatedAt: Date;
    widthCm: number;
  }>;
  policyAssignments: Array<{
    active: boolean;
    adminUserId: string;
    duty: string;
    id: string;
  }>;
  policySettings: {
    forwarderPatterns: string[];
    pilotStartedAt: Date | null;
    policyVersion: string;
    updatedAt: Date;
  } | null;
  providerCertifications: Array<{
    certifiedAt: Date;
    environment: string;
    evidenceReference: string;
    id: string;
    provider: string;
    revokedAt: Date | null;
    scope: string;
    validUntil: Date;
    version: string;
  }>;
  servicePolicies: Array<{
    claimDeadlineDays: number;
    claimWaitingDays: number;
    destinationCountryCode: string;
    enabled: boolean;
    evidenceReference: string | null;
    id: string;
    insuranceLimitCents: number;
    postageType: string;
    reviewedAt: Date;
    signatureCapable: boolean;
    trackingRequired: boolean;
    updatedAt: Date;
  }>;
  taxPolicies: Array<{
    approvedAt: Date | null;
    coverage: Record<string, boolean>;
    createdAt: Date;
    effectiveAt: Date | null;
    evidenceReference: string;
    id: string;
    status: string;
    version: string;
  }>;
}

export async function loadReadinessAdminState(): Promise<ReadinessAdminState> {
  const db = getPrivateDb();
  const [
    packageProfiles,
    taxPolicies,
    manualPolicies,
    policyAssignments,
    calendarExceptions,
    calendarVersions,
    fulfillmentPolicies,
    providerCertifications,
    servicePolicies,
    fundingReviews,
    policySettings,
  ] = await Promise.all([
    db
      .select({
        capacityUnits: shippingPackageProfiles.capacityUnits,
        enabled: shippingPackageProfiles.enabled,
        evidenceReference: shippingPackageProfiles.evidenceReference,
        heightCm: shippingPackageProfiles.heightCm,
        id: shippingPackageProfiles.id,
        lengthCm: shippingPackageProfiles.lengthCm,
        maxWeightGrams: shippingPackageProfiles.maxWeightGrams,
        name: shippingPackageProfiles.name,
        packageType: shippingPackageProfiles.packageType,
        rank: shippingPackageProfiles.rank,
        reviewedAt: shippingPackageProfiles.reviewedAt,
        slug: shippingPackageProfiles.slug,
        tareWeightGrams: shippingPackageProfiles.tareWeightGrams,
        updatedAt: shippingPackageProfiles.updatedAt,
        widthCm: shippingPackageProfiles.widthCm,
      })
      .from(shippingPackageProfiles)
      .orderBy(
        asc(shippingPackageProfiles.rank),
        asc(shippingPackageProfiles.slug),
      ),
    db
      .select({
        approvedAt: productTaxPolicyVersions.approvedAt,
        coverage: productTaxPolicyVersions.coverage,
        createdAt: productTaxPolicyVersions.createdAt,
        effectiveAt: productTaxPolicyVersions.effectiveAt,
        evidenceReference: productTaxPolicyVersions.evidenceReference,
        id: productTaxPolicyVersions.id,
        status: productTaxPolicyVersions.status,
        version: productTaxPolicyVersions.version,
      })
      .from(productTaxPolicyVersions)
      .orderBy(desc(productTaxPolicyVersions.createdAt)),
    db
      .select({
        approvedAt: manualFulfillmentPolicyVersions.approvedAt,
        createdAt: manualFulfillmentPolicyVersions.createdAt,
        effectiveAt: manualFulfillmentPolicyVersions.effectiveAt,
        evidenceReference: manualFulfillmentPolicyVersions.evidenceReference,
        id: manualFulfillmentPolicyVersions.id,
        policySnapshot: manualFulfillmentPolicyVersions.policySnapshot,
        status: manualFulfillmentPolicyVersions.status,
        version: manualFulfillmentPolicyVersions.version,
      })
      .from(manualFulfillmentPolicyVersions)
      .orderBy(desc(manualFulfillmentPolicyVersions.createdAt)),
    db
      .select({
        active: shippingPolicyAssignments.active,
        adminUserId: shippingPolicyAssignments.adminUserId,
        duty: shippingPolicyAssignments.duty,
        id: shippingPolicyAssignments.id,
      })
      .from(shippingPolicyAssignments)
      .orderBy(asc(shippingPolicyAssignments.duty)),
    db
      .select({
        exceptionDate: shippingCalendarExceptions.exceptionDate,
        id: shippingCalendarExceptions.id,
        kind: shippingCalendarExceptions.kind,
        label: shippingCalendarExceptions.label,
        updatedAt: shippingCalendarExceptions.updatedAt,
      })
      .from(shippingCalendarExceptions)
      .orderBy(desc(shippingCalendarExceptions.exceptionDate)),
    db
      .select({
        coverageEndsOn: shippingCalendarVersions.coverageEndsOn,
        coverageStartsOn: shippingCalendarVersions.coverageStartsOn,
        createdAt: shippingCalendarVersions.createdAt,
        effectiveAt: shippingCalendarVersions.effectiveAt,
        evidenceReference: shippingCalendarVersions.evidenceReference,
        id: shippingCalendarVersions.id,
        status: shippingCalendarVersions.status,
        timezone: shippingCalendarVersions.timezone,
        version: shippingCalendarVersions.version,
      })
      .from(shippingCalendarVersions)
      .orderBy(desc(shippingCalendarVersions.createdAt)),
    db
      .select({
        createdAt: fulfillmentPolicyVersions.createdAt,
        effectiveAt: fulfillmentPolicyVersions.effectiveAt,
        evidenceReference:
          fulfillmentPolicyVersions.attestationEvidenceReference,
        id: fulfillmentPolicyVersions.id,
        policySnapshot: fulfillmentPolicyVersions.policySnapshot,
        status: fulfillmentPolicyVersions.status,
        version: fulfillmentPolicyVersions.version,
      })
      .from(fulfillmentPolicyVersions)
      .orderBy(desc(fulfillmentPolicyVersions.createdAt)),
    db
      .select({
        certifiedAt: fulfillmentProviderCertifications.certifiedAt,
        environment: fulfillmentProviderCertifications.environment,
        evidenceReference: fulfillmentProviderCertifications.evidenceReference,
        id: fulfillmentProviderCertifications.id,
        provider: fulfillmentProviderCertifications.provider,
        revokedAt: fulfillmentProviderCertifications.revokedAt,
        scope: fulfillmentProviderCertifications.scope,
        validUntil: fulfillmentProviderCertifications.validUntil,
        version: fulfillmentProviderCertifications.version,
      })
      .from(fulfillmentProviderCertifications)
      .orderBy(desc(fulfillmentProviderCertifications.createdAt)),
    db
      .select({
        claimDeadlineDays: shippingServicePolicies.claimDeadlineDays,
        claimWaitingDays: shippingServicePolicies.claimWaitingDays,
        destinationCountryCode: shippingServicePolicies.destinationCountryCode,
        enabled: shippingServicePolicies.enabled,
        evidenceReference: shippingServicePolicies.evidenceReference,
        id: shippingServicePolicies.id,
        insuranceLimitCents: shippingServicePolicies.insuranceLimitCents,
        postageType: shippingServicePolicies.postageType,
        reviewedAt: shippingServicePolicies.reviewedAt,
        signatureCapable: shippingServicePolicies.signatureCapable,
        trackingRequired: shippingServicePolicies.trackingRequired,
        updatedAt: shippingServicePolicies.updatedAt,
      })
      .from(shippingServicePolicies)
      .orderBy(
        asc(shippingServicePolicies.destinationCountryCode),
        asc(shippingServicePolicies.postageType),
      ),
    db
      .select({
        balanceCents: shippingFundingReviews.balanceCents,
        calculatedFiveBusinessDaySpendCents:
          shippingFundingReviews.calculatedFiveBusinessDaySpendCents,
        calculatedTwoBusinessDaySpendCents:
          shippingFundingReviews.calculatedTwoBusinessDaySpendCents,
        createdAt: shippingFundingReviews.createdAt,
        externalEvidenceReference:
          shippingFundingReviews.externalEvidenceReference,
        id: shippingFundingReviews.id,
        kind: shippingFundingReviews.kind,
        observedAt: shippingFundingReviews.observedAt,
        status: shippingFundingReviews.status,
        validUntil: shippingFundingReviews.validUntil,
      })
      .from(shippingFundingReviews)
      .orderBy(desc(shippingFundingReviews.createdAt))
      .limit(100),
    db.query.shippingPolicySettings.findFirst({
      where: eq(shippingPolicySettings.singletonKey, "default"),
      columns: {
        forwarderPatterns: true,
        pilotStartedAt: true,
        policyVersion: true,
        updatedAt: true,
      },
    }),
  ]);
  return {
    calendarExceptions,
    calendarVersions,
    fulfillmentPolicies: fulfillmentPolicies.map((policy) => ({
      ...policy,
      snapshotHash: createAdminStepUpTarget(policy.policySnapshot),
    })),
    fundingReviews,
    helcimContract: getConfiguredHelcimProductPaymentsContract(),
    packageProfiles,
    policyAssignments,
    policySettings: policySettings ?? null,
    providerCertifications,
    servicePolicies,
    taxPolicies,
    manualPolicies: manualPolicies.map(({ policySnapshot, ...policy }) => ({
      ...policy,
      policyText:
        typeof policySnapshot.cancellationPolicyText === "string"
          ? policySnapshot.cancellationPolicyText
          : "",
    })),
  };
}

export async function saveShippingPackageProfile(input: {
  actorAdminUserId: string;
  capacityUnits: number;
  enabled: boolean;
  evidenceReference: string;
  expectedUpdatedAt?: Date;
  heightCm: number;
  id?: string;
  lengthCm: number;
  maxWeightGrams: number;
  name: string;
  packageType: string;
  rank: number;
  slug: string;
  stepUpAuthenticatedAt: Date;
  tareWeightGrams: number;
  widthCm: number;
}) {
  const now = new Date();
  assertFreshOwnerProof(input.stepUpAuthenticatedAt, now);
  const profile = normalizePackageProfile(input);
  return getPrivateDb().transaction(async (tx) => {
    const owner = await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    await tx.execute(
      sql`lock table shipping_package_profiles in share row exclusive mode`,
    );
    const evidence = ownerEvidenceHash({
      action: "approve_shipping_package_profile",
      actorAdminUserId: owner.id,
      evidenceReference: profile.evidenceReference,
      profile,
      reviewedAt: now.toISOString(),
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt.toISOString(),
    });
    const values = {
      ...profile,
      reviewedAt: now,
      reviewedByAdminUserId: owner.id,
      reviewStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      reviewEvidenceHash: evidence,
      reviewEvidenceVersion: PACKAGE_REVIEW_EVIDENCE_VERSION,
      reviewAction: "approve_shipping_package_profile",
      updatedAt: now,
    };
    if (input.id) {
      if (
        !input.expectedUpdatedAt ||
        !Number.isFinite(input.expectedUpdatedAt.getTime())
      ) {
        throw new Error("The package profile conflict token is required");
      }
      const [updated] = await tx
        .update(shippingPackageProfiles)
        .set(values)
        .where(
          and(
            eq(shippingPackageProfiles.id, input.id),
            eq(shippingPackageProfiles.updatedAt, input.expectedUpdatedAt),
          ),
        )
        .returning();
      if (!updated)
        throw new Error("The package profile changed; refresh before retrying");
      return updated;
    }
    const [created] = await tx
      .insert(shippingPackageProfiles)
      .values(values)
      .returning();
    if (!created) throw new Error("The package profile was not created");
    return created;
  });
}

export async function approveProductTaxPolicy(input: {
  actorAdminUserId: string;
  coverage: Record<string, boolean>;
  evidenceReference: string;
  expectedCurrentEffectiveId?: string;
  stepUpAuthenticatedAt: Date;
  version: string;
}) {
  const now = new Date();
  assertFreshOwnerProof(input.stepUpAuthenticatedAt, now);
  const version = cleanVersion(input.version);
  const evidenceReference = cleanEvidenceReference(input.evidenceReference);
  const coverage = normalizeTaxCoverage(input.coverage);
  return getPrivateDb().transaction(async (tx) => {
    const owner = await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    await tx.execute(
      sql`lock table product_tax_policy_versions in share row exclusive mode`,
    );
    const current = await currentEffectiveTaxPolicy(tx);
    assertExpectedCurrent(current?.id, input.expectedCurrentEffectiveId);
    if (current?.version === version) {
      throw new Error(
        "Create a new tax-policy version instead of rewriting the effective version",
      );
    }
    const [draft] = await tx
      .select({
        id: productTaxPolicyVersions.id,
        status: productTaxPolicyVersions.status,
      })
      .from(productTaxPolicyVersions)
      .where(eq(productTaxPolicyVersions.version, version))
      .for("update")
      .limit(1);
    if (draft && draft.status !== "draft") {
      throw new Error("The tax-policy version is already immutable");
    }
    const evidenceHash = ownerEvidenceHash({
      action: "approve_product_tax_policy",
      actorAdminUserId: owner.id,
      coverage,
      evidenceReference,
      approvedAt: now.toISOString(),
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt.toISOString(),
      version,
    });
    if (current) {
      await tx
        .update(productTaxPolicyVersions)
        .set({ status: "superseded", supersededAt: now })
        .where(
          and(
            eq(productTaxPolicyVersions.id, current.id),
            eq(productTaxPolicyVersions.status, "effective"),
          ),
        );
    }
    const values = {
      status: "effective",
      coverage,
      ownerName: owner.displayName?.trim() || owner.email,
      evidenceReference,
      approvedByAdminUserId: owner.id,
      approvalStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      approvalEvidenceHash: evidenceHash,
      approvalEvidenceVersion: TAX_APPROVAL_EVIDENCE_VERSION,
      approvalAction: "approve_product_tax_policy",
      approvedAt: now,
      effectiveAt: now,
      supersededAt: null,
    } as const;
    const [approved] = draft
      ? await tx
          .update(productTaxPolicyVersions)
          .set(values)
          .where(
            and(
              eq(productTaxPolicyVersions.id, draft.id),
              eq(productTaxPolicyVersions.status, "draft"),
            ),
          )
          .returning()
      : await tx
          .insert(productTaxPolicyVersions)
          .values({ version, ...values })
          .returning();
    if (!approved) throw new Error("The tax policy changed concurrently");
    return approved;
  });
}

export async function approveManualFulfillmentPolicy(input: {
  actorAdminUserId: string;
  cancellationPolicyText: string;
  evidenceReference: string;
  expectedCurrentEffectiveId?: string;
  stepUpAuthenticatedAt: Date;
  version: string;
}) {
  const now = new Date();
  assertFreshOwnerProof(input.stepUpAuthenticatedAt, now);
  const version = cleanVersion(input.version);
  const evidenceReference = cleanEvidenceReference(input.evidenceReference);
  const cancellationPolicyText = input.cancellationPolicyText.trim();
  if (
    cancellationPolicyText.length < 80 ||
    cancellationPolicyText.length > 8_000
  ) {
    throw new Error(
      "The published manual-order policy must be 80 to 8,000 characters",
    );
  }
  const policyTextHash = createHash("sha256")
    .update(cancellationPolicyText, "utf8")
    .digest("hex");
  return getPrivateDb().transaction(async (tx) => {
    const owner = await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    await tx.execute(
      sql`lock table manual_fulfillment_policy_versions in share row exclusive mode`,
    );
    const current = await currentEffectiveManualPolicy(tx);
    assertExpectedCurrent(current?.id, input.expectedCurrentEffectiveId);
    if (current?.version === version) {
      throw new Error(
        "Create a new manual-policy version instead of rewriting the effective version",
      );
    }
    const [draft] = await tx
      .select({
        id: manualFulfillmentPolicyVersions.id,
        status: manualFulfillmentPolicyVersions.status,
      })
      .from(manualFulfillmentPolicyVersions)
      .where(eq(manualFulfillmentPolicyVersions.version, version))
      .for("update")
      .limit(1);
    if (draft && draft.status !== "draft") {
      throw new Error("The manual-policy version is already immutable");
    }
    const evidenceHash = ownerEvidenceHash({
      action: "approve_manual_fulfillment_policy",
      actorAdminUserId: owner.id,
      cancellationPolicyTextHash: policyTextHash,
      evidenceReference,
      approvedAt: now.toISOString(),
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt.toISOString(),
      version,
    });
    if (current) {
      await tx
        .update(manualFulfillmentPolicyVersions)
        .set({ status: "superseded", supersededAt: now })
        .where(
          and(
            eq(manualFulfillmentPolicyVersions.id, current.id),
            eq(manualFulfillmentPolicyVersions.status, "effective"),
          ),
        );
    }
    const values = {
      status: "effective",
      policySnapshot: {
        cancellationPolicyText,
        approvalEvidenceVersion: MANUAL_APPROVAL_EVIDENCE_VERSION,
        approvedAt: now.toISOString(),
      },
      policyTextHash,
      evidenceReference,
      approvedByAdminUserId: owner.id,
      approvalStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      approvalEvidenceHash: evidenceHash,
      approvalEvidenceVersion: MANUAL_APPROVAL_EVIDENCE_VERSION,
      approvalAction: "approve_manual_fulfillment_policy",
      approvedAt: now,
      effectiveAt: now,
      supersededAt: null,
    } as const;
    const [approved] = draft
      ? await tx
          .update(manualFulfillmentPolicyVersions)
          .set(values)
          .where(
            and(
              eq(manualFulfillmentPolicyVersions.id, draft.id),
              eq(manualFulfillmentPolicyVersions.status, "draft"),
            ),
          )
          .returning()
      : await tx
          .insert(manualFulfillmentPolicyVersions)
          .values({ version, ...values })
          .returning();
    if (!approved) throw new Error("The manual policy changed concurrently");
    return approved;
  });
}

function normalizePackageProfile(input: {
  capacityUnits: number;
  enabled: boolean;
  evidenceReference: string;
  heightCm: number;
  lengthCm: number;
  maxWeightGrams: number;
  name: string;
  packageType: string;
  rank: number;
  slug: string;
  tareWeightGrams: number;
  widthCm: number;
}) {
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();
  const packageType = input.packageType.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new Error("Package profile slug is invalid");
  }
  if (name.length < 3 || name.length > 120) {
    throw new Error("Package profile name is invalid");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(packageType) || packageType.length > 60) {
    throw new Error("Provider package type is invalid");
  }
  const positiveFields = [
    input.rank,
    input.lengthCm,
    input.widthCm,
    input.heightCm,
    input.maxWeightGrams,
    input.capacityUnits,
  ];
  if (
    positiveFields.some((value) => !Number.isInteger(value) || value <= 0) ||
    !Number.isInteger(input.tareWeightGrams) ||
    input.tareWeightGrams < 0 ||
    input.tareWeightGrams >= input.maxWeightGrams
  ) {
    throw new Error(
      "Package dimensions, capacity, rank, or weights are invalid",
    );
  }
  return {
    capacityUnits: input.capacityUnits,
    enabled: input.enabled,
    evidenceReference: cleanEvidenceReference(input.evidenceReference),
    heightCm: input.heightCm,
    lengthCm: input.lengthCm,
    maxWeightGrams: input.maxWeightGrams,
    name,
    packageType,
    rank: input.rank,
    slug,
    tareWeightGrams: input.tareWeightGrams,
    widthCm: input.widthCm,
  };
}

function normalizeTaxCoverage(value: Record<string, boolean>) {
  const coverage = {
    merchandise: value.merchandise === true,
    shipping: value.shipping === true,
    supplements: value.supplements === true,
    usOrders: value.usOrders === true,
    componentRefunds: value.componentRefunds === true,
  };
  if (Object.values(coverage).some((covered) => !covered)) {
    throw new Error(
      "Tax policy must cover merchandise, shipping, supplements, U.S. orders, and component refunds",
    );
  }
  return coverage;
}

function cleanVersion(value: string): string {
  const version = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,119}$/.test(version)) {
    throw new Error("Policy version is invalid");
  }
  return version;
}

function cleanEvidenceReference(value: string): string {
  const evidenceReference = value.trim();
  if (evidenceReference.length < 6 || evidenceReference.length > 500) {
    throw new Error(
      "Controlled evidence reference must be 6 to 500 characters",
    );
  }
  return evidenceReference;
}

function assertFreshOwnerProof(stepUpAuthenticatedAt: Date, now: Date): void {
  if (
    !Number.isFinite(stepUpAuthenticatedAt.getTime()) ||
    stepUpAuthenticatedAt > now ||
    now.getTime() - stepUpAuthenticatedAt.getTime() > OWNER_PROOF_WINDOW_MS
  ) {
    throw new Error("Fresh owner step-up authentication is required");
  }
}

async function currentEffectiveTaxPolicy(tx: PrivateDbTransaction) {
  const [current] = await tx
    .select({
      id: productTaxPolicyVersions.id,
      version: productTaxPolicyVersions.version,
    })
    .from(productTaxPolicyVersions)
    .where(eq(productTaxPolicyVersions.status, "effective"))
    .for("update")
    .limit(1);
  return current;
}

async function currentEffectiveManualPolicy(tx: PrivateDbTransaction) {
  const [current] = await tx
    .select({
      id: manualFulfillmentPolicyVersions.id,
      version: manualFulfillmentPolicyVersions.version,
    })
    .from(manualFulfillmentPolicyVersions)
    .where(eq(manualFulfillmentPolicyVersions.status, "effective"))
    .for("update")
    .limit(1);
  return current;
}

function assertExpectedCurrent(
  currentId: string | undefined,
  expectedCurrentId: string | undefined,
): void {
  if ((currentId ?? "") !== (expectedCurrentId?.trim() ?? "")) {
    throw new Error("The effective policy changed; refresh before retrying");
  }
}

function ownerEvidenceHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
