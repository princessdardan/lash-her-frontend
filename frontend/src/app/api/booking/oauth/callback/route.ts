import type { NextRequest } from "next/server";

import { createOAuthClient } from "@/lib/booking/google-calendar";
import { saveGoogleRefreshToken } from "@/lib/booking/operational-store";

const OAUTH_STATE_COOKIE = "booking_oauth_state";

export async function GET(req: NextRequest): Promise<Response> {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (
    code === null ||
    state === null ||
    cookieState === undefined ||
    state !== cookieState
  ) {
    return new Response("Invalid OAuth callback", { status: 400 });
  }

  try {
    const oauthClient = createOAuthClient();
    const { tokens } = await oauthClient.getToken(code);

    if (typeof tokens.refresh_token !== "string") {
      return new Response(
        "Google did not return a refresh token. Retry setup and approve offline access.",
        { status: 400 },
      );
    }

    await saveGoogleRefreshToken(tokens.refresh_token);

    return new Response("Google Calendar booking OAuth is connected", {
      status: 200,
    });
  } catch (error) {
    console.error("[booking oauth callback] Failed:", getErrorMessage(error));

    return new Response("OAuth setup failed", { status: 500 });
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
