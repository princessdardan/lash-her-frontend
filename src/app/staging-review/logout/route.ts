import { NextResponse } from "next/server";
import { reviewCookie, reviewCookieOptions, reviewPath, reviewSameOrigin, reviewSettings } from "@/lib/staging-review/session";

export function POST(request: Request) {
  if (!reviewSettings()) return new Response(null, { status: 404 });
  if (!reviewSameOrigin(request)) return new Response(null, { status: 403 });
  const response = NextResponse.redirect(new URL(reviewPath, request.url), 303);
  response.headers.set("cache-control", "no-store");
  response.cookies.set(reviewCookie, "", { ...reviewCookieOptions, maxAge: 0 });
  return response;
}
