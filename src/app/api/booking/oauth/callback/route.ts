import type { NextRequest } from "next/server";
import { eq, or } from "drizzle-orm";
import { google } from "googleapis";

import {
  handleAdminCalendarOAuthCallback,
  type AdminCalendarOAuthCallbackDependencies,
} from "@/lib/admin/admin-calendar-oauth-callback";
import { createOAuthClient } from "@/lib/booking/google-calendar";
import {
  consumeBookingCalendarOAuthState,
  saveGoogleRefreshToken,
} from "@/lib/booking/operational-store";
import { getPrivateDb } from "@/lib/private-db/client";
import { bookingCalendarConnections } from "@/lib/private-db/schema";

const OAUTH_STATE_COOKIE = "booking_oauth_state";

export async function GET(req: NextRequest): Promise<Response> {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");

  if (
    state?.startsWith("calendar_") ||
    state?.startsWith("admin_") ||
    state?.startsWith("employee_")
  ) {
    return handleAdminCalendarOAuthCallback(
      {
        code,
        origin: req.nextUrl.origin,
        state,
      },
      adminCallbackDependencies,
    );
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

const adminCallbackDependencies: AdminCalendarOAuthCallbackDependencies = {
  async assertEmployeeOwnsConnection(input) {
    const { assertEmployeeOwnsCalendarConnection } =
      await import("@/lib/admin/employee-calendar");
    return assertEmployeeOwnsCalendarConnection(input);
  },
  async authorizeActor(state) {
    const { requirePermission } = await import("@/lib/admin/auth");
    return state.flowType === "employee"
      ? requirePermission("calendar-connections:self-manage", {
          bookingResourceId: state.resourceId!,
        })
      : requirePermission("calendar-connections:manage");
  },
  async canRevokeRejectedGrant(state, providerAccountId) {
    if (providerAccountId === undefined) {
      return false;
    }
    const connections = await getPrivateDb()
      .select({
        id: bookingCalendarConnections.id,
        providerAccountId: bookingCalendarConnections.providerAccountId,
      })
      .from(bookingCalendarConnections)
      .where(
        or(
          eq(bookingCalendarConnections.id, state.connectionId),
          eq(bookingCalendarConnections.providerAccountId, providerAccountId),
        ),
      );
    const target = connections.find(
      (connection) => connection.id === state.connectionId,
    );
    return (
      target?.providerAccountId === null &&
      !connections.some(
        (connection) =>
          connection.id !== state.connectionId &&
          connection.providerAccountId === providerAccountId,
      )
    );
  },
  consumeState: consumeBookingCalendarOAuthState,
  async disableProvisionalConnection(state) {
    if (state.flowType === "employee") {
      const { disableEmployeeCalendarConnectionAfterOAuthFailure } =
        await import("@/lib/admin/employee-calendar");
      await disableEmployeeCalendarConnectionAfterOAuthFailure({
        connectionId: state.connectionId,
        resourceId: state.resourceId!,
      });
      return;
    }

    const { disableAdminCalendarConnectionAfterOAuthFailure } =
      await import("@/lib/admin/operations-write");
    await disableAdminCalendarConnectionAfterOAuthFailure(state.connectionId);
  },
  async exchangeCode(code) {
    const oauthClient = createOAuthClient();
    const { tokens } = await oauthClient.getToken(code);
    const scopes =
      typeof tokens.scope === "string"
        ? tokens.scope.split(/\s+/).filter(Boolean)
        : [];
    return {
      async getVerifiedProfile() {
        oauthClient.setCredentials(tokens);
        const profileResponse = await google
          .oauth2({ auth: oauthClient, version: "v2" })
          .userinfo.get();
        return {
          accountEmail: profileResponse.data.email,
          providerAccountId: profileResponse.data.id,
          verified: profileResponse.data.verified_email === true,
        };
      },
      refreshToken: tokens.refresh_token ?? undefined,
      scopes,
    };
  },
  async revokeRefreshToken(refreshToken) {
    const { revokeGoogleTokenBestEffort } =
      await import("@/lib/booking/google-calendar");
    await revokeGoogleTokenBestEffort(refreshToken);
  },
  async saveEmployeeCredential(input) {
    const { saveEmployeeGoogleCalendarCredential } =
      await import("@/lib/admin/employee-calendar");
    return saveEmployeeGoogleCalendarCredential(input);
  },
  async saveOwnerCredential(input) {
    const { saveAdminGoogleCalendarCredential } =
      await import("@/lib/admin/operations-write");
    return saveAdminGoogleCalendarCredential(input);
  },
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
