import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ postId: string }> },
) {
  return communityRequest(request, "thread", (await context.params).postId);
}
