import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ contentId: string }> },
) {
  return communityRequest(request, "report", (await context.params).contentId);
}
