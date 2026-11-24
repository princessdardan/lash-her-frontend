import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  return communityRequest(request, "feed", (await context.params).courseId);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  return communityRequest(request, "post", (await context.params).courseId);
}
