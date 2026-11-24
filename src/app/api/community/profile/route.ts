import { communityRequest } from "@/lib/api-integration/community-discussions";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return communityRequest(request, "ownProfile");
}

export async function PUT(request: Request) {
  return communityRequest(request, "profile");
}
