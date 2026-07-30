import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
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
  squarePaymentRefundEvents,
} from "@/lib/private-db/schema";
import type { MarketingContactSyncJobStatus } from "@/lib/private-db/schema";

import { requirePermission } from "./auth";
import { recordAdminAudit } from "./audit-log";
import {
  addCalendarDays,
  getBusinessDateRange,
  getBusinessRollingDateRange,
} from "./business-time";
import { isPublicAddOnReady } from "./offering-readiness";
import {
  getMarketingSourceLabel,
  getMarketingSyncStatusPresentation,
} from "./presentation";
import { hasGlobalProviderServiceAccess } from "./provider-service-authorization";
import type { AdminActor } from "./types";

export async function getSetupReadiness() {
  await requirePermission("setup:view");
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
    db
      .select()
      .from(bookingProviders)
      .orderBy(asc(bookingProviders.displayOrder)),
    db
      .select()
      .from(bookingServices)
      .orderBy(asc(bookingServices.displayOrder)),
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
  const resourceById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const offeringById = new Map(
    offerings.map((offering) => [offering.id, offering]),
  );
  const scheduledResources = new Set(
    schedules.map((schedule) => schedule.resourceId),
  );
  const invalidAddOnOfferingIds = new Set(
    activeAddOns
      .filter((addOn) => !isPublicAddOnReady(addOn))
      .map((addOn) => addOn.offeringId),
  );
  const invalidRequiredResourceOfferingIds = new Set<string>();
  for (const requiredResource of requiredOfferingResources) {
    const offering = offeringById.get(requiredResource.offeringId);
    if (
      !offering ||
      requiredResource.resourceId === offering.primaryResourceId
    ) {
      continue;
    }
    if (
      requiredResource.resourceStatus !== "active" ||
      !requiredResource.scheduleId
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
    if (!provider.displayName.trim())
      blockers.push("Provider display name is missing");
    if (!provider.publicSlug?.trim())
      blockers.push("Provider public slug is missing");
    if (!resource || resource.status !== "active")
      blockers.push("Primary resource is not active");
    if (!scheduledResources.has(provider.primaryResourceId))
      blockers.push("No active weekly schedule");
    if (!writeCalendarResources.has(provider.primaryResourceId))
      blockers.push("No active booking calendar");
    const activeOfferings = providerOfferings.filter(
      (offering) => offering.status === "active",
    );
    if (activeOfferings.length === 0) {
      blockers.push("No active service offering");
    } else if (
      !activeOfferings.some((offering) => {
        const service = serviceById.get(offering.serviceId);
        return (
          service?.status === "active" &&
          Boolean(service.publicSlug?.trim()) &&
          Boolean(offering.publicTitle?.trim()) &&
          Boolean(offering.publicSummary?.trim()) &&
          !invalidAddOnOfferingIds.has(offering.id) &&
          !invalidRequiredResourceOfferingIds.has(offering.id)
        );
      })
    ) {
      blockers.push(
        "No active offering has complete public copy, a public service slug, valid add-ons, and ready required resources",
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
      activeOfferings: offerings.filter((row) => row.status === "active")
        .length,
      activeResources: resources.filter((row) => row.status === "active")
        .length,
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
  const actor = await requirePermission("offerings:view");
  const db = getPrivateDb();
  const hasGlobalAccess = hasGlobalProviderServiceAccess(actor);
  const providerResourceScope = hasGlobalAccess
    ? undefined
    : inArray(
        bookingProviders.primaryResourceId,
        actor.bookingProviderResourceIds,
      );
  const providers = await db
    .select()
    .from(bookingProviders)
    .where(providerResourceScope)
    .orderBy(asc(bookingProviders.displayOrder));
  const providerIds = providers.map((provider) => provider.id);
  const primaryResourceIds = providers.map(
    (provider) => provider.primaryResourceId,
  );
  const serviceScope = hasGlobalAccess
    ? undefined
    : or(
        isNull(bookingServices.ownerProviderId),
        inArray(bookingServices.ownerProviderId, providerIds),
      );
  const offeringScope = hasGlobalAccess
    ? undefined
    : inArray(bookingServiceOfferings.providerId, providerIds);
  const [services, resources, offerings] = await Promise.all([
    db
      .select()
      .from(bookingServices)
      .where(serviceScope)
      .orderBy(asc(bookingServices.displayOrder)),
    db
      .select()
      .from(bookingResources)
      .where(
        hasGlobalAccess
          ? undefined
          : inArray(bookingResources.id, primaryResourceIds),
      )
      .orderBy(asc(bookingResources.name)),
    db
      .select({
        bookingHorizonDays: bookingServiceOfferings.bookingHorizonDays,
        bufferAfterMinutes: bookingServiceOfferings.bufferAfterMinutes,
        bufferBeforeMinutes: bookingServiceOfferings.bufferBeforeMinutes,
        currency: bookingServiceOfferings.currency,
        depositAmountCents: bookingServiceOfferings.depositAmountCents,
        displayOrder: bookingServiceOfferings.displayOrder,
        durationMinutes: bookingServiceOfferings.durationMinutes,
        fullPriceCents: bookingServiceOfferings.fullPriceCents,
        id: bookingServiceOfferings.id,
        minimumLeadTimeHours: bookingServiceOfferings.minimumLeadTimeHours,
        offeringKey: bookingServiceOfferings.offeringKey,
        primaryResourceId: bookingServiceOfferings.primaryResourceId,
        providerId: bookingServiceOfferings.providerId,
        publicSummary: bookingServiceOfferings.publicSummary,
        publicTitle: bookingServiceOfferings.publicTitle,
        resourceName: bookingResources.name,
        serviceId: bookingServiceOfferings.serviceId,
        serviceOwnerProviderId: bookingServices.ownerProviderId,
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
      .where(offeringScope)
      .orderBy(asc(bookingServiceOfferings.displayOrder)),
  ]);
  const offeringIds = offerings.map((offering) => offering.id);
  const relatedOfferingScope = hasGlobalAccess
    ? undefined
    : inArray(bookingServiceOfferingAddOns.offeringId, offeringIds);
  const relatedResourceScope = hasGlobalAccess
    ? undefined
    : inArray(bookingServiceOfferingResources.offeringId, offeringIds);
  const [addOns, offeringResources] = await Promise.all([
    db
      .select()
      .from(bookingServiceOfferingAddOns)
      .where(relatedOfferingScope)
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
      .where(relatedResourceScope)
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

export async function listAdminSchedules(input: { resourceId?: string } = {}) {
  const actor = await requirePermission("schedules:view");
  const db = getPrivateDb();
  const now = new Date();
  const resourceFilter = getResourceFilter(actor, bookingResources.id);

  if (resourceFilter === false) {
    return { exceptions: [], resources: [], schedules: [] };
  }

  const resources = await db
    .select()
    .from(bookingResources)
    .where(resourceFilter)
    .orderBy(asc(bookingResources.name));
  const accessibleResourceIds = resources.map((resource) => resource.id);
  const requestedResourceId = input.resourceId?.trim();
  const resourceIds =
    requestedResourceId && accessibleResourceIds.includes(requestedResourceId)
      ? [requestedResourceId]
      : accessibleResourceIds;

  if (resourceIds.length === 0) {
    return { exceptions: [], resources, schedules: [] };
  }

  const [schedules, currentExceptions, exceptionHistory] = await Promise.all([
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
      .where(
        and(
          inArray(bookingResourceScheduleExceptions.resourceId, resourceIds),
          eq(bookingResourceScheduleExceptions.status, "active"),
          gte(bookingResourceScheduleExceptions.endsAt, now),
        ),
      )
      .orderBy(asc(bookingResourceScheduleExceptions.startsAt))
      .limit(200),
    db
      .select()
      .from(bookingResourceScheduleExceptions)
      .where(
        and(
          inArray(bookingResourceScheduleExceptions.resourceId, resourceIds),
          or(
            eq(bookingResourceScheduleExceptions.status, "cancelled"),
            lt(bookingResourceScheduleExceptions.endsAt, now),
          ),
        ),
      )
      .orderBy(desc(bookingResourceScheduleExceptions.startsAt))
      .limit(100),
  ]);

  return {
    exceptions: [...currentExceptions, ...exceptionHistory],
    resources,
    schedules,
  };
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
      .where(ne(bookingCalendarConnections.status, "disabled"))
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
        providerCalendarId:
          bookingResourceCalendarAssignments.providerCalendarId,
        resourceId: bookingResourceCalendarAssignments.resourceId,
        resourceName: bookingResources.name,
        status: bookingResourceCalendarAssignments.status,
      })
      .from(bookingResourceCalendarAssignments)
      .innerJoin(
        bookingResources,
        eq(bookingResources.id, bookingResourceCalendarAssignments.resourceId),
      )
      .where(eq(bookingResourceCalendarAssignments.status, "active"))
      .orderBy(asc(bookingResources.name)),
    db
      .select({
        displayName: adminUsers.displayName,
        email: adminUsers.email,
        id: adminUsers.id,
      })
      .from(adminUsers)
      .where(
        and(eq(adminUsers.role, "employee"), eq(adminUsers.status, "active")),
      )
      .orderBy(asc(adminUsers.emailNormalized)),
  ]);

  return { assignments, connections, employees, resources };
}

export async function listAdminAppointments() {
  const actor = await requirePermission("bookings:view");
  const db = getPrivateDb();
  const resourceFilter = getResourceFilter(
    actor,
    appointments.primaryResourceId,
  );

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
    .innerJoin(
      bookingProviders,
      eq(bookingProviders.id, appointments.providerId),
    )
    .where(resourceFilter)
    .orderBy(desc(appointments.selectedStart))
    .limit(150);
}

export async function getAdminAppointmentDetail(id: string) {
  const actor = await requirePermission("bookings:view");
  const db = getPrivateDb();
  const resourceFilter = getResourceFilter(
    actor,
    appointments.primaryResourceId,
  );

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
    .innerJoin(
      bookingProviders,
      eq(bookingProviders.id, appointments.providerId),
    )
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

export type AdminMarketingContactStatusFilter =
  | "all"
  | "delivery_issue"
  | "opted_in"
  | "unsubscribed";

export interface ListAdminMarketingContactsInput {
  from?: string;
  page?: number;
  pageSize?: number;
  q?: string;
  source?: string;
  status?: AdminMarketingContactStatusFilter;
  to?: string;
}

export async function listAdminMarketingContacts(
  input: ListAdminMarketingContactsInput = {},
) {
  const actor = await requirePermission("marketing:view");
  const db = getPrivateDb();
  const query = input.q?.trim().slice(0, 120) ?? "";
  const source = input.source?.trim().slice(0, 120) ?? "";
  const status = input.status ?? "all";
  const consentFrom = input.from?.trim() ?? "";
  const consentTo = input.to?.trim() ?? "";
  const requestedPage = positiveInteger(input.page, 1);
  const pageSize = Math.min(positiveInteger(input.pageSize, 50), 100);
  let consentRange: ReturnType<typeof getBusinessDateRange> | null = null;

  if (consentFrom || consentTo) {
    if (!consentFrom || !consentTo) {
      throw new Error("Both consent start and end dates are required");
    }

    const [settings] = await db
      .select({ timezone: bookingBusinessSettings.timezone })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"))
      .limit(1);
    consentRange = getBusinessDateRange(
      consentFrom,
      consentTo,
      settings?.timezone ?? "America/Toronto",
    );
  }
  const latestSyncJobs = db
    .selectDistinctOn([marketingContactSyncJobs.emailNormalized], {
      createdAt: marketingContactSyncJobs.createdAt,
      deadLetteredAt: marketingContactSyncJobs.deadLetteredAt,
      emailNormalized: marketingContactSyncJobs.emailNormalized,
      id: marketingContactSyncJobs.id,
      lastAttemptedAt: marketingContactSyncJobs.lastAttemptedAt,
      status: marketingContactSyncJobs.status,
      succeededAt: marketingContactSyncJobs.succeededAt,
    })
    .from(marketingContactSyncJobs)
    .orderBy(
      marketingContactSyncJobs.emailNormalized,
      desc(marketingContactSyncJobs.createdAt),
      desc(marketingContactSyncJobs.id),
    )
    .as("latest_marketing_contact_sync_jobs");
  const filters: SQL[] = [];

  if (query) {
    filters.push(
      or(
        ilike(marketingContacts.email, `%${query}%`),
        ilike(marketingContacts.name, `%${query}%`),
      )!,
    );
  }
  if (source) {
    filters.push(eq(marketingContacts.source, source));
  }
  if (consentRange) {
    filters.push(
      gte(marketingContacts.firstConsentedAt, consentRange.start),
      lt(marketingContacts.firstConsentedAt, consentRange.endExclusive),
    );
  }
  if (status === "opted_in") {
    filters.push(isNull(marketingContacts.unsubscribedAt));
  } else if (status === "unsubscribed") {
    filters.push(isNotNull(marketingContacts.unsubscribedAt));
  } else if (status === "delivery_issue") {
    filters.push(
      and(
        isNull(marketingContacts.unsubscribedAt),
        inArray(latestSyncJobs.status, MARKETING_SYNC_ISSUE_STATUSES),
      )!,
    );
  }

  const contactFilter = filters.length > 0 ? and(...filters) : undefined;
  const [totalRows, overviewRows, sourceRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingContacts)
      .leftJoin(
        latestSyncJobs,
        eq(latestSyncJobs.emailNormalized, marketingContacts.emailNormalized),
      )
      .where(contactFilter),
    db
      .select({
        currentAudience: sql<number>`count(*) filter (where ${marketingContacts.unsubscribedAt} is null)::int`,
        deliveryIssues: sql<number>`count(*) filter (
          where ${marketingContacts.unsubscribedAt} is null
            and ${latestSyncJobs.status} in ('retryable_failed', 'dead_letter')
        )::int`,
        total: sql<number>`count(*)::int`,
        unsubscribed: sql<number>`count(*) filter (where ${marketingContacts.unsubscribedAt} is not null)::int`,
      })
      .from(marketingContacts)
      .leftJoin(
        latestSyncJobs,
        eq(latestSyncJobs.emailNormalized, marketingContacts.emailNormalized),
      ),
    db
      .select({ source: marketingContacts.source })
      .from(marketingContacts)
      .groupBy(marketingContacts.source)
      .orderBy(marketingContacts.source),
  ]);
  const total = totalRows[0]?.count ?? 0;
  const pageCount = total === 0 ? 0 : Math.ceil(total / pageSize);
  const page = pageCount === 0 ? 1 : Math.min(requestedPage, pageCount);
  const contacts = await db
    .select({
      createdAt: marketingContacts.createdAt,
      email: marketingContacts.email,
      emailNormalized: marketingContacts.emailNormalized,
      firstConsentedAt: marketingContacts.firstConsentedAt,
      id: marketingContacts.id,
      instagram: marketingContacts.instagram,
      lastConsentedAt: marketingContacts.lastConsentedAt,
      latestSyncCreatedAt: latestSyncJobs.createdAt,
      latestSyncDeadLetteredAt: latestSyncJobs.deadLetteredAt,
      latestSyncLastAttemptedAt: latestSyncJobs.lastAttemptedAt,
      latestSyncStatus: latestSyncJobs.status,
      latestSyncSucceededAt: latestSyncJobs.succeededAt,
      name: marketingContacts.name,
      phone: marketingContacts.phone,
      source: marketingContacts.source,
      unsubscribedAt: marketingContacts.unsubscribedAt,
      updatedAt: marketingContacts.updatedAt,
    })
    .from(marketingContacts)
    .leftJoin(
      latestSyncJobs,
      eq(latestSyncJobs.emailNormalized, marketingContacts.emailNormalized),
    )
    .where(contactFilter)
    .orderBy(desc(marketingContacts.updatedAt), desc(marketingContacts.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const rows = contacts.map((contact) => {
    const latestSync =
      contact.latestSyncStatus === null
        ? null
        : {
            ...getMarketingSyncStatusPresentation(contact.latestSyncStatus),
            createdAt: contact.latestSyncCreatedAt,
            deadLetteredAt: contact.latestSyncDeadLetteredAt,
            lastAttemptedAt: contact.latestSyncLastAttemptedAt,
            succeededAt: contact.latestSyncSucceededAt,
          };
    const hasSyncIssue =
      contact.unsubscribedAt === null &&
      contact.latestSyncStatus !== null &&
      isMarketingSyncIssue(contact.latestSyncStatus);

    return {
      createdAt: contact.createdAt,
      email: contact.email,
      emailNormalized: contact.emailNormalized,
      firstConsentedAt: contact.firstConsentedAt,
      id: contact.id,
      instagram: contact.instagram,
      lastConsentedAt: contact.lastConsentedAt,
      latestSync,
      name: contact.name,
      phone: contact.phone,
      sourceCode: contact.source,
      sourceLabel: getMarketingSourceLabel(contact.source),
      syncIssue: hasSyncIssue ? latestSync : null,
      unsubscribedAt: contact.unsubscribedAt,
      updatedAt: contact.updatedAt,
    };
  });
  await recordAdminAudit({
    action: "marketing_contacts_view",
    actor,
    domain: "marketing",
    metadata: {
      page,
      resultCount: rows.length,
      consentRangeApplied: consentRange !== null,
      searchApplied: query.length > 0,
      sourceApplied: source.length > 0,
      statusApplied: status !== "all",
    },
    outcome: "success",
    targetType: "marketing_contact_list",
  });
  return {
    consentRange: consentRange
      ? { from: consentRange.from, to: consentRange.to }
      : null,
    overview: overviewRows[0] ?? {
      currentAudience: 0,
      deliveryIssues: 0,
      total: 0,
      unsubscribed: 0,
    },
    page,
    pageCount,
    pageSize,
    rows,
    sources: sourceRows.map((row) => ({
      label: getMarketingSourceLabel(row.source),
      value: row.source,
    })),
    total,
  };
}

export async function getAdminAnalytics(
  input: { from?: string; now?: Date; to?: string } = {},
) {
  await requirePermission("analytics:view");
  const db = getPrivateDb();
  const [settings] = await db
    .select({ timezone: bookingBusinessSettings.timezone })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"))
    .limit(1);
  const timezone = settings?.timezone ?? "America/Toronto";
  const defaultRange = getBusinessRollingDateRange(
    input.now ?? new Date(),
    timezone,
    30,
  );
  const range = getBusinessDateRange(
    input.from?.trim() || defaultRange.from,
    input.to?.trim() || defaultRange.to,
    timezone,
  );
  if (range.to > addCalendarDays(range.from, 365)) {
    throw new Error("The reporting range cannot exceed 366 days");
  }
  const completedSquareRefunds = db
    .selectDistinctOn([squarePaymentRefundEvents.squareRefundId], {
      amountCents: squarePaymentRefundEvents.amountCents,
      occurredAt: squarePaymentRefundEvents.occurredAt,
      squareRefundId: squarePaymentRefundEvents.squareRefundId,
    })
    .from(squarePaymentRefundEvents)
    .where(eq(squarePaymentRefundEvents.status, "COMPLETED"))
    .orderBy(
      squarePaymentRefundEvents.squareRefundId,
      squarePaymentRefundEvents.occurredAt,
      squarePaymentRefundEvents.createdAt,
    )
    .as("completed_square_refunds");
  const [
    scheduledAppointmentRows,
    completedAppointmentRows,
    paymentRows,
    newOptInRows,
    refundRows,
    audienceRows,
    offeringRows,
  ] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)::int`,
        status: appointments.status,
      })
      .from(appointments)
      .where(
        and(
          gte(appointments.selectedStart, range.start),
          lt(appointments.selectedStart, range.endExclusive),
        ),
      )
      .groupBy(appointments.status),
    db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.status, "completed"),
          gte(appointments.completedAt, range.start),
          lt(appointments.completedAt, range.endExclusive),
        ),
      ),
    db
      .select({
        count: sql<number>`count(*)::int`,
        paymentsReceivedCents: sql<number>`coalesce(
            sum(
              ${checkoutOrders.amountCents}
              + coalesce(${checkoutOrders.squareTipAmountCents}, 0)
            ),
            0
          )::int`,
      })
      .from(checkoutOrders)
      .where(
        and(
          inArray(checkoutOrders.status, ["paid", "refunded"]),
          gte(checkoutOrders.paidAt, range.start),
          lt(checkoutOrders.paidAt, range.endExclusive),
        ),
      ),
    db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(marketingContacts)
      .where(
        and(
          gte(marketingContacts.firstConsentedAt, range.start),
          lt(marketingContacts.firstConsentedAt, range.endExclusive),
        ),
      ),
    db
      .select({
        amountCents: sql<number>`coalesce(sum(${completedSquareRefunds.amountCents}), 0)::int`,
      })
      .from(completedSquareRefunds)
      .where(
        and(
          gte(completedSquareRefunds.occurredAt, range.start),
          lt(completedSquareRefunds.occurredAt, range.endExclusive),
        ),
      ),
    db
      .select({
        currentAudience: sql<number>`count(*) filter (where ${marketingContacts.unsubscribedAt} is null)::int`,
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
  const scheduledAppointmentsByStatus = Object.fromEntries(
    scheduledAppointmentRows.map((row) => [row.status, row.count]),
  );

  return {
    currentAudience: audienceRows[0] ?? {
      currentAudience: 0,
      total: 0,
      unsubscribed: 0,
    },
    currentConfiguration: {
      offerings: offeringRows[0] ?? { active: 0, total: 0 },
    },
    period: {
      completedAppointments: completedAppointmentRows[0]?.count ?? 0,
      newMarketingOptIns: newOptInRows[0]?.count ?? 0,
      paidCheckoutOrders: paymentRows[0]?.count ?? 0,
      paymentsReceivedCents: paymentRows[0]?.paymentsReceivedCents ?? 0,
      refundCoverage: "square_only" as const,
      refundsIssuedCents: refundRows[0]?.amountCents ?? 0,
      scheduledAppointmentsByStatus,
    },
    range: {
      from: range.from,
      to: range.to,
    },
    timezone,
  };
}

const MARKETING_SYNC_ISSUE_STATUSES = [
  "retryable_failed",
  "dead_letter",
] as const;

function isMarketingSyncIssue(status: MarketingContactSyncJobStatus): boolean {
  return MARKETING_SYNC_ISSUE_STATUSES.some(
    (candidate) => candidate === status,
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function getResourceFilter(
  actor: AdminActor,
  column: typeof bookingResources.id | typeof appointments.primaryResourceId,
) {
  if (actor.user.role !== "employee") return undefined;
  if (actor.bookingResourceIds.length === 0) return false as const;
  return inArray(column, actor.bookingResourceIds);
}
