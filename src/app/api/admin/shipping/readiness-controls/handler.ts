import { NextResponse, type NextRequest } from "next/server";

import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import {
  approveManualFulfillmentPolicy,
  approveProductTaxPolicy,
  loadReadinessAdminState,
  saveShippingPackageProfile,
} from "@/lib/shipping/readiness-admin";
import { assertShippingPolicyConfigurationMutationAllowed } from "@/lib/shipping/policy";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";

type ReadinessAction = "manual_policy" | "package_profile" | "tax_policy";

export interface ReadinessControlDependencies {
  approveManualPolicy: typeof approveManualFulfillmentPolicy;
  approveTaxPolicy: typeof approveProductTaxPolicy;
  getState: typeof loadReadinessAdminState;
  recordAudit: typeof recordAdminAuditBestEffort;
  requireConfiguredOwner: typeof assertConfiguredFulfillmentOwner;
  requirePermission: typeof requirePermission;
  requireStepUp: typeof requireRecentAdminAuthentication;
  savePackageProfile: typeof saveShippingPackageProfile;
}

const defaultDependencies: ReadinessControlDependencies = {
  approveManualPolicy: approveManualFulfillmentPolicy,
  approveTaxPolicy: approveProductTaxPolicy,
  getState: loadReadinessAdminState,
  recordAudit: recordAdminAuditBestEffort,
  requireConfiguredOwner: assertConfiguredFulfillmentOwner,
  requirePermission,
  requireStepUp: requireRecentAdminAuthentication,
  savePackageProfile: saveShippingPackageProfile,
};

export function createShippingReadinessControlHandlers(
  dependencies: ReadinessControlDependencies = defaultDependencies,
) {
  return {
    GET: async (): Promise<Response> => {
      const actor = await dependencies.requirePermission("settings:manage");
      try {
        await dependencies.requireConfiguredOwner(actor.user.id);
      } catch {
        return NextResponse.json(
          {
            error:
              "Only the configured fulfillment owner may view readiness configuration",
          },
          {
            headers: { "Cache-Control": "private, no-store" },
            status: 403,
          },
        );
      }
      const state = await dependencies.getState();
      return NextResponse.json(state, {
        headers: { "Cache-Control": "private, no-store" },
      });
    },
    POST: async (request: NextRequest): Promise<Response> => {
      const actor = await dependencies.requirePermission("settings:manage");
      try {
        await dependencies.requireConfiguredOwner(actor.user.id);
      } catch {
        return NextResponse.json(
          {
            error: "Only the configured fulfillment owner may manage readiness",
          },
          { status: 403 },
        );
      }
      if (request.headers.get("origin") !== request.nextUrl.origin) {
        return NextResponse.json(
          { error: "Invalid request origin" },
          { status: 403 },
        );
      }
      try {
        assertShippingPolicyConfigurationMutationAllowed();
      } catch {
        return NextResponse.json(
          { error: "Readiness configuration is read-only in observe mode" },
          { status: 409 },
        );
      }
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const action = parseAction(body?.action);
      if (!body || !action) {
        return NextResponse.json(
          { error: "Readiness action is invalid" },
          { status: 400 },
        );
      }
      const proof = readinessStepUpScope(action, body);
      let stepUpAuthenticatedAt: Date;
      try {
        stepUpAuthenticatedAt = await dependencies.requireStepUp(proof);
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Step-up authentication is required",
            stepUp: proof,
          },
          { status: 409 },
        );
      }
      try {
        const result = await runAction({
          action,
          actorAdminUserId: actor.user.id,
          body,
          dependencies,
          stepUpAuthenticatedAt,
        });
        await dependencies.recordAudit({
          action: `fulfillment.readiness_${action}`,
          actor,
          domain: "fulfillment",
          outcome: "success",
          targetId: result.id,
          targetType: readinessTargetType(action),
          metadata: { action },
        });
        return NextResponse.json(
          { id: result.id, ok: true },
          {
            headers: { "Cache-Control": "private, no-store" },
            status: action === "package_profile" && !body.id ? 201 : 200,
          },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Readiness update failed";
        await dependencies.recordAudit({
          action: `fulfillment.readiness_${action}`,
          actor,
          domain: "fulfillment",
          outcome: "failure",
          reason: message,
          targetId:
            cleanOptionalString(body.id) || cleanOptionalString(body.version),
          targetType: readinessTargetType(action),
        });
        return NextResponse.json(
          { error: message },
          {
            headers: { "Cache-Control": "private, no-store" },
            status: /sole configured fulfillment owner/i.test(message)
              ? 403
              : 409,
          },
        );
      }
    },
  };
}

async function runAction(input: {
  action: ReadinessAction;
  actorAdminUserId: string;
  body: Record<string, unknown>;
  dependencies: ReadinessControlDependencies;
  stepUpAuthenticatedAt: Date;
}) {
  if (input.action === "package_profile") {
    return input.dependencies.savePackageProfile({
      actorAdminUserId: input.actorAdminUserId,
      capacityUnits: numberValue(input.body.capacityUnits),
      enabled: input.body.enabled === true,
      evidenceReference: stringValue(input.body.evidenceReference),
      expectedUpdatedAt: dateValue(input.body.expectedUpdatedAt),
      heightCm: numberValue(input.body.heightCm),
      id: cleanOptionalString(input.body.id),
      lengthCm: numberValue(input.body.lengthCm),
      maxWeightGrams: numberValue(input.body.maxWeightGrams),
      name: stringValue(input.body.name),
      packageType: stringValue(input.body.packageType),
      rank: numberValue(input.body.rank),
      slug: stringValue(input.body.slug),
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      tareWeightGrams: numberValue(input.body.tareWeightGrams),
      widthCm: numberValue(input.body.widthCm),
    });
  }
  if (input.action === "tax_policy") {
    return input.dependencies.approveTaxPolicy({
      actorAdminUserId: input.actorAdminUserId,
      coverage: recordBooleanValue(input.body.coverage),
      evidenceReference: stringValue(input.body.evidenceReference),
      expectedCurrentEffectiveId: cleanOptionalString(
        input.body.expectedCurrentEffectiveId,
      ),
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      version: stringValue(input.body.version),
    });
  }
  return input.dependencies.approveManualPolicy({
    actorAdminUserId: input.actorAdminUserId,
    cancellationPolicyText: stringValue(input.body.cancellationPolicyText),
    evidenceReference: stringValue(input.body.evidenceReference),
    expectedCurrentEffectiveId: cleanOptionalString(
      input.body.expectedCurrentEffectiveId,
    ),
    stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
    version: stringValue(input.body.version),
  });
}

export function readinessStepUpScope(
  action: ReadinessAction,
  body: Record<string, unknown>,
): { action: string; target: string; targetLabel: string } {
  const payload = actionPayload(action, body);
  return {
    action: `shipping_readiness:${action}`,
    target: createAdminStepUpTarget({ action, payload }),
    targetLabel:
      action === "package_profile"
        ? `Package profile: ${String(body.slug ?? "new profile")}`
        : action === "tax_policy"
          ? `Product-tax policy: ${String(body.version ?? "new version")}`
          : `Manual-order policy: ${String(body.version ?? "new version")}`,
  };
}

function actionPayload(
  action: ReadinessAction,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (action === "package_profile") {
    return {
      action,
      id: cleanOptionalString(body.id) ?? null,
      expectedUpdatedAt: cleanOptionalString(body.expectedUpdatedAt) ?? null,
      slug: body.slug,
      name: body.name,
      rank: body.rank,
      packageType: body.packageType,
      lengthCm: body.lengthCm,
      widthCm: body.widthCm,
      heightCm: body.heightCm,
      tareWeightGrams: body.tareWeightGrams,
      maxWeightGrams: body.maxWeightGrams,
      capacityUnits: body.capacityUnits,
      enabled: body.enabled === true,
      evidenceReference: body.evidenceReference,
    };
  }
  if (action === "tax_policy") {
    return {
      action,
      version: body.version,
      evidenceReference: body.evidenceReference,
      expectedCurrentEffectiveId:
        cleanOptionalString(body.expectedCurrentEffectiveId) ?? null,
      coverage: body.coverage,
    };
  }
  return {
    action,
    version: body.version,
    evidenceReference: body.evidenceReference,
    expectedCurrentEffectiveId:
      cleanOptionalString(body.expectedCurrentEffectiveId) ?? null,
    cancellationPolicyText: body.cancellationPolicyText,
  };
}

function parseAction(value: unknown): ReadinessAction | null {
  return value === "package_profile" ||
    value === "tax_policy" ||
    value === "manual_policy"
    ? value
    : null;
}

function readinessTargetType(action: ReadinessAction): string {
  if (action === "package_profile") return "shipping_package_profile";
  if (action === "tax_policy") return "product_tax_policy_version";
  return "manual_fulfillment_policy_version";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cleanOptionalString(value: unknown): string | undefined {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned || undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function dateValue(value: unknown): Date | undefined {
  const text = cleanOptionalString(value);
  return text ? new Date(text) : undefined;
}

function recordBooleanValue(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      nested === true,
    ]),
  );
}
