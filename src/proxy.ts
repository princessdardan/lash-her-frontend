import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  ADMIN_DEVELOPER_MODE_COOKIE,
  isAdminDeveloperModeEnabled,
} from "@/lib/admin/developer-mode-config";

const PUBLIC_ADMIN_PATHS = new Set(["/admin/not-authorized", "/admin/sign-in"]);
const ADMIN_REQUEST_ID_HEADER = "x-lash-admin-request-id";

export default auth((request) => {
  const { pathname, search } = request.nextUrl;
  const isPublicAdminPath = PUBLIC_ADMIN_PATHS.has(pathname);
  const hasDeveloperSession =
    isAdminDeveloperModeEnabled() &&
    request.cookies.has(ADMIN_DEVELOPER_MODE_COOKIE);

  if (!request.auth && !hasDeveloperSession && !isPublicAdminPath) {
    const signInUrl = new URL("/admin/sign-in", request.nextUrl.origin);
    signInUrl.searchParams.set("returnTo", `${pathname}${search}`);

    return NextResponse.redirect(signInUrl);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(ADMIN_REQUEST_ID_HEADER, crypto.randomUUID());

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
});

export const config = {
  matcher: ["/admin/:path*"],
};
