import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
) {
  return communityRequest(
    request,
    "removeImage",
    (await context.params).mediaId,
  );
}
