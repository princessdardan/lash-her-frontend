import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointments,
  appointmentHolds,
  bookingBusinessSettings,
  bookingCalendarConnections,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResources,
  bookingResourceSchedules,
  bookingServices,
  bookingServiceOfferingAddOns,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
  checkoutOrders,
  marketingContacts,
  marketingContactSyncJobs,
  squarePaymentRefundEvents,
  trainingEnrollments,
} from "@/lib/private-db/schema";

import {
  getAdminOverviewAttentionAccess,
  getAdminOverviewResourceScope,
  settleAdminOverviewSections,
  type AdminOverviewResourceScope,
} from "./admin-overview-model";
import {
  buildAdminOverviewAttentionItems,
  type AdminOverviewAttentionItem,
} from "./admin-overview-attention";
import { requirePermission } from "./auth";
import { getBookingIssueFilter } from "./booking-issue-filter";
import {
  addCalendarDays,
  getBusinessDateRange,
  getBusinessRollingDateRange,
  getBusinessTodayRange,
} from "./business-time";
import {
  getAppointmentStatusPresentation,
  getTimezoneLabel,
  type AdminStatusPresentation,
} from "./presentation";

const FALLBACK_TIMEZONE = "America/Toronto";
const SCHEDULE_LIMIT = 8;

export type {
  AdminOverviewAttentionItem,
  AdminOverviewAttentionKind,
} from "./admin-overview-attention";

export interface AdminOverviewUnavailableSection {
  key: string;
  label: string;
}

export interface AdminOverviewScheduleItem {
  customerName: string;
  href: string;
  id: string;
  providerName: string;
  publicReference: string;
  serviceName: string;
  status: AdminStatusPresentation;
  timeLabel: string;
}

export interface AdminOverview {
  atAGlance: {
    appointmentsNextSevenDays: number;
    appointmentsToday: number;
    needsFollowUp: number;
    nextSevenDaysPeriod: { from: string; to: string };
  } | null;
  bookingHealth: {
    activeBookableServices: number | null;
    calendarConnectionsNeedingAttention: number | null;
    providersReadyForOnlineBooking: number | null;
    setupBlockers: number | null;
  } | null;
  businessSnapshot: {
    completedAppointments: number | null;
    newMarketingOptIns: number | null;
    paidCheckoutOrders: number | null;
    paymentsReceivedCents: number | null;
    period: { from: string; to: string };
    refundCoverage: "square_only";
    refundsIssuedCents: number | null;
  } | null;
  needsAttention: {
    complete: boolean;
    items: AdminOverviewAttentionItem[];
  };
  scope: "assigned_resources" | "business";
  timezoneLabel: string;
  todaySchedule: AdminOverviewScheduleItem[] | null;
  unavailableSections: AdminOverviewUnavailableSection[];
}

export async function getAdminOverview(
  input: { now?: Date } = {},
): Promise<AdminOverview> {
  const actor = await requirePermission("admin:view");
  const db = getPrivateDb();
  const now = input.now ?? new Date();
  const unavailableSections: AdminOverviewUnavailableSection[] = [];
  let timezone = FALLBACK_TIMEZONE;

  try {
    const [settings] = await db
      .select({ timezone: bookingBusinessSettings.timezone })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"))
      .limit(1);
    timezone = settings?.timezone ?? FALLBACK_TIMEZONE;
  } catch (error) {
    recordSectionFailure("timezone", error);
    unavailableSections.push({
      key: "timezone",
      label: "Business timezone",
    });
  }

  const scope = getAdminOverviewResourceScope(actor);
  const attentionAccess = getAdminOverviewAttentionAccess(scope);
  const isBusinessScope = scope.kind === "all";
  const today = getBusinessTodayRange(now, timezone);
  const nextSevenDays = getBusinessDateRange(
    addCalendarDays(today.to, 1),
    addCalendarDays(today.to, 7),
    timezone,
  );
  const lastThirtyDays = getBusinessRollingDateRange(now, timezone, 30);
  const common = await settleAdminOverviewSections({
    appointmentAttention: () => loadAppointmentAttention(db, scope, now),
    atAGlance: () =>
      loadAtAGlance(db, scope, {
        nextSevenDays,
        now,
        today,
      }),
    calendarAttention: () => loadCalendarAttention(db, scope),
    offeringHealth: () => loadOfferingHealth(db, scope),
    todaySchedule: () => loadTodaySchedule(db, scope, { now, timezone, today }),
  });

  unavailableSections.push(
    ...common.failures.map(({ error, key }) => {
      recordSectionFailure(String(key), error);
      return {
        key: String(key),
        label: COMMON_SECTION_LABELS[key],
      };
    }),
  );

  const ownerSections = isBusinessScope
    ? await settleAdminOverviewSections({
        bookingIssueAttention: () => loadBookingIssueAttention(db, now),
        completedAppointments: () =>
          loadCompletedAppointments(db, lastThirtyDays),
        holdEmailAttention: () => loadHoldEmailAttention(db),
        marketingAttention: () => loadMarketingAttention(db),
        newMarketingOptIns: () => loadNewMarketingOptIns(db, lastThirtyDays),
        paymentsReceived: () => loadPaymentsReceived(db, lastThirtyDays),
        refundsIssued: () => loadRefundsIssued(db, lastThirtyDays),
        trainingAttention: () => loadTrainingAttention(db),
      })
    : null;

  if (ownerSections) {
    unavailableSections.push(
      ...ownerSections.failures.map(({ error, key }) => {
        recordSectionFailure(String(key), error);
        return {
          key: String(key),
          label: OWNER_SECTION_LABELS[key],
        };
      }),
    );
  }

  const attentionItems = buildAdminOverviewAttentionItems(attentionAccess, {
    appointmentAttendance: common.values.appointmentAttention?.attendance,
    appointmentCalendarSync: common.values.appointmentAttention?.calendarSync,
    appointmentEmailFailures: common.values.appointmentAttention?.customerEmail,
    bookingIssues: ownerSections?.values.bookingIssueAttention?.count,
    calendarConnections: common.values.calendarAttention?.connections,
    holdEmailFailures: ownerSections?.values.holdEmailAttention?.count,
    marketingFailures: ownerSections?.values.marketingAttention?.count,
    serviceAvailabilityIssues:
      common.values.offeringHealth?.unavailableOfferings,
    trainingSchedulingIssues:
      (ownerSections?.values.trainingAttention?.pending ?? 0) +
      (ownerSections?.values.trainingAttention?.manualFollowUp ?? 0),
  });
  const ownerValues = ownerSections?.values;

  return {
    atAGlance: common.values.atAGlance,
    bookingHealth: isBusinessScope
      ? {
          activeBookableServices:
            common.values.offeringHealth?.activeBookableServices ?? null,
          calendarConnectionsNeedingAttention:
            common.values.calendarAttention?.connections ?? null,
          providersReadyForOnlineBooking:
            common.values.offeringHealth?.readyProviders ?? null,
          setupBlockers:
            common.values.offeringHealth?.unavailableOfferings ?? null,
        }
      : null,
    businessSnapshot: isBusinessScope
      ? {
          completedAppointments:
            ownerValues?.completedAppointments?.count ?? null,
          newMarketingOptIns: ownerValues?.newMarketingOptIns?.count ?? null,
          paidCheckoutOrders: ownerValues?.paymentsReceived?.count ?? null,
          paymentsReceivedCents:
            ownerValues?.paymentsReceived?.amountCents ?? null,
          period: {
            from: lastThirtyDays.from,
            to: lastThirtyDays.to,
          },
          refundCoverage: "square_only",
          refundsIssuedCents: ownerValues?.refundsIssued?.amountCents ?? null,
        }
      : null,
    needsAttention: {
      complete: !unavailableSections.some((section) =>
        ATTENTION_SECTION_KEYS.has(section.key),
      ),
      items: attentionItems,
    },
    scope: isBusinessScope ? "business" : "assigned_resources",
    timezoneLabel: `Times shown in ${getTimezoneLabel(timezone)}`,
    todaySchedule: common.values.todaySchedule,
    unavailableSections,
  };
}

type PrivateDb = ReturnType<typeof getPrivateDb>;
type BusinessRange = ReturnType<typeof getBusinessDateRange>;

const COMMON_SECTION_LABELS = {
  appointmentAttention: "Appointment attention",
  atAGlance: "At a glance",
  calendarAttention: "Calendar connection health",
  offeringHealth: "Service booking health",
  todaySchedule: "Today’s schedule",
} as const;

const OWNER_SECTION_LABELS = {
  bookingIssueAttention: "Booking issues",
  completedAppointments: "Completed appointments",
  holdEmailAttention: "Booking confirmation delivery",
  marketingAttention: "Marketing delivery",
  newMarketingOptIns: "New marketing opt-ins",
  paymentsReceived: "Payments received",
  refundsIssued: "Refunds issued",
  trainingAttention: "Training scheduling",
} as const;

const ATTENTION_SECTION_KEYS = new Set([
  "appointmentAttention",
  "bookingIssueAttention",
  "calendarAttention",
  "holdEmailAttention",
  "marketingAttention",
  "offeringHealth",
  "trainingAttention",
]);

async function loadAtAGlance(
  db: PrivateDb,
  scope: AdminOverviewResourceScope,
  input: {
    nextSevenDays: BusinessRange;
    now: Date;
    today: BusinessRange;
  },
) {
  const [row] = await db
    .select({
      appointmentsNextSevenDays: sql<number>`count(*) filter (
        where ${appointments.selectedStart} >= ${input.nextSevenDays.start}
          and ${appointments.selectedStart} < ${input.nextSevenDays.endExclusive}
          and ${appointments.status} <> 'cancelled'
      )::int`,
      appointmentsToday: sql<number>`count(*) filter (
        where ${appointments.selectedStart} >= ${input.today.start}
          and ${appointments.selectedStart} < ${input.today.endExclusive}
          and ${appointments.status} <> 'cancelled'
      )::int`,
      needsFollowUp: sql<number>`count(*) filter (
        where (
          (${appointments.status} = 'confirmed' and ${appointments.selectedEnd} <= ${input.now})
          or ${appointments.status} in ('manual_followup', 'rebooking_pending')
          or ${appointments.paymentStatus} = 'refund_required'
          or ${appointments.calendarSyncStatus} = 'manual_followup'
          or (
            ${appointments.bookingConfirmationEmailSentAt} is null
            and ${appointments.bookingConfirmationEmailLastError} is not null
          )
        )
      )::int`,
    })
    .from(appointments)
    .where(getScopeFilter(scope, appointments.primaryResourceId));

  return {
    ...(row ?? {
      appointmentsNextSevenDays: 0,
      appointmentsToday: 0,
      needsFollowUp: 0,
    }),
    nextSevenDaysPeriod: {
      from: input.nextSevenDays.from,
      to: input.nextSevenDays.to,
    },
  };
}

async function loadTodaySchedule(
  db: PrivateDb,
  scope: AdminOverviewResourceScope,
  input: { now: Date; timezone: string; today: BusinessRange },
): Promise<AdminOverviewScheduleItem[]> {
  const rows = await db
    .select({
      customerName: appointments.customerName,
      id: appointments.id,
      providerName: sql<string>`coalesce(
        nullif(${appointments.providerSnapshot}->>'displayName', ''),
        ${bookingProviders.displayName}
      )`,
      publicReference: appointments.publicReference,
      selectedStart: appointments.selectedStart,
      serviceName: sql<string>`coalesce(
        nullif(${appointments.offeringSnapshot}->'service'->>'displayTitle', ''),
        nullif(${appointments.offeringSnapshot}->>'title', ''),
        ${bookingServices.displayTitle}
      )`,
      status: appointments.status,
    })
    .from(appointments)
    .innerJoin(
      bookingProviders,
      eq(bookingProviders.id, appointments.providerId),
    )
    .innerJoin(
      bookingServiceOfferings,
      eq(bookingServiceOfferings.id, appointments.serviceOfferingId),
    )
    .innerJoin(
      bookingServices,
      eq(bookingServices.id, bookingServiceOfferings.serviceId),
    )
    .where(
      and(
        getScopeFilter(scope, appointments.primaryResourceId),
        ne(appointments.status, "cancelled"),
        gte(appointments.selectedStart, input.today.start),
        lt(appointments.selectedStart, input.today.endExclusive),
        gte(appointments.selectedEnd, input.now),
      ),
    )
    .orderBy(asc(appointments.selectedStart), asc(appointments.id))
    .limit(SCHEDULE_LIMIT);
  const timeFormatter = new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: input.timezone,
  });

  return rows.map((row) => ({
    customerName: row.customerName,
    href: `/admin/appointments/${row.id}`,
    id: row.id,
    providerName: row.providerName,
    publicReference: row.publicReference,
    serviceName: row.serviceName,
    status: getAppointmentStatusPresentation(row.status),
    timeLabel: timeFormatter.format(row.selectedStart),
  }));
}

async function loadAppointmentAttention(
  db: PrivateDb,
  scope: AdminOverviewResourceScope,
  now: Date,
) {
  const [row] = await db
    .select({
      attendance: sql<number>`count(*) filter (
        where ${appointments.status} = 'confirmed'
          and ${appointments.selectedEnd} <= ${now}
      )::int`,
      calendarSync: sql<number>`count(*) filter (
        where ${appointments.calendarSyncStatus} = 'manual_followup'
      )::int`,
      customerEmail: sql<number>`count(*) filter (
        where ${appointments.bookingConfirmationEmailSentAt} is null
          and ${appointments.bookingConfirmationEmailLastError} is not null
      )::int`,
    })
    .from(appointments)
    .where(getScopeFilter(scope, appointments.primaryResourceId));

  return row ?? { attendance: 0, calendarSync: 0, customerEmail: 0 };
}

async function loadBookingIssueAttention(db: PrivateDb, now: Date) {
  const [row] = await db
    .select({
      count: sql<number>`count(distinct ${appointmentHolds.id})::int`,
    })
    .from(appointmentHolds)
    .leftJoin(
      checkoutOrders,
      eq(checkoutOrders.id, appointmentHolds.checkoutOrderId),
    )
    .leftJoin(appointments, eq(appointments.sourceHoldId, appointmentHolds.id))
    .where(getBookingIssueFilter(now));

  return row ?? { count: 0 };
}

async function loadCalendarAttention(
  db: PrivateDb,
  scope: AdminOverviewResourceScope,
) {
  const [row] = await db
    .select({
      connections: sql<number>`count(distinct ${bookingCalendarConnections.id})::int`,
    })
    .from(bookingCalendarConnections)
    .innerJoin(
      bookingResourceCalendarAssignments,
      eq(
        bookingResourceCalendarAssignments.calendarConnectionId,
        bookingCalendarConnections.id,
      ),
    )
    .where(
      and(
        getScopeFilter(scope, bookingResourceCalendarAssignments.resourceId),
        eq(bookingResourceCalendarAssignments.status, "active"),
        inArray(bookingCalendarConnections.status, [
          "reconnect_required",
          "revoked",
        ]),
      ),
    );

  return row ?? { connections: 0 };
}

async function loadHoldEmailAttention(db: PrivateDb) {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(appointmentHolds)
    .where(
      and(
        isNull(appointmentHolds.bookingConfirmationEmailSentAt),
        isNotNull(appointmentHolds.bookingConfirmationEmailLastError),
        sql`not exists (
          select 1
          from ${appointments}
          where ${appointments.sourceHoldId} = ${appointmentHolds.id}
        )`,
      ),
    );

  return row ?? { count: 0 };
}

async function loadOfferingHealth(
  db: PrivateDb,
  scope: AdminOverviewResourceScope,
) {
  const ready = readyOfferingSql();
  const [row] = await db
    .select({
      activeBookableServices: sql<number>`count(distinct ${bookingServiceOfferings.serviceId}) filter (where ${ready})::int`,
      activeOfferings: sql<number>`count(*) filter (
        where ${bookingServiceOfferings.status} = 'active'
      )::int`,
      readyOfferings: sql<number>`count(*) filter (where ${ready})::int`,
      readyProviders: sql<number>`count(distinct ${bookingServiceOfferings.providerId}) filter (where ${ready})::int`,
    })
    .from(bookingServiceOfferings)
    .innerJoin(
      bookingServices,
      eq(bookingServices.id, bookingServiceOfferings.serviceId),
    )
    .innerJoin(
      bookingProviders,
      eq(bookingProviders.id, bookingServiceOfferings.providerId),
    )
    .innerJoin(
      bookingResources,
      eq(bookingResources.id, bookingServiceOfferings.primaryResourceId),
    )
    .where(getScopeFilter(scope, bookingServiceOfferings.primaryResourceId));
  const counts = row ?? {
    activeBookableServices: 0,
    activeOfferings: 0,
    readyOfferings: 0,
    readyProviders: 0,
  };

  return {
    ...counts,
    unavailableOfferings: Math.max(
      counts.activeOfferings - counts.readyOfferings,
      0,
    ),
  };
}

async function loadCompletedAppointments(db: PrivateDb, range: BusinessRange) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "completed"),
        gte(appointments.completedAt, range.start),
        lt(appointments.completedAt, range.endExclusive),
      ),
    );
  return row ?? { count: 0 };
}

async function loadPaymentsReceived(db: PrivateDb, range: BusinessRange) {
  const [row] = await db
    .select({
      amountCents: sql<number>`coalesce(
        sum(
          ${checkoutOrders.amountCents}
          + coalesce(${checkoutOrders.squareTipAmountCents}, 0)
        ),
        0
      )::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(checkoutOrders)
    .where(
      and(
        inArray(checkoutOrders.status, ["paid", "refunded"]),
        gte(checkoutOrders.paidAt, range.start),
        lt(checkoutOrders.paidAt, range.endExclusive),
      ),
    );
  return row ?? { amountCents: 0, count: 0 };
}

async function loadNewMarketingOptIns(db: PrivateDb, range: BusinessRange) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketingContacts)
    .where(
      and(
        gte(marketingContacts.firstConsentedAt, range.start),
        lt(marketingContacts.firstConsentedAt, range.endExclusive),
      ),
    );
  return row ?? { count: 0 };
}

async function loadRefundsIssued(db: PrivateDb, range: BusinessRange) {
  const completedRefunds = db
    .selectDistinctOn([squarePaymentRefundEvents.squareRefundId], {
      amountCents: squarePaymentRefundEvents.amountCents,
      occurredAt: squarePaymentRefundEvents.occurredAt,
      squareRefundId: squarePaymentRefundEvents.squareRefundId,
    })
    .from(squarePaymentRefundEvents)
    .where(eq(squarePaymentRefundEvents.status, "COMPLETED"))
    .orderBy(
      squarePaymentRefundEvents.squareRefundId,
      asc(squarePaymentRefundEvents.occurredAt),
      asc(squarePaymentRefundEvents.createdAt),
    )
    .as("overview_completed_square_refunds");
  const [row] = await db
    .select({
      amountCents: sql<number>`coalesce(sum(${completedRefunds.amountCents}), 0)::int`,
    })
    .from(completedRefunds)
    .where(
      and(
        gte(completedRefunds.occurredAt, range.start),
        lt(completedRefunds.occurredAt, range.endExclusive),
      ),
    );
  return row ?? { amountCents: 0 };
}

async function loadMarketingAttention(db: PrivateDb) {
  const latestJobs = db
    .selectDistinctOn([marketingContactSyncJobs.emailNormalized], {
      emailNormalized: marketingContactSyncJobs.emailNormalized,
      id: marketingContactSyncJobs.id,
      status: marketingContactSyncJobs.status,
    })
    .from(marketingContactSyncJobs)
    .orderBy(
      marketingContactSyncJobs.emailNormalized,
      desc(marketingContactSyncJobs.createdAt),
      desc(marketingContactSyncJobs.id),
    )
    .as("overview_latest_marketing_sync_jobs");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketingContacts)
    .innerJoin(
      latestJobs,
      eq(latestJobs.emailNormalized, marketingContacts.emailNormalized),
    )
    .where(
      and(
        isNull(marketingContacts.unsubscribedAt),
        inArray(latestJobs.status, ["retryable_failed", "dead_letter"]),
      ),
    );
  return row ?? { count: 0 };
}

async function loadTrainingAttention(db: PrivateDb) {
  const [row] = await db
    .select({
      manualFollowUp: sql<number>`count(*) filter (
        where ${trainingEnrollments.schedulingStatus} = 'manual_followup'
      )::int`,
      pending: sql<number>`count(*) filter (
        where ${trainingEnrollments.schedulingStatus} = 'pending'
      )::int`,
    })
    .from(trainingEnrollments);
  return row ?? { manualFollowUp: 0, pending: 0 };
}

function getScopeFilter(
  scope: AdminOverviewResourceScope,
  column: AnyPgColumn,
): SQL | undefined {
  if (scope.kind === "all") return undefined;
  if (scope.kind === "none") return sql`false`;
  return inArray(column, [...scope.ids]);
}

function readyOfferingSql(): SQL {
  return sql`
    ${bookingServiceOfferings.status} = 'active'
    and ${bookingServices.status} = 'active'
    and nullif(trim(${bookingServices.publicSlug}), '') is not null
    and ${bookingProviders.status} = 'active'
    and nullif(trim(${bookingProviders.displayName}), '') is not null
    and nullif(trim(${bookingProviders.publicSlug}), '') is not null
    and ${bookingProviders.primaryResourceId} = ${bookingServiceOfferings.primaryResourceId}
    and ${bookingResources.status} = 'active'
    and nullif(trim(${bookingServiceOfferings.publicTitle}), '') is not null
    and nullif(trim(${bookingServiceOfferings.publicSummary}), '') is not null
    and exists (
      select 1
      from ${bookingResourceSchedules}
      where ${bookingResourceSchedules.resourceId} = ${bookingServiceOfferings.primaryResourceId}
        and ${bookingResourceSchedules.status} = 'active'
    )
    and exists (
      select 1
      from ${bookingResourceCalendarAssignments}
      inner join ${bookingCalendarConnections}
        on ${bookingCalendarConnections.id} = ${bookingResourceCalendarAssignments.calendarConnectionId}
      where ${bookingResourceCalendarAssignments.resourceId} = ${bookingServiceOfferings.primaryResourceId}
        and ${bookingResourceCalendarAssignments.status} = 'active'
        and ${bookingResourceCalendarAssignments.acceptsBookings} = true
        and ${bookingCalendarConnections.status} = 'active'
    )
    and not exists (
      select 1
      from ${bookingServiceOfferingAddOns}
      where ${bookingServiceOfferingAddOns.offeringId} = ${bookingServiceOfferings.id}
        and ${bookingServiceOfferingAddOns.status} = 'active'
        and (
          nullif(trim(${bookingServiceOfferingAddOns.addOnKey}), '') is null
          or nullif(trim(${bookingServiceOfferingAddOns.name}), '') is null
          or nullif(trim(${bookingServiceOfferingAddOns.description}), '') is null
          or ${bookingServiceOfferingAddOns.priceCents} <= 0
          or ${bookingServiceOfferingAddOns.durationDeltaMinutes} < 0
        )
    )
    and not exists (
      select 1
      from ${bookingServiceOfferingResources}
      inner join ${bookingResources} as required_resource
        on required_resource.id = ${bookingServiceOfferingResources.resourceId}
      where ${bookingServiceOfferingResources.offeringId} = ${bookingServiceOfferings.id}
        and ${bookingServiceOfferingResources.isRequired} = true
        and ${bookingServiceOfferingResources.resourceId} <> ${bookingServiceOfferings.primaryResourceId}
        and (
          required_resource.status <> 'active'
          or not exists (
            select 1
            from ${bookingResourceSchedules} as required_schedule
            where required_schedule.resource_id = ${bookingServiceOfferingResources.resourceId}
              and required_schedule.status = 'active'
          )
        )
    )
  `;
}

function recordSectionFailure(section: string, error: unknown): void {
  console.error("[admin-overview] Section unavailable", {
    error: error instanceof Error ? error.message : "Unknown error",
    section,
  });
}
