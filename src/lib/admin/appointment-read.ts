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
  adminUsers,
  appointmentEvents,
  appointments,
  appointmentStatus,
  bookingBusinessSettings,
  bookingProviders,
  type AppointmentStatus,
} from "@/lib/private-db/schema";

import {
  getAdminAppointmentAttentionReasons,
  getAdminAppointmentEmailPresentation,
  getAdminAppointmentEventLabel,
  toAdminAppointmentSnapshotPresentation,
} from "./appointment-presentation";
import { recordAdminAuditBestEffort } from "./audit-log";
import {
  resolveAdminAppointmentDateBasis,
  type AdminAppointmentDateBasis,
} from "./appointment-filter-policy";
import { requirePermission } from "./auth";
import { getBusinessDateRange, getBusinessTodayRange } from "./business-time";
import {
  getAppointmentCalendarSyncStatusPresentation,
  getAppointmentOriginLabel,
  getAppointmentPaymentStatusPresentation,
  getAppointmentStatusPresentation,
  type AdminStatusPresentation,
} from "./presentation";
import type { AdminActor } from "./types";

const DEFAULT_BUSINESS_TIMEZONE = "America/Toronto";
const MAX_PAGE = 10_000;
const MAX_SEARCH_LENGTH = 120;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ADMIN_APPOINTMENT_PAGE_SIZE = 25;

export const ADMIN_APPOINTMENT_VIEWS = [
  "today",
  "upcoming",
  "past",
  "needs-attention",
  "all",
] as const;

export type AdminAppointmentView = (typeof ADMIN_APPOINTMENT_VIEWS)[number];

export interface AdminAppointmentSearchParams {
  basis?: string | string[];
  from?: string | string[];
  page?: string | string[];
  provider?: string | string[];
  q?: string | string[];
  status?: string | string[];
  to?: string | string[];
  view?: string | string[];
}

export interface AdminAppointmentFilters {
  dateBasis: AdminAppointmentDateBasis;
  from: string;
  providerId: string;
  query: string;
  status: AppointmentStatus | "";
  to: string;
  view: AdminAppointmentView;
}

export interface AdminAppointmentFieldErrors {
  from?: string;
  provider?: string;
  query?: string;
  status?: string;
  to?: string;
}

export interface AdminAppointmentListRow {
  addOnName: string | null;
  attentionReasons: string[];
  calendarStatus: AdminStatusPresentation;
  customerName: string;
  id: string;
  paymentStatus: AdminStatusPresentation;
  providerName: string;
  publicReference: string;
  selectedEnd: Date;
  selectedStart: Date;
  serviceName: string;
  status: AdminStatusPresentation;
}

export interface AdminAppointmentListResult {
  attentionCount: number;
  businessTimezone: string;
  businessTimezoneLabel: string;
  fieldErrors: AdminAppointmentFieldErrors;
  filters: AdminAppointmentFilters;
  page: number;
  pageCount: number;
  pageSize: number;
  providers: Array<{ id: string; name: string }>;
  rows: AdminAppointmentListRow[];
  statusOptions: Array<{
    label: string;
    value: AppointmentStatus;
  }>;
  total: number;
}

export interface AdminAppointmentDetail {
  activity: Array<{
    actorName: string | null;
    createdAt: Date;
    label: string;
  }>;
  addOn: {
    description: string | null;
    name: string;
  } | null;
  attendanceCanBeRecorded: boolean;
  attentionReasons: string[];
  businessTimezone: string;
  businessTimezoneLabel: string;
  calendarStatus: AdminStatusPresentation;
  cancellationNote: string | null;
  createdAt: Date;
  customerEmail: string;
  customerName: string;
  customerPhone: string | null;
  durationMinutes: number | null;
  emailStatus: AdminStatusPresentation;
  id: string;
  intake: Array<{ answer: string; label: string }>;
  originLabel: string;
  paymentStatus: AdminStatusPresentation;
  providerName: string;
  publicReference: string;
  selectedEnd: Date;
  selectedStart: Date;
  serviceName: string;
  status: AdminStatusPresentation;
  updatedAt: Date;
}

export async function getAdminAppointments(
  searchParams: AdminAppointmentSearchParams = {},
): Promise<AdminAppointmentListResult> {
  const actor = await requirePermission("bookings:view");
  const db = getPrivateDb();
  const now = new Date();
  const filters = normalizeAppointmentFilters(searchParams);
  const [settings] = await db
    .select({ timezone: bookingBusinessSettings.timezone })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"))
    .limit(1);
  const businessTimezone = settings?.timezone ?? DEFAULT_BUSINESS_TIMEZONE;
  const todayRange = getBusinessTodayRange(now, businessTimezone);
  const fieldErrors = validateAppointmentFilters(filters, searchParams);
  const resourceScope = getAppointmentResourceScope(actor);
  const attentionCondition = getAppointmentAttentionCondition(now);
  const whereCondition = and(
    resourceScope,
    getAppointmentViewCondition(filters.view, {
      now,
      todayEndExclusive: todayRange.endExclusive,
      todayStart: todayRange.start,
    }),
    getAppointmentSearchCondition(filters.query),
    getAppointmentDateCondition(filters, fieldErrors, businessTimezone),
    filters.providerId
      ? eq(appointments.providerId, filters.providerId)
      : undefined,
    filters.status ? eq(appointments.status, filters.status) : undefined,
  );
  const page = normalizePage(firstString(searchParams.page));
  const offset = (page - 1) * ADMIN_APPOINTMENT_PAGE_SIZE;

  const rowsQuery = db
    .select({
      bookingConfirmationEmailLastError:
        appointments.bookingConfirmationEmailLastError,
      bookingConfirmationEmailSentAt:
        appointments.bookingConfirmationEmailSentAt,
      calendarSyncStatus: appointments.calendarSyncStatus,
      customerName: appointments.customerName,
      id: appointments.id,
      offeringSnapshot: appointments.offeringSnapshot,
      paymentStatus: appointments.paymentStatus,
      providerDisplayName: bookingProviders.displayName,
      providerSnapshot: appointments.providerSnapshot,
      publicReference: appointments.publicReference,
      selectedEnd: appointments.selectedEnd,
      selectedStart: appointments.selectedStart,
      status: appointments.status,
    })
    .from(appointments)
    .innerJoin(
      bookingProviders,
      eq(bookingProviders.id, appointments.providerId),
    )
    .where(whereCondition)
    .orderBy(...getAppointmentSort(filters.view, now))
    .limit(ADMIN_APPOINTMENT_PAGE_SIZE)
    .offset(offset);
  const countQuery = db
    .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(appointments)
    .where(whereCondition);
  const attentionCountQuery = db
    .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(appointments)
    .where(and(resourceScope, attentionCondition));
  const providersQuery = db
    .selectDistinct({
      id: bookingProviders.id,
      name: bookingProviders.displayName,
    })
    .from(appointments)
    .innerJoin(
      bookingProviders,
      eq(bookingProviders.id, appointments.providerId),
    )
    .where(resourceScope)
    .orderBy(asc(bookingProviders.displayName), asc(bookingProviders.id));

  const [rawRows, countRows, attentionCountRows, providers] = await Promise.all(
    [rowsQuery, countQuery, attentionCountQuery, providersQuery],
  );
  const total = countRows[0]?.count ?? 0;

  return {
    attentionCount: attentionCountRows[0]?.count ?? 0,
    businessTimezone,
    businessTimezoneLabel: getBusinessTimezoneLabel(businessTimezone),
    fieldErrors,
    filters,
    page,
    pageCount: total === 0 ? 0 : Math.ceil(total / ADMIN_APPOINTMENT_PAGE_SIZE),
    pageSize: ADMIN_APPOINTMENT_PAGE_SIZE,
    providers,
    rows: rawRows.map((row) => {
      const snapshot = toAdminAppointmentSnapshotPresentation({
        intake: null,
        offering: row.offeringSnapshot,
        provider: row.providerSnapshot,
      });
      const bookingConfirmationEmailFailed =
        row.bookingConfirmationEmailSentAt === null &&
        row.bookingConfirmationEmailLastError !== null;

      return {
        addOnName: snapshot.addOn?.name ?? null,
        attentionReasons: getAdminAppointmentAttentionReasons({
          bookingConfirmationEmailFailed,
          calendarSyncStatus: row.calendarSyncStatus,
          now,
          paymentStatus: row.paymentStatus,
          selectedEnd: row.selectedEnd,
          status: row.status,
        }),
        calendarStatus: getAppointmentCalendarSyncStatusPresentation(
          row.calendarSyncStatus,
        ),
        customerName: row.customerName,
        id: row.id,
        paymentStatus: getAppointmentPaymentStatusPresentation(
          row.paymentStatus,
        ),
        providerName:
          snapshot.providerName ??
          row.providerDisplayName ??
          "Provider unavailable",
        publicReference: row.publicReference,
        selectedEnd: row.selectedEnd,
        selectedStart: row.selectedStart,
        serviceName: snapshot.serviceName ?? "Service unavailable",
        status: getAppointmentStatusPresentation(row.status),
      };
    }),
    statusOptions: appointmentStatus.enumValues.map((status) => ({
      label: getAppointmentStatusPresentation(status).label,
      value: status,
    })),
    total,
  };
}

export async function getAdminAppointmentDetail(
  id: string,
): Promise<AdminAppointmentDetail | null> {
  const actor = await requirePermission("bookings:view");
  if (!UUID_PATTERN.test(id)) return null;

  const db = getPrivateDb();
  const now = new Date();
  const resourceScope = getAppointmentResourceScope(actor);
  const [settings, rows] = await Promise.all([
    db
      .select({ timezone: bookingBusinessSettings.timezone })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"))
      .limit(1),
    db
      .select({
        bookingConfirmationEmailLastError:
          appointments.bookingConfirmationEmailLastError,
        bookingConfirmationEmailSentAt:
          appointments.bookingConfirmationEmailSentAt,
        calendarSyncStatus: appointments.calendarSyncStatus,
        cancellationReason: appointments.cancellationReason,
        createdAt: appointments.createdAt,
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
        selectedEnd: appointments.selectedEnd,
        selectedStart: appointments.selectedStart,
        status: appointments.status,
        updatedAt: appointments.updatedAt,
      })
      .from(appointments)
      .innerJoin(
        bookingProviders,
        eq(bookingProviders.id, appointments.providerId),
      )
      .where(and(eq(appointments.id, id), resourceScope))
      .limit(1),
  ]);
  const row = rows[0];
  if (!row) return null;

  await recordAdminAuditBestEffort({
    action: "appointment_detail_view",
    actor,
    domain: "appointments",
    outcome: "success",
    targetId: row.id,
    targetType: "appointment",
  });

  const rawActivity = await db
    .select({
      actorName: adminUsers.displayName,
      createdAt: appointmentEvents.createdAt,
      eventType: appointmentEvents.eventType,
    })
    .from(appointmentEvents)
    .leftJoin(adminUsers, eq(adminUsers.id, appointmentEvents.actorAdminUserId))
    .where(eq(appointmentEvents.appointmentId, row.id))
    .orderBy(desc(appointmentEvents.createdAt), desc(appointmentEvents.id))
    .limit(50);
  const snapshot = toAdminAppointmentSnapshotPresentation({
    intake: row.intakeSnapshot,
    offering: row.offeringSnapshot,
    provider: row.providerSnapshot,
  });
  const bookingConfirmationEmailFailed =
    row.bookingConfirmationEmailSentAt === null &&
    row.bookingConfirmationEmailLastError !== null;
  const businessTimezone = settings[0]?.timezone ?? DEFAULT_BUSINESS_TIMEZONE;

  return {
    activity: rawActivity.map((event) => ({
      actorName: cleanOptionalDisplayText(event.actorName, 200),
      createdAt: event.createdAt,
      label: getAdminAppointmentEventLabel(event.eventType),
    })),
    addOn: snapshot.addOn,
    attendanceCanBeRecorded:
      row.status === "confirmed" && row.selectedEnd <= now,
    attentionReasons: getAdminAppointmentAttentionReasons({
      bookingConfirmationEmailFailed,
      calendarSyncStatus: row.calendarSyncStatus,
      now,
      paymentStatus: row.paymentStatus,
      selectedEnd: row.selectedEnd,
      status: row.status,
    }),
    businessTimezone,
    businessTimezoneLabel: getBusinessTimezoneLabel(businessTimezone),
    calendarStatus: getAppointmentCalendarSyncStatusPresentation(
      row.calendarSyncStatus,
    ),
    cancellationNote: cleanOptionalDisplayText(row.cancellationReason, 1_000),
    createdAt: row.createdAt,
    customerEmail: row.customerEmail,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    durationMinutes: snapshot.durationMinutes,
    emailStatus: getAdminAppointmentEmailPresentation({
      lastError: row.bookingConfirmationEmailLastError,
      sentAt: row.bookingConfirmationEmailSentAt,
    }),
    id: row.id,
    intake: snapshot.intake,
    originLabel: getAppointmentOriginLabel(row.origin),
    paymentStatus: getAppointmentPaymentStatusPresentation(row.paymentStatus),
    providerName:
      snapshot.providerName ??
      row.providerDisplayName ??
      "Provider unavailable",
    publicReference: row.publicReference,
    selectedEnd: row.selectedEnd,
    selectedStart: row.selectedStart,
    serviceName: snapshot.serviceName ?? "Service unavailable",
    status: getAppointmentStatusPresentation(row.status),
    updatedAt: row.updatedAt,
  };
}

function normalizeAppointmentFilters(
  searchParams: AdminAppointmentSearchParams,
): AdminAppointmentFilters {
  const rawView = firstString(searchParams.view);
  const rawStatus = firstString(searchParams.status);
  const rawQuery = firstString(searchParams.q).trim();
  const rawProvider = firstString(searchParams.provider).trim();
  const status = appointmentStatus.enumValues.includes(
    rawStatus as AppointmentStatus,
  )
    ? (rawStatus as AppointmentStatus)
    : "";

  return {
    dateBasis: resolveAdminAppointmentDateBasis({
      basis: firstString(searchParams.basis),
      status,
    }),
    from: firstString(searchParams.from).trim(),
    providerId: UUID_PATTERN.test(rawProvider) ? rawProvider : "",
    query: rawQuery.slice(0, MAX_SEARCH_LENGTH),
    status,
    to: firstString(searchParams.to).trim(),
    view: ADMIN_APPOINTMENT_VIEWS.includes(rawView as AdminAppointmentView)
      ? (rawView as AdminAppointmentView)
      : "today",
  };
}

function validateAppointmentFilters(
  filters: AdminAppointmentFilters,
  searchParams: AdminAppointmentSearchParams,
): AdminAppointmentFieldErrors {
  const errors: AdminAppointmentFieldErrors = {};
  const rawProvider = firstString(searchParams.provider).trim();
  const rawQuery = firstString(searchParams.q).trim();
  const rawStatus = firstString(searchParams.status).trim();

  if (filters.from && !isCalendarDate(filters.from)) {
    errors.from = "Enter a valid start date.";
  }
  if (filters.to && !isCalendarDate(filters.to)) {
    errors.to = "Enter a valid end date.";
  }
  if (
    !errors.from &&
    !errors.to &&
    filters.from &&
    filters.to &&
    filters.from > filters.to
  ) {
    errors.from = "The start date must not be after the end date.";
    errors.to = "The end date must not be before the start date.";
  }
  if (rawProvider && !UUID_PATTERN.test(rawProvider)) {
    errors.provider = "Choose a provider from the list.";
  }
  if (
    rawStatus &&
    !appointmentStatus.enumValues.includes(rawStatus as AppointmentStatus)
  ) {
    errors.status = "Choose a valid appointment status.";
  }
  if (rawQuery.length > MAX_SEARCH_LENGTH) {
    errors.query = `Search terms must be ${MAX_SEARCH_LENGTH} characters or fewer.`;
  }

  return errors;
}

function getAppointmentResourceScope(actor: AdminActor): SQL | undefined {
  if (actor.user.role !== "employee") return undefined;
  if (actor.bookingResourceIds.length === 0) return sql`false`;
  return inArray(appointments.primaryResourceId, actor.bookingResourceIds);
}

function getAppointmentAttentionCondition(now: Date): SQL {
  return or(
    inArray(appointments.status, ["rebooking_pending", "manual_followup"]),
    eq(appointments.paymentStatus, "refund_required"),
    eq(appointments.calendarSyncStatus, "manual_followup"),
    and(
      eq(appointments.status, "confirmed"),
      lt(appointments.selectedEnd, now),
    ),
    and(
      ne(appointments.status, "cancelled"),
      isNull(appointments.bookingConfirmationEmailSentAt),
      isNotNull(appointments.bookingConfirmationEmailLastError),
    ),
  )!;
}

function getAppointmentViewCondition(
  view: AdminAppointmentView,
  input: {
    now: Date;
    todayEndExclusive: Date;
    todayStart: Date;
  },
): SQL | undefined {
  if (view === "today") {
    return and(
      gte(appointments.selectedStart, input.todayStart),
      lt(appointments.selectedStart, input.todayEndExclusive),
    );
  }
  if (view === "upcoming") {
    return gte(appointments.selectedStart, input.todayEndExclusive);
  }
  if (view === "past") {
    return lt(appointments.selectedStart, input.todayStart);
  }
  if (view === "needs-attention") {
    return getAppointmentAttentionCondition(input.now);
  }
  return undefined;
}

function getAppointmentSearchCondition(query: string): SQL | undefined {
  if (!query) return undefined;
  const pattern = `%${escapeLikePattern(query)}%`;
  return or(
    ilike(appointments.customerName, pattern),
    ilike(appointments.customerEmailNormalized, pattern),
    ilike(appointments.publicReference, pattern),
    ilike(appointments.sourceHoldPublicReference, pattern),
  );
}

function getAppointmentDateCondition(
  filters: AdminAppointmentFilters,
  errors: AdminAppointmentFieldErrors,
  timezone: string,
): SQL | undefined {
  const conditions: Array<SQL | undefined> = [];

  if (filters.from && !errors.from) {
    const range = getBusinessDateRange(filters.from, filters.from, timezone);
    conditions.push(
      filters.dateBasis === "completed"
        ? gte(appointments.completedAt, range.start)
        : gte(appointments.selectedStart, range.start),
    );
  }
  if (filters.to && !errors.to) {
    const range = getBusinessDateRange(filters.to, filters.to, timezone);
    conditions.push(
      filters.dateBasis === "completed"
        ? lt(appointments.completedAt, range.endExclusive)
        : lt(appointments.selectedStart, range.endExclusive),
    );
  }

  return and(...conditions);
}

function getAppointmentSort(view: AdminAppointmentView, now: Date): SQL[] {
  if (view === "past" || view === "all") {
    return [desc(appointments.selectedStart), desc(appointments.id)];
  }
  if (view === "needs-attention") {
    return [
      asc(sql<number>`case
        when ${appointments.status} in ('rebooking_pending', 'manual_followup')
          or ${appointments.paymentStatus} = 'refund_required' then 0
        when ${appointments.status} = 'confirmed'
          and ${appointments.selectedEnd} < ${now} then 1
        else 2
      end`),
      asc(appointments.selectedStart),
      asc(appointments.id),
    ];
  }
  return [asc(appointments.selectedStart), asc(appointments.id)];
}

function isCalendarDate(value: string): boolean {
  try {
    getBusinessDateRange(value, value, "UTC");
    return true;
  } catch {
    return false;
  }
}

function normalizePage(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) return 1;
  return Math.min(Number(value), MAX_PAGE);
}

function firstString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function cleanOptionalDisplayText(
  value: string | null,
  maximumLength: number,
): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function getBusinessTimezoneLabel(timezone: string): string {
  return timezone === "America/Toronto" ? "Toronto time" : "business time";
}
