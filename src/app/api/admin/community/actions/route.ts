import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return communityRequest(request, "moderate");
}
