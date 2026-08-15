import { NextResponse, type NextRequest } from "next/server";

import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import { approveFundingReview } from "@/lib/shipping/funding";
import { assertShippingPolicyConfigurationMutationAllowed } from "@/lib/shipping/policy";

export interface FundingApprovalRouteDependencies {
  approve: typeof approveFundingReview;
  assertMutationAllowed: typeof assertShippingPolicyConfigurationMutationAllowed;
  recordAudit: typeof recordAdminAuditBestEffort;
  requireConfiguredOwner: typeof assertConfiguredFulfillmentOwner;
  requirePermission: typeof requirePermission;
  requireStepUp: typeof requireRecentAdminAuthentication;
}

const defaultDependencies: FundingApprovalRouteDependencies = {
  approve: approveFundingReview,
  assertMutationAllowed: assertShippingPolicyConfigurationMutationAllowed,
  recordAudit: recordAdminAuditBestEffort,
  requireConfiguredOwner: assertConfiguredFulfillmentOwner,
  requirePermission,
  requireStepUp: requireRecentAdminAuthentication,
};

export function createFundingApprovalHandlers(
  dependencies: FundingApprovalRouteDependencies = defaultDependencies,
) {
  return {
    POST: async (
      req: NextRequest,
      { params }: { params: Promise<{ reviewId: string }> },
    ): Promise<Response> => {
      const actor = await dependencies.requirePermission("settings:manage");
      try {
        await dependencies.requireConfiguredOwner(actor.user.id);
      } catch {
        return NextResponse.json(
          {
            error: "Only the configured fulfillment owner may approve funding",
          },
          { status: 403 },
        );
      }
      if (req.headers.get("origin") !== req.nextUrl.origin) {
        return NextResponse.json(
          { error: "Invalid request origin" },
          { status: 403 },
        );
      }
      try {
        dependencies.assertMutationAllowed();
      } catch {
        return NextResponse.json(
          { error: "Funding configuration is read-only in observe mode" },
          { status: 409 },
        );
      }
      const body = (await req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const { reviewId } = await params;
      const markApplied = body?.markApplied === true;
      const stepUp = fundingApprovalStepUpScope(reviewId, markApplied);
      try {
        await dependencies.requireStepUp(stepUp);
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Step-up authentication is required",
            stepUp,
          },
          { status: 409 },
        );
      }
      try {
        const updated = await dependencies.approve({
          actorAdminUserId: actor.user.id,
          markApplied,
          reviewId,
        });
        await dependencies.recordAudit({
          action: "fulfillment.funding_review_approve",
          actor,
          domain: "fulfillment",
          outcome: "success",
          targetId: updated.id,
          targetType: "shipping_funding_review",
          metadata: { markApplied },
        });
        return NextResponse.json({ id: updated.id, status: updated.status });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Funding approval failed";
        await dependencies.recordAudit({
          action: "fulfillment.funding_review_approve",
          actor,
          domain: "fulfillment",
          outcome: "failure",
          reason: message,
          targetId: reviewId,
          targetType: "shipping_funding_review",
          metadata: { markApplied },
        });
        return NextResponse.json({ error: message }, { status: 409 });
      }
    },
  };
}

export function fundingApprovalStepUpScope(
  reviewId: string,
  markApplied: boolean,
) {
  return {
    action: "shipping_funding:approve",
    target: createAdminStepUpTarget({ markApplied, reviewId }),
  };
}
