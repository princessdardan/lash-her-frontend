import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
) {
  return communityRequest(
    request,
    "completeImage",
    (await context.params).mediaId,
  );
}
