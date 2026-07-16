import "server-only";

import { and, eq } from "drizzle-orm";

import { bookingCalendarConnections } from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

export type GoogleCalendarCredentialResolution =
  | { connectionId: string; status: "saved" }
  | { connectionId: string; status: "reconnected_existing" }
  | { status: "owned_elsewhere" };

export async function resolveAndSaveGoogleCalendarCredential(
  tx: AdminWriteTransaction,
  input: {
    accountEmail: string;
    actorAdminUserId: string;
    connectionId: string;
    credentialCiphertext: string;
    now: Date;
    providerAccountId: string;
    scopes: string[];
  },
): Promise<GoogleCalendarCredentialResolution> {
  const [provisional] = await tx
    .select({
      credentialOwnerAdminUserId:
        bookingCalendarConnections.credentialOwnerAdminUserId,
      id: bookingCalendarConnections.id,
    })
    .from(bookingCalendarConnections)
    .where(
      and(
        eq(bookingCalendarConnections.id, input.connectionId),
        eq(bookingCalendarConnections.provider, "google"),
      ),
    )
    .limit(1)
    .for("update");
  if (
    provisional === undefined ||
    (provisional.credentialOwnerAdminUserId !== null &&
      provisional.credentialOwnerAdminUserId !== input.actorAdminUserId)
  ) {
    throw new Error("Calendar connection is not owned by this user");
  }

  const [duplicate] = await tx
    .select({
      credentialOwnerAdminUserId:
        bookingCalendarConnections.credentialOwnerAdminUserId,
      id: bookingCalendarConnections.id,
    })
    .from(bookingCalendarConnections)
    .where(
      and(
        eq(bookingCalendarConnections.provider, "google"),
        eq(
          bookingCalendarConnections.providerAccountId,
          input.providerAccountId,
        ),
      ),
    )
    .limit(1)
    .for("update");

  if (duplicate !== undefined && duplicate.id !== input.connectionId) {
    await disableProvisionalConnection(tx, input.connectionId, input.now);
    if (duplicate.credentialOwnerAdminUserId !== input.actorAdminUserId) {
      return { status: "owned_elsewhere" };
    }

    await activateConnection(tx, duplicate.id, input);
    return {
      connectionId: duplicate.id,
      status: "reconnected_existing",
    };
  }

  await activateConnection(tx, input.connectionId, input, true);
  return { connectionId: input.connectionId, status: "saved" };
}

async function activateConnection(
  tx: AdminWriteTransaction,
  connectionId: string,
  input: Parameters<typeof resolveAndSaveGoogleCalendarCredential>[1],
  setProviderAccountId = false,
): Promise<void> {
  const [saved] = await tx
    .update(bookingCalendarConnections)
    .set({
      accountEmail: input.accountEmail,
      connectedByAdminUserId: input.actorAdminUserId,
      credentialCiphertext: input.credentialCiphertext,
      credentialOwnerAdminUserId: input.actorAdminUserId,
      credentialSecretRef: null,
      disabledAt: null,
      lastErrorCode: null,
      lastVerifiedAt: input.now,
      ...(setProviderAccountId
        ? { providerAccountId: input.providerAccountId }
        : {}),
      scopes: input.scopes,
      status: "active",
      updatedAt: input.now,
    })
    .where(eq(bookingCalendarConnections.id, connectionId))
    .returning({ id: bookingCalendarConnections.id });
  if (saved === undefined) throw new Error("Calendar connection was not found");
}

async function disableProvisionalConnection(
  tx: AdminWriteTransaction,
  connectionId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(bookingCalendarConnections)
    .set({
      credentialCiphertext: null,
      credentialSecretRef: null,
      disabledAt: now,
      status: "disabled",
      updatedAt: now,
    })
    .where(eq(bookingCalendarConnections.id, connectionId));
}
