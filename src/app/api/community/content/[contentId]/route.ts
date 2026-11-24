import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ contentId: string }> },
) {
  return communityRequest(request, "edit", (await context.params).contentId);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ contentId: string }> },
) {
  return communityRequest(request, "delete", (await context.params).contentId);
}
