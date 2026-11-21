import "server-only";

import { mintCourseEntitlementToken } from "./token";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { validateCandidateResponse, type CandidateSuccess } from "@/lib/api-integration/candidate-validation";
import { parseCourseResponse } from "@/lib/api-integration/response-validation";
import type { paths as CoursePaths } from "@/lib/api-integration/generated/course";
import type { coursePurchaseOrders, coursePurchaseJobs } from "./schema";

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

export async function readCourseOffer(
  userId: string,
  courseId: string,
): Promise<CourseOffer> {
  const response = await getGatewayTransport()({
    method: "GET",
    path: `${checkoutOffer}?${new URLSearchParams({ userId, courseId })}`,
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
        grantReason: "purchase",
        grantedAt: job.effectiveAt.toISOString(),
      }
    : {
        ...scope,
        revokeReason: "refund",
        revokedAt: job.effectiveAt.toISOString(),
      };
  const response = await getGatewayTransport()({
    method: "POST",
    path: grant ? grants : revocations,
    applicationToken: mintCourseEntitlementToken(),
    idempotencyKey: job.id,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new PurchaseDependencyError(response.status);
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
