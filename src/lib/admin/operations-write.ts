import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { listConnectionGoogleCalendars } from "@/lib/booking/google-calendar";
import { encryptCalendarCredential } from "@/lib/booking/calendar-credential-secret";
import { assertExactPublishedSanityServiceLink } from "@/lib/booking/operations/sanity-service-link";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentEvents,
  appointments,
  adminUserResources,
  adminUsers,
  bookingBusinessSettings,
  bookingCalendarConnections,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResourceReservations,
  bookingResources,
  bookingResourceScheduleExceptions,
  bookingResourceSchedules,
  bookingServices,
  bookingServiceOfferingAddOns,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
  type AdminRole,
  type BookingConfigurationStatus,
  type BookingResourceKind,
  type BookingScheduleExceptionKind,
} from "@/lib/private-db/schema";

import {
  runAuditedAdminMutation,
  type AdminWriteTransaction,
} from "./admin-transaction";
import { getAttendanceTransitionError } from "./attendance-transition";
import { requirePermission } from "./auth";
import { canAdmin } from "./permissions";
import { AdminAuthError } from "./types";
import { localDateTimeToUtc } from "./local-time";
import { getCalendarAssignmentAccessError } from "./calendar-capabilities";
import { getCalendarOwnershipTransferError } from "./calendar-self-service-policy";
import {
  getOfferingActivationBlockers,
  isPublicAddOnReady,
} from "./offering-readiness";

const EMAIL_PATTERN = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function createStaffUser(input: {
  displayName?: string;
  email: string;
  role: Exclude<AdminRole, "owner">;
}) {
  const actor = await requirePermission("staff:manage");
  const email = input.email.trim();

  if (!EMAIL_PATTERN.test(email)) throw new Error("A valid staff email is required");
  if (input.role !== "admin" && input.role !== "employee") throw new Error("Invalid staff role");

  return runAuditedAdminMutation({
    action: "staff_created",
    actor,
    domain: "staff",
    metadata: { role: input.role },
    mutate: async (tx) => {
      const [user] = await tx
        .insert(adminUsers)
        .values({
          displayName: cleanOptional(input.displayName),
          email,
          emailNormalized: email.toLowerCase(),
          providerUserId: `pending:${randomUUID()}`,
          role: input.role,
          status: "active",
        })
        .returning({ id: adminUsers.id });
      return user;
    },
    targetId: (user) => user.id,
    targetType: "admin_user",
  });
}

export async function setStaffStatus(input: {
  status: "active" | "disabled";
  userId: string;
}) {
  const actor = await requirePermission("staff:manage");
  if (input.userId === actor.user.id && input.status === "disabled") {
    throw new Error("You cannot disable your own account");
  }
  await runAuditedAdminMutation({
    action: "staff_status_changed",
    actor,
    domain: "staff",
    metadata: { status: input.status },
    mutate: async (tx) => {
      if (input.status === "disabled") {
        const [ownedActiveAssignment] = await tx
          .select({ id: bookingResourceCalendarAssignments.id })
          .from(bookingResourceCalendarAssignments)
          .innerJoin(
            bookingCalendarConnections,
            eq(
              bookingCalendarConnections.id,
              bookingResourceCalendarAssignments.calendarConnectionId,
            ),
          )
          .where(
            and(
              eq(
                bookingCalendarConnections.credentialOwnerAdminUserId,
                input.userId,
              ),
              eq(bookingResourceCalendarAssignments.status, "active"),
            ),
          )
          .limit(1);
        if (ownedActiveAssignment) {
          throw new Error(
            "Transfer or disconnect the employee's active calendar assignments before disabling the account",
          );
        }
      }
      const [row] = await tx
        .update(adminUsers)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(adminUsers.id, input.userId))
        .returning({ id: adminUsers.id });
      if (!row) throw new Error("Staff user not found");
    },
    targetId: input.userId,
    targetType: "admin_user",
  });
}

export async function assignStaffResource(input: {
  resourceId: string;
  userId: string;
}) {
  const actor = await requirePermission("staff:manage");
  await runAuditedAdminMutation({
    action: "staff_resource_assigned",
    actor,
    domain: "staff",
    metadata: { resourceId: input.resourceId },
    mutate: async (tx) => {
      const [ownedActiveAssignment] = await tx
        .select({ id: bookingResourceCalendarAssignments.id })
        .from(bookingResourceCalendarAssignments)
        .innerJoin(
          bookingCalendarConnections,
          eq(
            bookingCalendarConnections.id,
            bookingResourceCalendarAssignments.calendarConnectionId,
          ),
        )
        .where(
          and(
            eq(
              bookingCalendarConnections.credentialOwnerAdminUserId,
              input.userId,
            ),
            eq(
              bookingResourceCalendarAssignments.resourceId,
              input.resourceId,
            ),
            eq(bookingResourceCalendarAssignments.status, "active"),
          ),
        )
        .limit(1);
      if (ownedActiveAssignment) {
        throw new Error(
          "Transfer or disconnect the employee's active calendar assignment before removing this resource",
        );
      }
      await tx
        .insert(adminUserResources)
        .values({
          adminUserId: input.userId,
          bookingResourceId: input.resourceId,
          createdByAdminUserId: actor.user.id,
        })
        .onConflictDoNothing();
    },
    targetId: input.userId,
    targetType: "admin_user",
  });
}

export async function unassignStaffResource(input: {
  resourceId: string;
  userId: string;
}) {
  const actor = await requirePermission("staff:manage");
  await runAuditedAdminMutation({
    action: "staff_resource_unassigned",
    actor,
    domain: "staff",
    metadata: { resourceId: input.resourceId },
    mutate: async (tx) => {
      await tx
        .delete(adminUserResources)
        .where(and(
          eq(adminUserResources.adminUserId, input.userId),
          eq(adminUserResources.bookingResourceId, input.resourceId),
        ));
    },
    targetId: input.userId,
    targetType: "admin_user",
  });
}

export async function createBookingResource(input: {
  kind: BookingResourceKind;
  name: string;
  publicSlug?: string;
  resourceKey: string;
  sanityDocumentId?: string;
  timezone: string;
}) {
  const actor = await requirePermission("staff:manage");
  const name = requireText(input.name, "Resource name", 120);
  const resourceKey = requireKey(input.resourceKey, "Resource key");
  if (!isResourceKind(input.kind)) throw new Error("Invalid resource kind");
  assertTimezone(input.timezone);
  return runAuditedAdminMutation({
    action: "booking_resource_created",
    actor,
    domain: "booking_setup",
    metadata: { kind: input.kind },
    mutate: async (tx) => {
      const [resource] = await tx
        .insert(bookingResources)
        .values({
          createdByAdminUserId: actor.user.id,
          kind: input.kind,
          name,
          resourceKey,
          status: "draft",
          timezone: input.timezone,
          updatedByAdminUserId: actor.user.id,
        })
        .returning({ id: bookingResources.id });

      if (input.kind === "provider") {
        await tx.insert(bookingProviders).values({
          createdByAdminUserId: actor.user.id,
          displayName: name,
          primaryResourceId: resource.id,
          providerKey: resourceKey,
          publicSlug: cleanOptional(input.publicSlug),
          sanityDocumentId: cleanOptional(input.sanityDocumentId),
          status: "draft",
          updatedByAdminUserId: actor.user.id,
        });
      }

      return resource;
    },
    targetId: (resource) => resource.id,
    targetType: "booking_resource",
  });
}

export async function setBookingResourceStatus(input: {
  resourceId: string;
  status: Exclude<BookingConfigurationStatus, "archived">;
}) {
  const actor = await requirePermission("staff:manage");
  assertConfigurationStatus(input.status);
  await runAuditedAdminMutation({
    action: "booking_resource_status_changed",
    actor,
    domain: "booking_setup",
    metadata: { status: input.status },
    mutate: async (tx) => {
      if (input.status === "active") {
        const [[provider], [settings]] = await Promise.all([
          tx
            .select({
              id: bookingProviders.id,
              squareTeamMemberId: bookingProviders.squareTeamMemberId,
              squareTeamMemberStatus: bookingProviders.squareTeamMemberStatus,
              squareTeamMemberVerifiedAt:
                bookingProviders.squareTeamMemberVerifiedAt,
            })
            .from(bookingProviders)
            .where(eq(bookingProviders.primaryResourceId, input.resourceId))
            .limit(1),
          tx
            .select({
              required: bookingBusinessSettings.requireSquareTeamAttribution,
            })
            .from(bookingBusinessSettings)
            .where(eq(bookingBusinessSettings.singletonKey, "default"))
            .limit(1),
        ]);
        if (
          provider &&
          settings?.required === true &&
          !isVerifiedActiveSquareMapping(provider)
        ) {
          throw new Error(
            "Assign and verify an active Square team member before activating this provider",
          );
        }
      }

      const rows = await tx
        .update(bookingResources)
        .set({
          status: input.status,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
        })
        .where(eq(bookingResources.id, input.resourceId))
        .returning({ id: bookingResources.id });
      if (rows.length === 0) throw new Error("Booking resource not found");
      await tx
        .update(bookingProviders)
        .set({
          status: input.status,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
        })
        .where(eq(bookingProviders.primaryResourceId, input.resourceId));
    },
    targetId: input.resourceId,
    targetType: "booking_resource",
  });
}

export async function updateBookingResourceProfile(input: {
  name: string;
  providerPublicSlug?: string;
  providerSanityDocumentId?: string;
  resourceId: string;
  timezone: string;
}) {
  const actor = await requirePermission("staff:manage");
  const name = requireText(input.name, "Resource name", 120);
  const providerPublicSlug = cleanOptional(input.providerPublicSlug);
  const providerSanityDocumentId = cleanOptional(
    input.providerSanityDocumentId,
  );
  assertTimezone(input.timezone);

  await runAuditedAdminMutation({
    action: "booking_resource_profile_updated",
    actor,
    domain: "booking_setup",
    mutate: async (tx) => {
      const [resource] = await tx
        .update(bookingResources)
        .set({
          name,
          timezone: input.timezone,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
        })
        .where(eq(bookingResources.id, input.resourceId))
        .returning({ id: bookingResources.id, kind: bookingResources.kind });
      if (!resource) throw new Error("Booking resource not found");

      await tx
        .update(bookingResourceSchedules)
        .set({
          timezone: input.timezone,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
          version: sql`${bookingResourceSchedules.version} + 1`,
        })
        .where(eq(bookingResourceSchedules.resourceId, input.resourceId));

      if (resource.kind === "provider") {
        const [provider] = await tx
          .select({ id: bookingProviders.id })
          .from(bookingProviders)
          .where(eq(bookingProviders.primaryResourceId, resource.id))
          .limit(1);
        if (!provider) throw new Error("Provider profile not found");
        const activeOffering = await tx
          .select({ id: bookingServiceOfferings.id })
          .from(bookingServiceOfferings)
          .where(and(
            eq(bookingServiceOfferings.providerId, provider.id),
            eq(bookingServiceOfferings.status, "active"),
          ))
          .limit(1);
        if (activeOffering.length > 0 && !providerPublicSlug) {
          throw new Error(
            "Disable active provider offerings before removing the public provider slug",
          );
        }
        await tx
          .update(bookingProviders)
          .set({
            displayName: name,
            publicSlug: providerPublicSlug,
            sanityDocumentId: providerSanityDocumentId,
            updatedAt: new Date(),
            updatedByAdminUserId: actor.user.id,
          })
          .where(eq(bookingProviders.id, provider.id));
      }
    },
    targetId: input.resourceId,
    targetType: "booking_resource",
  });
}

export async function createBookingService(input: {
  displayTitle: string;
  publicSlug?: string;
  sanityDocumentId?: string;
  serviceKey: string;
}) {
  const actor = await requirePermission("offerings:manage");
  const publicSlug = cleanOptional(input.publicSlug);
  const sanityDocumentId = cleanOptional(input.sanityDocumentId);

  if (publicSlug || sanityDocumentId) {
    await assertExactPublishedSanityServiceLink({
      publicSlug,
      sanityDocumentId,
    });
  }

  return runAuditedAdminMutation({
    action: "booking_service_created",
    actor,
    domain: "offerings",
    mutate: async (tx) => {
      const [row] = await tx
        .insert(bookingServices)
        .values({
          createdByAdminUserId: actor.user.id,
          displayTitle: requireText(input.displayTitle, "Service title", 160),
          publicSlug,
          sanityDocumentId,
          serviceKey: requireKey(input.serviceKey, "Service key"),
          status: "draft",
          updatedByAdminUserId: actor.user.id,
        })
        .returning({ id: bookingServices.id });
      return row;
    },
    targetId: (row) => row.id,
    targetType: "booking_service",
  });
}

export async function setBookingServiceStatus(input: {
  serviceId: string;
  status: Exclude<BookingConfigurationStatus, "archived">;
}) {
  const actor = await requirePermission("offerings:manage");
  assertConfigurationStatus(input.status);
  await runAuditedAdminMutation({
    action: "booking_service_status_changed",
    actor,
    domain: "offerings",
    metadata: { status: input.status },
    mutate: async (tx) => {
      const rows = await tx
        .update(bookingServices)
        .set({
          status: input.status,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
        })
        .where(eq(bookingServices.id, input.serviceId))
        .returning({ id: bookingServices.id });
      if (rows.length === 0) throw new Error("Booking service not found");
    },
    targetId: input.serviceId,
    targetType: "booking_service",
  });
}

export async function updateBookingServiceProfile(input: {
  displayTitle: string;
  publicSlug?: string;
  sanityDocumentId?: string;
  serviceId: string;
}) {
  const actor = await requirePermission("offerings:manage");
  const displayTitle = requireText(input.displayTitle, "Service title", 160);
  const publicSlug = cleanOptional(input.publicSlug);
  const sanityDocumentId = cleanOptional(input.sanityDocumentId);

  if (publicSlug || sanityDocumentId) {
    await assertExactPublishedSanityServiceLink({
      publicSlug,
      sanityDocumentId,
    });
  }

  await runAuditedAdminMutation({
    action: "booking_service_profile_updated",
    actor,
    domain: "offerings",
    mutate: async (tx) => {
      const activeOffering = await tx
        .select({ id: bookingServiceOfferings.id })
        .from(bookingServiceOfferings)
        .where(and(
          eq(bookingServiceOfferings.serviceId, input.serviceId),
          eq(bookingServiceOfferings.status, "active"),
        ))
        .limit(1);
      if (activeOffering.length > 0 && (!publicSlug || !sanityDocumentId)) {
        throw new Error(
          "Disable active service offerings before removing the public slug or Sanity link",
        );
      }
      const rows = await tx
        .update(bookingServices)
        .set({
          displayTitle,
          publicSlug,
          sanityDocumentId,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
        })
        .where(eq(bookingServices.id, input.serviceId))
        .returning({ id: bookingServices.id });
      if (rows.length === 0) throw new Error("Booking service not found");
    },
    targetId: input.serviceId,
    targetType: "booking_service",
  });
}

export async function createServiceOffering(input: {
  bufferAfterMinutes: number;
  bufferBeforeMinutes: number;
  depositAmountCents: number;
  durationMinutes: number;
  fullPriceCents: number;
  offeringKey: string;
  providerId: string;
  serviceId: string;
  slotIntervalMinutes: number;
}) {
  const actor = await requirePermission("offerings:manage");
  assertPositiveInteger(input.durationMinutes, "Duration");
  assertPositiveInteger(input.slotIntervalMinutes, "Slot interval");
  assertNonnegativeInteger(input.bufferBeforeMinutes, "Buffer before");
  assertNonnegativeInteger(input.bufferAfterMinutes, "Buffer after");
  assertPositiveInteger(input.fullPriceCents, "Full price");
  assertPositiveInteger(input.depositAmountCents, "Deposit");
  if (input.depositAmountCents >= input.fullPriceCents) {
    throw new Error("Deposit must be lower than the full price");
  }
  return runAuditedAdminMutation({
    action: "service_offering_created",
    actor,
    domain: "offerings",
    mutate: async (tx) => {
      const [provider] = await tx
        .select({ primaryResourceId: bookingProviders.primaryResourceId })
        .from(bookingProviders)
        .where(eq(bookingProviders.id, input.providerId))
        .limit(1);
      if (!provider) throw new Error("Provider not found");
      const [row] = await tx
        .insert(bookingServiceOfferings)
        .values({
          bufferAfterMinutes: input.bufferAfterMinutes,
          bufferBeforeMinutes: input.bufferBeforeMinutes,
          createdByAdminUserId: actor.user.id,
          depositAmountCents: input.depositAmountCents,
          durationMinutes: input.durationMinutes,
          fullPriceCents: input.fullPriceCents,
          offeringKey: requireKey(input.offeringKey, "Offering key"),
          primaryResourceId: provider.primaryResourceId,
          providerId: input.providerId,
          serviceId: input.serviceId,
          slotIntervalMinutes: input.slotIntervalMinutes,
          status: "draft",
          updatedByAdminUserId: actor.user.id,
        })
        .returning({ id: bookingServiceOfferings.id });
      return row;
    },
    targetId: (row) => row.id,
    targetType: "service_offering",
  });
}

export async function updateServiceOffering(input: {
  bufferAfterMinutes: number;
  bufferBeforeMinutes: number;
  depositAmountCents: number;
  durationMinutes: number;
  expectedVersion: number;
  fullPriceCents: number;
  offeringId: string;
  slotIntervalMinutes: number;
}) {
  const actor = await requirePermission("offerings:manage");
  assertPositiveInteger(input.durationMinutes, "Duration");
  assertPositiveInteger(input.slotIntervalMinutes, "Slot interval");
  assertNonnegativeInteger(input.bufferBeforeMinutes, "Buffer before");
  assertNonnegativeInteger(input.bufferAfterMinutes, "Buffer after");
  assertPositiveInteger(input.fullPriceCents, "Full price");
  assertPositiveInteger(input.depositAmountCents, "Deposit");
  assertPositiveInteger(input.expectedVersion, "Offering version");
  if (input.depositAmountCents >= input.fullPriceCents) {
    throw new Error("Deposit must be lower than the full price");
  }

  await runAuditedAdminMutation({
    action: "service_offering_updated",
    actor,
    domain: "offerings",
    metadata: { previousVersion: input.expectedVersion },
    mutate: async (tx) => {
      const rows = await tx
        .update(bookingServiceOfferings)
        .set({
          bufferAfterMinutes: input.bufferAfterMinutes,
          bufferBeforeMinutes: input.bufferBeforeMinutes,
          depositAmountCents: input.depositAmountCents,
          durationMinutes: input.durationMinutes,
          fullPriceCents: input.fullPriceCents,
          slotIntervalMinutes: input.slotIntervalMinutes,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
          version: sql`${bookingServiceOfferings.version} + 1`,
        })
        .where(and(
          eq(bookingServiceOfferings.id, input.offeringId),
          eq(bookingServiceOfferings.version, input.expectedVersion),
        ))
        .returning({ id: bookingServiceOfferings.id });
      if (rows.length === 0) {
        throw new Error(
          "This offering changed after the page loaded. Refresh and try again",
        );
      }
    },
    targetId: input.offeringId,
    targetType: "service_offering",
  });
}

export async function setServiceOfferingStatus(input: {
  offeringId: string;
  status: Exclude<BookingConfigurationStatus, "archived">;
}) {
  const actor = await requirePermission("offerings:manage");
  assertConfigurationStatus(input.status);
  const validatedSanityLink = input.status === "active"
    ? await loadAndValidateOfferingSanityServiceLink(input.offeringId)
    : null;

  await runAuditedAdminMutation({
    action: "service_offering_status_changed",
    actor,
    domain: "offerings",
    metadata: { status: input.status },
    mutate: async (tx) => {
      if (input.status === "active") {
        const [configuration] = await tx
          .select({
            providerDisplayName: bookingProviders.displayName,
            providerPrimaryResourceId: bookingProviders.primaryResourceId,
            providerPublicSlug: bookingProviders.publicSlug,
            providerSquareTeamMemberId: bookingProviders.squareTeamMemberId,
            providerSquareTeamMemberStatus:
              bookingProviders.squareTeamMemberStatus,
            providerSquareTeamMemberVerifiedAt:
              bookingProviders.squareTeamMemberVerifiedAt,
            providerStatus: bookingProviders.status,
            resourceId: bookingResources.id,
            resourceStatus: bookingResources.status,
            servicePublicSlug: bookingServices.publicSlug,
            serviceSanityDocumentId: bookingServices.sanityDocumentId,
            serviceStatus: bookingServices.status,
          })
          .from(bookingServiceOfferings)
          .innerJoin(
            bookingProviders,
            eq(bookingProviders.id, bookingServiceOfferings.providerId),
          )
          .innerJoin(
            bookingResources,
            eq(bookingResources.id, bookingServiceOfferings.primaryResourceId),
          )
          .innerJoin(
            bookingServices,
            eq(bookingServices.id, bookingServiceOfferings.serviceId),
          )
          .where(eq(bookingServiceOfferings.id, input.offeringId))
          .limit(1);

        if (!configuration) throw new Error("Service offering not found");
        const [settings] = await tx
          .select({
            required: bookingBusinessSettings.requireSquareTeamAttribution,
          })
          .from(bookingBusinessSettings)
          .where(eq(bookingBusinessSettings.singletonKey, "default"))
          .limit(1);
        if (
          settings?.required === true &&
          !isVerifiedActiveSquareMapping({
            squareTeamMemberId: configuration.providerSquareTeamMemberId,
            squareTeamMemberStatus:
              configuration.providerSquareTeamMemberStatus,
            squareTeamMemberVerifiedAt:
              configuration.providerSquareTeamMemberVerifiedAt,
          })
        ) {
          throw new Error(
            "Assign and verify an active Square team member before activating this offering",
          );
        }
        if (
          validatedSanityLink === null ||
          configuration.servicePublicSlug !==
            validatedSanityLink.publicSlug ||
          configuration.serviceSanityDocumentId !==
            validatedSanityLink.sanityDocumentId
        ) {
          throw new Error(
            "The linked Sanity service changed during activation. Retry with the published service selected",
          );
        }

        const [
          schedule,
          bookingCalendar,
          activeAddOns,
          requiredSecondaryResourceRows,
        ] = await Promise.all([
          tx
            .select({ id: bookingResourceSchedules.id })
            .from(bookingResourceSchedules)
            .where(and(
              eq(bookingResourceSchedules.resourceId, configuration.resourceId),
              eq(bookingResourceSchedules.status, "active"),
            ))
            .limit(1),
          tx
            .select({ id: bookingResourceCalendarAssignments.id })
            .from(bookingResourceCalendarAssignments)
            .innerJoin(
              bookingCalendarConnections,
              eq(
                bookingCalendarConnections.id,
                bookingResourceCalendarAssignments.calendarConnectionId,
              ),
            )
            .where(and(
              eq(
                bookingResourceCalendarAssignments.resourceId,
                configuration.resourceId,
              ),
              eq(bookingResourceCalendarAssignments.status, "active"),
              eq(bookingResourceCalendarAssignments.acceptsBookings, true),
              eq(bookingCalendarConnections.status, "active"),
            ))
            .limit(1),
          tx
            .select({
              addOnKey: bookingServiceOfferingAddOns.addOnKey,
              description: bookingServiceOfferingAddOns.description,
              durationDeltaMinutes:
                bookingServiceOfferingAddOns.durationDeltaMinutes,
              name: bookingServiceOfferingAddOns.name,
              priceCents: bookingServiceOfferingAddOns.priceCents,
            })
            .from(bookingServiceOfferingAddOns)
            .where(and(
              eq(
                bookingServiceOfferingAddOns.offeringId,
                input.offeringId,
              ),
              eq(bookingServiceOfferingAddOns.status, "active"),
            )),
          tx
            .select({
              resourceId: bookingResources.id,
              resourceName: bookingResources.name,
              resourceStatus: bookingResources.status,
              scheduleId: bookingResourceSchedules.id,
            })
            .from(bookingServiceOfferingResources)
            .innerJoin(
              bookingResources,
              eq(
                bookingResources.id,
                bookingServiceOfferingResources.resourceId,
              ),
            )
            .leftJoin(
              bookingResourceSchedules,
              and(
                eq(
                  bookingResourceSchedules.resourceId,
                  bookingServiceOfferingResources.resourceId,
                ),
                eq(bookingResourceSchedules.status, "active"),
              ),
            )
            .where(and(
              eq(
                bookingServiceOfferingResources.offeringId,
                input.offeringId,
              ),
              eq(bookingServiceOfferingResources.isRequired, true),
              sql`${bookingServiceOfferingResources.resourceId} <> ${configuration.resourceId}`,
            )),
        ]);
        const requiredSecondaryResourceById = new Map<string, {
          hasActiveWeeklySchedule: boolean;
          name: string;
          status: BookingConfigurationStatus;
        }>();
        for (const resource of requiredSecondaryResourceRows) {
          const existing = requiredSecondaryResourceById.get(resource.resourceId);
          requiredSecondaryResourceById.set(resource.resourceId, {
            hasActiveWeeklySchedule:
              Boolean(resource.scheduleId) || existing?.hasActiveWeeklySchedule === true,
            name: resource.resourceName,
            status: resource.resourceStatus,
          });
        }
        const blockers = getOfferingActivationBlockers({
          activeAddOnsArePubliclyValid: activeAddOns.every(isPublicAddOnReady),
          hasActiveBookingCalendar: bookingCalendar.length > 0,
          hasActiveWeeklySchedule: schedule.length > 0,
          provider: {
            displayName: configuration.providerDisplayName,
            primaryResourceId: configuration.providerPrimaryResourceId,
            publicSlug: configuration.providerPublicSlug,
            status: configuration.providerStatus,
          },
          resource: {
            id: configuration.resourceId,
            status: configuration.resourceStatus,
          },
          requiredSecondaryResources: [
            ...requiredSecondaryResourceById.values(),
          ],
          service: {
            publicSlug: configuration.servicePublicSlug,
            sanityDocumentId: configuration.serviceSanityDocumentId,
            status: configuration.serviceStatus,
          },
        });

        if (blockers.length > 0) {
          throw new Error(
            `Complete booking setup before activation: ${blockers.join(", ")}`,
          );
        }
      }

      const rows = await tx
        .update(bookingServiceOfferings)
        .set({
          status: input.status,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
          version: sql`${bookingServiceOfferings.version} + 1`,
        })
        .where(eq(bookingServiceOfferings.id, input.offeringId))
        .returning({ id: bookingServiceOfferings.id });
      if (rows.length === 0) throw new Error("Service offering not found");
    },
    targetId: input.offeringId,
    targetType: "service_offering",
  });
}

async function loadAndValidateOfferingSanityServiceLink(
  offeringId: string,
) {
  const [link] = await getPrivateDb()
    .select({
      publicSlug: bookingServices.publicSlug,
      sanityDocumentId: bookingServices.sanityDocumentId,
    })
    .from(bookingServiceOfferings)
    .innerJoin(
      bookingServices,
      eq(bookingServices.id, bookingServiceOfferings.serviceId),
    )
    .where(eq(bookingServiceOfferings.id, offeringId))
    .limit(1);

  if (!link) {
    throw new Error("Service offering not found");
  }

  return assertExactPublishedSanityServiceLink(link);
}

export async function createOfferingAddOn(input: {
  addOnKey: string;
  description: string;
  durationDeltaMinutes: number;
  name: string;
  offeringId: string;
  priceCents: number;
}) {
  const actor = await requirePermission("offerings:manage");
  assertPositiveInteger(input.priceCents, "Add-on price");
  assertNonnegativeInteger(input.durationDeltaMinutes, "Add-on duration");
  await runAuditedAdminMutation({
    action: "offering_add_on_created",
    actor,
    domain: "offerings",
    metadata: { offeringId: input.offeringId },
    mutate: async (tx) => {
      const [row] = await tx
        .insert(bookingServiceOfferingAddOns)
        .values({
          addOnKey: requireKey(input.addOnKey, "Add-on key"),
          description: requireText(input.description, "Add-on description", 500),
          durationDeltaMinutes: input.durationDeltaMinutes,
          name: requireText(input.name, "Add-on name", 120),
          offeringId: input.offeringId,
          priceCents: input.priceCents,
          status: "active",
        })
        .returning({ id: bookingServiceOfferingAddOns.id });
      return row;
    },
    targetId: (row) => row.id,
    targetType: "offering_add_on",
  });
}

export async function setOfferingAddOnStatus(input: {
  addOnId: string;
  status: "active" | "disabled";
}) {
  const actor = await requirePermission("offerings:manage");
  await runAuditedAdminMutation({
    action: "offering_add_on_status_changed",
    actor,
    domain: "offerings",
    metadata: { status: input.status },
    mutate: async (tx) => {
      if (input.status === "active") {
        const [addOn] = await tx
          .select({
            addOnKey: bookingServiceOfferingAddOns.addOnKey,
            description: bookingServiceOfferingAddOns.description,
            durationDeltaMinutes:
              bookingServiceOfferingAddOns.durationDeltaMinutes,
            name: bookingServiceOfferingAddOns.name,
            priceCents: bookingServiceOfferingAddOns.priceCents,
          })
          .from(bookingServiceOfferingAddOns)
          .where(eq(bookingServiceOfferingAddOns.id, input.addOnId))
          .limit(1);
        if (!addOn) throw new Error("Offering add-on not found");
        if (!isPublicAddOnReady(addOn)) {
          throw new Error(
            "Complete the add-on name, key, description, price, and duration before activation",
          );
        }
      }

      const rows = await tx
        .update(bookingServiceOfferingAddOns)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(bookingServiceOfferingAddOns.id, input.addOnId))
        .returning({ id: bookingServiceOfferingAddOns.id });
      if (rows.length === 0) throw new Error("Offering add-on not found");
    },
    targetId: input.addOnId,
    targetType: "offering_add_on",
  });
}

export async function updateBookingSettings(input: {
  bookingHorizonDays: number;
  defaultBufferAfterMinutes: number;
  defaultBufferBeforeMinutes: number;
  minimumLeadTimeHours: number;
  slotIntervalMinutes: number;
  timezone: string;
}) {
  const actor = await requirePermission("offerings:manage");
  assertTimezone(input.timezone);
  assertPositiveInteger(input.bookingHorizonDays, "Booking horizon");
  assertNonnegativeInteger(input.minimumLeadTimeHours, "Minimum lead time");
  assertPositiveInteger(input.slotIntervalMinutes, "Slot interval");
  assertNonnegativeInteger(input.defaultBufferBeforeMinutes, "Default buffer before");
  assertNonnegativeInteger(input.defaultBufferAfterMinutes, "Default buffer after");
  await runAuditedAdminMutation({
    action: "booking_settings_updated",
    actor,
    domain: "booking_setup",
    mutate: async (tx) => {
      await tx
        .insert(bookingBusinessSettings)
        .values({
          ...input,
          singletonKey: "default",
          updatedByAdminUserId: actor.user.id,
        })
        .onConflictDoUpdate({
          target: bookingBusinessSettings.singletonKey,
          set: {
            ...input,
            updatedAt: new Date(),
            updatedByAdminUserId: actor.user.id,
            version: sql`${bookingBusinessSettings.version} + 1`,
          },
        });
    },
    targetId: "default",
    targetType: "booking_settings",
  });
}

export async function createResourceSchedule(input: {
  effectiveFrom: string;
  effectiveUntil?: string;
  endsAt: string;
  resourceId: string;
  startsAt: string;
  weekday: number;
}) {
  const actor = await requirePermission("schedules:manage", {
    bookingResourceId: input.resourceId,
  });
  assertWeekday(input.weekday);
  assertTimeRange(input.startsAt, input.endsAt);
  assertDateRange(input.effectiveFrom, input.effectiveUntil);
  await runAuditedAdminMutation({
    action: "resource_schedule_created",
    actor,
    domain: "schedules",
    metadata: { resourceId: input.resourceId },
    mutate: async (tx) => {
      const resource = await getResource(tx, input.resourceId);
      const [row] = await tx
        .insert(bookingResourceSchedules)
        .values({
          createdByAdminUserId: actor.user.id,
          effectiveFrom: input.effectiveFrom,
          effectiveUntil: cleanOptional(input.effectiveUntil),
          endsAt: input.endsAt,
          resourceId: input.resourceId,
          startsAt: input.startsAt,
          status: "active",
          timezone: resource.timezone,
          updatedByAdminUserId: actor.user.id,
          weekday: input.weekday,
        })
        .returning({ id: bookingResourceSchedules.id });
      return row;
    },
    targetId: (row) => row.id,
    targetType: "resource_schedule",
  });
}

export async function disableResourceSchedule(input: {
  resourceId: string;
  scheduleId: string;
}) {
  const actor = await requirePermission("schedules:manage", {
    bookingResourceId: input.resourceId,
  });
  await runAuditedAdminMutation({
    action: "resource_schedule_disabled",
    actor,
    domain: "schedules",
    metadata: { resourceId: input.resourceId },
    mutate: async (tx) => {
      await tx
        .update(bookingResourceSchedules)
        .set({
          status: "disabled",
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
          version: sql`${bookingResourceSchedules.version} + 1`,
        })
        .where(and(
          eq(bookingResourceSchedules.id, input.scheduleId),
          eq(bookingResourceSchedules.resourceId, input.resourceId),
        ));
    },
    targetId: input.scheduleId,
    targetType: "resource_schedule",
  });
}

export async function createScheduleException(input: {
  endsAtLocal: string;
  kind: BookingScheduleExceptionKind;
  note?: string;
  resourceId: string;
  startsAtLocal: string;
}) {
  const actor = await requirePermission("schedules:manage", {
    bookingResourceId: input.resourceId,
  });
  if (input.kind !== "available" && input.kind !== "unavailable") {
    throw new Error("Invalid exception type");
  }
  try {
    await runAuditedAdminMutation({
      action: "schedule_exception_created",
      actor,
      domain: "schedules",
      metadata: { kind: input.kind, resourceId: input.resourceId },
      mutate: async (tx) => {
      const resource = await getResource(tx, input.resourceId);
      const startsAt = localDateTimeToUtc(input.startsAtLocal, resource.timezone);
      const endsAt = localDateTimeToUtc(input.endsAtLocal, resource.timezone);
      if (endsAt <= startsAt) throw new Error("Exception end must be after start");
      if (input.kind === "unavailable") {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.resourceId}::text, 0))`,
        );
      }
      const [row] = await tx
        .insert(bookingResourceScheduleExceptions)
        .values({
          createdByAdminUserId: actor.user.id,
          endsAt,
          kind: input.kind,
          note: cleanOptional(input.note),
          resourceId: input.resourceId,
          startsAt,
          status: "active",
          timezone: resource.timezone,
          updatedByAdminUserId: actor.user.id,
        })
        .returning({ id: bookingResourceScheduleExceptions.id });
      if (input.kind === "unavailable") {
        await tx.insert(bookingResourceReservations).values({
          kind: "block",
          occupiedEnd: endsAt,
          occupiedStart: startsAt,
          resourceId: input.resourceId,
          scheduleExceptionId: row.id,
          state: "active",
        });
      }
        return row;
      },
      targetId: (row) => row.id,
      targetType: "schedule_exception",
    });
  } catch (error) {
    if (getPostgresErrorCode(error) === "23P01") {
      throw new Error("This unavailable period overlaps an existing hold, appointment, or blocked time");
    }
    throw error;
  }
}

export async function cancelScheduleException(input: {
  exceptionId: string;
  resourceId: string;
}) {
  const actor = await requirePermission("schedules:manage", {
    bookingResourceId: input.resourceId,
  });
  await runAuditedAdminMutation({
    action: "schedule_exception_cancelled",
    actor,
    domain: "schedules",
    metadata: { resourceId: input.resourceId },
    mutate: async (tx) => {
      const now = new Date();
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.resourceId}::text, 0))`,
      );
      await tx
        .update(bookingResourceScheduleExceptions)
        .set({
          cancelledAt: now,
          status: "cancelled",
          updatedAt: now,
          updatedByAdminUserId: actor.user.id,
        })
        .where(and(
          eq(bookingResourceScheduleExceptions.id, input.exceptionId),
          eq(bookingResourceScheduleExceptions.resourceId, input.resourceId),
        ));
      await tx
        .update(bookingResourceReservations)
        .set({
          releaseReason: "schedule_exception_cancelled",
          releasedAt: now,
          state: "released",
          updatedAt: now,
        })
        .where(and(
          eq(bookingResourceReservations.scheduleExceptionId, input.exceptionId),
          eq(bookingResourceReservations.resourceId, input.resourceId),
          eq(bookingResourceReservations.state, "active"),
        ));
    },
    targetId: input.exceptionId,
    targetType: "schedule_exception",
  });
}

export async function createCalendarConnection() {
  const actor = await requirePermission("calendar-connections:manage");
  return runAuditedAdminMutation({
    action: "calendar_connection_created",
    actor,
    domain: "calendar",
    mutate: async (tx) => {
      const [connection] = await tx
        .insert(bookingCalendarConnections)
        .values({
          connectedByAdminUserId: actor.user.id,
          provider: "google",
          status: "reconnect_required",
        })
        .returning({ id: bookingCalendarConnections.id });
      return connection;
    },
    targetId: (connection) => connection.id,
    targetType: "calendar_connection",
  });
}

export async function saveAdminGoogleCalendarCredential(input: {
  accountEmail: string;
  connectionId: string;
  providerAccountId: string;
  refreshToken: string;
  scopes: string[];
}) {
  const actor = await requirePermission("calendar-connections:manage");
  const credentialCiphertext = encryptCalendarCredential(input.refreshToken);
  const accountEmail = input.accountEmail.trim().toLowerCase();
  const providerAccountId = requireText(
    input.providerAccountId,
    "Google account ID",
    255,
  );
  if (!EMAIL_PATTERN.test(accountEmail)) {
    throw new Error("Google account email is invalid");
  }
  const scopes = [...new Set(input.scopes.map((scope) => scope.trim()))]
    .filter(Boolean)
    .sort();

  await runAuditedAdminMutation({
    action: "calendar_connection_authorized",
    actor,
    domain: "calendar",
    metadata: { provider: "google", scopeCount: scopes.length },
    mutate: async (tx) => {
      const now = new Date();
      const rows = await tx
        .update(bookingCalendarConnections)
        .set({
          accountEmail,
          connectedByAdminUserId: actor.user.id,
          credentialCiphertext,
          credentialSecretRef: null,
          disabledAt: null,
          lastErrorCode: null,
          lastVerifiedAt: now,
          providerAccountId,
          scopes,
          status: "active",
          updatedAt: now,
        })
        .where(and(
          eq(bookingCalendarConnections.id, input.connectionId),
          eq(bookingCalendarConnections.provider, "google"),
        ))
        .returning({ id: bookingCalendarConnections.id });
      if (rows.length === 0) throw new Error("Calendar connection was not found");
    },
    targetId: input.connectionId,
    targetType: "calendar_connection",
  });
}

export async function disableCalendarConnection(connectionId: string) {
  const actor = await requirePermission("calendar-connections:manage");
  await runAuditedAdminMutation({
    action: "calendar_connection_disabled",
    actor,
    domain: "calendar",
    mutate: async (tx) => {
      const now = new Date();
      await tx
        .update(bookingResourceCalendarAssignments)
        .set({ status: "disabled", updatedAt: now })
        .where(eq(bookingResourceCalendarAssignments.calendarConnectionId, connectionId));
      const rows = await tx
        .update(bookingCalendarConnections)
        .set({
          credentialCiphertext: null,
          credentialSecretRef: null,
          disabledAt: now,
          status: "disabled",
          updatedAt: now,
        })
        .where(eq(bookingCalendarConnections.id, connectionId))
        .returning({ id: bookingCalendarConnections.id });
      if (rows.length === 0) throw new Error("Calendar connection not found");
    },
    targetId: connectionId,
    targetType: "calendar_connection",
  });
}

export async function transferCalendarConnectionOwnership(input: {
  connectionId: string;
  employeeUserId: string | null;
}) {
  const actor = await requirePermission("calendar-connections:manage");

  await runAuditedAdminMutation({
    action: "calendar_connection_ownership_transferred",
    actor,
    domain: "calendar",
    metadata: { employeeOwnerPresent: input.employeeUserId !== null },
    mutate: async (tx) => {
      const [connection] = await tx
        .select({ id: bookingCalendarConnections.id })
        .from(bookingCalendarConnections)
        .where(eq(bookingCalendarConnections.id, input.connectionId))
        .limit(1)
        .for("update");
      if (!connection) {
        throw new Error("Calendar connection not found");
      }

      if (input.employeeUserId !== null) {
        const [employee] = await tx
          .select({ id: adminUsers.id, role: adminUsers.role, status: adminUsers.status })
          .from(adminUsers)
          .where(eq(adminUsers.id, input.employeeUserId))
          .limit(1);
        if (!employee || employee.role !== "employee" || employee.status !== "active") {
          throw new Error("Calendar ownership can only be transferred to an active employee");
        }

        const [assignedResources, activeAssignments] = await Promise.all([
          tx
            .select({ resourceId: adminUserResources.bookingResourceId })
            .from(adminUserResources)
            .where(eq(adminUserResources.adminUserId, employee.id)),
          tx
            .select({ resourceId: bookingResourceCalendarAssignments.resourceId })
            .from(bookingResourceCalendarAssignments)
            .where(
              and(
                eq(
                  bookingResourceCalendarAssignments.calendarConnectionId,
                  input.connectionId,
                ),
                eq(bookingResourceCalendarAssignments.status, "active"),
              ),
            ),
        ]);
        const transferError = getCalendarOwnershipTransferError({
          activeAssignmentResourceIds: activeAssignments.map(
            (assignment) => assignment.resourceId,
          ),
          employeeResourceIds: assignedResources.map(
            (assignment) => assignment.resourceId,
          ),
        });
        if (transferError) {
          throw new Error(transferError);
        }
      }

      await tx
        .update(bookingCalendarConnections)
        .set({
          credentialOwnerAdminUserId: input.employeeUserId,
          updatedAt: new Date(),
        })
        .where(eq(bookingCalendarConnections.id, input.connectionId));
    },
    targetId: input.connectionId,
    targetType: "calendar_connection",
  });
}

export async function saveCalendarAssignment(input: {
  acceptsBookings: boolean;
  calendarLabel?: string;
  connectionId: string;
  contributesBusy: boolean;
  providerCalendarId: string;
  resourceId: string;
}) {
  const actor = await requirePermission("calendar-connections:manage");
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
  let calendar: Awaited<ReturnType<typeof listConnectionGoogleCalendars>>[number]
    | undefined;
  try {
    calendar = (await listConnectionGoogleCalendars(input.connectionId))
      .find((option) => option.id === providerCalendarId);
  } catch {
    throw new Error(
      "Google Calendar access could not be verified. Reconnect the account and retry",
    );
  }
  const accessError = getCalendarAssignmentAccessError({
    acceptsBookings: input.acceptsBookings,
    accessRole: calendar?.accessRole ?? null,
  });
  if (accessError) {
    throw new Error(accessError);
  }
  return runAuditedAdminMutation({
    action: "calendar_assignment_saved",
    actor,
    domain: "calendar",
    metadata: {
      acceptsBookings: input.acceptsBookings,
      contributesBusy: input.contributesBusy,
      resourceId: input.resourceId,
    },
    mutate: async (tx) => {
      const now = new Date();
      if (input.acceptsBookings) {
        await tx
          .update(bookingResourceCalendarAssignments)
          .set({ acceptsBookings: false, updatedAt: now })
          .where(and(
            eq(bookingResourceCalendarAssignments.resourceId, input.resourceId),
            eq(bookingResourceCalendarAssignments.acceptsBookings, true),
          ));
      }
      const [assignment] = await tx
        .insert(bookingResourceCalendarAssignments)
        .values({
          acceptsBookings: input.acceptsBookings,
          calendarConnectionId: input.connectionId,
          calendarLabel: cleanOptional(input.calendarLabel),
          contributesBusy: input.contributesBusy,
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
            acceptsBookings: input.acceptsBookings,
            calendarLabel: cleanOptional(input.calendarLabel),
            contributesBusy: input.contributesBusy,
            lastErrorCode: null,
            lastVerifiedAt: now,
            status: "active",
            updatedAt: now,
          },
        })
        .returning({ id: bookingResourceCalendarAssignments.id });
      return assignment;
    },
    targetId: (assignment) => assignment.id,
    targetType: "calendar_assignment",
  });
}

export async function disableCalendarAssignment(assignmentId: string) {
  const actor = await requirePermission("calendar-connections:manage");
  await runAuditedAdminMutation({
    action: "calendar_assignment_disabled",
    actor,
    domain: "calendar",
    mutate: async (tx) => {
      const rows = await tx
        .update(bookingResourceCalendarAssignments)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(eq(bookingResourceCalendarAssignments.id, assignmentId))
        .returning({ id: bookingResourceCalendarAssignments.id });
      if (rows.length === 0) throw new Error("Calendar assignment not found");
    },
    targetId: assignmentId,
    targetType: "calendar_assignment",
  });
}

export async function setAppointmentAttendanceStatus(input: {
  appointmentId: string;
  status: "completed" | "no_show";
}) {
  const actor = await requirePermission("bookings:manage");
  const now = new Date();

  await runAuditedAdminMutation({
    action: input.status === "completed"
      ? "appointment_completed"
      : "appointment_marked_no_show",
    actor,
    domain: "bookings",
    metadata: { status: input.status },
    mutate: async (tx) => {
      const [appointment] = await tx
        .select({
          id: appointments.id,
          primaryResourceId: appointments.primaryResourceId,
          selectedEnd: appointments.selectedEnd,
          status: appointments.status,
        })
        .from(appointments)
        .where(eq(appointments.id, input.appointmentId))
        .limit(1)
        .for("update");

      if (!appointment) throw new Error("Appointment not found");
      if (!canAdmin({
        action: "bookings:manage",
        bookingResourceId: appointment.primaryResourceId,
        bookingResourceIds: actor.bookingResourceIds,
        role: actor.user.role,
      })) {
        throw new AdminAuthError("forbidden");
      }
      const transitionError = getAttendanceTransitionError({
        currentStatus: appointment.status,
        nextStatus: input.status,
        now,
        selectedEnd: appointment.selectedEnd,
      });
      if (transitionError) throw new Error(transitionError);
      if (appointment.status === input.status) return;

      await tx
        .update(appointments)
        .set({
          ...(input.status === "completed"
            ? { completedAt: now }
            : { noShowAt: now }),
          status: input.status,
          updatedAt: now,
          version: sql`${appointments.version} + 1`,
        })
        .where(eq(appointments.id, appointment.id));
      await tx.insert(appointmentEvents).values({
        actorAdminUserId: actor.user.id,
        appointmentId: appointment.id,
        eventType: input.status === "completed"
          ? "appointment_completed"
          : "appointment_marked_no_show",
        nextStatus: input.status,
        previousStatus: appointment.status,
        source: "admin_dashboard",
      });
    },
    targetId: input.appointmentId,
    targetType: "appointment",
  });
}

async function getResource(tx: AdminWriteTransaction, resourceId: string) {
  const [resource] = await tx
    .select({ id: bookingResources.id, timezone: bookingResources.timezone })
    .from(bookingResources)
    .where(eq(bookingResources.id, resourceId))
    .limit(1);
  if (!resource) throw new Error("Booking resource not found");
  return resource;
}

function requireText(value: string, label: string, maxLength: number): string {
  const text = value.trim();
  if (!text || text.length > maxLength) throw new Error(`${label} is required`);
  return text;
}

function requireKey(value: string, label: string): string {
  const key = value.trim().toLowerCase();
  if (!KEY_PATTERN.test(key) || key.length > 100) {
    throw new Error(`${label} must use lowercase letters, numbers, and hyphens`);
  }
  return key;
}

function cleanOptional(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  return text ? text : null;
}

function isVerifiedActiveSquareMapping(input: {
  squareTeamMemberId: string | null;
  squareTeamMemberStatus: "active" | "inactive" | "missing" | null;
  squareTeamMemberVerifiedAt: Date | null;
}): boolean {
  return (
    input.squareTeamMemberId !== null &&
    input.squareTeamMemberStatus === "active" &&
    input.squareTeamMemberVerifiedAt !== null
  );
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format();
  } catch {
    throw new Error("A valid IANA timezone is required");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} cannot be negative`);
}

function assertWeekday(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 7) throw new Error("Invalid weekday");
}

function assertTimeRange(startsAt: string, endsAt: string): void {
  if (!TIME_PATTERN.test(startsAt) || !TIME_PATTERN.test(endsAt) || endsAt <= startsAt) {
    throw new Error("Schedule end must be after start");
  }
}

function assertDateRange(effectiveFrom: string, effectiveUntil?: string): void {
  if (!DATE_PATTERN.test(effectiveFrom)) throw new Error("A valid start date is required");
  if (effectiveUntil && (!DATE_PATTERN.test(effectiveUntil) || effectiveUntil < effectiveFrom)) {
    throw new Error("Schedule end date must not be before its start date");
  }
}

function isResourceKind(value: string): value is BookingResourceKind {
  return value === "provider" || value === "room" || value === "equipment";
}

function assertConfigurationStatus(
  status: string,
): asserts status is Exclude<BookingConfigurationStatus, "archived"> {
  if (status !== "draft" && status !== "active" && status !== "disabled") {
    throw new Error("Invalid configuration status");
  }
}

function getPostgresErrorCode(error: unknown): string | null {
  let candidate = error;
  for (let depth = 0; depth < 5 && candidate !== null; depth += 1) {
    if (typeof candidate !== "object") return null;
    if ("code" in candidate && typeof candidate.code === "string") {
      return candidate.code;
    }
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return null;
}
