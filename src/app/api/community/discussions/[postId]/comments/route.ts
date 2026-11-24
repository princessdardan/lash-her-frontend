import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ postId: string }> },
) {
  return communityRequest(request, "comment", (await context.params).postId);
}
