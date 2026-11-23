import * as v from "valibot";
import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import {
  IntegrationServiceError,
  integrationErrorResponse,
} from "@/lib/api-integration/service-errors";
import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { hasP407CheckoutBinding } from "@/lib/writer-admission/p407-course";
import { courseRecoveryEnabled } from "@/lib/course-purchases/policy";
import { replayCourseJob } from "@/lib/course-purchases/store";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";

export const runtime = "nodejs";
const replayInput = v.strictObject({
  jobId: v.pipe(
    v.string(),
    v.regex(/^course-[a-z_-]+-[a-f0-9-]{36}(?:-[a-f0-9]{32})?$/u),
  ),
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
    const { jobId, reason } = v.parse(
      replayInput,
      await readSameOriginJson(
        request,
        process.env.AUTH_URL ??
          process.env.NEXTAUTH_URL ??
          process.env.NEXT_PUBLIC_SITE_URL,
        2048,
      ),
    );
    const replayed = await runWriterAdmission("recovery", () =>
      replayCourseJob(jobId, actor.user.id, reason),
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
