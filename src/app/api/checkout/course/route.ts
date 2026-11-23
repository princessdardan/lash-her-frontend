import * as v from "valibot";
import { getCustomerActor } from "@/lib/customer-auth/session";
import { getSquareCommerceConfig } from "@/lib/env/private-checkout";
import {
  IntegrationServiceError,
  integrationErrorResponse,
} from "@/lib/api-integration/service-errors";
import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { hasConfiguredRequestOrigin } from "@/lib/api-integration/request-origin";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import {
  payForCourse,
  publicCourseOrder,
  quoteCourse,
} from "@/lib/course-purchases/checkout";
import {
  coursePurchaseAccountEnabled,
  courseCheckoutEnabled,
  courseRecoveryEnabled,
} from "@/lib/course-purchases/policy";
import { PurchaseDependencyError } from "@/lib/course-purchases/course-api";
import { attemptCourseRecovery } from "@/lib/course-purchases/recovery";
import { resolveP407CheckoutScope } from "@/lib/course-purchases/p407-checkout-scope";
import { readCourseOrder } from "@/lib/course-purchases/store";
import { courseBillingSchema } from "@/lib/course-purchases/tax";

export const runtime = "nodejs";
const privateHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};
const orderIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const id = v.pipe(v.string(), v.regex(orderIdPattern));
const token = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
const checkoutInput = v.variant("operation", [
  v.strictObject({
    operation: v.literal("quote"),
    courseId: id,
    billing: courseBillingSchema,
  }),
  v.strictObject({
    operation: v.literal("charge"),
    orderId: id,
    sourceId: token,
    verificationToken: v.optional(token),
    acceptedTermsVersion: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  }),
]);

function failed(error: unknown) {
  if (error instanceof IntegrationServiceError)
    return integrationErrorResponse(error);
  if (
    error instanceof PurchaseDependencyError &&
    [403, 404, 409, 422].includes(error.status)
  )
    return Response.json(
      { error: { message: error.message } },
      { status: error.status, headers: privateHeaders },
    );
  return integrationErrorResponse(
    new IntegrationServiceError("service_unavailable", 503),
  );
}

export async function GET(request: Request) {
  try {
    if (!coursePurchaseAccountEnabled() || !courseRecoveryEnabled())
      throw new IntegrationServiceError("feature_disabled", 404);
    const scope = resolveP407CheckoutScope();
    if (scope && !hasConfiguredRequestOrigin(request, scope.origin))
      throw new IntegrationServiceError("forbidden", 403);
    const actor = await getCustomerActor();
    if (!actor) throw new IntegrationServiceError("sign_in_required", 401);
    if (scope && actor.id !== scope.customerId)
      throw new IntegrationServiceError("forbidden", 403);
    const entries = [...new URL(request.url).searchParams];
    if (
      entries.length === 1 &&
      entries[0][0] === "orderId" &&
      orderIdPattern.test(entries[0][1]) &&
      (!scope || entries[0][1] === scope.orderId)
    ) {
      const order = await readCourseOrder(entries[0][1], actor.id);
      if (!order || (scope && order.courseId !== scope.courseId))
        throw new IntegrationServiceError("not_found", 404);
      return Response.json(
        { order: publicCourseOrder(order) },
        { headers: privateHeaders },
      );
    }
    if (
      entries.length === 1 &&
      entries[0][0] === "config" &&
      entries[0][1] === "square"
    ) {
      if (!courseCheckoutEnabled())
        throw new IntegrationServiceError("feature_disabled", 404);
      const config = getSquareCommerceConfig(true);
      if (!config)
        throw new IntegrationServiceError("service_unavailable", 503);
      const scriptUrl =
        config.environment === "sandbox"
          ? "https://sandbox.web.squarecdn.com/v1/square.js"
          : "https://web.squarecdn.com/v1/square.js";
      return Response.json(
        { ...config, scriptUrl },
        { headers: privateHeaders },
      );
    }
    throw new IntegrationServiceError("invalid_request", 400);
  } catch (error) {
    return failed(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!courseCheckoutEnabled())
      throw new IntegrationServiceError("feature_disabled", 404);
    if (new URL(request.url).search)
      throw new IntegrationServiceError("invalid_request", 400);
    const scope = resolveP407CheckoutScope();
    const result = v.safeParse(
      checkoutInput,
      await readSameOriginJson(request, scope?.origin ?? process.env.CUSTOMER_AUTH_URL, 8192),
    );
    if (!result.success)
      throw new IntegrationServiceError("invalid_request", 400);
    const input = result.output;
    if (scope && (input.operation === "quote"
      ? input.courseId !== scope.courseId
      : input.orderId !== scope.orderId))
      throw new IntegrationServiceError("forbidden", 403);
    const order = await runWriterAdmission("new-work", async () => {
      try {
        if (!courseCheckoutEnabled())
          throw new IntegrationServiceError("feature_disabled", 404);
        const actor = await getCustomerActor();
        if (!actor) throw new IntegrationServiceError("sign_in_required", 401);
        if (scope && actor.id !== scope.customerId)
          throw new IntegrationServiceError("forbidden", 403);
        return input.operation === "quote"
          ? await quoteCourse(actor, input.courseId, input.billing, scope?.orderId)
          : await payForCourse(actor, input, scope?.courseId);
      } catch (error) {
        // A normal checkout rejection is a completed writer operation.
        if (
          (error instanceof IntegrationServiceError ||
            error instanceof PurchaseDependencyError) &&
          error.status < 500
        )
          return failed(error);
        throw error;
      }
    }, scope && { p407CourseOrderId: scope.orderId });
    if (order instanceof Response) return order;
    const charged = input.operation === "charge" && order.status === "paid";
    if (charged) await attemptCourseRecovery(order.id);
    const latest = charged
      ? ((await readCourseOrder(order.id, order.customerId)) ?? order)
      : order;
    return Response.json(
      { order: publicCourseOrder(latest) },
      {
        status:
          input.operation === "quote"
            ? 201
            : latest.status === "charging"
              ? 202
              : 200,
        headers: privateHeaders,
      },
    );
  } catch (error) {
    return failed(error);
  }
}
