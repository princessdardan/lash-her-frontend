import { NextResponse } from "next/server";
import { IntegrationServiceError, integrationErrorResponse } from "@/lib/api-integration/service-errors";
import {
  markSyntheticReplyRead, notificationSettings, reviewNotificationActor, reviewNotificationsPath, sendSyntheticReply,
} from "@/lib/staging-review/notifications";
import { reviewSameOrigin } from "@/lib/staging-review/session";

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    const scope = notificationSettings();
    const { action } = await context.params;
    if (!scope || new URL(request.url).search || (action !== "reply" && action !== "read"))
      throw new IntegrationServiceError("feature_disabled", 404);
    if (!reviewSameOrigin(request)) throw new IntegrationServiceError("forbidden", 403);
    const actor = await reviewNotificationActor(scope);
    if (!actor) throw new IntegrationServiceError("sign_in_required", 401);
    if (action === "reply") await sendSyntheticReply(scope, actor);
    else await markSyntheticReplyRead(scope, actor);
    const url = new URL(reviewNotificationsPath, request.url);
    if (action === "reply") url.searchParams.set("reply", "sent");
    const response = NextResponse.redirect(url, 303);
    response.headers.set("cache-control", "private, no-store");
    return response;
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
