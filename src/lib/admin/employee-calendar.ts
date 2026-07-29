import "server-only";

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import { encryptCalendarCredential } from "@/lib/booking/calendar-credential-secret";
import {
  listConnectionGoogleCalendars,
  type GoogleCalendarOption,
} from "@/lib/booking/google-calendar";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUserResources,
  bookingCalendarConnections,
  bookingResourceCalendarAssignments,
  bookingResources,
} from "@/lib/private-db/schema";

import {
  runAuditedAdminMutation,
  type AdminWriteTransaction,
} from "./admin-transaction";
import { requirePermission } from "./auth";
import { assertEmployeeBusyAssignmentCanBeSaved } from "./calendar-assignment-authorization";
import { getCalendarAssignmentAccessError } from "./calendar-capabilities";
import { revokeEncryptedGoogleCredentialBestEffort } from "./calendar-credential-revocation";
import {
  lockEmployeeCalendarInvariant,
  requireActiveEmployeeProviderResourceUnderInvariantLock,
} from "./employee-calendar-invariant";
import {
  disableProvisionalGoogleCalendarConnection,
  resolveAndSaveGoogleCalendarCredential,
} from "./google-calendar-credential-resolution";
import {
  getEmployeeAssignmentDisableError,
  getEmployeeDisconnectError,
} from "./calendar-self-service-policy";
import type { AdminActor } from "./types";

export async function listEmployeeCalendarWorkspace() {
  const actor = await requirePermission("calendar-connections:self-manage");
  assertEmployee(actor);
  const db = getPrivateDb();

  if (actor.bookingProviderResourceIds.length === 0) {
    return { assignments: [], connections: [], resources: [] };
  }

  const [connections, resources, assignments] = await Promise.all([
    db
      .select({
        accountEmail: bookingCalendarConnections.accountEmail,
        id: bookingCalendarConnections.id,
        lastErrorCode: bookingCalendarConnections.lastErrorCode,
        lastVerifiedAt: bookingCalendarConnections.lastVerifiedAt,
        status: bookingCalendarConnections.status,
      })
      .from(bookingCalendarConnections)
      .where(
        and(
          eq(
            bookingCalendarConnections.credentialOwnerAdminUserId,
            actor.user.id,
          ),
          ne(bookingCalendarConnections.status, "disabled"),
        ),
      )
      .orderBy(asc(bookingCalendarConnections.accountEmail)),
    db
      .select({ id: bookingResources.id, name: bookingResources.name })
      .from(bookingResources)
      .where(
        and(
          inArray(bookingResources.id, actor.bookingProviderResourceIds),
          eq(bookingResources.kind, "provider"),
        ),
      )
      .orderBy(asc(bookingResources.name)),
    db
      .select({
        acceptsBookings: bookingResourceCalendarAssignments.acceptsBookings,
        calendarLabel: bookingResourceCalendarAssignments.calendarLabel,
        connectionAccountEmail: bookingCalendarConnections.accountEmail,
        connectionId: bookingResourceCalendarAssignments.calendarConnectionId,
        connectionOwnerAdminUserId:
          bookingCalendarConnections.credentialOwnerAdminUserId,
        contributesBusy: bookingResourceCalendarAssignments.contributesBusy,
        id: bookingResourceCalendarAssignments.id,
        providerCalendarId:
          bookingResourceCalendarAssignments.providerCalendarId,
        resourceId: bookingResourceCalendarAssignments.resourceId,
        resourceName: bookingResources.name,
        status: bookingResourceCalendarAssignments.status,
      })
      .from(bookingResourceCalendarAssignments)
      .innerJoin(
        bookingCalendarConnections,
        eq(
          bookingCalendarConnections.id,
          bookingResourceCalendarAssignments.calendarConnectionId,
        ),
      )
      .innerJoin(
        bookingResources,
        eq(bookingResources.id, bookingResourceCalendarAssignments.resourceId),
      )
      .where(
        and(
          inArray(
            bookingResourceCalendarAssignments.resourceId,
            actor.bookingProviderResourceIds,
          ),
          eq(bookingResourceCalendarAssignments.status, "active"),
          ne(bookingCalendarConnections.status, "disabled"),
        ),
      )
      .orderBy(asc(bookingResources.name)),
  ]);

  return { assignments, connections, resources };
}

export async function createEmployeeCalendarConnection(
  resourceId: string,
): Promise<{ id: string }> {
  const actor = await requireEmployeeResource(resourceId);

  return runAuditedAdminMutation({
    action: "employee_calendar_connection_created",
    actor,
    domain: "calendar",
    metadata: { resourceId },
    mutate: async (tx) => {
      await lockEmployeeCalendarInvariant(tx, actor.user.id);
      await requireActiveEmployeeProviderResourceUnderInvariantLock(tx, {
        employeeUserId: actor.user.id,
        resourceId,
      });
      const [connection] = await tx
        .insert(bookingCalendarConnections)
        .values({
          connectedByAdminUserId: actor.user.id,
          credentialOwnerAdminUserId: actor.user.id,
          provider: "google",
          status: "reconnect_required",
        })
        .returning({ id: bookingCalendarConnections.id });

      if (!connection) {
        throw new Error("Calendar connection was not created");
      }
      return connection;
    },
    targetId: (connection) => connection.id,
    targetType: "calendar_connection",
  });
}

export async function disableEmployeeCalendarConnectionAfterOAuthFailure(input: {
  connectionId: string;
  resourceId: string;
}): Promise<void> {
  const actor = await assertEmployeeOwnsCalendarConnection(input);
  await runAuditedAdminMutation({
    action: "employee_calendar_authorization_failed",
    actor,
    domain: "calendar",
    metadata: { provider: "google", resourceId: input.resourceId },
    mutate: async (tx) => {
      await lockEmployeeCalendarInvariant(tx, actor.user.id);
      return disableProvisionalGoogleCalendarConnection(tx, {
        actorAdminUserId: actor.user.id,
        connectionId: input.connectionId,
        credentialOwnerAdminUserId: actor.user.id,
        now: new Date(),
      });
    },
    targetId: input.connectionId,
    targetType: "calendar_connection",
  });
}

export async function assertEmployeeOwnsCalendarConnection(input: {
  connectionId: string;
  resourceId: string;
}): Promise<AdminActor> {
  const actor = await requireEmployeeResource(input.resourceId);
  const [connection] = await getPrivateDb()
    .select({ id: bookingCalendarConnections.id })
    .from(bookingCalendarConnections)
    .where(
      and(
        eq(bookingCalendarConnections.id, input.connectionId),
        eq(
          bookingCalendarConnections.credentialOwnerAdminUserId,
          actor.user.id,
        ),
        eq(bookingCalendarConnections.provider, "google"),
      ),
    )
    .limit(1);

  if (!connection) {
    throw new Error("Calendar connection is not owned by this contractor");
  }
  return actor;
}

export async function listEmployeeGoogleCalendars(input: {
  connectionId: string;
  resourceId: string;
}): Promise<GoogleCalendarOption[]> {
  await assertEmployeeOwnsCalendarConnection(input);
  return listConnectionGoogleCalendars(input.connectionId);
}

export type EmployeeGoogleCredentialSaveResult =
  | {
      connectionId: string;
      status: "account_mismatch";
    }
  | { connectionId: string; status: "saved" }
  | { connectionId: string; status: "reconnected_existing" }
  | { status: "owned_elsewhere" };

export async function saveEmployeeGoogleCalendarCredential(input: {
  accountEmail: string;
  connectionId: string;
  providerAccountId: string;
  refreshToken: string;
  resourceId: string;
  scopes: string[];
}): Promise<EmployeeGoogleCredentialSaveResult> {
  const actor = await assertEmployeeOwnsCalendarConnection(input);
  const accountEmail = input.accountEmail.trim().toLowerCase();
  const providerAccountId = input.providerAccountId.trim();
  if (!accountEmail || !providerAccountId || !input.refreshToken.trim()) {
    throw new Error("Google account details are incomplete");
  }
  const credentialCiphertext = encryptCalendarCredential(input.refreshToken);
  const scopes = [...new Set(input.scopes.map((scope) => scope.trim()))]
    .filter(Boolean)
    .sort();

  return runAuditedAdminMutation({
    action: "employee_calendar_oauth_completed",
    actor,
    domain: "calendar",
    metadata: { provider: "google", resourceId: input.resourceId },
    mutate: async (tx) => {
      const now = new Date();
      return resolveAndSaveGoogleCalendarCredential(tx, {
        accountEmail,
        actorAdminUserId: actor.user.id,
        canManageAllConnections: false,
        connectionId: input.connectionId,
        credentialCiphertext,
        credentialOwnerAdminUserId: actor.user.id,
        employeeResourceId: input.resourceId,
        now,
        providerAccountId,
        scopes,
      });
    },
    targetId: (result) =>
      "connectionId" in result ? result.connectionId : input.connectionId,
    targetType: "calendar_connection",
  });
}

export async function saveEmployeeBusyAssignment(input: {
  calendarLabel?: string;
  connectionId: string;
  providerCalendarId: string;
  resourceId: string;
}) {
  const actor = await assertEmployeeOwnsCalendarConnection(input);
  const providerCalendarId = input.providerCalendarId.trim();
  if (!providerCalendarId || providerCalendarId === "primary") {
    throw new Error("A canonical Google Calendar ID is required");
  }

  const connectionSnapshot = await loadActiveEmployeeConnectionSnapshot({
    actorAdminUserId: actor.user.id,
    connectionId: input.connectionId,
  });
  let calendar: GoogleCalendarOption | undefined;
  try {
    calendar = (await listConnectionGoogleCalendars(input.connectionId)).find(
      (option) => option.id === providerCalendarId,
    );
  } catch {
    throw new Error(
      "Google Calendar access could not be verified. Reconnect the account and retry",
    );
  }
  const accessError = getCalendarAssignmentAccessError({
    acceptsBookings: false,
    accessRole: calendar?.accessRole ?? null,
  });
  if (accessError) {
    throw new Error(accessError);
  }

  return runAuditedAdminMutation({
    action: "employee_calendar_assignment_saved",
    actor,
    domain: "calendar",
    metadata: {
      acceptsBookings: false,
      contributesBusy: true,
      resourceId: input.resourceId,
    },
    mutate: async (tx) => {
      await lockEmployeeCalendarInvariant(tx, actor.user.id);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.resourceId}::text, 0))`,
      );
      await assertEmployeeProviderResourceAccessInTransaction(tx, {
        actorAdminUserId: actor.user.id,
        resourceId: input.resourceId,
      });
      const [connection] = await tx
        .select({
          credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
          credentialSecretRef: bookingCalendarConnections.credentialSecretRef,
          id: bookingCalendarConnections.id,
          providerAccountId: bookingCalendarConnections.providerAccountId,
          updatedAt: bookingCalendarConnections.updatedAt,
        })
        .from(bookingCalendarConnections)
        .where(
          and(
            eq(bookingCalendarConnections.id, input.connectionId),
            eq(
              bookingCalendarConnections.credentialOwnerAdminUserId,
              actor.user.id,
            ),
            eq(bookingCalendarConnections.status, "active"),
          ),
        )
        .limit(1)
        .for("update");
      if (!connection) {
        throw new Error(
          "Calendar connection is not active or owned by this contractor",
        );
      }
      if (
        connection.providerAccountId !== connectionSnapshot.providerAccountId ||
        connection.updatedAt.getTime() !==
          connectionSnapshot.updatedAt.getTime() ||
        (connection.credentialCiphertext === null) ===
          (connection.credentialSecretRef === null)
      ) {
        throw new Error(
          "Calendar connection changed during verification. Retry the assignment",
        );
      }

      await assertEmployeeBusyAssignmentCanBeSaved(tx, {
        connectionId: input.connectionId,
        providerCalendarId,
        resourceId: input.resourceId,
      });

      const now = new Date();
      const [assignment] = await tx
        .insert(bookingResourceCalendarAssignments)
        .values({
          acceptsBookings: false,
          calendarConnectionId: input.connectionId,
          calendarLabel: input.calendarLabel?.trim() || calendar?.label || null,
          contributesBusy: true,
          createdByAdminUserId: actor.user.id,
          lastErrorCode: null,
          lastVerifiedAt: now,
          providerCalendarId,
          resourceId: input.resourceId,
          status: "active",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            bookingResourceCalendarAssignments.resourceId,
            bookingResourceCalendarAssignments.calendarConnectionId,
            bookingResourceCalendarAssignments.providerCalendarId,
          ],
          set: {
            acceptsBookings: false,
            calendarLabel:
              input.calendarLabel?.trim() || calendar?.label || null,
            contributesBusy: true,
            lastErrorCode: null,
            lastVerifiedAt: now,
            status: "active",
            updatedAt: now,
          },
        })
        .returning({ id: bookingResourceCalendarAssignments.id });
      if (!assignment) {
        throw new Error("Calendar assignment was not saved");
      }
      return assignment;
    },
    targetId: (assignment) => assignment.id,
    targetType: "calendar_assignment",
  });
}

export async function disableEmployeeBusyAssignment(input: {
  assignmentId: string;
  resourceId: string;
}): Promise<void> {
  const actor = await requireEmployeeResource(input.resourceId);

  await runAuditedAdminMutation({
    action: "employee_calendar_assignment_disabled",
    actor,
    domain: "calendar",
    metadata: { resourceId: input.resourceId },
    mutate: async (tx) => {
      await lockEmployeeCalendarInvariant(tx, actor.user.id);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.resourceId}::text, 0))`,
      );
      await assertEmployeeProviderResourceAccessInTransaction(tx, {
        actorAdminUserId: actor.user.id,
        resourceId: input.resourceId,
      });
      const [assignment] = await tx
        .select({
          acceptsBookings: bookingResourceCalendarAssignments.acceptsBookings,
          connectionOwnerAdminUserId:
            bookingCalendarConnections.credentialOwnerAdminUserId,
          resourceId: bookingResourceCalendarAssignments.resourceId,
        })
        .from(bookingResourceCalendarAssignments)
        .innerJoin(
          bookingCalendarConnections,
          eq(
            bookingCalendarConnections.id,
            bookingResourceCalendarAssignments.calendarConnectionId,
          ),
        )
        .where(eq(bookingResourceCalendarAssignments.id, input.assignmentId))
        .limit(1)
        .for("update");

      const policyError = assignment
        ? getEmployeeAssignmentDisableError({
            acceptsBookings: assignment.acceptsBookings,
            connectionOwnedByActor:
              assignment.connectionOwnerAdminUserId === actor.user.id,
            resourceAssignedToActor:
              assignment.resourceId === input.resourceId &&
              actor.bookingProviderResourceIds.includes(assignment.resourceId),
          })
        : "Calendar assignment is outside this contractor's access";
      if (policyError) {
        throw new Error(policyError);
      }

      await tx
        .update(bookingResourceCalendarAssignments)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(eq(bookingResourceCalendarAssignments.id, input.assignmentId));
    },
    targetId: input.assignmentId,
    targetType: "calendar_assignment",
  });
}

export async function disconnectEmployeeCalendarConnection(input: {
  connectionId: string;
  resourceId: string;
}): Promise<void> {
  const actor = await assertEmployeeOwnsCalendarConnection(input);
  const credentialCiphertext = await runAuditedAdminMutation({
    action: "employee_calendar_connection_disconnected",
    actor,
    domain: "calendar",
    metadata: { resourceId: input.resourceId },
    mutate: async (tx) => {
      await lockEmployeeCalendarInvariant(tx, actor.user.id);
      await assertEmployeeProviderResourceAccessInTransaction(tx, {
        actorAdminUserId: actor.user.id,
        resourceId: input.resourceId,
      });
      const [lockedConnection] = await tx
        .select({
          credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
          id: bookingCalendarConnections.id,
        })
        .from(bookingCalendarConnections)
        .where(
          and(
            eq(bookingCalendarConnections.id, input.connectionId),
            eq(
              bookingCalendarConnections.credentialOwnerAdminUserId,
              actor.user.id,
            ),
            eq(bookingCalendarConnections.provider, "google"),
          ),
        )
        .limit(1)
        .for("update");
      if (!lockedConnection) {
        throw new Error("Calendar connection was not found");
      }

      const activeAssignments = await tx
        .select({
          acceptsBookings: bookingResourceCalendarAssignments.acceptsBookings,
          resourceId: bookingResourceCalendarAssignments.resourceId,
        })
        .from(bookingResourceCalendarAssignments)
        .where(
          and(
            eq(
              bookingResourceCalendarAssignments.calendarConnectionId,
              input.connectionId,
            ),
            eq(bookingResourceCalendarAssignments.status, "active"),
          ),
        )
        .for("update");
      const currentProviderResourceIds =
        await listEmployeeProviderResourceIdsInTransaction(tx, actor.user.id);
      if (
        activeAssignments.some(
          (assignment) =>
            !currentProviderResourceIds.includes(assignment.resourceId),
        )
      ) {
        throw new Error(
          "The owner must resolve assignments outside this contractor's resources before disconnecting",
        );
      }
      const disconnectError = getEmployeeDisconnectError(activeAssignments);
      if (disconnectError) {
        throw new Error(disconnectError);
      }

      const now = new Date();
      await tx
        .update(bookingResourceCalendarAssignments)
        .set({ status: "disabled", updatedAt: now })
        .where(
          and(
            eq(
              bookingResourceCalendarAssignments.calendarConnectionId,
              input.connectionId,
            ),
            eq(bookingResourceCalendarAssignments.contributesBusy, true),
          ),
        );
      const [connection] = await tx
        .update(bookingCalendarConnections)
        .set({
          credentialCiphertext: null,
          credentialSecretRef: null,
          disabledAt: now,
          status: "disabled",
          updatedAt: now,
        })
        .where(
          and(
            eq(bookingCalendarConnections.id, input.connectionId),
            eq(
              bookingCalendarConnections.credentialOwnerAdminUserId,
              actor.user.id,
            ),
          ),
        )
        .returning({ id: bookingCalendarConnections.id });
      if (!connection) {
        throw new Error("Calendar connection was not found");
      }
      return lockedConnection.credentialCiphertext;
    },
    targetId: input.connectionId,
    targetType: "calendar_connection",
  });

  await revokeEncryptedGoogleCredentialBestEffort(credentialCiphertext);
}

async function requireEmployeeResource(
  resourceId: string,
): Promise<AdminActor> {
  const normalized = resourceId.trim();
  if (!normalized) {
    throw new Error("Booking resource is required");
  }
  const actor = await requirePermission("calendar-connections:self-manage", {
    bookingResourceId: normalized,
  });
  assertEmployee(actor);
  await assertEmployeeProviderResourceAccess(normalized, actor.user.id);
  return actor;
}

function assertEmployee(actor: AdminActor): void {
  if (actor.user.role !== "employee") {
    throw new Error(
      "Contractor calendar self-service is available to contractors only",
    );
  }
}

async function assertEmployeeProviderResourceAccess(
  resourceId: string,
  actorAdminUserId: string,
): Promise<void> {
  const [resource] = await getPrivateDb()
    .select({ id: bookingResources.id })
    .from(adminUserResources)
    .innerJoin(
      bookingResources,
      eq(bookingResources.id, adminUserResources.bookingResourceId),
    )
    .where(
      and(
        eq(adminUserResources.adminUserId, actorAdminUserId),
        eq(adminUserResources.bookingResourceId, resourceId),
        eq(bookingResources.kind, "provider"),
      ),
    )
    .limit(1);
  if (!resource) {
    throw new Error("Calendar resource is outside this contractor's access");
  }
}

async function assertEmployeeProviderResourceAccessInTransaction(
  tx: AdminWriteTransaction,
  input: { actorAdminUserId: string; resourceId: string },
): Promise<void> {
  await requireActiveEmployeeProviderResourceUnderInvariantLock(tx, {
    employeeUserId: input.actorAdminUserId,
    resourceId: input.resourceId,
  });
}

async function listEmployeeProviderResourceIdsInTransaction(
  tx: AdminWriteTransaction,
  actorAdminUserId: string,
): Promise<string[]> {
  const resources = await tx
    .select({ id: bookingResources.id })
    .from(adminUserResources)
    .innerJoin(
      bookingResources,
      eq(bookingResources.id, adminUserResources.bookingResourceId),
    )
    .where(
      and(
        eq(adminUserResources.adminUserId, actorAdminUserId),
        eq(bookingResources.kind, "provider"),
      ),
    );
  return resources.map((resource) => resource.id);
}

async function loadActiveEmployeeConnectionSnapshot(input: {
  actorAdminUserId: string;
  connectionId: string;
}): Promise<{ providerAccountId: string; updatedAt: Date }> {
  const [connection] = await getPrivateDb()
    .select({
      providerAccountId: bookingCalendarConnections.providerAccountId,
      updatedAt: bookingCalendarConnections.updatedAt,
    })
    .from(bookingCalendarConnections)
    .where(
      and(
        eq(bookingCalendarConnections.id, input.connectionId),
        eq(
          bookingCalendarConnections.credentialOwnerAdminUserId,
          input.actorAdminUserId,
        ),
        eq(bookingCalendarConnections.provider, "google"),
        eq(bookingCalendarConnections.status, "active"),
      ),
    )
    .limit(1);
  if (!connection?.providerAccountId) {
    throw new Error(
      "Calendar connection is not active or owned by this contractor",
    );
  }
  return {
    providerAccountId: connection.providerAccountId,
    updatedAt: connection.updatedAt,
  };
}
