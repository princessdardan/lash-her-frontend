import "server-only";

import { mintCourseEntitlementToken } from "./token";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { validateCandidateResponse, type CandidateSuccess } from "@/lib/api-integration/candidate-validation";
import {
  isCourseDisputeGrant,
  isCoursePurchaseFence,
  parseCourseResponse,
} from "@/lib/api-integration/response-validation";
import type { paths as CoursePaths } from "@/lib/api-integration/generated/course";
import type { coursePurchaseOrders, coursePurchaseJobs } from "./schema";
import { resolveP407CheckoutScope } from "./p407-checkout-scope";
import { purchaseJobKey } from "./job-key";

const checkoutOffer = "/v1/internal/checkout-offer";
const grants = "/v1/internal/entitlements/grants";
const revocations = "/v1/internal/entitlements/revocations";
const reconciliation = "/v1/internal/entitlements/reconcile";
type ReconciliationRequest =
  CoursePaths[typeof reconciliation]["post"]["requestBody"]["content"]["application/json"];
export type CourseOffer = CandidateSuccess<"course", typeof checkoutOffer, "get">;

export class PurchaseDependencyError extends Error {
  constructor(
    readonly status: number,
    message = "A checkout dependency is unavailable.",
  ) {
    super(message);
  }
}

function candidateProof(userId: string, courseId: string, orderId?: string) {
  const scope = resolveP407CheckoutScope();
  if (!scope) return undefined;
  if (
    userId !== scope.customerId || courseId !== scope.courseId ||
    (orderId !== undefined && orderId !== scope.orderId)
  ) throw new PurchaseDependencyError(403);
  return process.env.P407_POSTGRES_RELAY_DEPLOYMENT_PROOF;
}

export async function readCourseOffer(
  userId: string,
  courseId: string,
): Promise<CourseOffer> {
  const response = await getGatewayTransport()({
    method: "GET",
    path: `${checkoutOffer}?${new URLSearchParams({ userId, courseId })}`,
    p407CourseProof: candidateProof(userId, courseId),
    applicationToken: mintCourseEntitlementToken(),
  });
  const data: unknown = await response.json();
  validateCandidateResponse(
    "course",
    checkoutOffer,
    "get",
    response.status,
    data,
  );
  if (!response.ok) throw new PurchaseDependencyError(response.status);
  const result = data as CourseOffer;
  if (result.userId !== userId || result.courseId !== courseId)
    throw new PurchaseDependencyError(502);
  return result;
}

export async function compareCourseEntitlements(
  input: ReconciliationRequest,
  signal?: AbortSignal,
) {
  const response = await getGatewayTransport()({
    method: "POST",
    path: reconciliation,
    applicationToken: mintCourseEntitlementToken(),
    body: JSON.stringify(input),
    signal,
  });
  if (response.status !== 200)
    throw new PurchaseDependencyError(response.status);
  return parseCourseResponse(
    reconciliation,
    "post",
    200,
    await response.json(),
  );
}

type Order = typeof coursePurchaseOrders.$inferSelect;
type Job = typeof coursePurchaseJobs.$inferSelect;

export async function deliverEntitlement(order: Order, job: Job) {
  const grant = job.kind === "grant";
  const disputeResolution = grant && job.accessGeneration > 0;
  const purchaseFence = job.kind === "revoke" && job.revokeReason !== null;
  const scope = {
    userId: order.customerId,
    courseId: order.courseId,
    orderId: order.id,
    idempotencyKey: job.id,
  };
  const body = grant
    ? {
        ...scope,
        externalPaymentId: order.squarePaymentId,
        provider: "square",
        ...(disputeResolution
          ? {
              grantReason: "dispute_resolution",
              purchaseCapturedAt: order.chargedAt?.toISOString(),
              disputeStartedAt: order.disputeStartedAt?.toISOString(),
            }
          : { grantReason: "purchase" }),
        grantedAt: job.effectiveAt.toISOString(),
      }
    : {
        ...scope,
        ...(purchaseFence
          ? {
              revokeReason: "purchase_fence",
              financialReason: job.revokeReason,
              grantIdempotencyKey: purchaseJobKey("grant", order.id, {
                accessGeneration: job.accessGeneration,
              }),
            }
          : { revokeReason: "refund" }),
        revokedAt: job.effectiveAt.toISOString(),
      };
  if (
    (disputeResolution && !isCourseDisputeGrant(body)) ||
    (purchaseFence && !isCoursePurchaseFence(body))
  )
    throw new PurchaseDependencyError(409);
  const response = await getGatewayTransport()({
    method: "POST",
    path: grant ? grants : revocations,
    p407CourseProof: candidateProof(order.customerId, order.courseId, order.id),
    applicationToken: mintCourseEntitlementToken(),
    idempotencyKey: job.id,
    body: JSON.stringify(body),
  });
  if (disputeResolution && response.status === 409) {
    const conflict = parseCourseResponse(
      grants,
      "post",
      409,
      await response.json(),
    );
    if (conflict.error.code === "ADMIN_ENTITLEMENT_OVERRIDE") return null;
  }
  if (!response.ok) throw new PurchaseDependencyError(response.status);
  if (purchaseFence) {
    if (response.status !== 204) throw new PurchaseDependencyError(502);
    return null;
  }
  const data: unknown = await response.json();
  const receipt = grant
    ? parseCourseResponse(
        grants,
        "post",
        response.status === 201 ? 201 : 200,
        data,
      )
    : parseCourseResponse(revocations, "post", 200, data);
  if (
    receipt.userId !== order.customerId ||
    receipt.courseId !== order.courseId ||
    (!grant && receipt.status === "active")
  )
    throw new PurchaseDependencyError(502);
  return receipt;
}
