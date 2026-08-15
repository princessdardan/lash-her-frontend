import { NextResponse, type NextRequest } from "next/server";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { getConfiguredHelcimProductPaymentsContract } from "@/lib/commerce/helcim-certified-contract";
import {
  assignShippingPolicyDuty,
  activateFulfillmentPolicyVersion,
  activateShippingCalendarVersion,
  certifyFulfillmentProvider,
  getCalendarActivationReview,
  getFulfillmentPolicyDraftReview,
  removeShippingCalendarException,
  revokeFulfillmentProviderCertification,
  updateShippingPolicySettings,
  upsertShippingCalendarException,
  upsertShippingServicePolicy,
} from "@/lib/shipping/policy-admin";
import { assertShippingPolicyConfigurationMutationAllowed } from "@/lib/shipping/policy";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import {
  normalizeProviderCertificationSubmission,
  policyRouteStepUpScope,
  requireTorontoPolicyTimezone,
} from "./policy-route-contract";

export async function POST(req: NextRequest): Promise<Response> {
  const actor = await requirePermission("settings:manage");
  try {
    await assertConfiguredFulfillmentOwner(actor.user.id);
  } catch {
    return NextResponse.json(
      {
        error:
          "Only the configured fulfillment owner may manage shipping policy",
      },
      { status: 403 },
    );
  }
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  try {
    assertShippingPolicyConfigurationMutationAllowed();
  } catch {
    return NextResponse.json(
      { error: "Policy configuration is read-only in observe mode" },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  try {
    let targetId = "default";
    if (body?.action === "assign_duty") {
      const duty = String(body.duty) as Parameters<
        typeof assignShippingPolicyDuty
      >[0]["duty"];
      const userId = String(body.adminUserId ?? "");
      const assignment = await assignShippingPolicyDuty({
        actorAdminUserId: actor.user.id,
        adminUserId: userId,
        duty,
        stepUpAuthenticatedAt: await requirePolicyStepUp("assign_duty", {
          adminUserId: userId,
          duty,
        }),
      });
      targetId = assignment.id;
    } else if (body?.action === "activate_calendar") {
      const calendarReview = await getCalendarActivationReview({
        coverageEndsOn: String(body.coverageEndsOn ?? ""),
        coverageStartsOn: String(body.coverageStartsOn ?? ""),
      });
      const activated = await activateShippingCalendarVersion({
        actorAdminUserId: actor.user.id,
        version: String(body.version ?? ""),
        coverageStartsOn: String(body.coverageStartsOn ?? ""),
        coverageEndsOn: String(body.coverageEndsOn ?? ""),
        timezone: requireTorontoPolicyTimezone(body.timezone),
        evidenceReference: String(body.evidenceReference ?? ""),
        expectedClosureSnapshotHash: calendarReview.snapshotHash,
        expectedCurrentEffectiveId:
          typeof body.expectedCurrentEffectiveId === "string"
            ? body.expectedCurrentEffectiveId
            : undefined,
        stepUpAuthenticatedAt: await requirePolicyStepUp("activate_calendar", {
          coverageEndsOn: body.coverageEndsOn,
          coverageStartsOn: body.coverageStartsOn,
          evidenceReference: body.evidenceReference,
          expectedClosureSnapshotHash: calendarReview.snapshotHash,
          expectedCurrentEffectiveId: body.expectedCurrentEffectiveId ?? null,
          timezone: body.timezone,
          version: body.version,
        }),
      });
      targetId = activated.id;
    } else if (body?.action === "activate_fulfillment_policy") {
      const policyReview = await getFulfillmentPolicyDraftReview(
        String(body.version ?? ""),
      );
      if (body.expectedPolicySnapshotHash !== policyReview.snapshotHash) {
        throw new Error(
          "Fulfillment policy draft changed; refresh and review it again",
        );
      }
      const activated = await activateFulfillmentPolicyVersion({
        actorAdminUserId: actor.user.id,
        version: String(body.version ?? ""),
        evidenceReference: String(body.evidenceReference ?? ""),
        expectedCurrentEffectiveId:
          typeof body.expectedCurrentEffectiveId === "string"
            ? body.expectedCurrentEffectiveId
            : undefined,
        expectedPolicySnapshotHash: policyReview.snapshotHash,
        stepUpAuthenticatedAt: await requirePolicyStepUp(
          "activate_fulfillment_policy",
          {
            evidenceReference: body.evidenceReference,
            expectedCurrentEffectiveId: body.expectedCurrentEffectiveId ?? null,
            expectedPolicySnapshotHash: policyReview.snapshotHash,
            version: body.version,
          },
        ),
      });
      targetId = activated.id;
    } else if (body?.action === "certify_provider") {
      if (body.provider !== "helcim" && body.provider !== "chitchats") {
        throw new Error("Provider is invalid");
      }
      if (body.environment !== "staging" && body.environment !== "production") {
        throw new Error("Provider environment is invalid");
      }
      const provider = body.provider;
      const configuredHelcim =
        provider === "helcim"
          ? getConfiguredHelcimProductPaymentsContract()
          : null;
      const { contractSnapshot, evidenceReference, validUntil, version } =
        normalizeProviderCertificationSubmission(body, configuredHelcim);
      const certification = await certifyFulfillmentProvider({
        actorAdminUserId: actor.user.id,
        provider,
        environment: body.environment,
        scope: String(body.scope ?? ""),
        version,
        evidenceReference,
        contractSnapshot,
        validUntil: new Date(String(validUntil ?? "")),
        stepUpAuthenticatedAt: await requirePolicyStepUp("certify_provider", {
          contractSnapshot,
          environment: body.environment,
          evidenceReference,
          provider,
          scope: body.scope,
          validUntil,
          version,
        }),
      });
      targetId = certification.id;
    } else if (body?.action === "revoke_provider_certification") {
      const certificationId = String(body.certificationId ?? "");
      const expectedValidUntil = new Date(
        String(body.expectedValidUntil ?? ""),
      );
      const reason = String(body.reason ?? "");
      const revoked = await revokeFulfillmentProviderCertification({
        actorAdminUserId: actor.user.id,
        certificationId,
        expectedValidUntil,
        reason,
        stepUpAuthenticatedAt: await requirePolicyStepUp(
          "revoke_provider_certification",
          {
            certificationId,
            expectedValidUntil: Number.isFinite(expectedValidUntil.getTime())
              ? expectedValidUntil.toISOString()
              : null,
            reason: reason.trim(),
          },
        ),
      });
      targetId = revoked.id;
    } else if (body?.action === "calendar_exception") {
      if (body.kind !== "branch_closure" && body.kind !== "ontario_holiday") {
        throw new Error("Calendar exception kind is invalid");
      }
      const id = typeof body.id === "string" && body.id ? body.id : undefined;
      const expectedUpdatedAt =
        typeof body.expectedUpdatedAt === "string" && body.expectedUpdatedAt
          ? new Date(body.expectedUpdatedAt)
          : undefined;
      const exceptionDate = String(body.exceptionDate ?? "");
      const label = String(body.label ?? "").trim();
      await upsertShippingCalendarException({
        actorAdminUserId: actor.user.id,
        id,
        expectedUpdatedAt,
        exceptionDate,
        kind: body.kind,
        label,
        stepUpAuthenticatedAt: await requirePolicyStepUp("calendar_exception", {
          exceptionDate,
          expectedUpdatedAt: body.expectedUpdatedAt ?? null,
          id: body.id ?? null,
          kind: body.kind,
          label,
        }),
      });
      targetId = id ?? "new-calendar-exception";
    } else if (body?.action === "remove_calendar_exception") {
      const id = String(body.id ?? "");
      const expectedUpdatedAt = new Date(String(body.expectedUpdatedAt ?? ""));
      const reason = String(body.reason ?? "").trim();
      if (reason.length < 10 || reason.length > 1_000) {
        throw new Error("Calendar exception removal reason is invalid");
      }
      const removed = await removeShippingCalendarException({
        actorAdminUserId: actor.user.id,
        id,
        expectedUpdatedAt,
        stepUpAuthenticatedAt: await requirePolicyStepUp(
          "remove_calendar_exception",
          {
            expectedUpdatedAt: Number.isFinite(expectedUpdatedAt.getTime())
              ? expectedUpdatedAt.toISOString()
              : null,
            id,
            reason,
          },
        ),
      });
      targetId = removed.id;
    } else if (body?.action === "service_policy") {
      if (
        body.destinationCountryCode !== "CA" &&
        body.destinationCountryCode !== "US"
      ) {
        throw new Error("Service destination is invalid");
      }
      const id =
        typeof body.id === "string" && body.id ? body.id.trim() : undefined;
      const expectedUpdatedAt =
        typeof body.expectedUpdatedAt === "string" && body.expectedUpdatedAt
          ? new Date(body.expectedUpdatedAt)
          : undefined;
      const postageType = String(body.postageType ?? "").trim();
      const evidenceReference = String(body.evidenceReference ?? "").trim();
      const claimDeadlineDays = Number(body.claimDeadlineDays);
      const claimWaitingDays = Number(body.claimWaitingDays);
      const insuranceLimitCents = Number(body.insuranceLimitCents);
      const enabled = body.enabled === true;
      const signatureCapable = body.signatureCapable === true;
      const trackingRequired = body.trackingRequired !== false;
      const service = await upsertShippingServicePolicy({
        actorAdminUserId: actor.user.id,
        id,
        expectedUpdatedAt,
        postageType,
        destinationCountryCode: body.destinationCountryCode,
        trackingRequired,
        insuranceLimitCents,
        signatureCapable,
        claimWaitingDays,
        claimDeadlineDays,
        enabled,
        evidenceReference,
        stepUpAuthenticatedAt: await requirePolicyStepUp("service_policy", {
          claimDeadlineDays,
          claimWaitingDays,
          destinationCountryCode: body.destinationCountryCode,
          enabled,
          evidenceReference,
          expectedUpdatedAt:
            expectedUpdatedAt && Number.isFinite(expectedUpdatedAt.getTime())
              ? expectedUpdatedAt.toISOString()
              : null,
          id: id ?? null,
          insuranceLimitCents,
          postageType,
          signatureCapable,
          trackingRequired,
        }),
      });
      targetId = service.id;
    } else if (body?.action === "settings") {
      const expectedUpdatedAt = new Date(String(body.expectedUpdatedAt ?? ""));
      const forwarderPatterns = Array.isArray(body.forwarderPatterns)
        ? body.forwarderPatterns
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 200)
        : undefined;
      const pilotStartedAt =
        typeof body.pilotStartedAt === "string" && body.pilotStartedAt
          ? new Date(body.pilotStartedAt)
          : undefined;
      await updateShippingPolicySettings({
        actorAdminUserId: actor.user.id,
        expectedUpdatedAt,
        forwarderPatterns,
        pilotStartedAt,
        stepUpAuthenticatedAt: await requirePolicyStepUp("update_settings", {
          forwarderPatterns: forwarderPatterns ?? null,
          expectedUpdatedAt: Number.isFinite(expectedUpdatedAt.getTime())
            ? expectedUpdatedAt.toISOString()
            : null,
          pilotStartedAt:
            pilotStartedAt && Number.isFinite(pilotStartedAt.getTime())
              ? pilotStartedAt.toISOString()
              : null,
        }),
      });
    } else {
      return NextResponse.json(
        { error: "Policy action is invalid" },
        { status: 400 },
      );
    }
    await recordAdminAuditBestEffort({
      action: `fulfillment.policy_${String(body.action)}`,
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId,
      targetType: "shipping_policy",
      metadata:
        body.action === "remove_calendar_exception" ||
        body.action === "revoke_provider_certification"
          ? { rationale: String(body.reason ?? "").trim() }
          : undefined,
    });
    return NextResponse.json({ ok: true, id: targetId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Policy update failed";
    await recordAdminAuditBestEffort({
      action: `fulfillment.policy_${String(body?.action ?? "invalid")}`,
      actor,
      domain: "fulfillment",
      outcome: "failure",
      reason: message,
      targetId: String(body?.id ?? body?.certificationId ?? "default"),
      targetType: "shipping_policy",
    });
    return NextResponse.json(
      {
        error: message,
        stepUp:
          error instanceof PolicyStepUpRequiredError ? error.scope : undefined,
      },
      { status: 409 },
    );
  }
}

class PolicyStepUpRequiredError extends Error {
  constructor(
    message: string,
    readonly scope: { action: string; target: string; targetLabel: string },
  ) {
    super(message);
    this.name = "PolicyStepUpRequiredError";
  }
}

async function requirePolicyStepUp(
  action: string,
  payload: Record<string, unknown>,
): Promise<Date> {
  const scope = policyRouteStepUpScope(action, payload);
  try {
    return await requireRecentAdminAuthentication(scope);
  } catch (error) {
    throw new PolicyStepUpRequiredError(
      error instanceof Error
        ? error.message
        : "Step-up authentication is required",
      scope,
    );
  }
}
