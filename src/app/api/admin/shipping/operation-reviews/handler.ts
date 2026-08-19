import { NextResponse, type NextRequest } from "next/server";

import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import {
  recordFulfillmentOperationReview,
  resolveReturnObservation,
  type FulfillmentOperationReviewKind,
  type ReturnObservationResolutionAction,
} from "@/lib/shipping/operations-actions";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTION_BY_KIND: Record<FulfillmentOperationReviewKind, string> = {
  provider_job: "request_reconciliation",
  shipment_generation: "acknowledge_manual_review",
  customer_decision: "record_legal_follow_up",
  refund: "record_external_manual_handoff",
};

const RETURN_ACTIONS = new Set<ReturnObservationResolutionAction>([
  "record_inspection",
  "escalate_unmatched_return",
  "confirm_linked_case",
]);

interface Actor {
  user: { id: string };
}

interface HandlerDependencies {
  audit: typeof recordAdminAuditBestEffort;
  requireConfiguredOwner: typeof assertConfiguredFulfillmentOwner;
  requireEnforce: typeof assertShippingPolicyMutationAllowed;
  requireManage: () => Promise<Actor>;
  requireStepUp: typeof requireRecentAdminAuthentication;
  reviewOperation: typeof recordFulfillmentOperationReview;
  resolveReturn: typeof resolveReturnObservation;
}

const dependencies: HandlerDependencies = {
  audit: recordAdminAuditBestEffort,
  requireConfiguredOwner: assertConfiguredFulfillmentOwner,
  requireEnforce: assertShippingPolicyMutationAllowed,
  requireManage: () => requirePermission("fulfillment:manage"),
  requireStepUp: requireRecentAdminAuthentication,
  reviewOperation: recordFulfillmentOperationReview,
  resolveReturn: resolveReturnObservation,
};

export function createOperationReviewHandler(
  overrides: Partial<HandlerDependencies> = {},
) {
  const deps = { ...dependencies, ...overrides };

  return async function handle(
    request: NextRequest,
    input:
      | { entityId: string; kind: FulfillmentOperationReviewKind }
      | { entityId: string; kind: "return_observation" },
  ): Promise<Response> {
    const actor = await deps.requireManage();
    try {
      await deps.requireConfiguredOwner(actor.user.id);
    } catch {
      return NextResponse.json(
        {
          error:
            "Only the configured fulfillment owner may perform this action",
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
      deps.requireEnforce();
    } catch {
      return NextResponse.json(
        { error: "Shipping operations are read-only outside enforce mode" },
        { status: 409 },
      );
    }
    if (!UUID_PATTERN.test(input.entityId)) {
      return NextResponse.json(
        { error: "Operation ID is invalid" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const action = typeof body?.action === "string" ? body.action : "";
    const expectedStateVersion = Number(body?.expectedStateVersion);
    const evidenceReference =
      typeof body?.evidenceReference === "string" ? body.evidenceReference : "";
    const rationale = typeof body?.rationale === "string" ? body.rationale : "";

    if (
      !Number.isInteger(expectedStateVersion) ||
      expectedStateVersion < 1 ||
      evidenceReference.trim().length < 6 ||
      rationale.trim().length < 10
    ) {
      return NextResponse.json(
        { error: "Version, evidence reference, and rationale are required" },
        { status: 400 },
      );
    }

    const expectedAction =
      input.kind === "return_observation" ? action : ACTION_BY_KIND[input.kind];
    if (
      (input.kind === "return_observation" &&
        !RETURN_ACTIONS.has(action as ReturnObservationResolutionAction)) ||
      (input.kind !== "return_observation" && action !== expectedAction)
    ) {
      return NextResponse.json(
        { error: "Operation action is invalid" },
        { status: 400 },
      );
    }

    const stepUpScope = {
      action: `operations:${input.kind}:${expectedAction}`,
      target: createAdminStepUpTarget({
        action: expectedAction,
        entityId: input.entityId,
        evidenceReference: evidenceReference.trim(),
        expectedStateVersion,
        kind: input.kind,
        rationale: rationale.trim(),
      }),
      targetLabel: `${input.kind.replaceAll("_", " ")} ${input.entityId}`,
    };
    try {
      const stepUpAuthenticatedAt = await deps.requireStepUp(stepUpScope);
      const result =
        input.kind === "return_observation"
          ? await deps.resolveReturn({
              action: action as ReturnObservationResolutionAction,
              actorAdminUserId: actor.user.id,
              evidenceReference,
              expectedStateVersion,
              id: input.entityId,
              rationale,
              stepUpAuthenticatedAt,
            })
          : await deps.reviewOperation({
              actorAdminUserId: actor.user.id,
              evidenceReference,
              expectedStateVersion,
              id: input.entityId,
              kind: input.kind,
              rationale,
              stepUpAuthenticatedAt,
            });
      await deps.audit({
        action: `fulfillment.${input.kind}.${expectedAction}`,
        actor: actor as Parameters<
          typeof recordAdminAuditBestEffort
        >[0]["actor"],
        domain: "fulfillment",
        outcome: "success",
        targetId: input.entityId,
        targetType: input.kind,
        metadata: { evidenceReference, expectedStateVersion },
      });
      return NextResponse.json(result, {
        status: input.kind === "provider_job" ? 202 : 200,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Operation failed";
      return NextResponse.json(
        {
          error: message,
          ...(/step-up|authentication/i.test(message)
            ? { stepUp: stepUpScope }
            : {}),
        },
        { status: 409 },
      );
    }
  };
}

export const handleOperationReview = createOperationReviewHandler();
