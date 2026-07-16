import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUserResources,
  adminUsers,
  appointments,
  bookingBusinessSettings,
  bookingCalendarConnections,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResources,
  bookingResourceScheduleExceptions,
  bookingResourceSchedules,
  bookingServices,
  bookingServiceOfferingAddOns,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
  checkoutOrders,
  marketingContacts,
  marketingContactSyncJobs,
} from "@/lib/private-db/schema";

import { requirePermission } from "./auth";
import { recordAdminAudit } from "./audit-log";
import { isPublicAddOnReady } from "./offering-readiness";
import type { AdminActor } from "./types";

export async function getSetupReadiness() {
  await requirePermission("offerings:view");
  const db = getPrivateDb();
  const [
    resources,
    providers,
    services,
    offerings,
    activeAddOns,
    requiredOfferingResources,
    schedules,
    writeAssignments,
    settingsRows,
  ] = await Promise.all([
    db.select().from(bookingResources).orderBy(asc(bookingResources.name)),
    db.select().from(bookingProviders).orderBy(asc(bookingProviders.displayOrder)),
    db.select().from(bookingServices).orderBy(asc(bookingServices.displayOrder)),
    db.select().from(bookingServiceOfferings),
    db
      .select({
        addOnKey: bookingServiceOfferingAddOns.addOnKey,
        description: bookingServiceOfferingAddOns.description,
        durationDeltaMinutes: bookingServiceOfferingAddOns.durationDeltaMinutes,
        name: bookingServiceOfferingAddOns.name,
        offeringId: bookingServiceOfferingAddOns.offeringId,
        priceCents: bookingServiceOfferingAddOns.priceCents,
      })
      .from(bookingServiceOfferingAddOns)
      .where(eq(bookingServiceOfferingAddOns.status, "active")),
    db
      .select({
        offeringId: bookingServiceOfferingResources.offeringId,
        resourceId: bookingResources.id,
        resourceStatus: bookingResources.status,
        scheduleId: bookingResourceSchedules.id,
      })
      .from(bookingServiceOfferingResources)
      .innerJoin(
        bookingResources,
        eq(bookingResources.id, bookingServiceOfferingResources.resourceId),
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
      .where(eq(bookingServiceOfferingResources.isRequired, true)),
    db
      .select({ resourceId: bookingResourceSchedules.resourceId })
      .from(bookingResourceSchedules)
      .where(eq(bookingResourceSchedules.status, "active")),
    db
      .select({
        connectionStatus: bookingCalendarConnections.status,
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
      .where(
        and(
          eq(bookingResourceCalendarAssignments.status, "active"),
          eq(bookingResourceCalendarAssignments.acceptsBookings, true),
        ),
      ),
    db
      .select()
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"))
      .limit(1),
  ]);
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const offeringById = new Map(offerings.map((offering) => [offering.id, offering]));
  const scheduledResources = new Set(schedules.map((schedule) => schedule.resourceId));
  const invalidAddOnOfferingIds = new Set(
    activeAddOns
      .filter((addOn) => !isPublicAddOnReady(addOn))
      .map((addOn) => addOn.offeringId),
  );
  const invalidRequiredResourceOfferingIds = new Set<string>();
  for (const requiredResource of requiredOfferingResources) {
    const offering = offeringById.get(requiredResource.offeringId);
    if (
      !offering
      || requiredResource.resourceId === offering.primaryResourceId
    ) {
      continue;
    }
    if (
      requiredResource.resourceStatus !== "active"
      || !requiredResource.scheduleId
    ) {
      invalidRequiredResourceOfferingIds.add(requiredResource.offeringId);
    }
  }
  const writeCalendarResources = new Set(
    writeAssignments
      .filter((assignment) => assignment.connectionStatus === "active")
      .map((assignment) => assignment.resourceId),
  );
  const providerReadiness = providers.map((provider) => {
    const resource = resourceById.get(provider.primaryResourceId);
    const providerOfferings = offerings.filter(
      (offering) => offering.providerId === provider.id,
    );
    const blockers: string[] = [];

    if (provider.status !== "active") blockers.push("Provider is not active");
    if (!provider.displayName.trim()) blockers.push("Provider display name is missing");
    if (!provider.publicSlug?.trim()) blockers.push("Provider public slug is missing");
    if (!resource || resource.status !== "active") blockers.push("Primary resource is not active");
    if (!scheduledResources.has(provider.primaryResourceId)) blockers.push("No active weekly schedule");
    if (!writeCalendarResources.has(provider.primaryResourceId)) blockers.push("No active booking calendar");
    const activeOfferings = providerOfferings.filter(
      (offering) => offering.status === "active",
    );
    if (activeOfferings.length === 0) {
      blockers.push("No active service offering");
    } else if (!activeOfferings.some((offering) => {
      const service = serviceById.get(offering.serviceId);
      return service?.status === "active"
        && Boolean(service.sanityDocumentId?.trim())
        && Boolean(service.publicSlug?.trim())
        && !invalidAddOnOfferingIds.has(offering.id)
        && !invalidRequiredResourceOfferingIds.has(offering.id);
    })) {
      blockers.push(
        "No active offering has a public Sanity service, valid add-ons, and ready required resources",
      );
    }

    return {
      blockers,
      displayName: provider.displayName,
      id: provider.id,
      ready: blockers.length === 0,
      resourceName: resource?.name ?? "Missing resource",
      status: provider.status,
    };
  });

  return {
    counts: {
      activeOfferings: offerings.filter((row) => row.status === "active").length,
      activeResources: resources.filter((row) => row.status === "active").length,
      activeServices: services.filter((row) => row.status === "active").length,
      providers: providers.length,
      readyProviders: providerReadiness.filter((row) => row.ready).length,
    },
    providerReadiness,
    settings: settingsRows[0] ?? null,
  };
}

export async function listAdminStaffAndResources() {
  await requirePermission("staff:view");
  const db = getPrivateDb();
  const [users, resources, assignments, providers] = await Promise.all([
    db
      .select({
        displayName: adminUsers.displayName,
        email: adminUsers.email,
        id: adminUsers.id,
        lastSignedInAt: adminUsers.lastSignedInAt,
        role: adminUsers.role,
        status: adminUsers.status,
      })
      .from(adminUsers)
      .orderBy(asc(adminUsers.role), asc(adminUsers.emailNormalized)),
    db
      .select()
      .from(bookingResources)
      .orderBy(asc(bookingResources.kind), asc(bookingResources.name)),
    db
      .select({
        adminUserId: adminUserResources.adminUserId,
        bookingResourceId: adminUserResources.bookingResourceId,
      })
      .from(adminUserResources),
    db.select().from(bookingProviders),
  ]);

  return { assignments, providers, resources, users };
}

export async function listAdminOfferings() {
  await requirePermission("offerings:view");
  const db = getPrivateDb();
  const [services, providers, resources, offerings, addOns, offeringResources] = await Promise.all([
    db.select().from(bookingServices).orderBy(asc(bookingServices.displayOrder)),
    db.select().from(bookingProviders).orderBy(asc(bookingProviders.displayOrder)),
    db.select().from(bookingResources).orderBy(asc(bookingResources.name)),
    db
      .select({
        bookingHorizonDays: bookingServiceOfferings.bookingHorizonDays,
        bufferAfterMinutes: bookingServiceOfferings.bufferAfterMinutes,
        bufferBeforeMinutes: bookingServiceOfferings.bufferBeforeMinutes,
        currency: bookingServiceOfferings.currency,
        depositAmountCents: bookingServiceOfferings.depositAmountCents,
        durationMinutes: bookingServiceOfferings.durationMinutes,
        fullPriceCents: bookingServiceOfferings.fullPriceCents,
        id: bookingServiceOfferings.id,
        minimumLeadTimeHours: bookingServiceOfferings.minimumLeadTimeHours,
        offeringKey: bookingServiceOfferings.offeringKey,
        primaryResourceId: bookingServiceOfferings.primaryResourceId,
        providerId: bookingServiceOfferings.providerId,
        resourceName: bookingResources.name,
        serviceId: bookingServiceOfferings.serviceId,
        serviceTitle: bookingServices.displayTitle,
        slotIntervalMinutes: bookingServiceOfferings.slotIntervalMinutes,
        status: bookingServiceOfferings.status,
        version: bookingServiceOfferings.version,
      })
      .from(bookingServiceOfferings)
      .innerJoin(
        bookingServices,
        eq(bookingServices.id, bookingServiceOfferings.serviceId),
      )
      .innerJoin(
        bookingResources,
        eq(bookingResources.id, bookingServiceOfferings.primaryResourceId),
      )
      .orderBy(asc(bookingServiceOfferings.displayOrder)),
    db
      .select()
      .from(bookingServiceOfferingAddOns)
      .orderBy(
        asc(bookingServiceOfferingAddOns.offeringId),
        asc(bookingServiceOfferingAddOns.displayOrder),
      ),
    db
      .select({
        id: bookingServiceOfferingResources.id,
        isRequired: bookingServiceOfferingResources.isRequired,
        offeringId: bookingServiceOfferingResources.offeringId,
        resourceId: bookingServiceOfferingResources.resourceId,
        resourceKind: bookingResources.kind,
        resourceName: bookingResources.name,
        resourceStatus: bookingResources.status,
        role: bookingServiceOfferingResources.role,
      })
      .from(bookingServiceOfferingResources)
      .innerJoin(
        bookingResources,
        eq(bookingResources.id, bookingServiceOfferingResources.resourceId),
      )
      .orderBy(
        asc(bookingServiceOfferingResources.offeringId),
        asc(bookingServiceOfferingResources.displayOrder),
        asc(bookingResources.name),
      ),
  ]);

  return {
    addOns,
    offeringResources,
    offerings,
    providers,
    resources,
    services,
  };
}

export async function listAdminSchedules() {
  const actor = await requirePermission("schedules:view");
  const db = getPrivateDb();
  const resourceFilter = getResourceFilter(actor, bookingResources.id);

  if (resourceFilter === false) {
    return { exceptions: [], resources: [], schedules: [] };
  }

  const resources = await db
    .select()
    .from(bookingResources)
    .where(resourceFilter)
    .orderBy(asc(bookingResources.name));
  const resourceIds = resources.map((resource) => resource.id);

  if (resourceIds.length === 0) {
    return { exceptions: [], resources, schedules: [] };
  }

  const [schedules, exceptions] = await Promise.all([
    db
      .select()
      .from(bookingResourceSchedules)
      .where(inArray(bookingResourceSchedules.resourceId, resourceIds))
      .orderBy(
        asc(bookingResourceSchedules.resourceId),
        asc(bookingResourceSchedules.weekday),
        asc(bookingResourceSchedules.startsAt),
      ),
    db
      .select()
      .from(bookingResourceScheduleExceptions)
      .where(inArray(bookingResourceScheduleExceptions.resourceId, resourceIds))
      .orderBy(desc(bookingResourceScheduleExceptions.startsAt))
      .limit(100),
  ]);

  return { exceptions, resources, schedules };
}

export async function listAdminCalendarConnections() {
  await requirePermission("calendar-connections:view");
  const db = getPrivateDb();
  const [connections, resources, assignments, employees] = await Promise.all([
    db
      .select({
        accountEmail: bookingCalendarConnections.accountEmail,
        credentialOwnerAdminUserId:
          bookingCalendarConnections.credentialOwnerAdminUserId,
        id: bookingCalendarConnections.id,
        lastErrorCode: bookingCalendarConnections.lastErrorCode,
        lastVerifiedAt: bookingCalendarConnections.lastVerifiedAt,
        ownerDisplayName: adminUsers.displayName,
        ownerEmail: adminUsers.email,
        provider: bookingCalendarConnections.provider,
        status: bookingCalendarConnections.status,
      })
      .from(bookingCalendarConnections)
      .leftJoin(
        adminUsers,
        eq(
          adminUsers.id,
          bookingCalendarConnections.credentialOwnerAdminUserId,
        ),
      )
      .orderBy(asc(bookingCalendarConnections.accountEmail)),
    db.select().from(bookingResources).orderBy(asc(bookingResources.name)),
    db
      .select({
        acceptsBookings: bookingResourceCalendarAssignments.acceptsBookings,
        calendarLabel: bookingResourceCalendarAssignments.calendarLabel,
        connectionId: bookingResourceCalendarAssignments.calendarConnectionId,
        contributesBusy: bookingResourceCalendarAssignments.contributesBusy,
        id: bookingResourceCalendarAssignments.id,
        lastErrorCode: bookingResourceCalendarAssignments.lastErrorCode,
        providerCalendarId: bookingResourceCalendarAssignments.providerCalendarId,
        resourceId: bookingResourceCalendarAssignments.resourceId,
        resourceName: bookingResources.name,
        status: bookingResourceCalendarAssignments.status,
      })
      .from(bookingResourceCalendarAssignments)
      .innerJoin(
        bookingResources,
        eq(bookingResources.id, bookingResourceCalendarAssignments.resourceId),
      )
      .orderBy(asc(bookingResources.name)),
    db
      .select({
        displayName: adminUsers.displayName,
        email: adminUsers.email,
        id: adminUsers.id,
      })
      .from(adminUsers)
      .where(and(eq(adminUsers.role, "employee"), eq(adminUsers.status, "active")))
      .orderBy(asc(adminUsers.emailNormalized)),
  ]);

  return { assignments, connections, employees, resources };
}

export async function listAdminAppointments() {
  const actor = await requirePermission("bookings:view");
  const db = getPrivateDb();
  const resourceFilter = getResourceFilter(actor, appointments.primaryResourceId);

  if (resourceFilter === false) return [];

  return db
    .select({
      calendarSyncStatus: appointments.calendarSyncStatus,
      customerName: appointments.customerName,
      id: appointments.id,
      paymentStatus: appointments.paymentStatus,
      providerDisplayName: bookingProviders.displayName,
      publicReference: appointments.publicReference,
      resourceId: appointments.primaryResourceId,
      selectedEnd: appointments.selectedEnd,
      selectedStart: appointments.selectedStart,
      status: appointments.status,
      timezone: appointments.timezone,
    })
    .from(appointments)
    .innerJoin(bookingProviders, eq(bookingProviders.id, appointments.providerId))
    .where(resourceFilter)
    .orderBy(desc(appointments.selectedStart))
    .limit(150);
}

export async function getAdminAppointmentDetail(id: string) {
  const actor = await requirePermission("bookings:view");
  const db = getPrivateDb();
  const resourceFilter = getResourceFilter(actor, appointments.primaryResourceId);

  if (resourceFilter === false) return null;

  const filters = [eq(appointments.id, id)];
  if (resourceFilter) filters.push(resourceFilter);

  const [row] = await db
    .select({
      calendarSyncLastErrorCode: appointments.calendarSyncLastErrorCode,
      calendarSyncStatus: appointments.calendarSyncStatus,
      cancellationReason: appointments.cancellationReason,
      customerEmail: appointments.customerEmail,
      customerName: appointments.customerName,
      customerPhone: appointments.customerPhone,
      id: appointments.id,
      intakeSnapshot: appointments.intakeSnapshot,
      offeringSnapshot: appointments.offeringSnapshot,
      origin: appointments.origin,
      paymentStatus: appointments.paymentStatus,
      providerDisplayName: bookingProviders.displayName,
      providerSnapshot: appointments.providerSnapshot,
      publicReference: appointments.publicReference,
      resourceId: appointments.primaryResourceId,
      selectedEnd: appointments.selectedEnd,
      selectedStart: appointments.selectedStart,
      status: appointments.status,
      timezone: appointments.timezone,
    })
    .from(appointments)
    .innerJoin(bookingProviders, eq(bookingProviders.id, appointments.providerId))
    .where(and(...filters))
    .limit(1);

  if (row) {
    await recordAdminAudit({
      action: "appointment_detail_view",
      actor,
      domain: "appointments",
      outcome: "success",
      targetId: row.id,
      targetType: "appointment",
    });
  }
  return row ?? null;
}

export async function listAdminMarketingContacts(search?: string) {
  const actor = await requirePermission("marketing:view");
  const db = getPrivateDb();
  const query = search?.trim().slice(0, 120) ?? "";
  const contactFilter = query
    ? or(
      ilike(marketingContacts.email, `%${query}%`),
      ilike(marketingContacts.name, `%${query}%`),
    )
    : undefined;
  const contacts = await db
    .select()
    .from(marketingContacts)
    .where(contactFilter)
    .orderBy(desc(marketingContacts.updatedAt))
    .limit(150);
  const emails = contacts.map((contact) => contact.emailNormalized);
  const failedJobs = emails.length === 0
    ? []
    : await db
      .select({
        emailNormalized: marketingContactSyncJobs.emailNormalized,
        lastError: marketingContactSyncJobs.lastError,
        status: marketingContactSyncJobs.status,
      })
      .from(marketingContactSyncJobs)
      .where(
        and(
          inArray(marketingContactSyncJobs.emailNormalized, emails),
          inArray(marketingContactSyncJobs.status, ["retryable_failed", "dead_letter"]),
        ),
      );
  const syncIssueByEmail = new Map(
    failedJobs.map((job) => [job.emailNormalized, job]),
  );

  const results = contacts.map((contact) => ({
    ...contact,
    syncIssue: syncIssueByEmail.get(contact.emailNormalized) ?? null,
  }));
  await recordAdminAudit({
    action: "marketing_contacts_view",
    actor,
    domain: "marketing",
    metadata: { resultCount: results.length, searchApplied: query.length > 0 },
    outcome: "success",
    targetType: "marketing_contact_list",
  });
  return results;
}

export async function getAdminAnalytics() {
  await requirePermission("analytics:view");
  const db = getPrivateDb();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const [appointmentRows, revenueRows, contactRows, offeringRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int`, status: appointments.status })
      .from(appointments)
      .where(gte(appointments.selectedStart, thirtyDaysAgo))
      .groupBy(appointments.status),
    db
      .select({
        count: sql<number>`count(*)::int`,
        revenueCents: sql<number>`coalesce(sum(${checkoutOrders.amountCents}), 0)::int`,
      })
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.status, "paid"),
          gte(checkoutOrders.createdAt, thirtyDaysAgo),
        ),
      ),
    db
      .select({
        active: sql<number>`count(*) filter (where ${marketingContacts.unsubscribedAt} is null)::int`,
        total: sql<number>`count(*)::int`,
        unsubscribed: sql<number>`count(*) filter (where ${marketingContacts.unsubscribedAt} is not null)::int`,
      })
      .from(marketingContacts),
    db
      .select({
        active: sql<number>`count(*) filter (where ${bookingServiceOfferings.status} = 'active')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(bookingServiceOfferings),
  ]);
  const appointmentCounts = Object.fromEntries(
    appointmentRows.map((row) => [row.status, row.count]),
  );

  return {
    appointmentCounts,
    contacts: contactRows[0] ?? { active: 0, total: 0, unsubscribed: 0 },
    offerings: offeringRows[0] ?? { active: 0, total: 0 },
    paidOrders: revenueRows[0]?.count ?? 0,
    revenueCents: revenueRows[0]?.revenueCents ?? 0,
  };
}

function getResourceFilter(
  actor: AdminActor,
  column: typeof bookingResources.id | typeof appointments.primaryResourceId,
) {
  if (actor.user.role !== "employee") return undefined;
  if (actor.bookingResourceIds.length === 0) return false as const;
  return inArray(column, actor.bookingResourceIds);
}
