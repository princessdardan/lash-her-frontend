import { NextResponse } from "next/server";
import { reviewCookie, reviewCookieOptions, reviewPath, reviewSameOrigin, reviewSettings, startReview } from "@/lib/staging-review/session";

export async function POST(request: Request) {
  if (!reviewSettings()) return new Response(null, { status: 404 });
  if (!reviewSameOrigin(request)) return new Response(null, { status: 403 });
  if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded")
    return new Response(null, { status: 415 });
  const response = NextResponse.redirect(new URL(reviewPath, request.url), 303);
  response.headers.set("cache-control", "no-store");
  const body = await request.text();
  const form = new URLSearchParams(body.length <= 400 ? body : "");
  const session = startReview(form.get("account") ?? "", form.get("password") ?? "");
  if (session) response.cookies.set(reviewCookie, session.value, { ...reviewCookieOptions, maxAge: session.maxAge });
  else response.headers.set("location", `${reviewPath}?signIn=failed`);
  return response;
}
