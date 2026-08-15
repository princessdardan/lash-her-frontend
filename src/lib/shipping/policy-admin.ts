import "server-only";

import { createHash } from "node:crypto";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import {
  adminUsers,
  fulfillmentPolicyVersions,
  fulfillmentProviderCertifications,
  shippingCalendarExceptions,
  shippingCalendarVersions,
  shippingPolicyAssignments,
  shippingPolicySettings,
  shippingServicePolicies,
  type FulfillmentProviderCertificationContractSnapshot,
  type HelcimProductPaymentsCertificationContractSnapshot,
  type ShippingPolicyDuty,
} from "@/lib/private-db/schema";
import { calendarCoverageComplete } from "./calendar-validation";
import { getConfiguredHelcimProductPaymentsContract } from "@/lib/commerce/helcim-certified-contract";
import {
  assertConfiguredFulfillmentOwnerInTransaction,
  assertConfiguredOwnerIdentityInTransaction,
} from "./configured-owner";

export async function getFulfillmentPolicyDraftReview(version: string) {
  const [draft] = await getPrivateDb()
    .select({
      id: fulfillmentPolicyVersions.id,
      policySnapshot: fulfillmentPolicyVersions.policySnapshot,
      status: fulfillmentPolicyVersions.status,
      version: fulfillmentPolicyVersions.version,
    })
    .from(fulfillmentPolicyVersions)
    .where(eq(fulfillmentPolicyVersions.version, version.trim()))
    .limit(1);
  if (!draft || draft.status !== "draft")
    throw new Error("Fulfillment policy draft was not found");
  return {
    ...draft,
    snapshotHash: createAdminStepUpTarget(draft.policySnapshot),
  };
}

export async function getCalendarActivationReview(input: {
  coverageEndsOn: string;
  coverageStartsOn: string;
}) {
  const closures = await getPrivateDb()
    .select({
      date: shippingCalendarExceptions.exceptionDate,
      kind: shippingCalendarExceptions.kind,
      label: shippingCalendarExceptions.label,
    })
    .from(shippingCalendarExceptions)
    .where(
      and(
        gte(shippingCalendarExceptions.exceptionDate, input.coverageStartsOn),
        lte(shippingCalendarExceptions.exceptionDate, input.coverageEndsOn),
      ),
    )
    .orderBy(
      shippingCalendarExceptions.exceptionDate,
      shippingCalendarExceptions.kind,
      shippingCalendarExceptions.id,
    );
  return {
    closures,
    snapshotHash: createAdminStepUpTarget(closures),
  };
}

export async function activateShippingCalendarVersion(input: {
  actorAdminUserId: string;
  version: string;
  coverageStartsOn: string;
  coverageEndsOn: string;
  timezone?: string;
  evidenceReference: string;
  expectedClosureSnapshotHash: string;
  expectedCurrentEffectiveId?: string;
  stepUpAuthenticatedAt: Date;
}) {
  const now = new Date();
  assertFreshStepUp(input.stepUpAuthenticatedAt, now);
  const timezone = input.timezone?.trim() || "America/Toronto";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.coverageStartsOn) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.coverageEndsOn) ||
    input.coverageEndsOn < input.coverageStartsOn ||
    input.version.trim().length < 3 ||
    timezone !== "America/Toronto" ||
    input.evidenceReference.trim().length < 6
  )
    throw new Error("Calendar activation evidence or coverage is invalid");
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    await tx.execute(
      sql`lock table shipping_calendar_exceptions in share mode`,
    );
    const [current] = await tx
      .select({ id: shippingCalendarVersions.id })
      .from(shippingCalendarVersions)
      .where(eq(shippingCalendarVersions.status, "effective"))
      .for("update")
      .limit(1);
    assertExpectedCurrentId(
      current?.id,
      input.expectedCurrentEffectiveId,
      "calendar",
    );
    const closures = await tx
      .select({
        date: shippingCalendarExceptions.exceptionDate,
        kind: shippingCalendarExceptions.kind,
        label: shippingCalendarExceptions.label,
      })
      .from(shippingCalendarExceptions)
      .where(
        and(
          gte(shippingCalendarExceptions.exceptionDate, input.coverageStartsOn),
          lte(shippingCalendarExceptions.exceptionDate, input.coverageEndsOn),
        ),
      )
      .orderBy(
        shippingCalendarExceptions.exceptionDate,
        shippingCalendarExceptions.kind,
        shippingCalendarExceptions.id,
      );
    if (
      createAdminStepUpTarget(closures) !== input.expectedClosureSnapshotHash
    ) {
      throw new Error(
        "Calendar closures changed; refresh and review the full snapshot",
      );
    }
    if (!closures.length)
      throw new Error(
        "Calendar activation requires a non-empty closure snapshot",
      );
    if (
      !calendarCoverageComplete(
        {
          coverageStartsOn: input.coverageStartsOn,
          coverageEndsOn: input.coverageEndsOn,
          closureDates: closures,
        },
        now,
      )
    )
      throw new Error(
        "Calendar activation requires 21 complete months of exact Ontario statutory/observed dates and reviewed branch closures",
      );
    await tx
      .update(shippingCalendarVersions)
      .set({
        status: "superseded",
        supersededAt: now,
      })
      .where(eq(shippingCalendarVersions.status, "effective"));
    const [created] = await tx
      .insert(shippingCalendarVersions)
      .values({
        version: input.version.trim(),
        status: "effective",
        timezone,
        coverageStartsOn: input.coverageStartsOn,
        coverageEndsOn: input.coverageEndsOn,
        closureDates: closures,
        evidenceReference: input.evidenceReference.trim(),
        attestedByAdminUserId: input.actorAdminUserId,
        attestedAt: now,
        effectiveAt: now,
      })
      .returning();
    return created!;
  });
}

export async function activateFulfillmentPolicyVersion(input: {
  actorAdminUserId: string;
  version: string;
  evidenceReference: string;
  expectedCurrentEffectiveId?: string;
  expectedPolicySnapshotHash: string;
  stepUpAuthenticatedAt: Date;
}) {
  const now = new Date();
  assertFreshStepUp(input.stepUpAuthenticatedAt, now);
  if (!input.version.trim() || input.evidenceReference.trim().length < 6)
    throw new Error("Fulfillment policy activation evidence is invalid");
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [draft] = await tx
      .select()
      .from(fulfillmentPolicyVersions)
      .where(
        and(
          eq(fulfillmentPolicyVersions.version, input.version.trim()),
          eq(fulfillmentPolicyVersions.status, "draft"),
        ),
      )
      .for("update")
      .limit(1);
    if (!draft) throw new Error("Fulfillment policy draft was not found");
    if (
      createAdminStepUpTarget(draft.policySnapshot) !==
      input.expectedPolicySnapshotHash
    ) {
      throw new Error(
        "Fulfillment policy draft changed; refresh and review it again",
      );
    }
    const [current] = await tx
      .select({ id: fulfillmentPolicyVersions.id })
      .from(fulfillmentPolicyVersions)
      .where(eq(fulfillmentPolicyVersions.status, "effective"))
      .for("update")
      .limit(1);
    assertExpectedCurrentId(
      current?.id,
      input.expectedCurrentEffectiveId,
      "fulfillment policy",
    );
    await tx
      .update(fulfillmentPolicyVersions)
      .set({ status: "superseded", supersededAt: now })
      .where(eq(fulfillmentPolicyVersions.status, "effective"));
    const [activated] = await tx
      .update(fulfillmentPolicyVersions)
      .set({
        status: "effective",
        privacyLegalAttestedAt: now,
        securityAttestedAt: now,
        operationsAttestedAt: now,
        attestationEvidenceReference: input.evidenceReference.trim(),
        attestedByAdminUserId: input.actorAdminUserId,
        effectiveAt: now,
        supersededAt: null,
      })
      .where(
        and(
          eq(fulfillmentPolicyVersions.id, draft.id),
          eq(fulfillmentPolicyVersions.status, "draft"),
        ),
      )
      .returning();
    if (!activated) throw new Error("Fulfillment policy activation raced");
    const [settings] = await tx
      .update(shippingPolicySettings)
      .set({ policyVersion: activated.version, updatedAt: now })
      .where(eq(shippingPolicySettings.singletonKey, "default"))
      .returning({ singletonKey: shippingPolicySettings.singletonKey });
    if (!settings)
      throw new Error("Shipping policy settings must exist before activation");
    return activated;
  });
}

export async function certifyFulfillmentProvider(
  input: {
    actorAdminUserId: string;
    provider: "helcim" | "chitchats";
    environment: "staging" | "production";
    scope: string;
    version: string;
    evidenceReference: string;
    contractSnapshot?: Record<string, unknown>;
    validUntil: Date;
    stepUpAuthenticatedAt: Date;
  },
  dependencies: { now?: Date } = {},
) {
  const now = dependencies.now ?? new Date();
  assertFreshStepUp(input.stepUpAuthenticatedAt, now);
  return getPrivateDb().transaction(async (tx) => {
    const owner = await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const configuredHelcim =
      input.provider === "helcim"
        ? getConfiguredHelcimProductPaymentsContract()
        : null;
    if (input.provider === "helcim" && !configuredHelcim)
      throw new Error("The certified Helcim contract is not configured");
    if (
      input.provider === "helcim" &&
      configuredHelcim &&
      (input.scope.trim() !== "product_payments" ||
        input.version.trim() !== configuredHelcim.version ||
        input.evidenceReference.trim() !== configuredHelcim.evidenceReference ||
        input.validUntil.getTime() !==
          new Date(configuredHelcim.effectiveUntil).getTime() ||
        createAdminStepUpTarget(input.contractSnapshot) !==
          createAdminStepUpTarget(configuredHelcim))
    ) {
      throw new Error(
        "Submitted Helcim certification must exactly match the configured contract",
      );
    }
    const version = configuredHelcim?.version ?? input.version.trim();
    const evidenceReference =
      configuredHelcim?.evidenceReference ?? input.evidenceReference.trim();
    const contractSnapshot = configuredHelcim ?? input.contractSnapshot ?? null;
    const validUntil = configuredHelcim
      ? new Date(configuredHelcim.effectiveUntil)
      : input.validUntil;
    const snapshotEffectiveFrom = readContractTimestamp(
      contractSnapshot,
      "effectiveFrom",
    );
    const snapshotEffectiveUntil = readContractTimestamp(
      contractSnapshot,
      "effectiveUntil",
    );
    const scope = input.scope.trim();
    if (
      (input.provider === "helcim" && scope !== "product_payments") ||
      (input.provider === "chitchats" &&
        scope !== "canada" &&
        scope !== "us_shipping_contract")
    ) {
      throw new Error("Provider certification scope is invalid");
    }
    if (
      input.provider === "chitchats" &&
      scope === "us_shipping_contract" &&
      (!contractSnapshot ||
        !snapshotEffectiveFrom ||
        !snapshotEffectiveUntil ||
        contractSnapshot.version !== version ||
        contractSnapshot.evidenceReference !== evidenceReference)
    ) {
      throw new Error(
        "U.S. Chit Chats certification must match a complete contract evidence window",
      );
    }
    if (
      snapshotEffectiveUntil &&
      snapshotEffectiveUntil.getTime() !== validUntil.getTime()
    ) {
      throw new Error(
        "Provider certification validity must match the contract evidence window",
      );
    }
    if (
      !scope ||
      !version ||
      evidenceReference.length < 6 ||
      !providerCertificationWindowAcceptsEvidence(
        snapshotEffectiveFrom ?? now,
        snapshotEffectiveUntil ?? validUntil,
        now,
      )
    )
      throw new Error("Provider certification evidence or validity is invalid");
    const evidence = {
      action: "certify_fulfillment_provider",
      actorAdminUserId: owner.id,
      provider: input.provider,
      environment: input.environment,
      scope,
      version,
      evidenceReference,
      contractSnapshot,
      certifiedAt: now.toISOString(),
      validUntil: validUntil.toISOString(),
    };
    await tx
      .update(fulfillmentProviderCertifications)
      .set({ revokedAt: now })
      .where(
        and(
          eq(fulfillmentProviderCertifications.provider, input.provider),
          eq(fulfillmentProviderCertifications.environment, input.environment),
          eq(fulfillmentProviderCertifications.scope, scope),
          sql`${fulfillmentProviderCertifications.revokedAt} IS NULL`,
        ),
      );
    const [created] = await tx
      .insert(fulfillmentProviderCertifications)
      .values({
        provider: input.provider,
        environment: input.environment,
        scope,
        version,
        evidenceReference,
        contractSnapshot: contractSnapshot as
          | FulfillmentProviderCertificationContractSnapshot
          | HelcimProductPaymentsCertificationContractSnapshot
          | null,
        certifiedByOwnerName: owner.displayName?.trim() || owner.email,
        certifiedByAdminUserId: owner.id,
        certificationStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
        certificationEvidenceHash: createHash("sha256")
          .update(JSON.stringify(evidence), "utf8")
          .digest("hex"),
        certificationEvidenceVersion: "provider-certification/v1",
        certificationAction: "certify_fulfillment_provider",
        certifiedAt: now,
        validUntil,
      })
      .returning();
    return created!;
  });
}

export async function revokeFulfillmentProviderCertification(input: {
  actorAdminUserId: string;
  certificationId: string;
  expectedValidUntil: Date;
  reason: string;
  stepUpAuthenticatedAt: Date;
}) {
  const now = new Date();
  assertFreshStepUp(input.stepUpAuthenticatedAt, now);
  const reason = input.reason.trim();
  if (
    !input.certificationId.trim() ||
    !Number.isFinite(input.expectedValidUntil.getTime()) ||
    reason.length < 10 ||
    reason.length > 1_000
  ) {
    throw new Error("Provider certification revocation evidence is invalid");
  }
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [revoked] = await tx
      .update(fulfillmentProviderCertifications)
      .set({ revokedAt: now })
      .where(
        and(
          eq(fulfillmentProviderCertifications.id, input.certificationId),
          eq(
            fulfillmentProviderCertifications.validUntil,
            input.expectedValidUntil,
          ),
          sql`${fulfillmentProviderCertifications.revokedAt} IS NULL`,
        ),
      )
      .returning();
    if (!revoked) {
      throw new Error(
        "Provider certification changed; refresh before revoking it",
      );
    }
    return { ...revoked, revocationReason: reason };
  });
}

function readContractTimestamp(
  snapshot: object | null,
  field: "effectiveFrom" | "effectiveUntil",
): Date | null {
  const value = snapshot
    ? (snapshot as Record<string, unknown>)[field]
    : undefined;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function providerCertificationWindowAcceptsEvidence(
  effectiveFrom: string | Date,
  effectiveUntil: string | Date,
  certifiedAt: Date,
): boolean {
  const startsAt = new Date(effectiveFrom);
  const endsAt = new Date(effectiveUntil);
  return (
    Number.isFinite(startsAt.getTime()) &&
    Number.isFinite(endsAt.getTime()) &&
    startsAt < endsAt &&
    Number.isFinite(certifiedAt.getTime()) &&
    certifiedAt < endsAt
  );
}

export function providerContractWindowIsActive(
  effectiveFrom: string | Date,
  effectiveUntil: string | Date,
  now: Date,
): boolean {
  const startsAt = new Date(effectiveFrom);
  const endsAt = new Date(effectiveUntil);
  return (
    Number.isFinite(startsAt.getTime()) &&
    Number.isFinite(endsAt.getTime()) &&
    startsAt < endsAt &&
    Number.isFinite(now.getTime()) &&
    startsAt <= now &&
    now < endsAt
  );
}

function assertFreshStepUp(authenticatedAt: Date, now: Date): void {
  if (
    !Number.isFinite(authenticatedAt.getTime()) ||
    authenticatedAt > now ||
    now.getTime() - authenticatedAt.getTime() > 5 * 60_000
  )
    throw new Error("Recent step-up authentication is required");
}

function assertExpectedCurrentId(
  currentId: string | undefined,
  expectedId: string | undefined,
  label: string,
): void {
  if ((currentId ?? "") !== (expectedId?.trim() ?? "")) {
    throw new Error(`The effective ${label} changed; refresh before retrying`);
  }
}

export async function assignShippingPolicyDuty(input: {
  actorAdminUserId: string;
  adminUserId: string;
  duty: ShippingPolicyDuty;
  stepUpAuthenticatedAt: Date;
}) {
  assertFreshStepUp(input.stepUpAuthenticatedAt, new Date());
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredOwnerIdentityInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [actor] = await tx
      .select({ role: adminUsers.role })
      .from(adminUsers)
      .where(eq(adminUsers.id, input.actorAdminUserId))
      .limit(1);
    const [assignee] = await tx
      .select({ id: adminUsers.id, role: adminUsers.role })
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.id, input.adminUserId),
          eq(adminUsers.status, "active"),
        ),
      )
      .limit(1);
    if (
      actor?.role !== "owner" ||
      !assignee ||
      assignee.role !== "owner" ||
      input.actorAdminUserId !== input.adminUserId
    )
      throw new Error(
        "The active Business Owner must self-assign policy roles",
      );
    await tx
      .update(shippingPolicyAssignments)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(shippingPolicyAssignments.duty, input.duty),
          eq(shippingPolicyAssignments.active, true),
        ),
      );
    const [created] = await tx
      .insert(shippingPolicyAssignments)
      .values({
        duty: input.duty,
        adminUserId: input.adminUserId,
        assignedByAdminUserId: input.actorAdminUserId,
      })
      .returning();
    return created!;
  });
}

export async function upsertShippingCalendarException(input: {
  actorAdminUserId: string;
  exceptionDate: string;
  expectedUpdatedAt?: Date;
  id?: string;
  kind: "ontario_holiday" | "branch_closure";
  label: string;
  stepUpAuthenticatedAt: Date;
}): Promise<void> {
  const now = new Date();
  assertFreshStepUp(input.stepUpAuthenticatedAt, now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.exceptionDate) || !input.label.trim())
    throw new Error("Calendar exception is invalid");
  await getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    if (input.label.trim().length > 160) {
      throw new Error("Calendar exception label is too long");
    }
    if (input.id) {
      if (
        !input.expectedUpdatedAt ||
        !Number.isFinite(input.expectedUpdatedAt.getTime())
      ) {
        throw new Error("Calendar exception conflict token is required");
      }
      const [updated] = await tx
        .update(shippingCalendarExceptions)
        .set({ label: input.label.trim(), updatedAt: now })
        .where(
          and(
            eq(shippingCalendarExceptions.id, input.id),
            eq(shippingCalendarExceptions.exceptionDate, input.exceptionDate),
            eq(shippingCalendarExceptions.kind, input.kind),
            eq(shippingCalendarExceptions.updatedAt, input.expectedUpdatedAt),
          ),
        )
        .returning({ id: shippingCalendarExceptions.id });
      if (!updated)
        throw new Error("Calendar exception changed; refresh before retrying");
      return;
    }
    if (input.expectedUpdatedAt) {
      throw new Error(
        "Calendar exception identity changed; refresh before retrying",
      );
    }
    await tx.insert(shippingCalendarExceptions).values({
      exceptionDate: input.exceptionDate,
      kind: input.kind,
      label: input.label.trim(),
      createdByAdminUserId: input.actorAdminUserId,
    });
  });
}

export async function removeShippingCalendarException(input: {
  actorAdminUserId: string;
  expectedUpdatedAt: Date;
  id: string;
  stepUpAuthenticatedAt: Date;
}) {
  const now = new Date();
  assertFreshStepUp(input.stepUpAuthenticatedAt, now);
  if (!input.id.trim() || !Number.isFinite(input.expectedUpdatedAt.getTime())) {
    throw new Error("Calendar exception conflict token is invalid");
  }
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [removed] = await tx
      .delete(shippingCalendarExceptions)
      .where(
        and(
          eq(shippingCalendarExceptions.id, input.id),
          eq(shippingCalendarExceptions.updatedAt, input.expectedUpdatedAt),
        ),
      )
      .returning();
    if (!removed)
      throw new Error("Calendar exception changed; refresh before removing it");
    return removed;
  });
}

export async function upsertShippingServicePolicy(input: {
  actorAdminUserId: string;
  postageType: string;
  destinationCountryCode: "CA" | "US";
  trackingRequired: boolean;
  insuranceLimitCents: number;
  signatureCapable: boolean;
  claimWaitingDays: number;
  claimDeadlineDays: number;
  enabled: boolean;
  evidenceReference: string;
  expectedUpdatedAt?: Date;
  id?: string;
  stepUpAuthenticatedAt: Date;
}) {
  const now = new Date();
  assertFreshStepUp(input.stepUpAuthenticatedAt, now);
  if (
    !input.postageType.trim() ||
    !Number.isInteger(input.insuranceLimitCents) ||
    input.insuranceLimitCents <= 0 ||
    !Number.isInteger(input.claimWaitingDays) ||
    input.claimWaitingDays < 0 ||
    !Number.isInteger(input.claimDeadlineDays) ||
    input.claimDeadlineDays <= input.claimWaitingDays ||
    input.evidenceReference.trim().length < 6
  )
    throw new Error("Service policy is invalid");
  return getPrivateDb().transaction(async (tx) => {
    const owner = await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const postageType = input.postageType.trim();
    const evidenceReference = input.evidenceReference.trim();
    const evidence = {
      action: "approve_shipping_service_policy",
      actorAdminUserId: owner.id,
      postageType,
      destinationCountryCode: input.destinationCountryCode,
      trackingRequired: input.trackingRequired,
      insuranceLimitCents: input.insuranceLimitCents,
      signatureCapable: input.signatureCapable,
      claimWaitingDays: input.claimWaitingDays,
      claimDeadlineDays: input.claimDeadlineDays,
      enabled: input.enabled,
      evidenceReference,
      reviewedAt: now.toISOString(),
    };
    const proof = {
      reviewedAt: now,
      reviewedByAdminUserId: owner.id,
      reviewStepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      evidenceReference,
      reviewEvidenceHash: createHash("sha256")
        .update(JSON.stringify(evidence), "utf8")
        .digest("hex"),
      reviewEvidenceVersion: "service-policy-review/v1",
      reviewAction: "approve_shipping_service_policy",
    };
    const [current] = input.id
      ? await tx
          .select({
            destinationCountryCode:
              shippingServicePolicies.destinationCountryCode,
            id: shippingServicePolicies.id,
            postageType: shippingServicePolicies.postageType,
            updatedAt: shippingServicePolicies.updatedAt,
          })
          .from(shippingServicePolicies)
          .where(eq(shippingServicePolicies.id, input.id))
          .for("update")
          .limit(1)
      : [];
    if (
      current &&
      (!input.expectedUpdatedAt ||
        current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() ||
        current.postageType !== postageType ||
        current.destinationCountryCode !== input.destinationCountryCode)
    ) {
      throw new Error("The service policy changed; refresh before retrying");
    }
    if (!current && (input.id || input.expectedUpdatedAt)) {
      throw new Error(
        "The service policy identity changed; refresh before retrying",
      );
    }
    const serviceValues = {
      trackingRequired: input.trackingRequired,
      insuranceLimitCents: input.insuranceLimitCents,
      signatureCapable: input.signatureCapable,
      claimWaitingDays: input.claimWaitingDays,
      claimDeadlineDays: input.claimDeadlineDays,
      enabled: input.enabled,
      updatedAt: now,
      ...proof,
    };
    const [updated] = current
      ? await tx
          .update(shippingServicePolicies)
          .set(serviceValues)
          .where(
            and(
              eq(shippingServicePolicies.id, current.id),
              eq(shippingServicePolicies.updatedAt, current.updatedAt),
            ),
          )
          .returning()
      : await tx
          .insert(shippingServicePolicies)
          .values({
            postageType,
            destinationCountryCode: input.destinationCountryCode,
            ...serviceValues,
          })
          .returning();
    if (!updated)
      throw new Error("The service policy changed; refresh before retrying");
    return updated!;
  });
}

export async function updateShippingPolicySettings(input: {
  actorAdminUserId: string;
  forwarderPatterns?: string[];
  expectedUpdatedAt: Date;
  pilotStartedAt?: Date;
  stepUpAuthenticatedAt: Date;
}) {
  const now = new Date();
  assertFreshStepUp(input.stepUpAuthenticatedAt, now);
  if (!Number.isFinite(input.expectedUpdatedAt.getTime()))
    throw new Error("Shipping policy settings conflict token is invalid");
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [updated] = await tx
      .update(shippingPolicySettings)
      .set({
        ...(input.forwarderPatterns
          ? {
              forwarderPatterns: input.forwarderPatterns
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean)
                .slice(0, 200),
            }
          : {}),
        ...(input.pilotStartedAt
          ? { pilotStartedAt: input.pilotStartedAt }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(shippingPolicySettings.singletonKey, "default"),
          eq(shippingPolicySettings.updatedAt, input.expectedUpdatedAt),
        ),
      )
      .returning();
    if (!updated)
      throw new Error(
        "Shipping policy settings changed; refresh before retrying",
      );
    return updated;
  });
}
