import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await context.params;
  return communityRequest(request, "members", courseId);
}
