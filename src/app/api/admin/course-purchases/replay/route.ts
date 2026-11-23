import * as v from "valibot";
import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import {
  IntegrationServiceError,
  integrationErrorResponse,
} from "@/lib/api-integration/service-errors";
import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { courseRecoveryEnabled } from "@/lib/course-purchases/policy";
import {
  lookupSupportOrderId,
  replayCourseJob,
} from "@/lib/course-purchases/store";
import { hasP407CheckoutBinding } from "@/lib/writer-admission/p407-course";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";

export const runtime = "nodejs";
const replayInput = v.strictObject({
  jobId: v.pipe(
    v.string(),
    v.regex(
      /^course-(?:grant|revoke|tax_sale|tax_refund|receipt|refund_receipt)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:-[a-f0-9]{32}|-g[1-9][0-9]{0,9})?(?:-dispute)?$/u,
    ),
  ),
  orderReference: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(39))),
  reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
});

export async function POST(request: Request) {
  try {
    if (hasP407CheckoutBinding() || !courseRecoveryEnabled())
      throw new IntegrationServiceError("feature_disabled", 404);
    if (new URL(request.url).search)
      throw new IntegrationServiceError("invalid_request", 400);
    const actor = await requirePermission("payments:refund");
    if (actor.developerMode)
      throw new IntegrationServiceError("forbidden", 403);
    const { jobId, reason, orderReference } = v.parse(
      replayInput,
      await readSameOriginJson(
        request,
        process.env.AUTH_URL ??
          process.env.NEXTAUTH_URL ??
          process.env.NEXT_PUBLIC_SITE_URL,
        2048,
      ),
    );
    const orderId =
      orderReference === undefined
        ? undefined
        : lookupSupportOrderId(orderReference);
    if (orderReference !== undefined && !orderId)
      throw new IntegrationServiceError("invalid_request", 400);
    const replayed = await runWriterAdmission("recovery", () =>
      replayCourseJob(jobId, actor.user.id, reason, orderId),
    );
    if (!replayed) throw new IntegrationServiceError("conflict", 409);
    return Response.json(
      { queued: true },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const failure =
      error instanceof IntegrationServiceError
        ? error
        : error instanceof AdminAuthError
          ? error.code === "unauthenticated"
            ? new IntegrationServiceError("sign_in_required", 401)
            : new IntegrationServiceError("forbidden", 403)
          : v.isValiError(error)
            ? new IntegrationServiceError("invalid_request", 400)
            : new IntegrationServiceError("service_unavailable", 503);
    return integrationErrorResponse(failure);
  }
}
