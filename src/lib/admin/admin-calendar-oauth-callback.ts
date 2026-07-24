import type { BookingCalendarOAuthState } from "@/lib/booking/calendar-oauth-state";

export interface AdminCalendarOAuthCallbackDependencies {
  assertEmployeeOwnsConnection(input: {
    connectionId: string;
    resourceId: string;
  }): Promise<unknown>;
  authorizeActor(state: BookingCalendarOAuthState): Promise<{
    user: { id: string };
  }>;
  consumeState(state: string): Promise<BookingCalendarOAuthState | null>;
  disableProvisionalConnection(
    state: BookingCalendarOAuthState,
  ): Promise<void>;
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
  }): Promise<{ status: "owned_elsewhere" | "reconnected_existing" | "saved" }>;
  saveOwnerCredential(input: {
    accountEmail: string;
    connectionId: string;
    providerAccountId: string;
    refreshToken: string;
    scopes: string[];
  }): Promise<{ status: "owned_elsewhere" | "reconnected_existing" | "saved" }>;
}

export async function handleAdminCalendarOAuthCallback(
  input: { code: string | null; origin: string; state: string },
  dependencies: AdminCalendarOAuthCallbackDependencies,
): Promise<Response> {
  if (input.code === null) {
    return new Response("Invalid OAuth callback", { status: 400 });
  }

  const statePayload = await dependencies.consumeState(input.state);
  if (statePayload === null) {
    return new Response("OAuth authorization expired or was already used", {
      status: 400,
    });
  }

  let issuedRefreshToken: string | undefined;
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

    const grant = await dependencies.exchangeCode(input.code);
    issuedRefreshToken = grant.refreshToken;
    if (issuedRefreshToken === undefined) {
      await cleanupRejectedGrant(dependencies, statePayload);
      return oauthRedirect(
        statePayload.returnTo,
        input.origin,
        "error",
        "Google did not return offline access. Reconnect and approve the requested access.",
      );
    }

    const profile = await grant.getVerifiedProfile();
    const providerAccountId = profile.providerAccountId;
    const accountEmail = profile.accountEmail;
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
      );
      return oauthRedirect(
        statePayload.returnTo,
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
      await cleanupRejectedGrant(
        dependencies,
        statePayload,
        issuedRefreshToken,
      );
      return oauthRedirect(
        statePayload.returnTo,
        input.origin,
        "error",
        "That Google account is already managed by another employee or by the owner. Contact the owner to transfer it.",
      );
    }

    return oauthRedirect(
      statePayload.returnTo,
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
      );
    }
    return oauthRedirect(
      statePayload.returnTo,
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
): Promise<void> {
  await Promise.allSettled([
    dependencies.disableProvisionalConnection(state),
    ...(refreshToken === undefined
      ? []
      : [dependencies.revokeRefreshToken(refreshToken)]),
  ]);
}

function oauthRedirect(
  returnTo: string,
  origin: string,
  kind: "error" | "notice",
  message: string,
): Response {
  const redirectUrl = new URL(returnTo, origin);
  redirectUrl.searchParams.set(kind, message);
  return new Response(null, {
    headers: { location: redirectUrl.toString() },
    status: 307,
  });
}
