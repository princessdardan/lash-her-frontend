import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { withAdminAuthRouteAdmission } from "@/lib/admin/auth-route-admission";
import { stagingOwnerRequest } from "@/lib/admin/staging-owner-auth";

const gatedGet = withAdminAuthRouteAdmission(handlers.GET);
const stagingGoogleGets = new Set([
  "/api/auth/callback/google", "/api/auth/session", "/api/auth/providers", "/api/auth/csrf",
]);

export async function GET(request: NextRequest) {
  if (stagingGoogleGets.has(request.nextUrl.pathname) && await stagingOwnerRequest()) {
    return handlers.GET(request);
  }
  return gatedGet(request);
}

export const POST = withAdminAuthRouteAdmission(handlers.POST);
