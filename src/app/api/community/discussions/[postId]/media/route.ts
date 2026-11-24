import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ postId: string }> },
) {
  return communityRequest(request, "media", (await context.params).postId);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ postId: string }> },
) {
  return communityRequest(
    request,
    "reserveImage",
    (await context.params).postId,
  );
}
