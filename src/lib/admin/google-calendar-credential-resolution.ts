import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { bookingCalendarConnections } from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";
import {
  lockEmployeeCalendarInvariants,
  requireActiveEmployeeProviderResourceUnderInvariantLock,
} from "./employee-calendar-invariant";

export type GoogleCalendarCredentialResolution =
  | {
      connectionId: string;
      status: "account_mismatch";
    }
  | { connectionId: string; status: "saved" }
  | { connectionId: string; status: "reconnected_existing" }
  | { status: "owned_elsewhere" };

export async function resolveAndSaveGoogleCalendarCredential(
  tx: AdminWriteTransaction,
  input: {
    accountEmail: string;
    actorAdminUserId: string;
    canManageAllConnections: boolean;
    connectionId: string;
    credentialCiphertext: string;
    credentialOwnerAdminUserId: string | null;
    employeeResourceId: string | null;
    now: Date;
    providerAccountId: string;
    scopes: string[];
  },
): Promise<GoogleCalendarCredentialResolution> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`google:${input.providerAccountId}`}::text, 0))`,
  );

  const [provisionalSnapshot] = await tx
    .select({
      credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
      credentialOwnerAdminUserId:
        bookingCalendarConnections.credentialOwnerAdminUserId,
      credentialSecretRef: bookingCalendarConnections.credentialSecretRef,
      disabledAt: bookingCalendarConnections.disabledAt,
      id: bookingCalendarConnections.id,
      providerAccountId: bookingCalendarConnections.providerAccountId,
      status: bookingCalendarConnections.status,
      updatedAt: bookingCalendarConnections.updatedAt,
    })
    .from(bookingCalendarConnections)
    .where(
      and(
        eq(bookingCalendarConnections.id, input.connectionId),
        eq(bookingCalendarConnections.provider, "google"),
      ),
    )
    .limit(1);
  if (
    provisionalSnapshot === undefined ||
    (!input.canManageAllConnections &&
      provisionalSnapshot.credentialOwnerAdminUserId !==
        input.credentialOwnerAdminUserId)
  ) {
    throw new Error("Calendar connection is not owned by this user");
  }

  const [duplicateSnapshot] = await tx
    .select({
      credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
      credentialOwnerAdminUserId:
        bookingCalendarConnections.credentialOwnerAdminUserId,
      credentialSecretRef: bookingCalendarConnections.credentialSecretRef,
      disabledAt: bookingCalendarConnections.disabledAt,
      id: bookingCalendarConnections.id,
      providerAccountId: bookingCalendarConnections.providerAccountId,
      status: bookingCalendarConnections.status,
      updatedAt: bookingCalendarConnections.updatedAt,
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
    .limit(1);

  await lockEmployeeCalendarInvariants(tx, [
    input.credentialOwnerAdminUserId,
    provisionalSnapshot.credentialOwnerAdminUserId,
    duplicateSnapshot?.credentialOwnerAdminUserId,
  ]);
  if (
    input.employeeResourceId !== null &&
    input.credentialOwnerAdminUserId !== null
  ) {
    await requireActiveEmployeeProviderResourceUnderInvariantLock(tx, {
      employeeUserId: input.credentialOwnerAdminUserId,
      resourceId: input.employeeResourceId,
    });
  }

  const [provisional] = await tx
    .select({
      credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
      credentialOwnerAdminUserId:
        bookingCalendarConnections.credentialOwnerAdminUserId,
      credentialSecretRef: bookingCalendarConnections.credentialSecretRef,
      disabledAt: bookingCalendarConnections.disabledAt,
      id: bookingCalendarConnections.id,
      providerAccountId: bookingCalendarConnections.providerAccountId,
      status: bookingCalendarConnections.status,
      updatedAt: bookingCalendarConnections.updatedAt,
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
    connectionAuthorizationSnapshotChanged(provisionalSnapshot, provisional)
  ) {
    throw new Error("Calendar connection changed. Retry authorization");
  }

  if (
    provisional.providerAccountId !== null &&
    provisional.providerAccountId !== input.providerAccountId
  ) {
    return {
      connectionId: provisional.id,
      status: "account_mismatch",
    };
  }

  const [duplicate] = await tx
    .select({
      credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
      credentialOwnerAdminUserId:
        bookingCalendarConnections.credentialOwnerAdminUserId,
      credentialSecretRef: bookingCalendarConnections.credentialSecretRef,
      disabledAt: bookingCalendarConnections.disabledAt,
      id: bookingCalendarConnections.id,
      providerAccountId: bookingCalendarConnections.providerAccountId,
      status: bookingCalendarConnections.status,
      updatedAt: bookingCalendarConnections.updatedAt,
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
  if (
    (duplicateSnapshot === undefined) !== (duplicate === undefined) ||
    (duplicateSnapshot !== undefined &&
      duplicate !== undefined &&
      connectionAuthorizationSnapshotChanged(duplicateSnapshot, duplicate))
  ) {
    throw new Error("Google account connection changed. Retry authorization");
  }

  if (duplicate !== undefined && duplicate.id !== input.connectionId) {
    await disableProvisionalConnection(tx, input.connectionId, input.now);
    if (
      !input.canManageAllConnections &&
      duplicate.credentialOwnerAdminUserId !== input.credentialOwnerAdminUserId
    ) {
      return { status: "owned_elsewhere" };
    }

    await activateConnection(
      tx,
      duplicate.id,
      input,
      false,
      duplicate.credentialOwnerAdminUserId,
    );
    return {
      connectionId: duplicate.id,
      status: "reconnected_existing",
    };
  }

  await activateConnection(
    tx,
    input.connectionId,
    input,
    provisional.providerAccountId === null,
    provisional.providerAccountId === null
      ? input.credentialOwnerAdminUserId
      : provisional.credentialOwnerAdminUserId,
  );
  return { connectionId: input.connectionId, status: "saved" };
}

export async function disableProvisionalGoogleCalendarConnection(
  tx: AdminWriteTransaction,
  input: {
    actorAdminUserId: string;
    connectionId: string;
    credentialOwnerAdminUserId: string | null;
    now: Date;
  },
): Promise<boolean> {
  const [connection] = await tx
    .select({
      credentialOwnerAdminUserId:
        bookingCalendarConnections.credentialOwnerAdminUserId,
      id: bookingCalendarConnections.id,
      status: bookingCalendarConnections.status,
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
    connection === undefined ||
    connection.credentialOwnerAdminUserId !==
      input.credentialOwnerAdminUserId ||
    connection.status !== "reconnect_required"
  ) {
    return false;
  }

  const [disabled] = await tx
    .update(bookingCalendarConnections)
    .set({
      credentialCiphertext: null,
      credentialSecretRef: null,
      disabledAt: input.now,
      status: "disabled",
      updatedAt: input.now,
    })
    .where(eq(bookingCalendarConnections.id, connection.id))
    .returning({ id: bookingCalendarConnections.id });

  return disabled !== undefined;
}

async function activateConnection(
  tx: AdminWriteTransaction,
  connectionId: string,
  input: Parameters<typeof resolveAndSaveGoogleCalendarCredential>[1],
  setProviderAccountId = false,
  credentialOwnerAdminUserId = input.credentialOwnerAdminUserId,
): Promise<void> {
  const [saved] = await tx
    .update(bookingCalendarConnections)
    .set({
      accountEmail: input.accountEmail,
      connectedByAdminUserId: input.actorAdminUserId,
      credentialCiphertext: input.credentialCiphertext,
      credentialOwnerAdminUserId,
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

type ConnectionAuthorizationSnapshot = Pick<
  typeof bookingCalendarConnections.$inferSelect,
  | "credentialCiphertext"
  | "credentialOwnerAdminUserId"
  | "credentialSecretRef"
  | "disabledAt"
  | "id"
  | "providerAccountId"
  | "status"
  | "updatedAt"
>;

function connectionAuthorizationSnapshotChanged(
  before: ConnectionAuthorizationSnapshot,
  after: ConnectionAuthorizationSnapshot,
): boolean {
  return (
    before.id !== after.id ||
    before.credentialOwnerAdminUserId !== after.credentialOwnerAdminUserId ||
    before.providerAccountId !== after.providerAccountId ||
    before.status !== after.status ||
    before.disabledAt?.getTime() !== after.disabledAt?.getTime() ||
    before.updatedAt.getTime() !== after.updatedAt.getTime() ||
    before.credentialCiphertext !== after.credentialCiphertext ||
    before.credentialSecretRef !== after.credentialSecretRef
  );
}
