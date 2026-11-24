import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  context: { params: Promise<{ notificationId: string }> },
) {
  return communityRequest(
    request,
    "setNotificationRead",
    (await context.params).notificationId,
  );
}
