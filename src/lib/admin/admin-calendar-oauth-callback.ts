import type { BookingCalendarOAuthState } from "@/lib/booking/calendar-oauth-state";
import { toContractorTerminology } from "@/lib/admin/presentation";

export interface AdminCalendarOAuthCallbackDependencies {
  assertEmployeeOwnsConnection(input: {
    connectionId: string;
    resourceId: string;
  }): Promise<unknown>;
  authorizeActor(state: BookingCalendarOAuthState): Promise<{
    user: { id: string };
  }>;
  canRevokeRejectedGrant(
    state: BookingCalendarOAuthState,
    providerAccountId: string | undefined,
  ): Promise<boolean>;
  consumeState(state: string): Promise<BookingCalendarOAuthState | null>;
  disableProvisionalConnection(state: BookingCalendarOAuthState): Promise<void>;
  exchangeCode(code: string): Promise<{
    getVerifiedProfile(): Promise<{
      accountEmail?: string | null;
      providerAccountId?: string | null;
      verified: boolean;
    }>;
    refreshToken?: string;
    scopes: string[];
  }>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
  saveEmployeeCredential(input: {
    accountEmail: string;
    connectionId: string;
    providerAccountId: string;
    refreshToken: string;
    resourceId: string;
    scopes: string[];
  }): Promise<
    | {
        connectionId: string;
        status: "account_mismatch";
      }
    | { connectionId: string; status: "reconnected_existing" | "saved" }
    | { status: "owned_elsewhere" }
  >;
  saveOwnerCredential(input: {
    accountEmail: string;
    connectionId: string;
    providerAccountId: string;
    refreshToken: string;
    scopes: string[];
  }): Promise<
    | {
        connectionId: string;
        status: "account_mismatch";
      }
    | { connectionId: string; status: "reconnected_existing" | "saved" }
    | { status: "owned_elsewhere" }
  >;
}

export async function handleAdminCalendarOAuthCallback(
  input: { code: string | null; origin: string; state: string },
  dependencies: AdminCalendarOAuthCallbackDependencies,
): Promise<Response> {
  const statePayload = await dependencies.consumeState(input.state);
  if (statePayload === null) {
    return new Response("OAuth authorization expired or was already used", {
      status: 400,
    });
  }

  let issuedRefreshToken: string | undefined;
  let issuedProviderAccountId: string | undefined;
  try {
    const actor = await dependencies.authorizeActor(statePayload);
    if (actor.user.id !== statePayload.actorAdminUserId) {
      return new Response("OAuth authorization does not belong to this user", {
        status: 403,
      });
    }

    if (statePayload.flowType === "employee") {
      await dependencies.assertEmployeeOwnsConnection({
        connectionId: statePayload.connectionId,
        resourceId: statePayload.resourceId!,
      });
    }

    if (input.code === null) {
      await cleanupRejectedGrant(dependencies, statePayload);
      return oauthRedirect(
        statePayload,
        input.origin,
        "error",
        "Google Calendar authorization was denied or cancelled.",
      );
    }

    const grant = await dependencies.exchangeCode(input.code);
    issuedRefreshToken = grant.refreshToken;
    if (issuedRefreshToken === undefined) {
      await cleanupRejectedGrant(dependencies, statePayload);
      return oauthRedirect(
        statePayload,
        input.origin,
        "error",
        "Google did not return offline access. Reconnect and approve the requested access.",
      );
    }

    const profile = await grant.getVerifiedProfile();
    const providerAccountId = profile.providerAccountId;
    const accountEmail = profile.accountEmail;
    issuedProviderAccountId =
      typeof providerAccountId === "string" && providerAccountId.length > 0
        ? providerAccountId
        : undefined;
    if (
      typeof providerAccountId !== "string" ||
      providerAccountId.length === 0 ||
      typeof accountEmail !== "string" ||
      accountEmail.length === 0 ||
      profile.verified !== true
    ) {
      await cleanupRejectedGrant(
        dependencies,
        statePayload,
        issuedRefreshToken,
        issuedProviderAccountId,
      );
      return oauthRedirect(
        statePayload,
        input.origin,
        "error",
        "The Google account identity could not be verified.",
      );
    }

    const result =
      statePayload.flowType === "employee"
        ? await dependencies.saveEmployeeCredential({
            accountEmail,
            connectionId: statePayload.connectionId,
            providerAccountId,
            refreshToken: issuedRefreshToken,
            resourceId: statePayload.resourceId!,
            scopes: grant.scopes,
          })
        : await dependencies.saveOwnerCredential({
            accountEmail,
            connectionId: statePayload.connectionId,
            providerAccountId,
            refreshToken: issuedRefreshToken,
            scopes: grant.scopes,
          });
    if (result.status === "owned_elsewhere") {
      return oauthRedirect(
        statePayload,
        input.origin,
        "error",
        "That Google account is already managed by another contractor or by the owner. Contact the owner to transfer it.",
      );
    }
    if (result.status === "account_mismatch") {
      return oauthRedirect(
        statePayload,
        input.origin,
        "error",
        "Reconnect with the Google account already assigned to this connection.",
      );
    }

    return oauthRedirect(
      statePayload,
      input.origin,
      "notice",
      "Google Calendar account connected.",
    );
  } catch {
    if (issuedRefreshToken !== undefined) {
      await cleanupRejectedGrant(
        dependencies,
        statePayload,
        issuedRefreshToken,
        issuedProviderAccountId,
      );
    }
    return oauthRedirect(
      statePayload,
      input.origin,
      "error",
      "Google Calendar authorization failed. Retry the connection.",
    );
  }
}

async function cleanupRejectedGrant(
  dependencies: AdminCalendarOAuthCallbackDependencies,
  state: BookingCalendarOAuthState,
  refreshToken?: string,
  providerAccountId?: string,
): Promise<void> {
  await Promise.allSettled([dependencies.disableProvisionalConnection(state)]);
  if (refreshToken === undefined) {
    return;
  }

  let canRevoke = false;
  try {
    canRevoke = await dependencies.canRevokeRejectedGrant(
      state,
      providerAccountId,
    );
  } catch {
    // Preserve the external grant when local state cannot establish safety.
  }
  if (canRevoke) {
    await Promise.allSettled([dependencies.revokeRefreshToken(refreshToken)]);
  }
}

function oauthRedirect(
  state: BookingCalendarOAuthState,
  origin: string,
  kind: "error" | "notice",
  message: string,
): Response {
  const returnTo =
    state.flowType === "employee"
      ? "/admin/my-calendar"
      : "/admin/calendar-connections";
  const redirectUrl = new URL(returnTo, origin);
  redirectUrl.searchParams.set(kind, toContractorTerminology(message));
  return new Response(null, {
    headers: { location: redirectUrl.toString() },
    status: 307,
  });
}
