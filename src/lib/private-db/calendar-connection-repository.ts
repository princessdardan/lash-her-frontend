import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import {
  getBookingDestinationChangeError,
  getCalendarConnectionDisableError,
} from "@/lib/admin/calendar-destination-policy";
import {
  decryptCalendarCredential,
  encryptCalendarCredential,
} from "@/lib/booking/calendar-credential-secret";

import { getPrivateDb } from "./client";
import {
  bookingCalendarConnections,
  bookingResourceCalendarAssignments,
  bookingResources,
} from "./schema";

export interface CalendarConnectionSummary {
  accountEmail: string | null;
  credentialOwnerAdminUserId: string | null;
  id: string;
  lastErrorCode: string | null;
  lastVerifiedAt: Date | null;
  provider: "google";
  status: "active" | "disabled" | "reconnect_required" | "revoked";
}

export interface ResourceCalendarAssignmentSummary {
  acceptsBookings: boolean;
  calendarLabel: string | null;
  connectionId: string;
  contributesBusy: boolean;
  id: string;
  lastErrorCode: string | null;
  lastVerifiedAt: Date | null;
  providerCalendarId: string;
  resourceId: string;
  status: "active" | "disabled";
}

export interface CalendarConnectionRepository {
  createGoogleConnection(input: {
    actorAdminUserId: string;
    now: Date;
  }): Promise<CalendarConnectionSummary>;
  disableConnection(input: {
    connectionId: string;
    now: Date;
  }): Promise<boolean>;
  getActiveGoogleCredential(
    connectionId: string,
  ): Promise<{ refreshToken: string; scopes: string[] }>;
  listAssignmentsForResource(
    resourceId: string,
  ): Promise<ResourceCalendarAssignmentSummary[]>;
  listConnections(): Promise<CalendarConnectionSummary[]>;
  saveGoogleCredential(input: {
    accountEmail: string;
    actorAdminUserId: string;
    connectionId: string;
    now: Date;
    providerAccountId: string;
    refreshToken: string;
    scopes: string[];
  }): Promise<CalendarConnectionSummary>;
  upsertAssignment(input: {
    acceptsBookings: boolean;
    actorAdminUserId: string;
    calendarLabel?: string;
    confirmedReplacementAssignmentId?: string;
    connectionId: string;
    contributesBusy: boolean;
    now: Date;
    providerCalendarId: string;
    resourceId: string;
  }): Promise<ResourceCalendarAssignmentSummary>;
}

const connectionSelection = {
  accountEmail: bookingCalendarConnections.accountEmail,
  credentialOwnerAdminUserId:
    bookingCalendarConnections.credentialOwnerAdminUserId,
  id: bookingCalendarConnections.id,
  lastErrorCode: bookingCalendarConnections.lastErrorCode,
  lastVerifiedAt: bookingCalendarConnections.lastVerifiedAt,
  provider: bookingCalendarConnections.provider,
  status: bookingCalendarConnections.status,
};

const assignmentSelection = {
  acceptsBookings: bookingResourceCalendarAssignments.acceptsBookings,
  calendarLabel: bookingResourceCalendarAssignments.calendarLabel,
  connectionId: bookingResourceCalendarAssignments.calendarConnectionId,
  contributesBusy: bookingResourceCalendarAssignments.contributesBusy,
  id: bookingResourceCalendarAssignments.id,
  lastErrorCode: bookingResourceCalendarAssignments.lastErrorCode,
  lastVerifiedAt: bookingResourceCalendarAssignments.lastVerifiedAt,
  providerCalendarId: bookingResourceCalendarAssignments.providerCalendarId,
  resourceId: bookingResourceCalendarAssignments.resourceId,
  status: bookingResourceCalendarAssignments.status,
};

export function createDrizzleCalendarConnectionRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): CalendarConnectionRepository {
  return {
    async createGoogleConnection(input) {
      const [row] = await db
        .insert(bookingCalendarConnections)
        .values({
          connectedByAdminUserId: input.actorAdminUserId,
          credentialOwnerAdminUserId: input.actorAdminUserId,
          createdAt: input.now,
          provider: "google",
          status: "reconnect_required",
          updatedAt: input.now,
        })
        .returning(connectionSelection);

      return requireRow(row, "Calendar connection was not created");
    },
    async disableConnection(input) {
      return db.transaction(async (tx) => {
        const [connection] = await tx
          .select({ id: bookingCalendarConnections.id })
          .from(bookingCalendarConnections)
          .where(eq(bookingCalendarConnections.id, input.connectionId))
          .limit(1)
          .for("update");
        if (!connection) {
          return false;
        }

        const activeBookingDestinations = await tx
          .select({
            resourceName: bookingResources.name,
          })
          .from(bookingResourceCalendarAssignments)
          .innerJoin(
            bookingResources,
            eq(
              bookingResources.id,
              bookingResourceCalendarAssignments.resourceId,
            ),
          )
          .where(
            and(
              eq(
                bookingResourceCalendarAssignments.calendarConnectionId,
                input.connectionId,
              ),
              eq(bookingResourceCalendarAssignments.status, "active"),
              eq(bookingResourceCalendarAssignments.acceptsBookings, true),
            ),
          )
          .for("update");
        const disableError = getCalendarConnectionDisableError(
          activeBookingDestinations.map((row) => row.resourceName),
        );
        if (disableError) {
          throw new Error(disableError);
        }

        await tx
          .update(bookingResourceCalendarAssignments)
          .set({ status: "disabled", updatedAt: input.now })
          .where(
            eq(
              bookingResourceCalendarAssignments.calendarConnectionId,
              input.connectionId,
            ),
          );
        const rows = await tx
          .update(bookingCalendarConnections)
          .set({
            credentialCiphertext: null,
            credentialSecretRef: null,
            disabledAt: input.now,
            status: "disabled",
            updatedAt: input.now,
          })
          .where(eq(bookingCalendarConnections.id, input.connectionId))
          .returning({ id: bookingCalendarConnections.id });

        return rows.length === 1;
      });
    },
    async getActiveGoogleCredential(connectionId) {
      const [row] = await db
        .select({
          credentialCiphertext: bookingCalendarConnections.credentialCiphertext,
          provider: bookingCalendarConnections.provider,
          scopes: bookingCalendarConnections.scopes,
          status: bookingCalendarConnections.status,
        })
        .from(bookingCalendarConnections)
        .where(eq(bookingCalendarConnections.id, connectionId))
        .limit(1);

      if (
        !row ||
        row.provider !== "google" ||
        row.status !== "active" ||
        !row.credentialCiphertext
      ) {
        throw new Error("Google Calendar connection is not active");
      }

      return {
        refreshToken: decryptCalendarCredential(row.credentialCiphertext),
        scopes: row.scopes ?? [],
      };
    },
    async listAssignmentsForResource(resourceId) {
      return db
        .select(assignmentSelection)
        .from(bookingResourceCalendarAssignments)
        .where(eq(bookingResourceCalendarAssignments.resourceId, resourceId))
        .orderBy(
          asc(bookingResourceCalendarAssignments.status),
          asc(bookingResourceCalendarAssignments.calendarLabel),
        );
    },
    async listConnections() {
      return db
        .select(connectionSelection)
        .from(bookingCalendarConnections)
        .orderBy(asc(bookingCalendarConnections.accountEmail));
    },
    async saveGoogleCredential(input) {
      const credentialCiphertext = encryptCalendarCredential(
        input.refreshToken,
      );
      const scopes = [...new Set(input.scopes.map((scope) => scope.trim()))]
        .filter(Boolean)
        .sort();
      const [row] = await db
        .update(bookingCalendarConnections)
        .set({
          accountEmail: input.accountEmail.trim().toLowerCase(),
          connectedByAdminUserId: input.actorAdminUserId,
          credentialCiphertext,
          credentialOwnerAdminUserId: input.actorAdminUserId,
          credentialSecretRef: null,
          disabledAt: null,
          lastErrorCode: null,
          lastVerifiedAt: input.now,
          providerAccountId: input.providerAccountId,
          scopes,
          status: "active",
          updatedAt: input.now,
        })
        .where(
          and(
            eq(bookingCalendarConnections.id, input.connectionId),
            eq(bookingCalendarConnections.provider, "google"),
          ),
        )
        .returning(connectionSelection);

      return requireRow(row, "Calendar connection was not found");
    },
    async upsertAssignment(input) {
      const providerCalendarId = input.providerCalendarId.trim();

      if (!providerCalendarId || providerCalendarId === "primary") {
        throw new Error("A canonical Google Calendar ID is required");
      }

      if (!input.contributesBusy && !input.acceptsBookings) {
        throw new Error("Calendar assignment must have a booking role");
      }
      if (input.acceptsBookings && !input.contributesBusy) {
        throw new Error("A booking calendar must also block its busy time");
      }

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.resourceId}::text, 0))`,
        );
        const [connection] = await tx
          .select({
            id: bookingCalendarConnections.id,
            status: bookingCalendarConnections.status,
          })
          .from(bookingCalendarConnections)
          .where(eq(bookingCalendarConnections.id, input.connectionId))
          .limit(1)
          .for("update");
        if (!connection || connection.status !== "active") {
          throw new Error("Calendar connection is not active");
        }

        const [currentDestination] = await tx
          .select({
            assignmentId: bookingResourceCalendarAssignments.id,
            connectionId:
              bookingResourceCalendarAssignments.calendarConnectionId,
            providerCalendarId:
              bookingResourceCalendarAssignments.providerCalendarId,
          })
          .from(bookingResourceCalendarAssignments)
          .where(
            and(
              eq(
                bookingResourceCalendarAssignments.resourceId,
                input.resourceId,
              ),
              eq(bookingResourceCalendarAssignments.status, "active"),
              eq(bookingResourceCalendarAssignments.acceptsBookings, true),
            ),
          )
          .limit(1)
          .for("update");
        const destinationChangeError = getBookingDestinationChangeError({
          acceptsBookings: input.acceptsBookings,
          confirmedReplacementAssignmentId:
            input.confirmedReplacementAssignmentId?.trim() || null,
          currentDestination: currentDestination ?? null,
          requestedConnectionId: input.connectionId,
          requestedProviderCalendarId: providerCalendarId,
        });
        if (destinationChangeError) {
          throw new Error(destinationChangeError);
        }

        if (input.acceptsBookings) {
          await tx
            .update(bookingResourceCalendarAssignments)
            .set({ acceptsBookings: false, updatedAt: input.now })
            .where(
              and(
                eq(
                  bookingResourceCalendarAssignments.resourceId,
                  input.resourceId,
                ),
                eq(bookingResourceCalendarAssignments.acceptsBookings, true),
              ),
            );
        }

        const [row] = await tx
          .insert(bookingResourceCalendarAssignments)
          .values({
            acceptsBookings: input.acceptsBookings,
            calendarConnectionId: input.connectionId,
            calendarLabel: input.calendarLabel?.trim() || null,
            contributesBusy: input.contributesBusy,
            createdAt: input.now,
            createdByAdminUserId: input.actorAdminUserId,
            lastErrorCode: null,
            lastVerifiedAt: input.now,
            providerCalendarId,
            resourceId: input.resourceId,
            status: "active",
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: [
              bookingResourceCalendarAssignments.resourceId,
              bookingResourceCalendarAssignments.calendarConnectionId,
              bookingResourceCalendarAssignments.providerCalendarId,
            ],
            set: {
              acceptsBookings: input.acceptsBookings,
              calendarLabel: input.calendarLabel?.trim() || null,
              contributesBusy: input.contributesBusy,
              lastErrorCode: null,
              lastVerifiedAt: input.now,
              status: "active",
              updatedAt: input.now,
            },
          })
          .returning(assignmentSelection);

        return requireRow(row, "Calendar assignment was not saved");
      });
    },
  };
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }

  return row;
}
