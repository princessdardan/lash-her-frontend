import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  return communityRequest(request, "space", (await context.params).courseId);
}
