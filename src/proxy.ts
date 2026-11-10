import {
  NextResponse,
  type NextRequest,
  type NextFetchEvent,
} from "next/server";
import {
  FRESHA_BOOKING_URL,
  isServiceBookingEntryPath,
  serviceBookingMovedResponse,
} from "@/lib/booking/fresha";

import { auth } from "@/auth";
import {
  ADMIN_DEVELOPER_MODE_COOKIE,
  isAdminDeveloperModeEnabled,
} from "@/lib/admin/developer-mode-config";
import { interactiveRequestHeaders } from "@/lib/writer-admission/interactive-proof";

const PUBLIC_ADMIN_PATHS = new Set(["/admin/not-authorized", "/admin/sign-in"]);
const ADMIN_REQUEST_ID_HEADER = "x-lash-admin-request-id";

const adminProxy = auth((request, event: NextFetchEvent) => {
  void event;
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

  const requestHeaders = interactiveRequestHeaders(request) ?? new Headers(request.headers);
  requestHeaders.set(ADMIN_REQUEST_ID_HEADER, crypto.randomUUID());

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (isServiceBookingEntryPath(request.nextUrl.pathname)) {
    // A 307 preserves the method and body: never forward a submitted form to Fresha.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return serviceBookingMovedResponse(request);
    }
    // Redirect before layouts start streaming; do not copy the incoming query.
    return NextResponse.redirect(FRESHA_BOOKING_URL, 307);
  }
  if (
    request.nextUrl.pathname === "/admin" ||
    request.nextUrl.pathname.startsWith("/admin/")
  ) {
    return adminProxy(request, event);
  }
  const headers = interactiveRequestHeaders(request);
  return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
}

export const config = {
  matcher: [
    "/admin/:path*", "/booking", "/services/:slug/booking",
    { source: "/:path*", has: [{ type: "cookie", key: "__Host-lash-p2q-window" }] },
    { source: "/:path*", has: [{ type: "header", key: "x-lash-internal-interactive-admission" }] },
  ],
};
