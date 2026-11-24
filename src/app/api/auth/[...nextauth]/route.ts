import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { permitsP506CandidateRequest } from "@/lib/env/p506-candidate-origin";
import { withAdminAuthRouteAdmission } from "@/lib/admin/auth-route-admission";
import { stagingOwnerRequest } from "@/lib/admin/staging-owner-auth";

const gatedGet = withAdminAuthRouteAdmission(handlers.GET);
const gatedPost = withAdminAuthRouteAdmission(handlers.POST);
const rejectOrigin = () => new Response(null, { status: 403, headers: { "cache-control": "private, no-store" } });
const stagingGoogleGets = new Set([
  "/api/auth/callback/google", "/api/auth/session", "/api/auth/providers", "/api/auth/csrf",
]);

export async function GET(request: NextRequest) {
  if (!permitsP506CandidateRequest(request)) return rejectOrigin();
  if (stagingGoogleGets.has(request.nextUrl.pathname) && await stagingOwnerRequest()) {
    return handlers.GET(request);
  }
  return gatedGet(request);
}

export async function POST(request: NextRequest) {
  return permitsP506CandidateRequest(request) ? gatedPost(request) : rejectOrigin();
}
