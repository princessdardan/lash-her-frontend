import { NextResponse, type NextRequest } from "next/server";

import {
  executeIntakeLocationMutation,
  intakeLocationStepUpScope,
  parseIntakeLocationMutationPayload,
} from "@/app/admin/(protected)/shipping-readiness/actions";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import { assertShippingPolicyConfigurationMutationAllowed } from "@/lib/shipping/policy";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export interface IntakeLocationHandlerDependencies {
  assertMutationAllowed: typeof assertShippingPolicyConfigurationMutationAllowed;
  executeMutation: typeof executeIntakeLocationMutation;
  recordAudit: typeof recordAdminAuditBestEffort;
  requireConfiguredOwner: typeof assertConfiguredFulfillmentOwner;
  requirePermission: typeof requirePermission;
  requireStepUp: typeof requireRecentAdminAuthentication;
}

const defaultDependencies: IntakeLocationHandlerDependencies = {
  assertMutationAllowed: assertShippingPolicyConfigurationMutationAllowed,
  executeMutation: executeIntakeLocationMutation,
  recordAudit: recordAdminAuditBestEffort,
  requireConfiguredOwner: assertConfiguredFulfillmentOwner,
  requirePermission,
  requireStepUp: requireRecentAdminAuthentication,
};

export function createShippingIntakeLocationHandlers(
  dependencies: IntakeLocationHandlerDependencies = defaultDependencies,
) {
  return {
    POST: async (request: NextRequest): Promise<Response> => {
      const actor = await dependencies.requirePermission("settings:manage");
      if (request.headers.get("origin") !== request.nextUrl.origin) {
        return json({ error: "Invalid request origin" }, 403);
      }
      try {
        await dependencies.requireConfiguredOwner(actor.user.id);
      } catch {
        await dependencies.recordAudit({
          action: "fulfillment.intake_location_owner_denied",
          actor,
          domain: "fulfillment",
          outcome: "denied",
          reason:
            "Only the configured fulfillment owner may manage the intake location",
          targetType: "chitchats_intake_location_attestation",
        });
        return json(
          {
            error:
              "Only the configured fulfillment owner may manage this attestation",
          },
          403,
        );
      }
      try {
        dependencies.assertMutationAllowed();
      } catch {
        return json(
          {
            error:
              "Shipping readiness configuration is read-only in observe mode",
          },
          409,
        );
      }

      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      let payload: ReturnType<typeof parseIntakeLocationMutationPayload>;
      try {
        payload = parseIntakeLocationMutationPayload(body);
      } catch (error) {
        return json(
          {
            error: errorMessage(
              error,
              "The intake-location request is invalid",
            ),
          },
          400,
        );
      }

      const stepUp = intakeLocationStepUpScope(payload);
      let stepUpAuthenticatedAt: Date;
      try {
        stepUpAuthenticatedAt = await dependencies.requireStepUp(stepUp);
      } catch (error) {
        await dependencies.recordAudit({
          action: `fulfillment.intake_location_${payload.action}`,
          actor,
          domain: "fulfillment",
          outcome: "denied",
          reason: "step_up_required",
          targetId: payload.expectedCurrentAttestationId ?? undefined,
          targetType: "chitchats_intake_location_attestation",
        });
        return json(
          {
            error: errorMessage(error, "Step-up authentication is required"),
            stepUp,
          },
          409,
        );
      }

      try {
        const result = await dependencies.executeMutation({
          actorAdminUserId: actor.user.id,
          payload,
          stepUpAuthenticatedAt,
        });
        return json({ id: result.id, ok: true }, 200);
      } catch (error) {
        const message = errorMessage(
          error,
          "The intake-location change could not be saved",
        );
        await dependencies.recordAudit({
          action: `fulfillment.intake_location_${payload.action}`,
          actor,
          domain: "fulfillment",
          outcome: "failure",
          reason: message,
          targetId: payload.expectedCurrentAttestationId ?? undefined,
          targetType: "chitchats_intake_location_attestation",
        });
        return json({ error: message }, 409);
      }
    },
  };
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE_HEADERS, status });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : fallback;
}
