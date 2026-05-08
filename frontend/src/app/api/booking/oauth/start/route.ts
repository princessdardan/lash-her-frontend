import { nanoid } from "nanoid";
import { NextRequest, NextResponse } from "next/server";

import { getOAuthConsentUrl } from "@/lib/booking/google-calendar";
import { getBookingEnv } from "@/sanity/env";

const OAUTH_STATE_COOKIE = "booking_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export function GET(req: NextRequest): NextResponse {
  const env = getBookingEnv();
  const secret = req.nextUrl.searchParams.get("secret");

  if (secret !== env.bookingAdminSetupSecret) {
    return new NextResponse(null, { status: 404 });
  }

  const state = nanoid();
  const response = NextResponse.redirect(getOAuthConsentUrl(state));

  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });

  return response;
}
