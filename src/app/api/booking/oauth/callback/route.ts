import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { google } from "googleapis";

import { createOAuthClient } from "@/lib/booking/google-calendar";
import {
  consumeBookingCalendarOAuthState,
  saveGoogleRefreshToken,
} from "@/lib/booking/operational-store";

const OAUTH_STATE_COOKIE = "booking_oauth_state";

export async function GET(req: NextRequest): Promise<Response> {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");

  if (
    state?.startsWith("calendar_") ||
    state?.startsWith("admin_") ||
    state?.startsWith("employee_")
  ) {
    return handleAdminCalendarOAuthCallback({ code, req, state });
  }

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

async function handleAdminCalendarOAuthCallback(input: {
  code: string | null;
  req: NextRequest;
  state: string;
}): Promise<Response> {
  if (input.code === null) {
    return new Response("Invalid OAuth callback", { status: 400 });
  }

  const statePayload = await consumeBookingCalendarOAuthState(input.state);

  if (statePayload === null) {
    return new Response("OAuth authorization expired or was already used", {
      status: 400,
    });
  }

  try {
    const { requirePermission } = await import("@/lib/admin/auth");
    const actor = statePayload.flowType === "employee"
      ? await requirePermission("calendar-connections:self-manage", {
          bookingResourceId: statePayload.resourceId!,
        })
      : await requirePermission("calendar-connections:manage");

    if (actor.user.id !== statePayload.actorAdminUserId) {
      return new Response("OAuth authorization does not belong to this user", {
        status: 403,
      });
    }

    if (statePayload.flowType === "employee") {
      const { assertEmployeeOwnsCalendarConnection } = await import(
        "@/lib/admin/employee-calendar"
      );
      await assertEmployeeOwnsCalendarConnection({
        connectionId: statePayload.connectionId,
        resourceId: statePayload.resourceId!,
      });
    }

    const oauthClient = createOAuthClient();
    const { tokens } = await oauthClient.getToken(input.code);

    if (typeof tokens.refresh_token !== "string") {
      return adminOAuthRedirect(
        statePayload.returnTo,
        input.req.nextUrl.origin,
        "error",
        "Google did not return offline access. Reconnect and approve the requested access.",
      );
    }

    oauthClient.setCredentials(tokens);
    const profileResponse = await google
      .oauth2({ auth: oauthClient, version: "v2" })
      .userinfo.get();
    const providerAccountId = profileResponse.data.id;
    const accountEmail = profileResponse.data.email;

    if (
      typeof providerAccountId !== "string" ||
      providerAccountId.length === 0 ||
      typeof accountEmail !== "string" ||
      accountEmail.length === 0 ||
      profileResponse.data.verified_email !== true
    ) {
      return adminOAuthRedirect(
        statePayload.returnTo,
        input.req.nextUrl.origin,
        "error",
        "The Google account identity could not be verified.",
      );
    }

    const scopes = typeof tokens.scope === "string"
      ? tokens.scope.split(/\s+/).filter(Boolean)
      : [];
    if (statePayload.flowType === "employee") {
      const {
        saveEmployeeGoogleCalendarCredential,
      } = await import("@/lib/admin/employee-calendar");
      const result = await saveEmployeeGoogleCalendarCredential({
        accountEmail,
        connectionId: statePayload.connectionId,
        providerAccountId,
        refreshToken: tokens.refresh_token,
        resourceId: statePayload.resourceId!,
        scopes,
      });
      if (result.status === "owned_elsewhere") {
        const { revokeGoogleTokenBestEffort } = await import(
          "@/lib/booking/google-calendar"
        );
        await revokeGoogleTokenBestEffort(tokens.refresh_token);
        return adminOAuthRedirect(
          statePayload.returnTo,
          input.req.nextUrl.origin,
          "error",
          "That Google account is already managed by another employee or by the owner. Contact the owner to transfer it.",
        );
      }
    } else {
      const { saveAdminGoogleCalendarCredential } = await import(
        "@/lib/admin/operations-write"
      );
      await saveAdminGoogleCalendarCredential({
        accountEmail,
        connectionId: statePayload.connectionId,
        providerAccountId,
        refreshToken: tokens.refresh_token,
        scopes,
      });
    }
    const redirectUrl = new URL(statePayload.returnTo, input.req.nextUrl.origin);
    redirectUrl.searchParams.set("notice", "Google Calendar account connected.");

    return NextResponse.redirect(redirectUrl);
  } catch {
    console.error("[booking admin oauth callback] Failed");
    return adminOAuthRedirect(
      statePayload.returnTo,
      input.req.nextUrl.origin,
      "error",
      "Google Calendar authorization failed. Retry the connection.",
    );
  }
}

function adminOAuthRedirect(
  returnTo: string,
  origin: string,
  kind: "error" | "notice",
  message: string,
): Response {
  const redirectUrl = new URL(returnTo, origin);
  redirectUrl.searchParams.set(kind, message);
  return NextResponse.redirect(redirectUrl);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
