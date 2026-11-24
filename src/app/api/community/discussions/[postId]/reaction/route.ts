import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  context: { params: Promise<{ postId: string }> },
) {
  return communityRequest(request, "react", (await context.params).postId);
}
